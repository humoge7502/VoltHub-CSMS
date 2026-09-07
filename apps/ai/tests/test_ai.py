# VoltHub AI — pytest suite. CPU tests run anywhere (CI-safe); CUDA tests skip
# cleanly when no GPU is pinned. Run: python3 -m pytest apps/ai/tests -q
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))


def test_simulate_shapes_and_determinism():
    from simulate import simulate_demand

    a = simulate_demand(n_stations=3, days=2, vehicles=40, seed=11, device="cpu")
    b = simulate_demand(n_stations=3, days=2, vehicles=40, seed=11, device="cpu")
    assert a["hourly"].shape == (3, 48)
    assert a["sessions"].shape == (3, 48)
    assert a["meta"]["total_sessions"] == b["meta"]["total_sessions"]
    assert (a["hourly"] - b["hourly"]).abs().max().item() == 0.0, "same seed+device must be reproducible"
    assert a["hourly"].sum().item() > 0, "fleet demand must be positive"


def test_simulate_seed_changes_outcome():
    from simulate import simulate_demand

    a = simulate_demand(n_stations=3, days=2, vehicles=40, seed=11, device="cpu")
    b = simulate_demand(n_stations=3, days=2, vehicles=40, seed=12, device="cpu")
    assert a["meta"]["total_sessions"] != b["meta"]["total_sessions"] or a["meta"]["total_kwh"] != b["meta"]["total_kwh"]


def test_optimizer_respects_hard_constraints():
    from fastapi.testclient import TestClient

    import service

    app = service.app
    with TestClient(app, raise_server_exceptions=True) as client:
        H = app  # noqa: F841
        r = client.post(
            "/v1/optimize",
            json={
                "station_id": 1,
                "window_hours": 12,
                "station_power_cap_kw": 60.0,
                "price_per_kwh": [10, 9, 8, 6, 5, 5, 6, 7, 8, 9, 10, 11],
                "vehicles": [
                    {"id": "v1", "arrive": 0, "deadline": 6, "energy_kwh": 40, "max_kw": 22},
                    {"id": "v2", "arrive": 2, "deadline": 10, "energy_kwh": 50, "max_kw": 11},
                ],
            },
            headers={"x-internal": "dev-internal"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["feasible"] is True
        assert body["advisory"] is True
        # Hard constraint 1: per-hour station cap.
        for h, kwh in enumerate(body["station_hour_kwh"]):
            assert kwh <= 60.0 + 1e-6, f"hour {h} exceeds station cap: {kwh}"
        # Hard constraint 2: every vehicle receives its required energy inside its window.
        req = {"v1": 40.0, "v2": 50.0}
        for vid, delivered in body["delivered_kwh"].items():
            assert delivered >= req[vid] - 1e-3, f"{vid} under-charged: {delivered} < {req[vid]}"
        # Hard constraint 3: per-vehicle connector rate (kWh in one hour <= max_kw).
        sched = body["schedule_kwh"]
        caps = {"v1": 22.0, "v2": 11.0}
        for vid, hours in sched.items():
            for kwh in hours:
                assert kwh <= caps[vid] + 1e-6
        # Optimality sanity: cheapest hours fill first (prices at h3..h5 = 6,5,5; v1 max 22 →
        # h4 takes the full 22, h5 takes the remaining 18).
        assert sched["v1"][4] > 0 and sched["v1"][5] > 0


def test_optimizer_infeasible_reports_honestly():
    from fastapi.testclient import TestClient

    import service

    with TestClient(service.app) as client:
        r = client.post(
            "/v1/optimize",
            json={
                "station_id": 1,
                "window_hours": 2,
                "station_power_cap_kw": 5.0,
                "price_per_kwh": [1, 1],
                "vehicles": [{"id": "v1", "arrive": 0, "deadline": 2, "energy_kwh": 500, "max_kw": 22}],
            },
            headers={"x-internal": "dev-internal"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["feasible"] is False, "impossible demand must be reported, never silently truncated"


def test_anomaly_zscore_flags_meter_spike():
    from fastapi.testclient import TestClient

    import service

    with TestClient(service.app) as client:
        ticks = [{"session_id": 1, "ts": f"2026-09-07T00:{i:02d}:00Z", "meter_kwh": 1.0 * i, "power_kw": 11.0} for i in range(20)]
        ticks.append({"session_id": 1, "ts": "2026-09-07T00:20:00Z", "meter_kwh": 1.0 * 19 + 40, "power_kw": 11.0})
        r = client.post("/v1/anomalies", json={"ticks": ticks}, headers={"x-internal": "dev-internal"})
        assert r.status_code == 200
        body = r.json()
        assert body["checked"] == 21
        assert any("z=" in reason for f in body["flagged"] for reason in f["reasons"]), "the 40 kWh spike must flag"


def test_auth_requires_internal_token():
    from fastapi.testclient import TestClient

    import service

    with TestClient(service.app) as client:
        assert client.get("/health").status_code == 401
        assert client.get("/health", headers={"x-internal": "wrong"}).status_code == 401
        assert client.get("/health", headers={"x-internal": "dev-internal"}).status_code == 200
        assert client.get("/health", headers={"x-internal": "dev-internal"}).json()["advisory_only"] is True


def test_forecast_honest_degradation(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    import service

    with TestClient(service.app) as client:
        r = client.post(
            "/v1/forecast",
            json={"station_ids": [1], "hours": 6},
            headers={"x-internal": "dev-internal"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["advisory"] is True
        assert body["model_loaded"] in (True, False)
        st = body["stations"]["1"]
        assert len(st["hours"]) == 6
        # Honesty contract: when no trained artifact exists, the note says so and names
        # the training command; with a loaded model, the note is None.
        if not body["model_loaded"]:
            assert "train.py" in (body["note"] or ""), "missing artifact must be stated, never hidden"
            assert st["model"] == "seasonal-naive-fallback"
        else:
            assert body["note"] is None
            # short history (< max lag) must still fall back per station
            assert st["model"] in ("mlp_128x64", "seasonal-naive-fallback")


def test_gpu_allocator_parsing():
    import gpu

    sample = "\n".join(
        [
            "0, 21838, 81920, 49",
            "1, 1815, 81920, 47",
            "3, 45825, 81920, 59",
        ]
    )
    gpus = gpu.list_gpus(sample)
    assert [g["index"] for g in gpus] == [0, 1, 3]
    assert gpus[1]["mem_used_mb"] == 1815
    pick = gpu.pick_gpu(min_free_mb=4096, smi_output=sample)
    assert pick == 1, "least-memory-used GPU with enough free memory must win"
    assert gpu.pick_gpu(min_free_mb=85000, smi_output=sample) is None, "impossible ask must return None (CPU fallback)"


@pytest.mark.skipif(not os.environ.get("AI_TEST_GPU"), reason="GPU smoke runs are opt-in (AI_TEST_GPU=1)")
def test_gpu_simulation_smoke():
    import torch

    assert torch.cuda.is_available()
    from simulate import simulate_demand

    out = simulate_demand(n_stations=2, days=1, vehicles=10, device="cuda")
    assert out["meta"]["device"] == "cuda"
    assert out["hourly"].shape == (2, 24)
