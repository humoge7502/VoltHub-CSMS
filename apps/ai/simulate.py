# VoltHub AI — Tier 3 (simulation): GPU-batched EV fleet demand simulator.
# Generates reproducible station-level hourly demand used for (a) forecaster
# training data, (b) CPU-vs-GPU benchmarking, (c) what-if scenario evaluation.
# Vectorized in torch so the same code runs on CPU (numpy-class perf) and CUDA
# (batched fleet dynamics). Deterministic under a fixed seed on a fixed device.

from __future__ import annotations

import math

import torch

HOURS_PER_DAY = 24

# Diurnal arrival profile (relative demand per hour) — twin-peak commuter shape.
_ARRIVAL_PROFILE = [
    0.30, 0.22, 0.18, 0.15, 0.18, 0.35, 0.65, 1.00, 1.30, 1.10, 0.90, 0.85,
    0.95, 1.00, 0.95, 0.90, 1.05, 1.35, 1.60, 1.45, 1.10, 0.85, 0.60, 0.40,
]


def _profile_tensor(device: torch.device) -> torch.Tensor:
    return torch.tensor(_ARRIVAL_PROFILE, dtype=torch.float32, device=device)


def simulate_demand(
    n_stations: int = 24,
    days: int = 28,
    vehicles: int = 2000,
    seed: int = 7,
    device: str = "cpu",
) -> dict:
    """Simulate `days` of fleet charging across `n_stations`.

    Returns {"hourly": (n_stations, days*24) kWh delivered per station-hour,
             "sessions": (n_stations, days*24) session starts per station-hour}.
    Same seed+device => same numbers; CPU and CUDA agree only statistically
    (Poisson sampling differs across backends), which is fine for training data.
    """
    dev = torch.device(device)
    if dev.type == "cuda" and not torch.cuda.is_available():
        dev = torch.device("cpu")
    g = torch.Generator(device=dev.type)
    g.manual_seed(seed)

    hours = days * HOURS_PER_DAY
    profile = _profile_tensor(dev)
    # Station heterogeneity: lognormal weights + per-station weekend skew.
    weights = torch.empty(n_stations, device=dev).log_normal_(mean=0.0, std=0.6, generator=g)
    weights = weights / weights.sum()

    hourly = torch.zeros(n_stations, hours, device=dev)
    sessions = torch.zeros(n_stations, hours, device=dev)

    # Per-hour arrival rates: base fleet pressure x profile x weekday/weekend skew.
    hour_idx = torch.arange(hours, device=dev) % HOURS_PER_DAY
    dow = (torch.arange(hours, device=dev) // HOURS_PER_DAY) % 7
    weekend = ((dow == 5) | (dow == 6)).float()
    day_factor = torch.where(weekend == 1, torch.tensor(0.8, device=dev), torch.tensor(1.0, device=dev))
    rate = (
        torch.tensor(vehicles / 10.0, device=dev)  # ~10% of the fleet plugs in per day
        * profile[hour_idx]
        * day_factor
    )  # (hours,)

    # Poisson arrivals per station-hour: outer(rate, weights) scaled.
    lam = torch.outer(rate, weights)  # (hours, stations)
    arrivals = torch.poisson(lam, generator=g)  # sessions started
    sessions = arrivals.T.contiguous()  # (stations, hours)

    # Energy per session: lognormal around 25 kWh (60 kWh pack, 20-80% SoC window),
    # clipped to [5, 75]. Same count of samples as total sessions.
    total = int(sessions.sum().item())
    if total > 0:
        # Energy per session: lognormal around 25 kWh (60 kWh pack, 20-80% SoC window),
        # clipped to [5, 75]. log_normal_ is the in-place functional form (torch 2.x
        # renamed lognormal_) and accepts the seeded generator.
        energy = torch.empty(total, device=dev).log_normal_(
            mean=math.log(25.0), std=0.35, generator=g
        )
        energy = energy.clamp(5.0, 75.0)
        # Scatter energy back to (station, hour) cells.
        flat = sessions.flatten()
        cell = torch.repeat_interleave(torch.arange(flat.numel(), device=dev), flat.long())
        station_of = (cell // hours).long()
        energy_per_cell = torch.zeros(flat.numel(), device=dev)
        energy_per_cell.index_add_(0, cell, energy)
        hourly = energy_per_cell.view(n_stations, hours)

    return {
        "hourly": hourly.cpu(),
        "sessions": sessions.cpu(),
        "meta": {
            "n_stations": n_stations,
            "days": days,
            "vehicles": vehicles,
            "seed": seed,
            "device": dev.type,
            "total_sessions": total,
            "total_kwh": float(hourly.sum().item()),
        },
    }


if __name__ == "__main__":
    out = simulate_demand(n_stations=4, days=3, vehicles=50)
    m = out["meta"]
    print(
        f"sim ok: {m['n_stations']}x{m['days']*24}h, sessions={m['total_sessions']}, kWh={m['total_kwh']:.0f} on {m['device']}"
    )
