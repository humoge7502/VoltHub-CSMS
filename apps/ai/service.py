# VoltHub AI — Tier 1 (inference) FastAPI sidecar.
# ADVISORY-ONLY by design (ADR-0008): every response carries `advisory: true`,
# nothing here can mutate charging state, and the REST API enforces RBAC +
# station scope BEFORE this service is ever reached. The service itself is an
# internal-only component (compose binds it to the compose network; it checks
# the shared `x-internal` token and refuses public callers).
#
# The forecast contract lives in contract.py and is shared with train.py, so a
# feature can never be computed one way in training and another way here.
#
# Run:  python3 apps/ai/service.py            (uvicorn, :8100)
# Docs: docs/ai-platform.md

from __future__ import annotations

import json
import math
import os
import secrets
import statistics
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field

import contract

HERE = Path(__file__).resolve().parent
REPORTS = HERE / "reports"

PUBLISHED_DEV_TOKENS = {"dev-internal", "change_me", "replace_with_32_random_bytes"}


def _is_production() -> bool:
    return (os.environ.get("AI_ENV") or os.environ.get("NODE_ENV") or "").lower() == "production"


def _resolve_token() -> str:
    """The shared internal token, with the same boot discipline as the API.

    Dev keeps `dev-internal` so the local stack works with zero setup; in
    production a missing, short, or publicly-known token aborts the process
    instead of quietly exposing the sidecar to anyone on the compose network.
    """
    tok = os.environ.get("AI_TOKEN", "")
    if _is_production():
        if not tok or len(tok) < 24 or tok in PUBLISHED_DEV_TOKENS or tok.startswith("replace_with_"):
            raise SystemExit(
                "FATAL: AI_TOKEN must be a unique secret of >=24 bytes in production "
                "(the published development default is refused)."
            )
        return tok
    return tok or "dev-internal"


AI_TOKEN = _resolve_token()

_MODEL: dict = {"loaded": False, "error": None, "note": None}


def _auth(x_internal: str | None) -> None:
    # Constant-time compare: a timing side channel on an internal shared secret
    # is exactly the kind of thing a co-tenant on the host can amplify.
    if not x_internal or not secrets.compare_digest(str(x_internal), AI_TOKEN):
        raise HTTPException(status_code=401, detail="bad internal token")


def _build_network(spec: dict):
    # The trainer built this graph through the same helper, so the artifact can
    # never be loaded into a different topology than the one that earned the receipt.
    return contract.build_network(
        int(spec["input_dim"]), spec.get("hidden") or [128, 64], int(spec["horizon"])
    )


def _load_model() -> None:
    """Load, version-check and integrity-check the trained artifact.

    Any failure here is a loud, honest degradation: the sidecar keeps serving
    (statistical baselines) and reports exactly why the model is not in use.
    """
    path = REPORTS / "model.pt"
    if not path.exists():
        _MODEL["error"] = "model artifact missing — run apps/ai/train.py (forecast degrades to seasonal-naive)"
        return
    try:
        import torch

        # weights_only=True: the artifact is a data payload, never pickled code.
        pt = torch.load(path, map_location="cpu", weights_only=True)
    except Exception as e:
        _MODEL["error"] = f"model load failed: {e}"
        return
    try:
        digest = contract.file_sha256(path)
        sidecar = REPORTS / "model.pt.sha256"
        if sidecar.exists():
            expected = sidecar.read_text(encoding="utf-8").strip()
            if expected and expected != digest:
                _MODEL["error"] = "artifact checksum mismatch — refusing to serve a possibly tampered model"
                return
        if pt.get("format") != contract.ARTIFACT_FORMAT:
            _MODEL["error"] = f"artifact format {pt.get('format')!r} != {contract.ARTIFACT_FORMAT!r} — retrain"
            return
        if pt.get("feature_version") != contract.FEATURE_VERSION:
            _MODEL["error"] = (
                f"artifact feature_version {pt.get('feature_version')!r} != serving "
                f"{contract.FEATURE_VERSION!r} — retrain with apps/ai/train.py"
            )
            return
        spec = pt["spec"]
        if int(spec["input_dim"]) != contract.INPUT_DIM:
            _MODEL["error"] = f"artifact input_dim {spec['input_dim']} != contract {contract.INPUT_DIM} — retrain"
            return
        if int(spec["horizon"]) != contract.HORIZON:
            _MODEL["error"] = f"artifact horizon {spec['horizon']} != contract {contract.HORIZON} — retrain"
            return
        conf = pt.get("conformal")
        if not conf or not conf.get("quantiles_kwh"):
            _MODEL["error"] = "artifact carries no calibration table — intervals would be invented, not measured"
            return
        for level, vec in conf["quantiles_kwh"].items():
            if len(vec) != contract.HORIZON:
                _MODEL["error"] = f"conformal quantile {level} has {len(vec)} entries, need {contract.HORIZON}"
                return
        # An artifact may declare an interval level its own calibration table cannot
        # produce. Serving that would either 500 on the first forecast or, worse, publish
        # a band under names (p10/p90) that promise a level nobody measured — so the level
        # is validated against the table here, at load, and the artifact is refused.
        level = float(pt.get("interval_level") or contract.INTERVAL_LEVEL)
        half = round((1.0 - level) / 2.0, 6)
        needed = {str(half), str(round(1.0 - half, 6)), str(round(contract.QUANTILE_LEVELS[1], 6))}
        absent = sorted(needed - set(conf["quantiles_kwh"]))
        if absent:
            _MODEL["error"] = (
                f"artifact interval_level {level} needs conformal quantiles {absent}, "
                "which its calibration table does not contain — recalibrate with train.py"
            )
            return
        claimed = pt.get("payload_sha256")
        if claimed and contract.payload_hash(pt) != claimed:
            _MODEL["error"] = "payload digest mismatch — weights do not match their own receipt"
            return
        model = _build_network(spec)
        model.load_state_dict(pt["state_dict"])
        model.eval()
        _MODEL["pt"] = {
            "model": model,
            "spec": spec,
            "scaler_mean": list(pt["scaler_mean"]),
            "scaler_scale": list(pt["scaler_scale"]),
            "conformal": pt.get("conformal"),
            "interval_level": level,
        }
        _MODEL["loaded"] = True
        _MODEL["error"] = None
        _MODEL["note"] = None
        _MODEL["meta"] = {
            "trained_at": pt.get("trained_at"),
            "feature_version": pt.get("feature_version"),
            "file_sha256": digest[:16],
            "payload_sha256": (claimed or "")[:16],
            "backtest": (pt.get("receipt") or {}).get("backtest", {}).get("protocol"),
            "coverage": (pt.get("receipt") or {}).get("intervals", {}).get("empirical_coverage"),
            "mae_kwh": next(
                iter(
                    [
                        v.get("mae_kwh")
                        for k, v in ((pt.get("receipt") or {}).get("models") or {}).items()
                        if k.startswith("mlp_")
                    ]
                ),
                None,
            ),
        }
    except Exception as e:  # a broken artifact must not kill the sidecar
        _MODEL["error"] = f"artifact rejected: {e}"
        _MODEL["loaded"] = False


# Lifespan handler instead of the deprecated `@app.on_event("startup")`. `_load_model`
# runs at startup, not import time — a broken artifact still cannot kill the sidecar.
@asynccontextmanager
async def _lifespan(_app: FastAPI):
    _load_model()
    yield


app = FastAPI(title="VoltHub AI", version="2.0.0", docs_url=None, redoc_url=None, lifespan=_lifespan)


@app.middleware("http")
async def _no_cache(request: Request, call_next):
    response = await call_next(request)
    response.headers["cache-control"] = "no-store"
    return response


def _cuda_ok() -> bool:
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:
        return False


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
        "ready": _MODEL["loaded"],
        "model_loaded": _MODEL["loaded"],
        "model_note": _MODEL["error"],
        "model_meta": _MODEL.get("meta"),
        "contract": {
            "feature_version": contract.FEATURE_VERSION,
            "input_dim": contract.INPUT_DIM,
            "horizon_hours": contract.HORIZON,
            "min_history_hours": contract.MIN_HISTORY_H,
            "interval_level": contract.INTERVAL_LEVEL,
        },
        "gpus": gpus,
        "advisory_only": True,
    }


# ---- forecast ----


class ForecastReq(BaseModel):
    station_ids: list[int] = Field(min_length=1, max_length=500)
    hours: int = Field(default=contract.HORIZON, ge=1, le=contract.HORIZON)
    # station id -> either [kWh, ...] or {"timestamps": [...], "kwh": [...]}.
    # A timestamped history is the honest form: hour-of-week comes from the clock.
    history: dict[str, object] | None = None
    anchor: str | None = None  # RFC-3339 hour of the LAST observed point (default: now)


def _normalize_history(sid: int, raw) -> tuple[list[float], list | None]:
    if raw is None:
        return [], None
    if isinstance(raw, dict):
        values = raw.get("kwh") if "kwh" in raw else raw.get("values")
        stamps = raw.get("timestamps")
        if values is None or not isinstance(values, list):
            raise HTTPException(status_code=422, detail=f"station {sid}: history.kwh must be a list of numbers")
        if stamps is not None and not isinstance(stamps, list):
            raise HTTPException(status_code=422, detail=f"station {sid}: history.timestamps must be a list")
    elif isinstance(raw, list):
        values, stamps = raw, None
    else:
        raise HTTPException(status_code=422, detail=f"station {sid}: history must be a list or {{timestamps, kwh}}")
    try:
        nums = [float(v) for v in values]
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail=f"station {sid}: history contains non-numeric values") from None
    if any(not math.isfinite(v) for v in nums):
        raise HTTPException(status_code=422, detail=f"station {sid}: history contains NaN or Inf")
    return nums, (list(stamps) if stamps else None)


@app.post("/v1/forecast")
def forecast(req: ForecastReq, x_internal: str | None = Header(default=None)):
    """One fixed 24-hour forward forecast per station (h..h+24 from the anchor).

    `hours` selects how many of those 24 lead times to return; it never changes
    what the model was asked to predict (v1 trained a 24-step head and then
    served `min(hours, 24)` recursively, which was a different forecast).
    """
    _auth(x_internal)
    anchor = contract.parse_ts(req.anchor) or datetime.now(timezone.utc)
    loaded = _MODEL["loaded"]
    pt = _MODEL.get("pt") if loaded else None

    ready: list[tuple[int, contract.Series, int]] = []
    fallback: dict[str, dict] = {}
    for sid in req.station_ids:
        values, stamps = _normalize_history(sid, (req.history or {}).get(str(sid)))
        if stamps is not None:
            try:
                series = contract.series_from_timed(str(sid), stamps, values)
            except ValueError as e:
                fallback[str(sid)] = {"reason": str(e), "hours": len(values)}
                continue
        else:
            series = contract.series_from_values(str(sid), values, start=anchor)
        if series.hours < contract.MIN_HISTORY_H:
            fallback[str(sid)] = {"reason": f"history has {series.hours} h, contract needs {contract.MIN_HISTORY_H} h"}
            continue
        ready.append((sid, series, series.hours - 1))

    preds: dict[str, object] = {}
    if pt is not None and ready:
        import numpy as np
        import torch

        rows, mus, keep = [], [], []
        for sid, series, t in ready:
            feats = contract.origin_features(series, t)
            if feats is None:
                fallback[str(sid)] = {"reason": "trailing 168 h are flat (no demand signal to scale on)"}
                continue
            rows.append(contract.standardize(feats, pt["scaler_mean"], pt["scaler_scale"]))
            mus.append(float(series.window(t, contract.MIN_HISTORY_H).mean()))
            keep.append(sid)
        if rows:
            with torch.no_grad():
                out = pt["model"](torch.tensor(np.stack(rows), dtype=torch.float32)).numpy()
            # Deliberately unclipped: the calibration quantiles were fitted against
            # these raw values, so clipping here would shift the interval coverage.
            for sid, rel, mu in zip(keep, out, mus):
                preds[str(sid)] = rel * mu

    out = {}
    for sid, series, t in ready:
        key = str(sid)
        if key in preds:
            kwh = preds[key]
            model_name = "mlp_{}x{}".format(*pt["spec"].get("hidden", [128, 64]))
            conf = pt["conformal"]
            level = pt["interval_level"]
        else:
            kwh = contract.naive_row(series, t).astype("float32")
            model_name = "seasonal-naive-168-fallback"
            conf = None
            level = contract.INTERVAL_LEVEL
        # Intervals are always computed on the full 24-lead calibration vector and
        # then truncated: slicing first would mis-align the per-horizon quantiles.
        point = low = high = None
        if conf is not None:
            import numpy as np

            point, low, high = contract.conformal_intervals(np.asarray(kwh, dtype=np.float32), conf, level)
        shown = point if point is not None else kwh
        entry = {
            "hours": [round(float(v), 3) for v in shown[: req.hours]],
            "model": model_name,
            "lead_hours": list(range(1, len(shown[: req.hours]) + 1)),
            "station_scale_kwh_per_hour": round(float(series.window(t, contract.MIN_HISTORY_H).mean()), 4),
        }
        if conf is not None:
            # `lower`/`upper` are the honest field names: they carry whatever level the
            # artifact was actually calibrated at. `p10`/`p90` stay for existing clients,
            # but only while that level really is 0.8 — an 0.9 band published under 10/90
            # names is a quiet lie to whoever sizes a transformer or a demand charge off
            # it (audit 2026-10-25, "interval names are hardcoded").
            entry["lower"] = [round(float(v), 3) for v in low[: req.hours]]
            entry["upper"] = [round(float(v), 3) for v in high[: req.hours]]
            entry["interval_level"] = level
            entry["interval_method"] = conf["method"]
            named = abs(level - 0.8) < 1e-9
            entry["p10"] = entry["lower"] if named else None
            entry["p90"] = entry["upper"] if named else None
        else:
            entry["lower"] = None
            entry["upper"] = None
            entry["p10"] = None
            entry["p90"] = None
            entry["interval_note"] = "no calibrated intervals for the fallback model (uncalibrated by design)"
        out[key] = entry
    for sid, why in fallback.items():
        out[str(sid)] = {
            "hours": None,
            "model": "no-forecast",
            "reason": why.get("reason") if isinstance(why, dict) else str(why),
        }

    return {
        "advisory": True,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "anchor_utc": anchor.isoformat(),
        "horizon_hours": contract.HORIZON,
        "returned_hours": req.hours,
        "model_loaded": loaded,
        "feature_version": contract.FEATURE_VERSION,
        "stations": out,
        "rejected": len(fallback),
        "note": _MODEL["error"],
    }


# ---- model card (governance / audit surface) ----


def _report(name: str) -> dict | None:
    path = REPORTS / name
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


@app.get("/v1/model-card")
def model_card(x_internal: str | None = Header(default=None)):
    """The receipt a reviewer needs before trusting a forecast.

    It deliberately separates measured facts (dataset size, backtest errors,
    conformal coverage, artifact digests) from intended use and limitations, and
    states plainly that the model is advisory. Dataset labels are public research
    panels; no CSMS customer data is embedded in the card.
    """
    _auth(x_internal)
    metrics = _report("metrics.json") or {}
    dataset = _report("dataset.json") or {}
    data = dataset.get("panel") or {}
    per_source = dataset.get("per_source") or {}
    backtest = metrics.get("backtest") or {}
    models = metrics.get("models") or {}
    intervals = metrics.get("intervals") or {}
    artifact = metrics.get("artifact") or {}
    sources = [
        {
            "source": key,
            "license": (val.get("provenance") or {}).get("license"),
            "title": (val.get("provenance") or {}).get("title"),
            "doi": (val.get("provenance") or {}).get("doi"),
            "url": (val.get("provenance") or {}).get("url"),
            "period": (val.get("provenance") or {}).get("period"),
            "region": (val.get("provenance") or {}).get("region"),
            "stations": val.get("stations_kept"),
            "total_kwh": val.get("total_kwh"),
        }
        for key, val in sorted(per_source.items())
    ]
    return {
        "advisory": True,
        "model": {
            "name": "vh-demand-mlp",
            "feature_version": contract.FEATURE_VERSION,
            "artifact_format": contract.ARTIFACT_FORMAT,
            "trained_at": metrics.get("trained_at") or (_MODEL.get("meta") or {}).get("trained_at"),
            "device": metrics.get("device"),
            "torch": metrics.get("torch"),
            "train_seconds": metrics.get("train_seconds"),
            "loaded": bool(_MODEL["loaded"]),
            "load_error": _MODEL["error"],
            "artifact_sha256": artifact.get("file_sha256"),
            "payload_sha256": artifact.get("payload_sha256"),
            "serving_parity": artifact.get("serving_parity"),
        },
        "contract": {
            "horizon_hours": contract.HORIZON,
            "min_history_hours": contract.MIN_HISTORY_H,
            "feature_version": contract.FEATURE_VERSION,
            "input_dim": contract.INPUT_DIM,
            "interval_level": contract.INTERVAL_LEVEL,
            "features": list(contract.FEATURE_NAMES),
        },
        "training_data": {
            "stations": data.get("series") or data.get("stations"),
            "station_hours": data.get("station_hours"),
            "total_kwh": data.get("total_kwh"),
            "sources": data.get("sources"),
            "datasets": sources,
            "citations": dataset.get("citations") or [],
            "excluded_sources": dataset.get("excluded_sources") or {},
            "raw_sha256": dataset.get("raw_sha256") or {},
        },
        "evaluation": {
            "protocol": backtest.get("protocol"),
            "folds": backtest.get("folds"),
            "backtest_days": backtest.get("backtest_days"),
            "test_points": backtest.get("test_points"),
            "leakage_note": backtest.get("leakage_note"),
            "models": models,
            "intervals": intervals,
            "beats_naive": metrics.get("beats_naive"),
            "beats_weekly_mean": metrics.get("beats_weekly_mean"),
        },
        "intended_use": [
            "staff-facing hourly demand guidance for a charge point or site",
            "a prior for the deterministic smart-charging LP, never a hard constraint",
            "capacity planning and anomaly triage on stations with at least 168 h of meter history",
        ],
        "not_intended_for": [
            "billing, settlement, invoicing or any figure in the money path",
            "automatic curtailment or hardware actuation",
            "a station with no history, a flat/dead history, or a time base that is not hourly UTC",
            "individual driver profiling; the model is trained on station-level kWh only",
        ],
        "limitations": [
            "trained on public research panels (Tennessee, Norway, Korea), not on this deployment's fleet",
            "one pooled model: local tariffs, weather shocks and new connectors are not features",
            "conformal intervals are marginal (80%) and assume exchangeability with the calibration window",
            "forecast skill is measured on historical rolling-origin folds, not on future demand",
            "data drift is monitored statistically; drift does not by itself mean the model is wrong",
        ],
        "monitoring": {
            "drift_endpoint": "POST /v1/drift",
            "api_proxy": "GET /api/v1/ai/drift?stationId=<id>",
            "method": "PSI over demand deciles + two-sample KS + mean/zero/volatility shift + hourly-shape TV",
            "retrain_trigger": "verdict=drift on a station with a non-trivial baseline",
        },
        "explainability": {
            "endpoint": "POST /v1/explain",
            "method": "feature-group occlusion against the training mean, in standardized space",
            "caveat": "sensitivity, not causality; occlusion groups coexist and can interact",
        },
        "licenses": sorted(
            {str((v.get("provenance") or {}).get("license")) for v in per_source.values() if v.get("provenance")}
        ),
    }


# ---- explainability (model-agnostic, deterministic) ----


class ExplainReq(BaseModel):
    station_id: int
    history: object | None = None
    anchor: str | None = None
    hours: int = Field(default=contract.HORIZON, ge=1, le=contract.HORIZON)


# Feature index groups (contract v3 order):
#   0:3 lags · 3:5 rolling means · 5:29 last 24 h · 29:36 calendar
_EXPLAIN_GROUPS = (
    ("lag_1h_24h_168h", 0, 3),
    ("rolling_mean_24h_168h", 3, 5),
    ("history_earlier_18h", 5, 23),
    ("history_last_6h", 23, 29),
    ("calendar_hour_day_of_week", 29, 36),
)


@app.post("/v1/explain")
def explain(req: ExplainReq, x_internal: str | None = Header(default=None)):
    _auth(x_internal)
    if not _MODEL["loaded"]:
        raise HTTPException(
            status_code=503,
            detail=f"model not loaded: {_MODEL['error'] or 'artifact missing'} — forecast explanations need the trained network",
        )
    values, stamps = _normalize_history(req.station_id, req.history)
    anchor = contract.parse_ts(req.anchor) or datetime.now(timezone.utc)
    try:
        series = (
            contract.series_from_timed(str(req.station_id), stamps, values)
            if stamps is not None
            else contract.series_from_values(str(req.station_id), values, start=anchor)
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None
    if series.hours < contract.MIN_HISTORY_H:
        raise HTTPException(
            status_code=422,
            detail=f"history has {series.hours} h, contract needs {contract.MIN_HISTORY_H} h",
        )
    t = series.hours - 1
    feats = contract.origin_features(series, t)
    if feats is None:
        raise HTTPException(status_code=422, detail="trailing 168 h are flat (no demand signal to explain)")
    pt = _MODEL["pt"]
    mu = float(series.window(t, contract.MIN_HISTORY_H).mean())
    x = contract.standardize(feats, pt["scaler_mean"], pt["scaler_scale"])

    import numpy as np
    import torch

    def predict(row):
        with torch.no_grad():
            return pt["model"](torch.tensor(np.asarray([row], dtype=np.float32))).numpy()[0].astype(np.float64)

    base_rel = predict(x)
    base_kwh = base_rel * mu
    attributions = []
    for name, lo, hi in _EXPLAIN_GROUPS:
        occluded = x.copy()
        # Standardized 0 is the training mean for that feature: the neutral value.
        occluded[lo:hi] = 0.0
        delta = (base_rel - predict(occluded)) * mu
        attributions.append(
            {
                "group": name,
                "features": list(contract.FEATURE_NAMES[lo:hi]),
                "mean_delta_kwh": round(float(delta.mean()), 4),
                "mean_abs_delta_kwh": round(float(np.abs(delta).mean()), 4),
                "direction": "raises" if float(delta.mean()) > 0 else "lowers",
            }
        )
    attributions.sort(key=lambda a: abs(a["mean_delta_kwh"]), reverse=True)
    conf = pt["conformal"]
    point, low, high = contract.conformal_intervals(np.asarray(base_kwh, dtype=np.float32), conf, pt["interval_level"])
    lower = [round(float(v), 3) for v in low[: req.hours]]
    upper = [round(float(v), 3) for v in high[: req.hours]]
    # Same naming rule as /v1/forecast: p10/p90 are only published when the calibrated
    # level really is 0.8; lower/upper always describe whatever was actually computed.
    named = abs(pt["interval_level"] - 0.8) < 1e-9
    return {
        "advisory": True,
        "station_id": req.station_id,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "anchor_utc": series.ts(t).isoformat(),
        "hours": req.hours,
        "lead_hours": list(range(1, req.hours + 1)),
        "forecast_kwh": [round(float(v), 3) for v in point[: req.hours]],
        "raw_forecast_kwh": [round(float(v), 3) for v in base_kwh[: req.hours]],
        "interval_level": pt["interval_level"],
        "lower": lower,
        "upper": upper,
        "p10": lower if named else None,
        "p90": upper if named else None,
        "station_scale_kwh_per_hour": round(mu, 4),
        "attributions": attributions,
        "top_driver": attributions[0]["group"] if attributions else None,
        "method": "feature-group occlusion against the training mean (standardized space)",
        "caveat": "sensitivity, not causality; groups can interact and the model remains one pooled MLP",
    }


# ---- data drift monitoring (deterministic statistics, no retraining) ----


class TimedHistory(BaseModel):
    timestamps: list[str] = Field(min_length=1, max_length=2000)
    kwh: list[float] = Field(min_length=1, max_length=2000)


class DriftReq(BaseModel):
    station_id: int
    baseline: TimedHistory
    recent: TimedHistory
    min_hours: int = Field(default=48, ge=24, le=2000)


def _drift_state(value: float, watch: float, drift: float) -> str:
    return "drift" if value >= drift else "watch" if value >= watch else "stable"


def _psi_by_value(baseline, recent) -> float:
    import numpy as np

    # PSI over demand deciles. Hour-of-day counts are always equal on whole-day
    # windows (both sides are multiples of 24), so a time-bucket PSI would report 0
    # drift no matter how much demand changed. Value bins are the standard PSI view.
    edges = np.unique(np.quantile(baseline, np.linspace(0.0, 1.0, 11)))
    if len(edges) < 3:
        return 0.0
    b = np.digitize(baseline, edges[1:-1])
    r = np.digitize(recent, edges[1:-1])
    nb, nr = len(edges) - 1, len(edges) - 1
    cb = np.bincount(b, minlength=nb).astype(np.float64)
    cr = np.bincount(r, minlength=nr).astype(np.float64)
    # Laplace smoothing keeps a zero-count bin from producing log(0).
    pb = (cb + 0.5) / (cb.sum() + 0.5 * nb)
    pr = (cr + 0.5) / (cr.sum() + 0.5 * nr)
    return float(np.sum((pr - pb) * np.log(pr / pb)))


def _hourly_shape(baseline, recent, baseline_hours: list[int], recent_hours: list[int]) -> float:
    """Total-variation distance between the two normalized hour-of-day load shapes."""
    import numpy as np

    b = np.bincount(baseline_hours, weights=baseline, minlength=24)
    r = np.bincount(recent_hours, weights=recent, minlength=24)
    if b.sum() <= 1e-9 or r.sum() <= 1e-9:
        return 0.0
    return float(np.abs(b / b.sum() - r / r.sum()).sum() / 2.0)


@app.post("/v1/drift")
def drift(req: DriftReq, x_internal: str | None = Header(default=None)):
    _auth(x_internal)
    if len(req.baseline.timestamps) != len(req.baseline.kwh):
        raise HTTPException(status_code=422, detail="baseline timestamps and kwh must have equal length")
    if len(req.recent.timestamps) != len(req.recent.kwh):
        raise HTTPException(status_code=422, detail="recent timestamps and kwh must have equal length")
    if len(req.baseline.kwh) < req.min_hours or len(req.recent.kwh) < req.min_hours:
        raise HTTPException(
            status_code=422,
            detail=f"drift needs at least {req.min_hours} hours on each side "
            f"(baseline={len(req.baseline.kwh)}, recent={len(req.recent.kwh)})",
        )

    import numpy as np

    def parsed(hist: TimedHistory, label: str):
        stamps = [contract.parse_ts(s) for s in hist.timestamps]
        if any(s is None for s in stamps):
            raise HTTPException(status_code=422, detail=f"{label} contains an invalid timestamp")
        vals = np.asarray(hist.kwh, dtype=np.float64)
        if not np.all(np.isfinite(vals)):
            raise HTTPException(status_code=422, detail=f"{label} contains NaN or Inf")
        if np.any(vals < 0):
            raise HTTPException(status_code=422, detail=f"{label} contains negative energy")
        return vals, [s.hour for s in stamps], [s.isoformat() for s in stamps]

    base, base_hours, base_stamps = parsed(req.baseline, "baseline")
    recent, recent_hours, recent_stamps = parsed(req.recent, "recent")

    base_mean = float(base.mean())
    recent_mean = float(recent.mean())
    base_std = float(base.std())
    recent_std = float(recent.std())
    base_zero = float(np.mean(base <= 1e-9))
    recent_zero = float(np.mean(recent <= 1e-9))
    psi = _psi_by_value(base, recent)
    shape = _hourly_shape(base, recent, base_hours, recent_hours)
    from scipy.stats import ks_2samp

    ks = ks_2samp(base, recent)
    mean_shift_pct = (recent_mean - base_mean) / max(base_mean, 0.05) * 100.0
    volatility_ratio = recent_std / base_std if base_std > 1e-9 else None
    zero_delta = recent_zero - base_zero
    psi_state = _drift_state(psi, 0.10, 0.25)
    ks_state = "drift" if ks.pvalue < 0.01 and ks.statistic >= 0.20 else "watch" if ks.pvalue < 0.05 and ks.statistic >= 0.10 else "stable"
    mean_state = _drift_state(abs(mean_shift_pct), 35.0, 60.0)
    zero_state = "drift" if abs(zero_delta) >= 0.25 and max(base_zero, recent_zero) >= 0.20 else "watch" if abs(zero_delta) >= 0.10 else "stable"
    vol_state = (
        "drift"
        if volatility_ratio is not None and (volatility_ratio >= 2.5 or volatility_ratio <= 0.40)
        else "watch"
        if volatility_ratio is not None and (volatility_ratio >= 1.8 or volatility_ratio <= 0.55)
        else "stable"
    )
    shape_state = _drift_state(shape, 0.15, 0.25)
    states = {
        "psi": psi_state,
        "ks": ks_state,
        "mean": mean_state,
        "zeros": zero_state,
        "volatility": vol_state,
        "hourly_shape": shape_state,
    }
    rank = {"stable": 0, "watch": 1, "drift": 2}
    verdict = max(states.values(), key=lambda s: rank[s]) if base_mean > 0.01 else "insufficient"
    reasons = []
    if base_mean <= 0.01:
        reasons.append("baseline has no demand signal (mean <= 0.01 kWh/h); drift is undefined")
    if psi_state != "stable":
        reasons.append(f"demand-distribution PSI={psi:.3f} ({psi_state})")
    if ks_state != "stable":
        reasons.append(f"two-sample KS D={ks.statistic:.3f}, p={ks.pvalue:.4f} ({ks_state})")
    if mean_state != "stable":
        reasons.append(f"mean demand shifted {mean_shift_pct:+.1f}% ({mean_state})")
    if zero_state != "stable":
        reasons.append(f"zero-hour share moved {zero_delta:+.1%} ({zero_state})")
    if vol_state != "stable":
        reasons.append(f"volatility ratio {volatility_ratio:.2f}x ({vol_state})")
    if shape_state != "stable":
        reasons.append(f"hour-of-day load shape moved {shape:.3f} TV ({shape_state})")
    if not reasons:
        reasons.append("no material distribution shift detected")
    return {
        "advisory": True,
        "station_id": req.station_id,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "verdict": verdict,
        "retrain_recommended": verdict == "drift",
        "model_loaded": bool(_MODEL["loaded"]),
        "baseline_hours": int(len(base)),
        "recent_hours": int(len(recent)),
        "baseline_mean_kwh": round(base_mean, 4),
        "recent_mean_kwh": round(recent_mean, 4),
        "mean_shift_pct": round(mean_shift_pct, 2),
        "zero_share_baseline": round(base_zero, 4),
        "zero_share_recent": round(recent_zero, 4),
        "volatility_ratio": round(volatility_ratio, 4) if volatility_ratio is not None else None,
        "psi": round(psi, 4),
        "hourly_shape_shift": round(shape, 4),
        "ks_statistic": round(float(ks.statistic), 4),
        "ks_pvalue": round(float(ks.pvalue), 6),
        "states": states,
        "reasons": reasons,
        "baseline_window": {"from": base_stamps[0], "to": base_stamps[-1]},
        "recent_window": {"from": recent_stamps[0], "to": recent_stamps[-1]},
        "method": "PSI over demand deciles (Laplace-smoothed) + two-sample KS + mean/zero/volatility shift + hourly-shape TV",
        "note": "Data drift is a monitoring signal, not proof of forecast error. Retraining needs a labelled backtest.",
    }


# ---- anomalies (statistical, explainable — no training data needed) ----


class Tick(BaseModel):
    session_id: int
    ts: str
    meter_kwh: float
    power_kw: float | None = None


class AnomalyReq(BaseModel):
    ticks: list[Tick] = Field(min_length=1, max_length=5000)
    z_threshold: float = Field(default=3.5, gt=0)
    # A meter can legitimately hold still; a session this short has no spread to
    # judge anything against, so it is skipped instead of flagged (v1 divided by
    # a MAD of one or two samples and called it an anomaly).
    min_samples: int = Field(default=6, ge=3, le=200)
    max_kw: float | None = Field(default=None, gt=0)


@app.post("/v1/anomalies")
def anomalies(req: AnomalyReq, x_internal: str | None = Header(default=None)):
    _auth(x_internal)
    by_session: dict[int, list] = {}
    invalid_ts = 0
    for t in req.ticks:
        ts = contract.parse_ts(t.ts)
        if ts is None:
            invalid_ts += 1
            continue
        by_session.setdefault(t.session_id, []).append((ts, t))
    flags = []
    skipped = []
    for sid, rows in by_session.items():
        rows.sort(key=lambda r: r[0])
        deduped, seen = [], None
        for ts, t in rows:
            # An identical re-delivered frame (same hour, same meter) must not fake a
            # zero-length gap. A same-hour frame with a DIFFERENT meter value is a real
            # disagreement between two reports, so it survives to be flagged below.
            if seen is not None and ts == seen[0] and abs(t.meter_kwh - seen[1]) < 1e-9:
                continue
            seen = (ts, t.meter_kwh)
            deduped.append((ts, t))
        rows = deduped
        if len(rows) < req.min_samples:
            skipped.append({"session_id": sid, "ticks": len(rows), "reason": "below min_samples"})
            continue
        rates = []
        for i in range(1, len(rows)):
            gap_h = (rows[i][0] - rows[i - 1][0]).total_seconds() / contract.HOURS_SECONDS
            if gap_h > 1e-9:
                rates.append((rows[i][1].meter_kwh - rows[i - 1][1].meter_kwh) / gap_h)
        finite = [r for r in rates if math.isfinite(r)]
        med = statistics.median(finite) if finite else 0.0
        mad = statistics.median([abs(r - med) for r in finite]) if finite else 0.0
        for i in range(1, len(rows)):
            (ts_prev, t_prev), (ts, t) = rows[i - 1], rows[i]
            gap_h = (ts - ts_prev).total_seconds() / contract.HOURS_SECONDS
            reasons = []
            if gap_h <= 1e-9:
                reasons.append("duplicate timestamp with different meter value")
            else:
                rate = (t.meter_kwh - t_prev.meter_kwh) / gap_h
                if mad > 1e-9:
                    z = (rate - med) / (1.4826 * mad)
                else:
                    # Degenerate spread (a perfectly steady rate): a zero MAD means any
                    # real jump is infinitely anomalous, but comparing floats at 1e-9
                    # flags every tick of a healthy session (11.000000000000002 vs 11.0).
                    # Use a relative floor, and cap the jump value so JSON stays valid.
                    z = 0.0 if abs(rate - med) <= max(1e-6, 1e-6 * abs(med)) else 1e9
                if abs(z) > req.z_threshold:
                    reasons.append(f"meter rate z={z:.2f} ({rate:.1f} vs median {med:.1f} kW)")
                if t.meter_kwh < t_prev.meter_kwh - 1e-6:
                    reasons.append("meter regression")
                if req.max_kw and rate > req.max_kw * 1.2:
                    reasons.append(f"meter rate {rate:.1f} kW exceeds connector cap {req.max_kw} kW")
                if t.power_kw is not None and gap_h > 0.5 and abs(rate - t.power_kw) > max(0.5 * t.power_kw, 5.0):
                    reasons.append(f"meter rate {rate:.1f} kW disagrees with reported power {t.power_kw} kW")
            if t.power_kw is not None and t.power_kw < 0:
                reasons.append("negative power")
            if t.power_kw is not None and t.power_kw > 0 and abs(t.meter_kwh - t_prev.meter_kwh) < 1e-9:
                reasons.append("power reported but meter stalled")
            if reasons:
                flags.append({"session_id": sid, "ts": ts.isoformat(), "meter_kwh": t.meter_kwh, "reasons": reasons})
    return {
        "advisory": True,
        "checked": len(req.ticks) - invalid_ts,
        "invalid_timestamps": invalid_ts,
        "flagged": flags,
        "skipped": skipped,
        "method": "per-session robust z-score on kWh/h meter rate (median/MAD)",
    }


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
    # Optional second objective: grid carbon intensity (gCO2/kWh) per hour. When
    # present the LP minimises cost + carbon_weight x carbon, still deterministically.
    carbon_g_per_kwh: list[float] | None = None
    carbon_weight: float = Field(default=0.0, ge=0.0)


@app.post("/v1/optimize")
def optimize(req: OptimizeReq, x_internal: str | None = Header(default=None)):
    _auth(x_internal)
    ids = [v.id for v in req.vehicles]
    if len(ids) != len(set(ids)):
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        raise HTTPException(status_code=422, detail=f"duplicate vehicle ids: {dupes}")
    for v in req.vehicles:
        if v.deadline <= v.arrive:
            raise HTTPException(status_code=422, detail=f"vehicle {v.id}: deadline must be after arrive")
        if v.arrive >= req.window_hours:
            raise HTTPException(status_code=422, detail=f"vehicle {v.id}: arrives outside the window")
    import numpy as np
    from scipy.optimize import linprog

    H = req.window_hours

    def extend(seq):
        seq = list(seq)[:H]
        return seq + [seq[-1]] * (H - len(seq))

    prices = extend(req.price_per_kwh)
    carbons = extend(req.carbon_g_per_kwh) if req.carbon_g_per_kwh else None
    V = len(req.vehicles)
    n = V * H

    def vid(v: int, h: int) -> int:
        return v * H + h

    # Cost: price[h] (+ optional weighted carbon intensity) per kWh delivered.
    c = np.zeros(n)
    for v in range(V):
        for h in range(H):
            c[vid(v, h)] = prices[h] + (req.carbon_weight * carbons[h] if carbons else 0.0)
    A, b = [], []
    # Station power cap per hour: sum_v e[v,h] <= cap * 1h
    for h in range(H):
        row = np.zeros(n)
        for v in range(V):
            row[vid(v, h)] = 1.0
        A.append(row)
        b.append(req.station_power_cap_kw)
    # Per-vehicle window: only hours arrive..min(deadline, H) allowed, charging
    # rate <= connector max_kw; hours outside the window are pinned to zero.
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
                b.append(0.0)
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
    schedule = {veh.id: [round(float(x[vid(v, h)]), 3) for h in range(H)] for v, veh in enumerate(req.vehicles)}
    objective_cost = sum(prices[h] * x[vid(v, h)] for v in range(V) for h in range(H))
    objective_carbon = (
        sum(carbons[h] * x[vid(v, h)] for v in range(V) for h in range(H)) if carbons else None
    )
    return {
        "advisory": True,
        "feasible": True,
        "objective_cost": round(float(objective_cost), 2),
        "objective_carbon_g": round(float(objective_carbon), 1) if objective_carbon is not None else None,
        "solver_value": round(float(res.fun), 4),
        "schedule_kwh": schedule,
        "delivered_kwh": {k: round(float(sum(s)), 3) for k, s in schedule.items()},
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

    # AI_HOST defaults to loopback for bare-metal runs; the container sets 0.0.0.0
    # so the API can reach it over the compose network.
    uvicorn.run(
        app,
        host=os.environ.get("AI_HOST", "127.0.0.1"),
        port=int(os.environ.get("AI_PORT", "8100")),
        log_level="info",
    )
