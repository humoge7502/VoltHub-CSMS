# VoltHub AI — Tier 3 (simulation): GPU-batched EV fleet demand simulator.
# Generates reproducible station-level hourly demand used for (a) forecaster
# training data, (b) CPU-vs-GPU benchmarking, (c) what-if scenario evaluation.
# Vectorized in torch so the same code runs on CPU (numpy-class perf) and CUDA
# (batched fleet dynamics). Deterministic under a fixed seed on a fixed device.

from __future__ import annotations

import math
from datetime import datetime, timezone

import torch

HOURS_PER_DAY = 24

# The synthetic panel is anchored to a real Monday midnight in UTC so that the
# weekday/weekend structure the simulator generates is the same structure the
# forecaster's calendar features read (contract.Series derives day-of-week from
# the timestamp, never from an array index).
DEFAULT_START = datetime(2026, 8, 3, 0, 0, tzinfo=timezone.utc)

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
    start: datetime | None = None,
) -> dict:
    """Simulate `days` of fleet charging across `n_stations`.

    Returns {"hourly": (n_stations, days*24) kWh delivered per station-hour,
             "sessions": (n_stations, days*24) session starts per station-hour,
             "timestamps": days*24 hourly UTC stamps,
             "series": [contract.Series, ...] for the forecaster pipeline}.
    Same seed+device => same numbers; CPU and CUDA agree only statistically
    (Poisson sampling differs across backends), which is fine for training data.

    The world is deliberately harder than the v1 twin: alongside the diurnal
    profile it now also generates a slow fleet-growth trend, per-station
    availability outages (multi-hour dead blocks) and a handful of extreme
    weather days. A forecaster that only memorises the average day loses badly
    on that, so `beats_naive` means something.
    """
    dev = torch.device(device)
    if dev.type == "cuda" and not torch.cuda.is_available():
        dev = torch.device("cpu")
    g = torch.Generator(device=dev.type)
    g.manual_seed(seed)

    anchor = (start or DEFAULT_START)
    if anchor.tzinfo is None:
        anchor = anchor.replace(tzinfo=timezone.utc)

    hours = days * HOURS_PER_DAY
    profile = _profile_tensor(dev)
    # Station heterogeneity: lognormal weights + per-station weekend skew.
    weights = torch.empty(n_stations, device=dev).log_normal_(mean=0.0, std=0.6, generator=g)
    weights = weights / weights.sum()

    sessions = torch.zeros(n_stations, hours, device=dev)

    # Per-hour arrival rates: base fleet pressure x profile x weekday/weekend skew.
    hour_idx = torch.arange(hours, device=dev) % HOURS_PER_DAY
    dow = (torch.arange(hours, device=dev) // HOURS_PER_DAY) % 7
    weekend = ((dow == 5) | (dow == 6)).float()
    day_factor = torch.where(weekend == 1, torch.tensor(0.8, device=dev), torch.tensor(1.0, device=dev))
    # Fleet growth: the panel spans a ramp-up, so a stationary model drifts.
    trend = torch.linspace(1.0, 1.25, hours, device=dev)
    rate = (
        torch.tensor(vehicles / 10.0, device=dev)  # ~10% of the fleet plugs in per day
        * profile[hour_idx]
        * day_factor
        * trend
    )  # (hours,)

    # Poisson arrivals per station-hour: outer(rate, weights) scaled.
    lam = torch.outer(rate, weights)  # (hours, stations)
    arrivals = torch.poisson(lam, generator=g)  # sessions started
    sessions = arrivals.T.contiguous()  # (stations, hours)

    # Energy per session: lognormal around 25 kWh (60 kWh pack, 20-80% SoC window),
    # clipped to [5, 75]. Same count of samples as total sessions.
    total = int(sessions.sum().item())
    hourly = torch.zeros(n_stations, hours, device=dev)
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
        energy_per_cell = torch.zeros(flat.numel(), device=dev)
        energy_per_cell.index_add_(0, cell, energy)
        hourly = energy_per_cell.view(n_stations, hours)

    # Availability outages: a few multi-hour dead blocks per station (connector
    # faults, site maintenance). Zero is a real value here, not missing data.
    n_outages = max(1, days // 7)
    for s in range(n_stations):
        for _ in range(n_outages):
            pick = int(torch.randint(0, hours, (1,), generator=g, device=dev).item())
            length = int(torch.randint(3, 13, (1,), generator=g, device=dev).item())
            hourly[s, pick : min(pick + length, hours)] = 0.0

    # Extreme-weather days: heat/cold spikes push fleet-wide load up for 24-48 h.
    n_events = max(1, days // 10)
    for _ in range(n_events):
        pick = int(torch.randint(0, max(1, hours - 48), (1,), generator=g, device=dev).item())
        span = int(torch.randint(24, 48, (1,), generator=g, device=dev).item())
        boost = 1.0 + float(torch.rand(1, generator=g, device=dev).item()) * 0.8
        hourly[:, pick : pick + span] *= boost

    timestamps = [anchor.replace(tzinfo=timezone.utc).timestamp() + i * 3600 for i in range(hours)]
    timestamps = [datetime.fromtimestamp(ts, tz=timezone.utc) for ts in timestamps]

    out = {
        "hourly": hourly.cpu(),
        "sessions": sessions.cpu(),
        "timestamps": timestamps,
        "meta": {
            "n_stations": n_stations,
            "days": days,
            "vehicles": vehicles,
            "seed": seed,
            "device": dev.type,
            "total_sessions": total,
            "total_kwh": float(hourly.sum().item()),
            "start": anchor.isoformat(),
            "generator": "volthub-twin-v2 (diurnal + trend + outages + weather events)",
        },
    }
    out["series"] = synthetic_series(out)
    return out


def synthetic_series(sim: dict) -> list:
    """Expose a simulation run as contract.Series objects (one per station)."""
    from contract import Series

    hourly = sim["hourly"].numpy()
    start = sim["timestamps"][0]
    return [
        Series(label=f"sim-{s}", source="synthetic-twin", start=start, values=hourly[s].astype("float32"))
        for s in range(hourly.shape[0])
    ]


if __name__ == "__main__":
    out = simulate_demand(n_stations=4, days=3, vehicles=50)
    m = out["meta"]
    print(
        f"sim ok: {m['n_stations']}x{m['days']*24}h, sessions={m['total_sessions']}, kWh={m['total_kwh']:.0f} on {m['device']}"
    )
