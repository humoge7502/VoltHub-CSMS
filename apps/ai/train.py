# VoltHub AI — Tier 4 (training): 24-h hourly demand forecaster.
#
# Trains on the real licensed panel (`ingest.py`) when it is present and on the
# Tier-3 twin otherwise; `--source both` pools them into one station-relative model.
#
# Honesty rules this file exists to enforce:
#  * every number in the receipt comes from a ROLLING-ORIGIN BACKTEST, never a
#    single lucky holdout: F folds, each model re-fit per fold.
#  * a PURGE + calibration block sits between the training rows and the test
#    block, so a target window can never be inside what the model saw.
#  * the winner must beat two statistical baselines (seasonal-naive-168 and
#    4-week same-hour mean) on MASE, not just on a metric with no scale.
#  * intervals are CONFORMAL: quantiles fitted on held-out calibration
#    residuals, then measured for coverage on the test folds. v1 shipped
#    `pred*0.72 / pred*1.38`, a made-up band with no coverage guarantee.
#
# Run:  python3 apps/ai/train.py [--source auto --folds 4 --epochs 30]
# Out:  apps/ai/reports/model.pt (+ .sha256), apps/ai/reports/metrics.json

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
REPORTS = HERE / "reports"

_TORCH = None


def _torch():
    global _TORCH
    if _TORCH is None:
        import torch

        _TORCH = torch
    return _TORCH


def load_series(source: str, args, device: str):
    """Return (series_list, provenance). `auto` prefers real data, twin as fallback."""
    import contract
    from ingest import load_panel

    out, prov = [], {}
    if source in ("real", "both"):
        out = load_panel()
        if not out and source == "real":
            raise SystemExit("no real panel — run `python3 apps/ai/ingest.py --fetch` first")
        if out:
            prov["real_panel"] = {
                "stations": len(out),
                "station_hours": int(sum(s.hours for s in out)),
                "sources": sorted({s.source for s in out}),
            }
    if source in ("synthetic", "both") or not out:
        from simulate import simulate_demand

        sim = simulate_demand(
            n_stations=args.stations, days=args.days, vehicles=args.vehicles, seed=args.seed, device=device
        )
        out = sim["series"] if source == "synthetic" else list(out) + list(sim["series"])
        prov["synthetic_twin"] = sim["meta"]
    # A series shorter than the contract minimum cannot produce a single row.
    out = [s for s in out if s.hours >= contract.MIN_HISTORY_H + contract.HORIZON + 1]
    return out, prov


def aligned_arrays(series_list, meta):
    """Vectorised targets + statistical baselines in kWh, row-aligned with `meta`."""
    import contract

    n = len(meta)
    truth = np.zeros((n, contract.HORIZON), dtype=np.float32)
    naive = np.zeros_like(truth)
    weekly = np.zeros_like(truth)
    mu = np.zeros(n, dtype=np.float32)
    by_series = {}
    for i, (si, t, m) in enumerate(meta):
        by_series.setdefault(si, []).append((i, t))
        mu[i] = m
    for si, pairs in by_series.items():
        values = series_list[si].values.astype(np.float32)
        swv = np.lib.stride_tricks.sliding_window_view(values, contract.HORIZON)  # swv[s] = hours s..s+23
        rows = np.asarray([p[0] for p in pairs])
        org = np.asarray([p[1] for p in pairs])
        truth[rows] = swv[org + 1]
        naive[rows] = swv[org + 1 - contract.MIN_HISTORY_H]
        leads = np.arange(contract.HORIZON, dtype=np.int64)
        acc = np.zeros((len(org), contract.HORIZON), dtype=np.float64)
        seen = np.zeros_like(acc)
        for w in range(1, 5):
            # Same-hour mean over the previous 4 weeks, exactly like
            # contract.weekly_mean_row: weeks that do not exist yet are skipped
            # per lead (an origin 167 h into a series has one week of lookback,
            # not four), so the vectorised baseline cannot silently average zeros.
            idx = org[:, None] + 1 + leads[None, :] - contract.MIN_HISTORY_H * w
            have = idx >= 0
            acc += np.where(have, values[np.clip(idx, 0, None).astype(np.int64)], 0.0)
            seen += have
        weekly[rows] = acc / np.maximum(seen, 1.0)
    return {"truth": truth, "naive168": naive, "weekly4": weekly, "mu": mu}


def fold_masks(meta, folds: int, backtest_hours: int, calib_hours: int, purge: int, horizon: int):
    """Per-fold (train, calib, test) masks over rows, aligned per series.

    Each series is folded by ITS OWN recency (the panel spans different calendar
    years, so there is no shared "now"), and every fold keeps a calibration plus
    purge block between the last training target and the first test target.
    """
    n = len(meta)
    si = np.asarray([m[0] for m in meta])
    t = np.asarray([m[1] for m in meta])
    t_max = np.zeros(int(si.max()) + 1, dtype=np.int64)
    for s, tt in zip(si, t):
        t_max[s] = max(t_max[s], tt)
    test_start = t_max[si] - backtest_hours + 1  # per row: where its fold-0 test block begins
    fold_hours = max(backtest_hours // folds, horizon)
    out = []
    for k in range(folds):
        start = test_start + k * fold_hours
        reach = start <= t_max[si]
        test = reach & (t >= start) & (t < start + fold_hours)
        calib = reach & (t >= start - horizon - calib_hours) & (t < start - horizon)
        train = reach & (t < start - horizon - calib_hours - purge)
        if test.any() and train.any() and calib.any():
            out.append({"fold": k, "train": train, "calib": calib, "test": test, "fold_hours": int(fold_hours)})
    return out


def make_model(input_dim: int, hidden, horizon: int, seed: int, device: str):
    import contract

    _torch().manual_seed(seed)
    # Same builder the sidecar uses: the graph that earned these numbers is the
    # graph that serves them.
    return contract.build_network(input_dim, hidden, horizon, device)


def fit_mlp(Xtr, Ytr, scaler, hidden, seed, device, epochs: int, batch: int, lr: float, val=None, patience: int = 3):
    """Adam + SmoothL1 on relative targets; returns (model, fit_stats).

    `Xtr`/`val` are RAW contract features: the standardization the artifact ships
    (`scaler_mean`/`scaler_scale`) is applied here through `contract.standardize`,
    the same function serving calls. A call site can therefore never fit on
    standardized rows and predict on raw ones — the silent train/serve divergence
    `contract.py` exists to prevent, which is what made an earlier run score the
    MLP 60 % worse than ridge.

    `fit_stats` records the optimizer steps the model actually saw, because "an
    MLP loses to ridge" turned out to be a batch-size artefact: at batch 8192 a
    12 k-row fold got two steps per epoch. Receipts state the steps, so a slow
    run is diagnosable without re-running it.
    """
    import torch.nn as nn

    import contract

    torch = _torch()
    model = make_model(Xtr.shape[1], hidden, Ytr.shape[1], seed, device)
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    loss_fn = nn.SmoothL1Loss()
    xt = torch.tensor(contract.standardize(Xtr, scaler.mean_, scaler.scale_), device=device)
    yt = torch.tensor(Ytr, device=device)
    n = xt.shape[0]
    gen = torch.Generator(device=device).manual_seed(seed)
    vt = (
        (torch.tensor(contract.standardize(val[0], scaler.mean_, scaler.scale_), device=device),
         torch.tensor(val[1], device=device))
        if val is not None
        else None
    )
    best = (float("inf"), None)
    stale, steps, stopped = 0, 0, False
    epoch = 0
    for epoch in range(epochs):
        model.train()
        perm = torch.randperm(n, device=device, generator=gen)
        for i in range(0, n, batch):
            b = perm[i : i + batch]
            opt.zero_grad()
            loss = loss_fn(model(xt[b]), yt[b])
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            opt.step()
            steps += 1
        if vt is not None:
            model.eval()
            with torch.no_grad():
                v = float(loss_fn(model(vt[0]), vt[1]).item())
            if v < best[0] - 1e-5:
                best = (v, {k: t.detach().clone() for k, t in model.state_dict().items()})
                stale = 0
            else:
                stale += 1
                if epoch >= 5 and stale >= patience:
                    model.load_state_dict(best[1])  # roll back to the best validation epoch
                    stopped = True
                    break
    stats = {
        "epochs_run": int(epoch + 1),
        "optimizer_steps": int(steps),
        "early_stopped": bool(stopped),
        "val_loss": (round(best[0], 6) if best[1] is not None else None),
    }
    return model, stats


def predict(model, X, scaler, device, chunk: int = 65536) -> np.ndarray:
    """Forward pass over RAW features, standardized the way the artifact stores it."""
    import contract

    torch = _torch()
    model.eval()
    out = np.zeros((X.shape[0], model[-1].out_features), dtype=np.float32)
    with torch.no_grad():
        for i in range(0, X.shape[0], chunk):
            block = contract.standardize(X[i : i + chunk], scaler.mean_, scaler.scale_)
            out[i : i + chunk] = model(torch.tensor(block, device=device)).cpu().numpy()
    return out


def verify_artifact(path, X, scaler, model, rows: int = 512) -> dict:
    """Prove the saved artifact serves the numbers the backtest scored.

    Reloads with `weights_only=True` exactly like `service.py`, rebuilds the graph
    from the artifact's own spec, and compares its output with the trainer's. A
    mismatch means the deployable file is not the model that was measured, so this
    fails the run loudly instead of shipping it.
    """
    import contract

    torch = _torch()
    pt = torch.load(path, map_location="cpu", weights_only=True)
    if contract.payload_hash(pt) != pt["payload_sha256"]:
        raise SystemExit("[train] FATAL: artifact payload digest does not verify after save")
    net = contract.build_network(pt["spec"]["input_dim"], pt["spec"]["hidden"], pt["spec"]["horizon"])
    net.load_state_dict(pt["state_dict"])
    net.eval()
    k = min(rows, X.shape[0])
    with torch.no_grad():
        served = net(torch.tensor(contract.standardize(X[:k], pt["scaler_mean"], pt["scaler_scale"]))).numpy()
    trained = predict(model.to("cpu"), X[:k], scaler, "cpu")
    diff = float(np.max(np.abs(served - trained)))
    if not np.isfinite(diff) or diff > 1e-3:
        raise SystemExit(f"[train] FATAL: artifact/trainer parity broke (max |Δ| = {diff:.6g} relative kWh)")
    return {
        "rows_checked": int(k),
        "max_abs_relative_difference": round(diff, 8),
        "weights_only_load": True,
        "payload_sha256_verified": True,
        "file_sha256": contract.file_sha256(path),
    }


def summarize(truth, pred, naive, weekly) -> dict:
    import contract

    m = contract.metrics_kwh(truth, pred)
    naive_mae = float(np.mean(np.abs(truth - naive)))
    return {
        "mae_kwh": round(m["mae"], 4),
        "rmse_kwh": round(m["rmse"], 4),
        "points": int(m["n"]),
        "mase_vs_naive168": (None if not np.isfinite(contract.mase(truth, pred, naive)) else round(contract.mase(truth, pred, naive), 4)),
        "skill_vs_naive_pct": round(100.0 * (1.0 - m["mae"] / max(naive_mae, 1e-9)), 2),
        "skill_vs_weekly4_pct": round(100.0 * (1.0 - m["mae"] / max(float(np.mean(np.abs(truth - weekly))), 1e-9)), 2),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["auto", "real", "synthetic", "both"], default="auto")
    ap.add_argument("--days", type=int, default=120, help="synthetic twin length when used")
    ap.add_argument("--stations", type=int, default=24)
    ap.add_argument("--vehicles", type=int, default=2000)
    ap.add_argument("--folds", type=int, default=4)
    ap.add_argument("--backtest-days", type=int, default=45)
    ap.add_argument("--calib-days", type=int, default=10)
    ap.add_argument("--purge-days", type=int, default=1)
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--batch", type=int, default=512)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument(
        "--patience",
        type=int,
        default=3,
        help="validation epochs without improvement before the fit rolls back to its best",
    )
    ap.add_argument("--hidden", type=int, nargs=2, default=[128, 64])
    ap.add_argument("--max-rows", type=int, default=240000, help="stride-sample the panel to bound runtime")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--cpu", action="store_true", help="force CPU (CI-safe)")
    ap.add_argument("--no-final-fit", action="store_true", help="backtest only (skip the deployable artifact)")
    args = ap.parse_args()

    import gpu

    device = "cpu"
    gpu_idx = None
    if not args.cpu:
        gpu_idx = gpu.acquire(min_free_mb=4096)
        if gpu_idx is not None:
            device = "cuda"
            print(f"[train] pinned gpu{gpu_idx}")
    try:
        return _train_all(args, device)
    finally:
        # A crashed job must never leave a stale lock blocking the slot (quota hygiene).
        gpu.release(gpu_idx)


def _train_all(args, device: str) -> int:
    import contract
    import gpu
    from sklearn.linear_model import Ridge
    from sklearn.preprocessing import StandardScaler

    torch = _torch()
    # `torch.__version__` is a TorchVersion instance (a str subclass). Pickling one
    # embeds a global that `weights_only=True` refuses to load, which would make the
    # sidecar reject every artifact and fall back to naive forever. Store a plain str.
    TORCH_VERSION = str(torch.__version__)
    torch.manual_seed(args.seed)
    t0 = time.perf_counter()

    with gpu.UtilLogger("train") if device == "cuda" else gpu.UtilLogger("train-cpu", interval_s=15):
        series_list, prov = load_series(args.source, args, device)
        X, Y, meta = contract.build_rows(series_list)
        if not len(meta):
            raise SystemExit("no training rows — the panel is too short for the feature contract")
        arrays = aligned_arrays(series_list, meta)
        print(f"[train] {len(meta):,} rows over {len(series_list)} stations (source={args.source})")

        if len(meta) > args.max_rows:
            step = int(np.ceil(len(meta) / args.max_rows))
            keep = np.arange(0, len(meta), step)
            X, Y, meta = X[keep], Y[keep], [meta[i] for i in keep]
            arrays = {k: v[keep] for k, v in arrays.items()}
            print(f"[train] stride-sampled to {len(meta):,} rows (step {step})")

        truth, naive, weekly, mu = arrays["truth"], arrays["naive168"], arrays["weekly4"], arrays["mu"]
        masks = fold_masks(
            meta,
            folds=args.folds,
            backtest_hours=args.backtest_days * 24,
            calib_hours=args.calib_days * 24,
            purge=args.purge_days * 24,
            horizon=contract.HORIZON,
        )
        if not masks:
            raise SystemExit("no usable backtest folds — lengthen --backtest-days or shorten the purge")

        hidden = tuple(args.hidden)
        mlp_points, mlp_lows, mlp_highs, ridge_preds, calib_residuals, fold_rows = [], [], [], [], [], []
        per_source = {}
        interval_level = float(contract.INTERVAL_LEVEL)
        tau = (1.0 - interval_level) / 2.0
        for f in masks:
            tr, ca, te = f["train"], f["calib"], f["test"]
            scaler = StandardScaler().fit(X[tr])
            ridge = Ridge(alpha=1.0).fit(scaler.transform(X[tr]), Y[tr])
            ridge_pred = ridge.predict(scaler.transform(X[te])) * mu[te][:, None]
            mlp, fit_stats = fit_mlp(
                X[tr],
                Y[tr],
                scaler,
                hidden,
                args.seed,
                device,
                args.epochs,
                args.batch,
                args.lr,
                val=(X[ca], Y[ca]),
                patience=args.patience,
            )
            mlp_raw = predict(mlp, X[te], scaler, device) * mu[te][:, None]
            resid_k = truth[ca] - predict(mlp, X[ca], scaler, device) * mu[ca][:, None]
            calib_residuals.append(resid_k)
            # Each fold is calibrated on ITS OWN held-out block, then scored on the
            # test block — the coverage number is out-of-sample, not a self-report.
            conf_k = contract.conformal_table(resid_k)
            point_k, low_k, high_k = contract.conformal_intervals(mlp_raw, conf_k, interval_level)
            mlp_points.append(point_k)
            mlp_lows.append(low_k)
            mlp_highs.append(high_k)
            ridge_preds.append(ridge_pred)
            mm = contract.metrics_kwh(truth[te], point_k)
            mn = contract.metrics_kwh(truth[te], naive[te])
            mw = contract.metrics_kwh(truth[te], weekly[te])
            fold_rows.append(
                {
                    "fold": f["fold"],
                    "rows": int(te.sum()),
                    "mlp_mae_kwh": round(mm["mae"], 4),
                    "ridge_mae_kwh": round(contract.metrics_kwh(truth[te], ridge_pred)["mae"], 4),
                    "naive168_mae_kwh": round(mn["mae"], 4),
                    "weekly4_mae_kwh": round(mw["mae"], 4),
                    "skill_vs_naive_pct": round(100.0 * (1.0 - mm["mae"] / max(mn["mae"], 1e-9)), 2),
                    "interval_coverage": round(contract.coverage(truth[te], low_k, high_k), 4),
                    "fit": fit_stats,
                }
            )
            src_of = np.asarray([series_list[meta[i][0]].source for i in np.nonzero(te)[0]])
            for s in set(src_of.tolist()):
                sel = src_of == s
                d = per_source.setdefault(s, {"truth": [], "pred": [], "naive": []})
                d["truth"].append(truth[te][sel])
                d["pred"].append(point_k[sel])
                d["naive"].append(naive[te][sel])

        te_idx = np.concatenate([np.nonzero(f["test"])[0] for f in masks])
        tr_t, na_n, wk_w = truth[te_idx], naive[te_idx], weekly[te_idx]
        mlp_all = np.concatenate(mlp_points)
        low_all, high_all = np.concatenate(mlp_lows), np.concatenate(mlp_highs)
        pooled = {
            "mlp": summarize(tr_t, mlp_all, na_n, wk_w),
            "ridge": summarize(tr_t, np.concatenate(ridge_preds), na_n, wk_w),
        }
        naive_mae = float(np.mean(np.abs(tr_t - na_n)))
        weekly_mae = float(np.mean(np.abs(tr_t - wk_w)))
        # The shipped table is fitted on the union of every calibration block; the
        # coverage number above is per-fold, so it cannot flatter this choice.
        conf = contract.conformal_table(np.concatenate(calib_residuals))
        cov = contract.coverage(tr_t, low_all, high_all)
        receipt_intervals = {
            "method": conf["method"],
            "nominal_coverage": interval_level,
            "empirical_coverage": round(cov, 4),
            "coverage_error": round(cov - interval_level, 4),
            "per_fold_coverage": [f["interval_coverage"] for f in fold_rows],
            "n_calibration_points": int(np.concatenate(calib_residuals).size),
            "pinball_low": round(contract.pinball(tr_t, low_all, tau), 4),
            "pinball_high": round(contract.pinball(tr_t, high_all, 1.0 - tau), 4),
            "mean_width_kwh": round(float(np.mean(high_all - low_all)), 4),
        }
        per_horizon = [round(float(np.mean(np.abs(tr_t[:, j] - mlp_all[:, j]))), 4) for j in range(contract.HORIZON)]
        per_source_summary = {
            s: {
                "mae_kwh": round(float(np.mean(np.abs(np.concatenate(d["truth"]) - np.concatenate(d["pred"])))), 4),
                "naive_mae_kwh": round(float(np.mean(np.abs(np.concatenate(d["truth"]) - np.concatenate(d["naive"])))), 4),
                "points": int(np.concatenate(d["truth"]).size),
            }
            for s, d in per_source.items()
        }

        # ---- final deployable fit: every row, same contract ----
        final = None
        if not args.no_final_fit:
            scaler = StandardScaler().fit(X)
            model, final_stats = fit_mlp(
                X, Y, scaler, hidden, args.seed, device, args.epochs, args.batch, args.lr, patience=args.patience
            )
            final = (scaler, model, final_stats)

    train_s = time.perf_counter() - t0
    model_key = "mlp_{}x{}".format(*args.hidden)
    receipt = {
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "device": device,
        "torch": TORCH_VERSION,
        "feature_version": contract.FEATURE_VERSION,
        "input_dim": int(X.shape[1]),
        "data": prov,
        "panel": {
            "stations": len(series_list),
            "rows": int(len(meta)),
            "station_hours": int(sum(s.hours for s in series_list)),
            "sources": sorted({s.source for s in series_list}),
        },
        "backtest": {
            "protocol": "rolling-origin, per-series recency, purge + calibration block before each test fold",
            "folds": len(masks),
            "fold_hours": masks[0]["fold_hours"],
            "backtest_days": args.backtest_days,
            "calib_days": args.calib_days,
            "purge_days": args.purge_days,
            "test_points": int(tr_t.size),
            "per_fold": fold_rows,
            "per_source": per_source_summary,
            "per_horizon_mae_kwh": per_horizon,
            "leakage_note": (
                "Within a station, no training target window overlaps its fold's test window (purge enforced). "
                "Cross-station pooling keeps other stations' rows in train — intentional, this is one shared "
                "model, and it is exactly how the sidecar is deployed."
            ),
        },
        "models": {
            model_key: pooled["mlp"],
            "ridge": pooled["ridge"],
            "seasonal_naive_168h": {
                "mae_kwh": round(naive_mae, 4),
                "rmse_kwh": round(float(np.sqrt(np.mean((tr_t - na_n) ** 2))), 4),
                "points": int(tr_t.size),
                "mase_vs_naive168": 1.0,
            },
            "weekly_same_hour_mean": {
                "mae_kwh": round(weekly_mae, 4),
                "rmse_kwh": round(float(np.sqrt(np.mean((tr_t - wk_w) ** 2))), 4),
                "points": int(tr_t.size),
            },
        },
        "intervals": receipt_intervals,
        "train_seconds": round(train_s, 2),
        "beats_naive": bool(pooled["mlp"]["mae_kwh"] < round(naive_mae, 4)),
        "beats_weekly_mean": bool(pooled["mlp"]["mae_kwh"] < round(weekly_mae, 4)),
    }

    REPORTS.mkdir(parents=True, exist_ok=True)
    (REPORTS / "metrics.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")

    if final is not None:
        scaler, model, final_stats = final
        payload = {
            "format": contract.ARTIFACT_FORMAT,
            "feature_version": contract.FEATURE_VERSION,
            "trained_at": receipt["trained_at"],
            "spec": {
                "lags": list(contract.LAGS),
                "horizon": contract.HORIZON,
                "input_dim": int(X.shape[1]),
                "feature_names": list(contract.FEATURE_NAMES),
                "hidden": list(args.hidden),
                "target": "station-relative hourly kWh (value / mean of the origin's trailing 168 h)",
                "seed": args.seed,
                "torch": TORCH_VERSION,
                "data_source": prov,
            },
            "state_dict": {k: v.detach().cpu() for k, v in model.state_dict().items()},
            "scaler_mean": [float(v) for v in scaler.mean_],
            "scaler_scale": [float(v) for v in scaler.scale_],
            "conformal": conf,
            "interval_level": interval_level,
            "receipt": {k: v for k, v in receipt.items() if k != "data"},
        }
        payload["payload_sha256"] = contract.payload_hash(payload)
        torch.save(payload, REPORTS / "model.pt")
        digest = contract.file_sha256(REPORTS / "model.pt")
        (REPORTS / "model.pt.sha256").write_text(digest + "\n", encoding="utf-8")
        parity = verify_artifact(REPORTS / "model.pt", X, scaler, model)
        receipt["artifact"] = {
            "path": "apps/ai/reports/model.pt",
            "file_sha256": digest,
            "serving_parity": parity,
            "payload_sha256": payload["payload_sha256"],
        }
        (REPORTS / "metrics.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")

    m = receipt["models"][model_key]
    steps = sum(f["fit"]["optimizer_steps"] for f in fold_rows)
    print(f"\n[train] device={device} rows={len(meta):,} folds={receipt['backtest']['folds']} "
          f"steps/fold={steps:,} in {train_s:.1f}s")
    print(f"[train] seasonal-naive MAE={receipt['models']['seasonal_naive_168h']['mae_kwh']} kWh")
    print(f"[train] weekly-mean    MAE={receipt['models']['weekly_same_hour_mean']['mae_kwh']} kWh")
    print(f"[train] ridge          MAE={receipt['models']['ridge']['mae_kwh']} kWh "
          f"(skill {receipt['models']['ridge']['skill_vs_naive_pct']}%)")
    print(f"[train] {model_key} MAE={m['mae_kwh']} kWh (skill {m['skill_vs_naive_pct']}% vs naive, "
          f"{m['skill_vs_weekly4_pct']}% vs weekly mean, MASE {m['mase_vs_naive168']})")
    print(f"[train] conformal coverage={receipt['intervals']['empirical_coverage']} "
          f"(nominal {receipt['intervals']['nominal_coverage']}), "
          f"width={receipt['intervals']['mean_width_kwh']} kWh")
    print(f"[train] beats naive: {receipt['beats_naive']} | beats weekly mean: {receipt['beats_weekly_mean']}")
    print("[train] receipt -> apps/ai/reports/metrics.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
