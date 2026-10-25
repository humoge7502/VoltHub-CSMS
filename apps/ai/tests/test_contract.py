# Feature-contract tests (apps/ai/contract.py).
#
# These are the tests that make the forecast trustworthy: the contract is the only
# place features, baselines, calibration and integrity digests are defined, and both
# the trainer and the sidecar call into it. Every v1 defect (index-derived calendar,
# station id as a feature, scale-bound targets, an invented ±38 % band) has a test
# here that fails if it comes back.
#
# Run: python -m pytest apps/ai/tests -q
from __future__ import annotations

import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pytest

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

import contract  # noqa: E402

START = datetime(2026, 8, 3, 0, 0, tzinfo=timezone.utc)  # a Monday


def make_series(hours=240, start=START, scale=1.0, seed=3, label="s1", source="test"):
    rng = np.random.default_rng(seed)
    base = 20.0 + 12.0 * np.sin(np.arange(hours) * 2 * np.pi / 24) + rng.normal(0, 2, hours)
    return contract.Series(label, source, start, np.clip(base, 0, None).astype(np.float32) * scale)


def origin(series):
    return series.hours - 1  # last observed hour is the origin


def last_trainable_origin(series):
    """The newest origin that still has a full 24-hour target window."""
    return series.hours - 1 - contract.HORIZON


# ---- the shape of the contract ----


def test_feature_names_have_no_station_id_and_fixed_width():
    assert contract.INPUT_DIM == len(contract.FEATURE_NAMES) == 36
    assert not any("station" in n or "id" in n for n in contract.FEATURE_NAMES), (
        "station id must never be a feature: dataset station numbers mean nothing to a CSMS"
    )
    assert contract.FEATURE_NAMES[:3] == ["lag_1h", "lag_24h", "lag_168h"]
    assert contract.FEATURE_NAMES[-7] == "hour_sin"


def test_calendar_features_come_from_the_clock_not_the_array_index():
    """v1 derived hour-of-day from `index % 24`, so every served forecast could be off by hours."""
    s = make_series(start=START.replace(hour=13))
    t = last_trainable_origin(s)
    lead = s.ts(t + 1)  # the FIRST forecast hour drives the calendar block
    row = contract.origin_features(s, t)
    assert row[29] == pytest.approx(math.sin(2 * math.pi * lead.hour / 24), abs=1e-5)
    assert row[30] == pytest.approx(math.cos(2 * math.pi * lead.hour / 24), abs=1e-5)
    # Same values, different clock: only the calendar block may move.
    other = contract.origin_features(make_series(start=START.replace(hour=16)), t)
    assert not np.allclose(row[29:33], other[29:33]), "a different anchor hour must change the calendar block"


def test_weekend_and_peak_flags_agree_with_the_timestamp():
    sat_evening = make_series(start=START + timedelta(days=5))  # Saturday
    row = contract.origin_features(sat_evening, origin(sat_evening))
    dt = sat_evening.ts(origin(sat_evening) + 1)
    assert row[33] == (1.0 if dt.weekday() >= 5 else 0.0)
    assert row[34] == (1.0 if 5 <= dt.hour < 10 else 0.0)
    assert row[35] == (1.0 if 17 <= dt.hour < 22 else 0.0)


def test_rows_are_station_scale_free():
    """One pooled model serves a 5 kW kerb charger and a 350 kW hub: every value is /mu."""
    small = make_series(scale=1.0)
    big = make_series(scale=50.0)
    t_small, t_big = last_trainable_origin(small), last_trainable_origin(big)
    assert np.allclose(contract.origin_features(small, t_small), contract.origin_features(big, t_big), atol=1e-4), (
        "features must be invariant to station size"
    )
    assert np.allclose(contract.target_row(small, t_small), contract.target_row(big, t_big), atol=1e-4)
    mu_small = small.window(t_small, contract.MIN_HISTORY_H).mean()
    mu_big = big.window(t_big, contract.MIN_HISTORY_H).mean()
    assert mu_big / mu_small == pytest.approx(50.0, rel=1e-3), "the station scale is what converts relative back to kWh"


def test_flat_or_short_history_is_refused_the_same_way_on_both_sides():
    flat = contract.Series("dead", "test", START, np.zeros(300, dtype=np.float32))
    assert contract.origin_features(flat, 250) is None
    assert contract.target_row(flat, 250) is None
    short = make_series(hours=contract.MIN_HISTORY_H - 1)
    assert contract.origin_features(short, origin(short)) is None


def test_build_rows_matches_a_plain_loop_reference():
    series_list = [make_series(hours=200, seed=1), make_series(hours=260, seed=2, start=START + timedelta(days=2))]
    X, Y, meta = contract.build_rows(series_list)
    ref_x, ref_y, ref_meta = [], [], []
    for si, s in enumerate(series_list):
        for t in range(contract.MIN_HISTORY_H - 1, s.hours - contract.HORIZON):
            f, y = contract.origin_features(s, t), contract.target_row(s, t)
            if f is None or y is None:
                continue
            ref_x.append(f)
            ref_y.append(y)
            ref_meta.append((si, t, float(s.window(t, contract.MIN_HISTORY_H).mean())))
    assert len(meta) == len(ref_x) > 0
    assert np.allclose(X, np.stack(ref_x))
    assert np.allclose(Y, np.stack(ref_y))
    assert [m[:2] for m in meta] == [m[:2] for m in ref_meta]
    # Targets are the NEXT 24 hours after the origin, never the origin window itself.
    si, t, _mu = meta[0]
    assert np.allclose(Y[0], series_list[si].values[t + 1 : t + 1 + contract.HORIZON] / _mu, atol=1e-4)


# ---- baselines the model must beat ----


def test_naive_and_weekly_baselines_look_back_the_right_distance():
    s = make_series(hours=240)
    t = origin(s)
    naive = contract.naive_row(s, t)
    assert np.allclose(naive, s.values[t + 1 - 168 : t + 1 + contract.HORIZON - 168])
    weekly = contract.weekly_mean_row(s, t)
    assert weekly.shape == (contract.HORIZON,)
    # For the first lead, weekly mean is the average of the same hour 1..4 weeks back.
    lead = t + 1
    idx = [lead - 168 * w for w in range(1, 5) if lead - 168 * w >= 0]
    assert weekly[0] == pytest.approx(float(np.mean([s.values[i] for i in idx])), abs=1e-4)


# ---- conformal calibration ----


def test_conformal_table_uses_signed_quantiles_with_the_finite_sample_correction():
    rng = np.random.default_rng(11)
    resid = rng.normal(0.0, 5.0, size=(100, contract.HORIZON))
    table = contract.conformal_table(resid)
    n = 100
    for level, expected_q in ((0.1, math.ceil(0.1 * (n + 1)) / n), (0.9, math.ceil(0.9 * (n + 1)) / n)):
        want = np.quantile(resid, min(1.0, expected_q), axis=0)
        assert np.allclose(table["quantiles_kwh"][str(float(level))], want, atol=1e-5)
    q10 = np.asarray(table["quantiles_kwh"]["0.1"])
    q50 = np.asarray(table["quantiles_kwh"]["0.5"])
    q90 = np.asarray(table["quantiles_kwh"]["0.9"])
    assert np.all(q10 < q50) and np.all(q50 < q90), "signed quantiles must be ordered"
    assert np.mean(np.abs(q50)) < 1.0, "a symmetric error distribution needs almost no bias correction"


def test_conformal_intervals_are_out_of_sample_honest_and_ordered():
    rng = np.random.default_rng(7)
    H = contract.HORIZON
    calib_pred = rng.uniform(40, 120, size=(2000, H))
    calib_truth = calib_pred + rng.normal(0, 8, size=(2000, H))
    table = contract.conformal_table(calib_truth - calib_pred)
    test_pred = rng.uniform(40, 120, size=(2000, H))
    test_truth = test_pred + rng.normal(0, 8, size=(2000, H))
    point, low, high = contract.conformal_intervals(test_pred, table, contract.INTERVAL_LEVEL)
    cov = contract.coverage(test_truth, low, high)
    assert 0.74 <= cov <= 0.90, f"nominal 0.80 must land near 0.80 out of sample, got {cov}"
    assert np.all(low <= point + 1e-6) and np.all(point <= high + 1e-6)
    assert np.all(low >= 0.0) and np.all(point >= 0.0), "demand cannot be negative"
    # Asymmetry is the point of signed residuals: a long right tail, a hard left bound.
    assert float(np.mean(high - point)) > float(np.mean(point - low))
    # The table is per-horizon, so calibrate on the full 24 and truncate AFTER —
    # calibrating a sliced forecast would apply the h=1 quantile to h=6. Serving
    # does it in this order; this pins the wrong order as an error.
    with pytest.raises(ValueError, match="horizon"):
        contract.conformal_intervals(test_pred[:, :6], table, contract.INTERVAL_LEVEL)
    _p, l6, h6 = contract.conformal_intervals(test_pred, table, contract.INTERVAL_LEVEL)
    assert l6.shape[1] == contract.HORIZON
    assert np.all(l6 >= 0.0)


def test_conformal_rejects_mismatched_horizon_and_empty_calibration():
    with pytest.raises(ValueError):
        contract.conformal_table(np.zeros((0, contract.HORIZON)))
    with pytest.raises(ValueError):
        contract.conformal_table(np.zeros((5, 12)))
    table = contract.conformal_table(np.random.default_rng(1).normal(0, 1, size=(20, contract.HORIZON)))
    with pytest.raises(ValueError):
        contract.conformal_q(table, 0.5, horizon=6)
    with pytest.raises(ValueError):
        contract.conformal_q(table, 0.42, contract.HORIZON)


def test_pinball_prefers_the_honest_bound():
    rng = np.random.default_rng(5)
    truth = rng.uniform(10, 90, size=(500, 24))
    honest = truth.copy()
    lazy_low = truth - 30.0
    assert contract.pinball(truth, honest, 0.1) < contract.pinball(truth, lazy_low, 0.1)


# ---- metrics ----


def test_mase_is_scaled_and_degrades_honestly():
    truth = np.arange(1, 25, dtype=np.float64)[None, :].repeat(10, axis=0)
    naive = truth + 2.0
    assert contract.mase(truth, truth.copy(), naive) == pytest.approx(0.0)
    assert contract.mase(truth, naive, naive) == pytest.approx(1.0)
    assert math.isnan(contract.mase(truth, truth.copy(), truth.copy())), "a perfect baseline cannot be scaled against"
    # A model twice as wrong as naive scores 2.0 — no dataset-size excuse.
    assert contract.mase(truth, truth + 4.0, naive) == pytest.approx(2.0)


# ---- timestamps and integrity ----


@pytest.mark.parametrize(
    "raw,hour,ok",
    [
        ("2026-10-25T13:00:00Z", 13, True),
        ("2026-10-25t13:00:00z", 13, True),
        ("2026-10-25T13:00:00+05:30", 7, True),  # converted to UTC
        ("2026-10-25T13:00:00", 13, True),  # naive is assumed UTC
        ("2026-10-25 13:00", 13, True),
        ("not-a-time", None, False),
        ("1970-01-01T00:00:00Z", None, False),
        ("9999-12-31T00:00:00Z", None, False),
        ("", None, False),
        (None, None, False),
        (12345, None, False),
    ],
)
def test_parse_ts_is_strict_but_never_raises(raw, hour, ok):
    got = contract.parse_ts(raw)
    if not ok:
        assert got is None
        return
    assert got.tzinfo is not None and got.hour == hour


def test_timestamped_history_must_be_one_contiguous_hourly_grid():
    values = list(np.linspace(10, 20, 200))
    good = [(START + timedelta(hours=i)).isoformat().replace("+00:00", "Z") for i in range(200)]
    s = contract.series_from_timed("ok", good, values)
    assert s.hours == 200 and s.start == START
    holes = list(good)
    del holes[50]
    with pytest.raises(ValueError, match="contiguous"):
        contract.series_from_timed("hole", holes, values[:-1])
    with pytest.raises(ValueError, match="RFC-3339"):
        contract.series_from_timed("junk", ["yesterday"] * 200, values)


def test_unstamped_history_anchors_its_origin_at_the_supplied_clock():
    """A trailing list of N hours ends at `anchor`; v1 assumed it started there."""
    values = list(np.linspace(10, 20, 200))
    anchor = START.replace(hour=13)
    s = contract.series_from_values("caller", values, start=anchor)
    assert s.hours == 200
    assert s.ts(s.hours - 1) == anchor.replace(minute=0, second=0, microsecond=0)
    assert s.ts(0) == anchor - timedelta(hours=199)


def test_payload_hash_covers_weights_scaler_and_receipt():
    rng = np.random.default_rng(2)
    weights = {"0.weight": np.ones((4, 3), dtype=np.float32), "0.bias": np.zeros(4, dtype=np.float32)}
    base = {
        "format": contract.ARTIFACT_FORMAT,
        "feature_version": contract.FEATURE_VERSION,
        "trained_at": "2026-10-25T00:00:00+00:00",
        "spec": {"input_dim": 36, "horizon": 24, "hidden": [128, 64]},
        "scaler_mean": [0.0] * 36,
        "scaler_scale": [1.0] * 36,
        "conformal": contract.conformal_table(rng.normal(0, 1, size=(50, 24))),
        "state_dict": weights,
    }
    h1 = contract.payload_hash(base)
    assert contract.payload_hash(dict(base, payload_sha256=h1)) == h1, "the digest field must not self-reference"
    assert contract.payload_hash({**base, "trained_at": "2027-01-01T00:00:00+00:00"}) != h1
    assert contract.payload_hash({**base, "scaler_scale": [2.0] * 36}) != h1
    tampered = dict(base, state_dict={"0.weight": np.ones((4, 3), dtype=np.float32) * 1e-3, "0.bias": weights["0.bias"]})
    assert contract.payload_hash(tampered) != h1, "a single flipped weight byte must change the digest"


def test_file_sha256_is_stable_and_detects_truncation(tmp_path):
    p = tmp_path / "artifact.bin"
    p.write_bytes(b"volthub" * 1000)
    before = contract.file_sha256(p)
    assert before == contract.file_sha256(p)
    p.write_bytes(b"volthub" * 999)
    assert contract.file_sha256(p) != before
