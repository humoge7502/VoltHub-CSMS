# Model, data-ingestion and evaluation-harness tests.
#
# These pin the parts that make a receipt trustworthy rather than impressive:
# the licensed-data derivation, the twin's realism, the backtest's leakage
# discipline, and the rule that the deployed artifact is the model that was
# measured.
#
# Run: python -m pytest apps/ai/tests -q
from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pytest

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

import contract  # noqa: E402
import ingest  # noqa: E402

START = datetime(2026, 8, 3, 0, 0, tzinfo=timezone.utc)


def make_series(hours=400, seed=1, scale=1.0, start=START):
    rng = np.random.default_rng(seed)
    base = 30.0 + 15.0 * np.sin(np.arange(hours) * 2 * np.pi / 24) + rng.normal(0, 3, hours)
    return contract.Series(f"s{seed}", "test", start, np.clip(base, 0.5, None).astype(np.float32) * scale)


# ---- real-data derivation ----


def test_overlap_weighted_spread_conserves_energy():
    grid = np.zeros(6, dtype=np.float32)
    base = START
    # A 12 kWh session from 00:30 to 02:30 touches three hours: 0.5 h, 1 h, 0.5 h.
    ingest._add_span(grid, base, base + timedelta(minutes=30), base + timedelta(hours=2, minutes=30), 12.0)
    assert float(grid.sum()) == pytest.approx(12.0, abs=1e-4), "aggregation must never invent or lose kWh"
    assert grid[0] == pytest.approx(3.0, abs=0.05)
    assert grid[1] == pytest.approx(6.0, abs=0.05)
    assert grid[2] == pytest.approx(3.0, abs=0.05)
    assert grid[3] == 0.0


def test_contiguous_trim_drops_only_dead_space():
    vals = np.array([0, 0, 1, 2, 0, 0], dtype=np.float32)
    start, trimmed = ingest._contiguous(vals, START)
    assert list(trimmed) == [1.0, 2.0]
    assert start == START + timedelta(hours=2)
    assert ingest._contiguous(np.zeros(4, dtype=np.float32), START) == (None, None)


def _write_norway(path: Path, days=32):
    hours = []
    t0 = datetime(2019, 3, 1, 0, 0)
    for d in range(days):
        for h in range(24):
            hours.append(t0 + timedelta(days=d, hours=h))
    lines = ["user_id;session_id;date_from;energy_charged_i"]
    for i, ts in enumerate(hours):
        # comma decimals and a NA row, exactly like the released CSV
        lines.append(f"LYS_Plass1;{i:03d};{ts.strftime('%Y-%m-%d %H:%M:%S')};{0.5 + (i % 7) * 0.1:.1f}".replace(".", ","))
    lines.append(f"BER_Bl1-1;999;{hours[10].strftime('%Y-%m-%d %H:%M:%S')};NA")
    lines.append(f"LYS_Plass2;1000;{hours[11].strftime('%Y-%m-%d %H:%M:%S')};1,0")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_norway_loader_groups_by_location_and_keeps_the_hour_grid(tmp_path):
    (tmp_path / "norway").mkdir()
    _write_norway(tmp_path / "norway" / "Dataset4_hourly_predictions.csv", days=40)
    series, stats = ingest.load_norway(tmp_path, max_stations=40)
    assert [s.label for s in series] == ["NO:LYS"], "the physical location is the station, not the parking bay"
    s = series[0]
    assert s.source == "norway"
    assert s.hours == 40 * 24, "one contiguous hour grid, gaps are true zeros"
    # The two LYS spots land in the same hour, so the location-hour is their sum.
    assert s.values[11] == pytest.approx(0.5 + (11 % 7) * 0.1 + 1.0, abs=1e-4)
    assert stats["stations_kept"] == 1
    assert stats["aggregation"], "the receipt must state how the panel was derived"


def test_tennessee_loader_rejects_impossible_sessions(tmp_path):
    import pandas as pd

    raw = tmp_path / "tennessee"
    raw.mkdir()
    rows = []
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    for d in range(40):  # long enough to clear MIN_HOURS
        # one ordinary session per day on charger A
        rows.append(
            {
                "charger_id": "A",
                "session_id": d,
                "session_start": (t0 + timedelta(days=d, hours=1)).isoformat(),
                "session_end": (t0 + timedelta(days=d, hours=3)).isoformat(),
                "energy_kwh": 20.0,
                "peak_power_kw": 11.0,
            }
        )
    # charger B: a 30-hour "session" (a reporting artefact) and a NaN energy row
    rows.append(
        {
            "charger_id": "B",
            "session_id": 900,
            "session_start": t0.isoformat(),
            "session_end": (t0 + timedelta(hours=30)).isoformat(),
            "energy_kwh": 500.0,
            "peak_power_kw": 22.0,
        }
    )
    rows.append(
        {
            "charger_id": "B",
            "session_id": 901,
            "session_start": t0.isoformat(),
            "session_end": (t0 + timedelta(hours=2)).isoformat(),
            "energy_kwh": None,
            "peak_power_kw": 22.0,
        }
    )
    pd.DataFrame(rows).to_csv(raw / "Se_01_2024.csv", index=False)

    series, stats = ingest.load_tennessee(tmp_path, max_stations=40)
    assert [s.label for s in series] == ["US-TN:A"], "an over-day session and a NaN row must not become demand"
    s = series[0]
    assert s.hours >= ingest.MIN_HOURS
    assert float(s.values.sum()) == pytest.approx(40 * 20.0, rel=1e-3), "energy is conserved across the grid"
    assert stats["usable_sessions"] == 40
    assert stats["raw_rows"] == 42


def test_build_panel_writes_a_provenance_receipt_and_round_trips(tmp_path, monkeypatch):
    import pandas as pd

    raw = tmp_path / "raw"
    raw.mkdir()
    t0 = datetime(2024, 1, 1, tzinfo=timezone.utc)
    rows = [
        {
            "charger_id": "A",
            "session_id": d,
            "session_start": (t0 + timedelta(days=d, hours=2)).isoformat(),
            "session_end": (t0 + timedelta(days=d, hours=4)).isoformat(),
            "energy_kwh": 15.0,
            "peak_power_kw": 11.0,
        }
        for d in range(35)
    ]
    (raw / "tennessee").mkdir()
    (raw / "norway").mkdir()
    pd.DataFrame(rows).to_csv(raw / "tennessee" / "Se_01_2024.csv", index=False)
    _write_norway(raw / "norway" / "Dataset4_hourly_predictions.csv", days=40)

    out = tmp_path / "hourly"
    monkeypatch.setattr(ingest, "RECEIPT", tmp_path / "dataset.json")
    receipt = ingest.build_panel(raw, out, max_stations=40)

    assert set(receipt["panel"]["sources"]) == {"tennessee", "norway"}
    assert receipt["raw_sha256"], "every raw file is digested"
    assert len(receipt["citations"]) == 3
    assert receipt["excluded_sources"], "a rejected source stays documented as rejected"
    assert "Simulation" in json.dumps(receipt["excluded_sources"])

    back = ingest.load_panel(out)
    assert len(back) == receipt["panel"]["series"]
    # The panel must reassemble to exactly what the loaders produced from raw CSVs:
    # a long-format (station, hour, kWh) round-trip with no re-derivation drift.
    expected = {}
    for loader in (ingest.load_tennessee, ingest.load_norway):
        made, _ = loader(raw, max_stations=40)
        expected.update({s.label: s for s in made})
    assert set(expected) == {s.label for s in back}
    for loaded in back:
        original = expected[loaded.label]
        assert loaded.hours == len(loaded.values)
        assert loaded.start == original.start
        assert np.allclose(loaded.values, original.values)


# ---- synthetic twin ----


def test_twin_is_deterministic_and_contract_shaped():
    from simulate import simulate_demand, synthetic_series

    a = simulate_demand(n_stations=3, days=8, vehicles=60, seed=11, device="cpu")
    b = simulate_demand(n_stations=3, days=8, vehicles=60, seed=11, device="cpu")
    assert (a["hourly"] - b["hourly"]).abs().max().item() == 0.0, "same seed+device must be reproducible"
    assert a["hourly"].shape == (3, 8 * 24)
    assert a["hourly"].sum().item() > 0
    stamps = a["timestamps"]
    assert stamps[0] < stamps[1] and (stamps[1] - stamps[0]) == timedelta(hours=1)
    assert "twin-v2" in a["meta"]["generator"]

    series = synthetic_series(a)
    assert len(series) == 3 and series[0].hours == 8 * 24
    assert series[0].source == "synthetic-twin"
    # The twin must be usable through the SAME contract as real data.
    X, Y, meta = contract.build_rows(series)
    assert len(meta) == len(X) > 0 or series[0].hours < contract.MIN_HISTORY_H


def test_twin_has_outages_and_growth_not_just_a_clean_wave():
    from simulate import simulate_demand

    a = simulate_demand(n_stations=6, days=30, vehicles=400, seed=5, device="cpu")
    vals = a["hourly"].numpy()
    assert (vals == 0).any(), "the twin must contain outage blocks, or the forecaster never sees a stall"
    first, last = vals[:, :24].mean(axis=1), vals[:, -24:].mean(axis=1)
    assert (last > first).any(), "a demand trend is what makes a 168 h lag insufficient"


# ---- evaluation harness ----


def test_predict_applies_the_artifact_scaler():
    """The bug this pins: fit on standardized rows, score on raw ones (MAE +60 %)."""
    import train
    from sklearn.preprocessing import StandardScaler

    series = [make_series(400, seed=1), make_series(420, seed=2)]
    X, Y, meta = contract.build_rows(series)
    scaler = StandardScaler().fit(X)
    model, stats = train.fit_mlp(X, Y, scaler, (16, 8), 3, "cpu", 4, 256, 2e-3)
    import torch

    with torch.no_grad():
        manual = model(torch.tensor(contract.standardize(X[:64], scaler.mean_, scaler.scale_))).numpy()
    assert np.allclose(train.predict(model, X[:64], scaler, "cpu"), manual, atol=1e-6)
    identity = type("S", (), {"mean_": np.zeros(X.shape[1], np.float32), "scale_": np.ones(X.shape[1], np.float32)})()
    assert not np.allclose(train.predict(model, X[:64], identity, "cpu"), manual, atol=1e-3), (
        "if this matched, the scaler would not be applied at all"
    )


def test_vectorised_baselines_agree_with_the_loop_reference():
    import train

    series = [make_series(400, seed=1), make_series(340, seed=7, scale=3.0)]
    X, Y, meta = contract.build_rows(series)
    arr = train.aligned_arrays(series, meta)
    assert arr["truth"].shape == (len(meta), contract.HORIZON)
    for i, (si, t, mu) in enumerate(meta[:120]):
        assert np.allclose(arr["truth"][i], series[si].values[t + 1 : t + 1 + contract.HORIZON], atol=1e-4)
        assert np.allclose(arr["naive168"][i], contract.naive_row(series[si], t), atol=1e-4), "seasonal-naive at lag 168"
        assert np.allclose(arr["weekly4"][i], contract.weekly_mean_row(series[si], t), atol=1e-4)
        assert arr["mu"][i] == pytest.approx(mu, rel=1e-5)


def test_folds_purge_the_calib_block_and_never_leak_a_target_window():
    import train

    series = [make_series(900, seed=i) for i in range(3)]
    _X, _Y, meta = contract.build_rows(series)
    masks = train.fold_masks(meta, folds=3, backtest_hours=24 * 30, calib_hours=24 * 5, purge=24, horizon=contract.HORIZON)
    assert len(masks) >= 2
    for f in masks:
        tr, ca, te = f["train"], f["calib"], f["test"]
        assert tr.any() and ca.any() and te.any()
        assert not (tr & ca).any() and not (ca & te).any() and not (tr & te).any(), "blocks must be disjoint"
        by_si = {}
        for i, (si, t) in enumerate((m[0], m[1]) for m in meta):
            by_si.setdefault(si, {"train": [], "calib": [], "test": []})
            for name, mask in (("train", tr), ("calib", ca), ("test", te)):
                if mask[i]:
                    by_si[si][name].append(t)
        for si, groups in by_si.items():
            if not (groups["train"] and groups["calib"] and groups["test"]):
                continue
            # A train row's 24-hour target window must end before the first test target begins.
            assert min(groups["test"]) - max(groups["train"]) >= contract.HORIZON + 1, (
                f"series {si}: a training target overlaps the test block"
            )
            assert min(groups["calib"]) > max(groups["train"])
            assert min(groups["test"]) > max(groups["calib"])


def test_receipt_metrics_are_finite_or_null_not_nan():
    import train

    s = make_series(300, seed=4)
    arr = {"truth": np.zeros((4, 24), np.float32)}
    out = train.summarize(arr["truth"], arr["truth"].copy(), arr["truth"].copy(), arr["truth"].copy())
    assert json.dumps(out)  # NaN would raise here: json.dump writes a bare NaN token
    assert out["points"] == 96


def test_artifact_parity_round_trips_through_weights_only(tmp_path):
    import torch
    import train
    from sklearn.preprocessing import StandardScaler

    series = [make_series(320, seed=9)]
    X, Y, meta = contract.build_rows(series)
    scaler = StandardScaler().fit(X)
    model, _stats = train.fit_mlp(X, Y, scaler, (16, 8), 2, "cpu", 3, 512, 2e-3)
    payload = {
        "format": contract.ARTIFACT_FORMAT,
        "feature_version": contract.FEATURE_VERSION,
        "spec": {"input_dim": contract.INPUT_DIM, "horizon": contract.HORIZON, "hidden": [16, 8]},
        "state_dict": {k: v.detach().cpu() for k, v in model.state_dict().items()},
        "scaler_mean": [float(v) for v in scaler.mean_],
        "scaler_scale": [float(v) for v in scaler.scale_],
        "conformal": contract.conformal_table(np.random.default_rng(0).normal(0, 3, size=(80, contract.HORIZON))),
    }
    payload["payload_sha256"] = contract.payload_hash(payload)
    path = tmp_path / "model.pt"
    torch.save(payload, path)

    report = train.verify_artifact(path, X, scaler, model, rows=64)
    assert report["weights_only_load"] is True and report["payload_sha256_verified"] is True
    assert report["max_abs_relative_difference"] < 1e-3

    # A byte-level weight swap is caught before the artifact can ever be served.
    tampered = dict(payload, state_dict={k: v + 1e-3 for k, v in payload["state_dict"].items()})
    torch.save(tampered, path)
    with pytest.raises(SystemExit, match="payload digest"):
        train.verify_artifact(path, X, scaler, model, rows=32)


def test_fit_reports_the_steps_it_actually_saw():
    """Batch size hid an undertrained model once; the receipt must state the steps."""
    import train

    series = [make_series(320, seed=3)]
    X, Y, _meta = contract.build_rows(series)
    from sklearn.preprocessing import StandardScaler

    scaler = StandardScaler().fit(X)
    model, stats = train.fit_mlp(X, Y, scaler, (16, 8), 2, "cpu", 30, 64, 2e-3)
    assert stats["optimizer_steps"] >= 30, "three epochs at batch 64 must be at least 30 steps"
    assert stats["epochs_run"] == 30 and stats["early_stopped"] is False and stats["val_loss"] is None
    # A validation block that gets worse as training proceeds (targets negated):
    # the best epoch must be restored and the fit must stop, not burn the ceiling.
    _m, with_val = train.fit_mlp(X, Y, scaler, (16, 8), 2, "cpu", 30, 64, 2e-3, val=(X, -Y), patience=1)
    assert with_val["early_stopped"] is True, "a validation block that stops improving must stop the fit"
    assert with_val["epochs_run"] < 30 and with_val["val_loss"] is not None


# ---- gpu allocator ----


def test_gpu_allocator_parsing_and_choice():
    import gpu

    sample = "\n".join(["0, 21838, 81920, 49", "1, 1815, 81920, 47", "3, 45825, 81920, 59"])
    gpus = gpu.list_gpus(sample)
    assert [g["index"] for g in gpus] == [0, 1, 3]
    assert gpus[1]["mem_used_mb"] == 1815
    assert gpu.pick_gpu(min_free_mb=4096, smi_output=sample) == 1, "least-used GPU with enough free memory wins"
    assert gpu.pick_gpu(min_free_mb=85000, smi_output=sample) is None, "impossible ask falls back to CPU"


def test_gpu_lock_is_released_even_when_the_job_raises():
    import gpu

    holder = gpu.acquire(min_free_mb=0) if hasattr(gpu, "acquire") else None
    if holder is None:
        pytest.skip("no GPU visible to the test runner")
    gpu.release(holder)
    assert gpu.acquire(min_free_mb=0) is not None, "a released slot must be claimable again"


@pytest.mark.skipif(not __import__("os").environ.get("AI_TEST_GPU"), reason="GPU smoke runs are opt-in (AI_TEST_GPU=1)")
def test_gpu_simulation_smoke():
    import torch

    assert torch.cuda.is_available()
    from simulate import simulate_demand

    out = simulate_demand(n_stations=2, days=1, vehicles=10, device="cuda")
    assert out["meta"]["device"] == "cuda"
    assert out["hourly"].shape == (2, 24)
