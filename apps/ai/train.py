# VoltHub AI — Tier 4 (training): per-station hourly demand forecaster.
# Trains on the Tier-3 simulator output (self-contained + reproducible; when
# TS_HOST is set a future revision can pull real ticks from the Timescale
# enriched views instead). Never claims usefulness without a baseline: the
# receipt compares MLP vs ridge vs seasonal-naive on a held-out tail.
#
# Run:  python3 apps/ai/train.py [--days 28 --stations 24 --epochs 60]
# Out:  apps/ai/reports/model.pt (weights + feature metadata + metrics)

from __future__ import annotations

import argparse
import json
import math
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
REPORTS = HERE / "reports"
LAGS = (1, 24, 168)
HORIZON_FEATURES = 24  # direct multi-horizon head


def build_dataset(hourly: np.ndarray):
    """hourly: (stations, T) kWh -> sliding-window features + direct-horizon targets."""
    n_stations, T = hourly.shape
    max_lag = max(LAGS)
    xs, ys, meta = [], [], []
    for s in range(n_stations):
        for t in range(max_lag, T - HORIZON_FEATURES):
            feats = []
            for lag in LAGS:
                feats.append(hourly[s, t - lag])
            # calendar
            hour = t % 24
            feats += [math.sin(2 * math.pi * hour / 24), math.cos(2 * math.pi * hour / 24)]
            feats.append(1.0 if 5 <= hour < 10 else 0.0)  # morning peak
            feats.append(1.0 if 17 <= hour < 22 else 0.0)  # evening peak
            xs.append([s, *feats])
            ys.append(hourly[s, t : t + HORIZON_FEATURES])
            meta.append((s, t))
    X = np.asarray(xs, dtype=np.float32)
    Y = np.asarray(ys, dtype=np.float32)
    return X, Y, meta


def metrics(y_true: np.ndarray, y_pred: np.ndarray) -> dict:
    err = y_pred - y_true
    return {
        "mae": float(np.mean(np.abs(err))),
        "rmse": float(np.sqrt(np.mean(err**2))),
        "n": int(err.size),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=28)
    ap.add_argument("--stations", type=int, default=24)
    ap.add_argument("--vehicles", type=int, default=2000)
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--cpu", action="store_true", help="force CPU (CI-safe)")
    args = ap.parse_args()

    # GPU pinning must happen BEFORE torch initializes CUDA.
    import gpu

    device = "cpu"
    gpu_idx = None
    if not args.cpu:
        gpu_idx = gpu.acquire(min_free_mb=4096)
        if gpu_idx is not None:
            device = "cuda"
            print(f"[train] pinned gpu{gpu_idx}")

    try:
        _train_all(args, device)
    finally:
        # A crashed job must never leave a stale lock blocking the slot (quota hygiene).
        gpu.release(gpu_idx)
    return 0


def _train_all(args, device):
    import torch
    import torch.nn as nn

    import gpu
    from simulate import simulate_demand

    torch.manual_seed(args.seed)
    t0 = time.perf_counter()
    with gpu.UtilLogger("train") if device == "cuda" else gpu.UtilLogger("train-cpu", interval_s=10):
        sim = simulate_demand(n_stations=args.stations, days=args.days, vehicles=args.vehicles, seed=args.seed, device=device)
        hourly = sim["hourly"].numpy()
        # Per-station target normalization: station scales vary ~10x (lognormal weights),
        # which lets big stations dominate the loss. Models train on relative demand
        # (kWh / station_mean); all metrics are reported back in kWh for comparability.
        st_mean = hourly.mean(axis=1)  # (stations,)
        st_scale = (st_mean + 1e-6)[:, None]
        X, Yn, _meta = build_dataset(hourly / st_scale)
        # Raw kWh targets for kWh-space evaluation (single source of truth for all models).
        Y_kwh = np.stack([hourly[m[0], m[1] : m[1] + HORIZON_FEATURES] for m in _meta])
        n_stations, T = hourly.shape
        # Time-based split: last 7 days are test.
        t_test = T - 7 * 24
        train_mask = np.asarray([m[1] < t_test for m in _meta])
        test_mask = ~train_mask
        Xtr, Ytr, Xte = X[train_mask], Yn[train_mask], X[test_mask]
        Yte_kwh = Y_kwh[test_mask]

        # ---- baseline 1: seasonal naive (demand[t] = demand[t-168]) — kWh space, TEST rows ----
        naive_pred = np.stack([hourly[m[0], m[1] - 168 : m[1] - 168 + HORIZON_FEATURES] for m in _meta])
        m_naive = metrics(Yte_kwh, naive_pred[test_mask])

        # ---- baseline 2: ridge on identical features (CPU, sklearn) ----
        from sklearn.linear_model import Ridge
        from sklearn.preprocessing import StandardScaler

        scaler = StandardScaler().fit(Xtr)
        ridge = Ridge(alpha=1.0).fit(scaler.transform(Xtr), Ytr)
        ridge_pred_kwh = ridge.predict(scaler.transform(Xte)) * st_scale[[m[0] for m in _meta if m[1] >= t_test]]
        m_ridge = metrics(Yte_kwh, ridge_pred_kwh)

        # ---- model: small MLP (GPU when pinned) ----
        Xtr_t = torch.tensor(scaler.transform(Xtr), device=device)
        Ytr_t = torch.tensor(Ytr, device=device)
        Xte_t = torch.tensor(scaler.transform(Xte), device=device)
        model = nn.Sequential(
            nn.Linear(X.shape[1], 128), nn.ReLU(), nn.Linear(128, 64), nn.ReLU(), nn.Linear(64, HORIZON_FEATURES)
        ).to(device)
        opt = torch.optim.Adam(model.parameters(), lr=2e-3)
        loss_fn = nn.SmoothL1Loss()
        n = Xtr_t.shape[0]
        batch = 4096
        gen = torch.Generator(device=device).manual_seed(args.seed)
        for _epoch in range(args.epochs):
            model.train()
            perm = torch.randperm(n, device=device, generator=gen)
            for i in range(0, n, batch):
                b = perm[i : i + batch]
                opt.zero_grad()
                loss = loss_fn(model(Xtr_t[b]), Ytr_t[b])
                loss.backward()
                opt.step()
        model.eval()
        with torch.no_grad():
            pred = model(Xte_t).cpu().numpy() * st_scale[[m[0] for m in _meta if m[1] >= t_test]]
        m_mlp = metrics(Yte_kwh, pred)

        train_s = time.perf_counter() - t0

    receipt = {
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "device": device,
        "data": sim["meta"],
        "split": {"train_rows": int(train_mask.sum()), "test_rows": int(test_mask.sum()), "test_last_days": 7},
        "models": {"seasonal_naive_168h": m_naive, "ridge": m_ridge, "mlp_128x64": m_mlp},
        "train_seconds": round(train_s, 2),
        "beats_naive": bool(m_mlp["mae"] < m_naive["mae"]),
    }
    REPORTS.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "state_dict": model.state_dict(),
            "feature_spec": {"lags": LAGS, "horizon": HORIZON_FEATURES, "input_dim": int(X.shape[1]), "target": "station-relative hourly kWh (kWh / station_mean)"},
            "scaler_mean": scaler.mean_.tolist(),
            "scaler_scale": scaler.scale_.tolist(),
            "station_mean": st_mean.tolist(),
            "receipt": receipt,
        },
        REPORTS / "model.pt",
    )
    (REPORTS / "metrics.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")

    print(f"\n[train] device={device} rows={train_mask.sum()}/{test_mask.sum()} in {train_s:.1f}s")
    print(f"[train] seasonal-naive MAE={m_naive['mae']:.3f} RMSE={m_naive['rmse']:.3f}")
    print(f"[train] ridge          MAE={m_ridge['mae']:.3f} RMSE={m_ridge['rmse']:.3f}")
    print(f"[train] mlp_128x64     MAE={m_mlp['mae']:.3f} RMSE={m_mlp['rmse']:.3f}")
    print(f"[train] beats naive: {receipt['beats_naive']} — receipt at apps/ai/reports/metrics.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
