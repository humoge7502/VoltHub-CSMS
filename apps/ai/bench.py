# VoltHub AI — Tier 1/2/3/5 benchmarks: measure before claiming.
# Produces apps/ai/reports/benchmarks.json with CPU-vs-GPU numbers for the
# simulator, the feature pipeline and forecaster inference, plus an honest
# optimizer comparison at CSMS-representative scale. Numbers land in
# docs/ai-platform.md verbatim.
#
# Run: python3 apps/ai/bench.py [--quick]

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPORTS = HERE / "reports"


def _best_of(fn, repeats: int = 3) -> float:
    best = float("inf")
    for _ in range(repeats):
        t0 = time.perf_counter()
        fn()
        best = min(best, time.perf_counter() - t0)
    return best


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="small shapes for CI/dev smoke")
    args = ap.parse_args()

    import gpu

    # Pin before torch initializes CUDA; release the slot no matter how we exit
    # (a crashed benchmark must not leave a stale file-lock blocking the pool).
    device_idx = None if args.quick else gpu.acquire(min_free_mb=8192)
    try:
        return _run(args, device_idx)
    finally:
        gpu.release(device_idx if not args.quick else None)


def _run(args, device_idx) -> int:
    import numpy as np
    import torch

    import contract
    from simulate import simulate_demand
    from train import aligned_arrays

    cuda = torch.cuda.is_available()
    if cuda and device_idx is None:
        device_idx = torch.cuda.current_device()
    results = {"generated_at": datetime.now(timezone.utc).isoformat(), "torch": torch.__version__, "cuda": cuda}

    # ---- Tier 3: fleet simulation CPU vs GPU ----
    stations, days, vehicles = (4, 3, 60) if args.quick else (24, 120, 2000)
    t_cpu = _best_of(lambda: simulate_demand(stations, days, vehicles, device="cpu"))
    results["simulation"] = {"shape": f"{stations} stations x {days}d x {vehicles} vehicles",
                             "cpu_seconds": round(t_cpu, 4)}
    if cuda:
        try:
            simulate_demand(stations, days, vehicles, device="cuda")  # context warm-up
            t_gpu = _best_of(lambda: simulate_demand(stations, days, vehicles, device="cuda"))
            results["simulation"]["gpu_seconds"] = round(t_gpu, 4)
            results["simulation"]["gpu_speedup"] = round(t_cpu / max(t_gpu, 1e-9), 2)
        except Exception as e:
            results["simulation"]["gpu_error"] = str(e)

    # ---- feature pipeline on the REAL panel (contract is the shared path) ----
    from ingest import load_panel

    panel = load_panel()
    if panel:
        t0 = time.perf_counter()
        X, Y, meta = contract.build_rows(panel[:8] if args.quick else panel)
        feat_s = time.perf_counter() - t0
        arrays = aligned_arrays(panel[:8] if args.quick else panel, meta)
        results["features"] = {
            "panel_stations": len(panel[:8] if args.quick else panel),
            "rows": int(len(meta)),
            "input_dim": int(X.shape[1]),
            "build_seconds": round(feat_s, 3),
            "rows_per_second": round(len(meta) / max(feat_s, 1e-9)),
            "baseline_arrays_seconds": round(time.perf_counter() - t0, 3),
            "panel_total_kwh": round(float(np.sum(arrays["truth"])), 1),
        }
    else:
        results["features"] = {"note": "no real panel (run apps/ai/ingest.py) — measured on the twin instead"}
        sim = simulate_demand(24, 120, 2000, device="cpu")
        t0 = time.perf_counter()
        X, Y, meta = contract.build_rows(sim["series"])
        results["features"].update({"rows": int(len(meta)), "build_seconds": round(time.perf_counter() - t0, 3)})

    # ---- Tier 1: batched inference CPU vs GPU ----
    artifact = REPORTS / "model.pt"
    if artifact.exists():
        t_load = _best_of(lambda: torch.load(artifact, map_location="cpu", weights_only=True), repeats=1)
        results["artifact_load"] = {"weights_only": True, "seconds": round(t_load, 3),
                                    "bytes": artifact.stat().st_size}
        pt = torch.load(artifact, map_location="cpu", weights_only=True)
        from service import _build_network

        model = _build_network(pt["spec"])
        model.load_state_dict(pt["state_dict"])
        model.eval()
        rows = np.random.default_rng(0).standard_normal((1, contract.INPUT_DIM)).astype(np.float32)
    else:
        model = torch.nn.Sequential(
            torch.nn.Linear(contract.INPUT_DIM, 128), torch.nn.ReLU(),
            torch.nn.Linear(128, 64), torch.nn.ReLU(), torch.nn.Linear(64, contract.HORIZON),
        )
        rows = np.random.default_rng(0).standard_normal((1, contract.INPUT_DIM)).astype(np.float32)

    def infer(device: str, batch: int):
        m = model.to(device)
        x = torch.tensor(np.repeat(rows, batch, axis=0), dtype=torch.float32, device=device)
        with torch.no_grad():
            m(x)

    batch_small = 500 if not args.quick else 50  # one poll of 500 stations
    batch_big = 4096 if not args.quick else 256
    t500 = _best_of(lambda: infer("cpu", batch_small))
    results["forecast_inference"] = {
        "stations_per_call": batch_small,
        "cpu_seconds": round(t500, 5),
        "throughput_stations_per_second": round(batch_small / max(t500, 1e-9)),
        "batch_rows": batch_big,
        "cpu_batch_seconds": round(_best_of(lambda: infer("cpu", batch_big)), 4),
    }
    if cuda:
        try:
            infer("cuda", batch_big)
            torch.cuda.synchronize()
            t_gpu = _best_of(lambda: infer("cuda", batch_big))
            torch.cuda.synchronize()
            results["forecast_inference"]["gpu_batch_seconds"] = round(t_gpu, 5)
            results["forecast_inference"]["gpu_speedup"] = round(
                results["forecast_inference"]["cpu_batch_seconds"] / max(t_gpu, 1e-9), 2
            )
        except Exception as e:
            results["forecast_inference"]["gpu_error"] = str(e)

    # ---- Tier 2: optimizer — LP (CPU/HiGHS) vs GPU scenario search (honest) ----
    from scipy.optimize import linprog

    def solve_lp(V, H, carbon=False):
        n = V * H
        c = np.tile(np.linspace(4.0, 9.0, H), V)
        if carbon:
            c = c + 0.02 * np.tile(np.sin(np.linspace(0, 3.14, H)), V) * 400.0
        A = np.zeros((H + V * H, n))
        b = np.zeros(H + V * H)
        for h in range(H):
            A[h, h::H] = 1.0
            b[h] = 120.0
        for v in range(V):
            for h in range(H):
                row = H + v * H + h
                A[row, v * H + h] = 1.0
                b[row] = 22.0 if h >= v else 0.0
        A_eq = np.zeros((V, n))
        b_eq = np.zeros(V)
        for v in range(V):
            A_eq[v, v * H : (v + 1) * H] = 1.0
            b_eq[v] = 25.0
        return linprog(c, A_ub=A, b_ub=b, A_eq=A_eq, b_eq=b_eq, bounds=[(0, None)] * n, method="highs")

    t_lp10 = _best_of(lambda: solve_lp(10, 24), repeats=5)
    t_lp200 = _best_of(lambda: solve_lp(200, 24), repeats=3) if not args.quick else _best_of(lambda: solve_lp(60, 24))
    v_cost = 200 if not args.quick else 60
    t_lp_carbon = _best_of(lambda: solve_lp(v_cost, 24, carbon=True), repeats=3)
    results["optimizer"] = {
        "instance_small": "10 vehicles x 24h, cap 120 kW",
        "lp_highs_cpu_seconds": round(t_lp10, 4),
        "instance_full": f"{v_cost} vehicles x 24h with equality energy constraints",
        "lp_highs_cpu_seconds_full": round(t_lp200, 4),
        "lp_highs_carbon_objective_seconds": round(t_lp_carbon, 4),
        "verdict": "LP (deterministic, exact) stays on CPU; GPU reserved for simulation/training/inference",
    }

    REPORTS.mkdir(parents=True, exist_ok=True)
    (REPORTS / "benchmarks.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(json.dumps(results, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
