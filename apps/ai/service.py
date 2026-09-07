# VoltHub AI — Tier 1 (inference) FastAPI sidecar.
# ADVISORY-ONLY by design (ADR-0008): every response carries `advisory: true`,
# nothing here can mutate charging state, and the REST API enforces RBAC +
# station scope BEFORE this service is ever reached. The service itself is an
# internal-only component (compose binds it to the compose network; it checks
# the shared `x-internal` token and refuses public callers).
#
# Run:  python3 apps/ai/service.py            (uvicorn, :8100)
# Docs: docs/ai-platform.md

from __future__ import annotations

import json
import math
import os
import statistics
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

HERE = Path(__file__).resolve().parent
REPORTS = HERE / "reports"
AI_TOKEN = os.environ.get("AI_TOKEN", "dev-internal")

app = FastAPI(title="VoltHub AI", version="1.0.0", docs_url=None, redoc_url=None)
_MODEL = {"pt": None, "loaded": False, "error": None}


def _auth(x_internal: str | None) -> None:
    if not x_internal or x_internal != AI_TOKEN:
        raise HTTPException(status_code=401, detail="bad internal token")


@app.on_event("startup")
def _load_model() -> None:
    path = REPORTS / "model.pt"
    if not path.exists():
        _MODEL["error"] = "model artifact missing — run apps/ai/train.py (forecast degrades to seasonal-naive)"
        return
    try:
        import torch

        pt = torch.load(path, map_location="cpu", weights_only=False)
        import torch.nn as nn

        spec = pt["feature_spec"]
        model = nn.Sequential(
            nn.Linear(spec["input_dim"], 128), nn.ReLU(), nn.Linear(128, 64), nn.ReLU(), nn.Linear(64, spec["horizon"])
        )
        model.load_state_dict(pt["state_dict"])
        model.eval()
        _MODEL["pt"] = {
            "model": model,
            "spec": spec,
            "scaler_mean": pt["scaler_mean"],
            "scaler_scale": pt["scaler_scale"],
            "station_mean": pt.get("station_mean"),
        }
        _MODEL["loaded"] = True
    except Exception as e:  # a broken artifact must not kill the sidecar
        _MODEL["error"] = f"model load failed: {e}"


@app.get("/health")
def health(x_internal: str | None = Header(default=None)):
    _auth(x_internal)
    import gpu

    try:
        gpus = gpu.list_gpus()
    except Exception:
        gpus = []
    return {
        "ok": True,
        "service": "volthub-ai",
        "device": "cuda" if _cuda_ok() else "cpu",
        "model_loaded": _MODEL["loaded"],
        "model_note": _MODEL["error"],
        "gpus": gpus,
        "advisory_only": True,
    }


def _cuda_ok() -> bool:
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:
        return False


# ---- forecast ----


class ForecastReq(BaseModel):
    station_ids: list[int] = Field(min_length=1, max_length=500)
    hours: int = Field(default=24, ge=1, le=48)
    history: dict[str, list[float]] | None = None  # station_id -> recent hourly kWh (>=168 points)


@app.post("/v1/forecast")
def forecast(req: ForecastReq, x_internal: str | None = Header(default=None)):
    _auth(x_internal)
    horizon = _MODEL["pt"]["spec"]["horizon"] if _MODEL["loaded"] else 24
    spec_lags = _MODEL["pt"]["spec"]["lags"] if _MODEL["loaded"] else (168,)
    out = {}
    for sid in req.station_ids:
        hist = (req.history or {}).get(str(sid)) or []
        if len(hist) >= 168:
            base = hist[-168:]
        else:
            base = None
        if _MODEL["loaded"] and len(hist) >= max(spec_lags):
            pred = _mlp_forecast(sid, hist, min(req.hours, horizon))
            model_name = "mlp_128x64"
        else:
            pred = _naive_forecast(base, req.hours)
            model_name = "seasonal-naive-fallback"
        out[str(sid)] = {
            "hours": pred,
            "p80_low": [round(v * 0.72, 3) for v in pred],
            "p80_high": [round(v * 1.38, 3) for v in pred],
            "model": model_name,
        }
    return {
        "advisory": True,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "horizon_hours": req.hours,
        "model_loaded": _MODEL["loaded"],
        "stations": out,
        "note": _MODEL["error"],
    }


def _naive_forecast(last_week: list[float] | None, hours: int) -> list[float]:
    if not last_week:
        return [0.0] * hours
    return [round(float(last_week[-168 + (i % 168)]), 3) for i in range(hours)]


def _mlp_forecast(sid: int, hist: list[float], hours: int) -> list[float]:
    import numpy as np
    import torch

    pt = _MODEL["pt"]
    spec = pt["spec"]
    lags = spec["lags"]
    mean = np.asarray(pt["scaler_mean"], dtype=np.float32)
    scale = np.asarray(pt["scaler_scale"], dtype=np.float32)
    # The model was trained on station-relative targets (kWh / station_mean). The
    # caller's history supplies the station scale here (its own mean); predictions
    # come back relative and are scaled to kWh before returning.
    mu = max(sum(hist) / len(hist), 1e-6)
    window = [v / mu for v in hist]
    preds: list[float] = []
    t = len(window)
    for step in range(hours):
        feats = [float(sid)] + [window[t - lag] for lag in lags]
        hour = t % 24
        feats += [math.sin(2 * math.pi * hour / 24), math.cos(2 * math.pi * hour / 24)]
        feats.append(1.0 if 5 <= hour < 10 else 0.0)
        feats.append(1.0 if 17 <= hour < 22 else 0.0)
        x = (np.asarray(feats, dtype=np.float32) - mean) / scale
        with torch.no_grad():
            y = pt["model"](torch.tensor(x).unsqueeze(0)).squeeze(0)
        v = max(0.0, float(y[min(step, y.numel() - 1)].item())) * mu
        preds.append(round(v, 3))
        window.append(v / mu)
        t += 1
    return preds


# ---- anomalies (statistical, explainable — no training data needed) ----


class Tick(BaseModel):
    session_id: int
    ts: str
    meter_kwh: float
    power_kw: float | None = None


class AnomalyReq(BaseModel):
    ticks: list[Tick] = Field(min_length=1, max_length=5000)
    z_threshold: float = Field(default=3.5, gt=0)


@app.post("/v1/anomalies")
def anomalies(req: AnomalyReq, x_internal: str | None = Header(default=None)):
    _auth(x_internal)
    # Robust z-scores on per-session kWh deltas and on power readings.
    by_session: dict[int, list[Tick]] = {}
    for t in req.ticks:
        by_session.setdefault(t.session_id, []).append(t)
    flags = []
    for sid, ticks in by_session.items():
        ticks.sort(key=lambda t: t.ts)
        deltas = [b.meter_kwh - a.meter_kwh for a, b in zip(ticks, ticks[1:])]
        med = statistics.median(deltas) if deltas else 0.0
        mad = statistics.median([abs(d - med) for d in deltas]) if deltas else 0.0
        for i, t in enumerate(ticks):
            reasons = []
            if i > 0:
                d = ticks[i].meter_kwh - ticks[i - 1].meter_kwh
                if mad > 1e-9:
                    z = (d - med) / (1.4826 * mad)
                else:
                    # Degenerate spread (constant deltas): any real jump is infinitely
                    # anomalous; cap at a large finite value so JSON stays valid.
                    z = 0.0 if abs(d - med) <= 1e-9 else 1e9
                if abs(z) > req.z_threshold:
                    reasons.append(f"meter delta z={z:.2f}")
                if d < -1e-6:
                    reasons.append("meter regression")
            if t.power_kw is not None and t.power_kw < 0:
                reasons.append("negative power")
            if reasons:
                flags.append({"session_id": sid, "ts": t.ts, "meter_kwh": t.meter_kwh, "reasons": reasons})
    return {"advisory": True, "checked": len(req.ticks), "flagged": flags, "method": "median/MAD robust z-score"}


# ---- smart-charging optimizer (constrained LP — deterministic, never AI-guessed) ----


class Vehicle(BaseModel):
    id: str
    arrive: int = Field(ge=0)
    deadline: int = Field(ge=1)
    energy_kwh: float = Field(gt=0)
    max_kw: float = Field(default=22.0, gt=0)


class OptimizeReq(BaseModel):
    station_id: int
    window_hours: int = Field(default=24, ge=1, le=72)
    station_power_cap_kw: float = Field(gt=0)
    price_per_kwh: list[float] = Field(min_length=1)
    vehicles: list[Vehicle] = Field(min_length=1, max_length=200)


@app.post("/v1/optimize")
def optimize(req: OptimizeReq, x_internal: str | None = Header(default=None)):
    _auth(x_internal)
    import numpy as np
    from scipy.optimize import linprog

    H = req.window_hours
    prices = req.price_per_kwh[:H]
    if len(prices) < H:
        prices = prices + [prices[-1]] * (H - len(prices))
    # Variables: e[v, h] kWh delivered to vehicle v in hour h.
    V = len(req.vehicles)
    n = V * H

    def vid(v: int, h: int) -> int:
        return v * H + h

    # Cost: price[h] * e[v,h] (per-kWh cost; energy is the decision variable).
    c = np.zeros(n)
    for v in range(V):
        for h in range(H):
            c[vid(v, h)] = prices[h]
    # A_ub x <= b_ub
    A, b = [], []
    # Station power cap per hour: sum_v e[v,h] <= cap * 1h
    for h in range(H):
        row = np.zeros(n)
        for v in range(V):
            row[vid(v, h)] = 1.0
        A.append(row)
        b.append(req.station_power_cap_kw)
    # Per-vehicle window: only hours arrive..min(deadline, H) allowed, energy met by deadline,
    # charging rate <= connector max_kw.
    for v, veh in enumerate(req.vehicles):
        lo, hi = veh.arrive, min(veh.deadline, H)
        for h in range(H):
            row = np.zeros(n)
            if lo <= h < hi:
                row[vid(v, h)] = 1.0
                A.append(row)
                b.append(veh.max_kw)  # kWh in one hour <= max_kw
            else:
                A.append(row)
                b.append(0.0)  # outside the plug-in window
    # HARD CONSTRAINT: each vehicle must receive exactly its required energy by its
    # deadline (equality). An infeasible demand reports honestly — never silently
    # truncated (mission rule: deterministic safety constraints over AI output).
    A_eq, b_eq = [], []
    for v, veh in enumerate(req.vehicles):
        row = np.zeros(n)
        for h in range(veh.arrive, min(veh.deadline, H)):
            row[vid(v, h)] = 1.0
        A_eq.append(row)
        b_eq.append(veh.energy_kwh)
    bounds = [(0, None)] * n
    res = linprog(
        c,
        A_ub=np.asarray(A),
        b_ub=np.asarray(b),
        A_eq=np.asarray(A_eq),
        b_eq=np.asarray(b_eq),
        bounds=bounds,
        method="highs",
    )
    if not res.success:
        return {
            "advisory": True,
            "feasible": False,
            "reason": res.message,
            "constraints": {"window_hours": H, "station_power_cap_kw": req.station_power_cap_kw},
        }
    x = res.x
    schedule = {}
    for v, veh in enumerate(req.vehicles):
        schedule[veh.id] = [round(float(x[vid(v, h)]), 3) for h in range(H)]
    delivered = {vid_: sum(s) for vid_, s in schedule.items()}
    return {
        "advisory": True,
        "feasible": True,
        "objective_cost": round(float(res.fun), 2),
        "schedule_kwh": schedule,
        "delivered_kwh": {k: round(v, 3) for k, v in delivered.items()},
        "station_hour_kwh": [round(float(sum(x[vid(v, h)] for v in range(V))), 3) for h in range(H)],
        "constraints": {
            "window_hours": H,
            "station_power_cap_kw": req.station_power_cap_kw,
            "vehicles": V,
            "solver": "scipy highs (deterministic LP — no ML in the control path)",
        },
        "note": "Advisory schedule. Hard electrical constraints are enforced by the CSMS, never by this output.",
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("AI_PORT", "8100")), log_level="info")
