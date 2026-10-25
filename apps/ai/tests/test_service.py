# Sidecar surface tests (apps/ai/service.py).
#
# Covers the three things the API relies on: the internal token gate, honest
# degradation (never a 500, never an invented interval), and artifact integrity
# (a model that does not match its own receipt is refused, not served).
#
# Every test runs on the CPU with no trained artifact required: the loaded-model
# cases install a deterministic stand-in through the same contract the trainer
# uses, so the serving path is exercised without a GPU or a long fit.
#
# Run: python -m pytest apps/ai/tests -q
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))

# The token is resolved at import; pin the development mode before importing.
os.environ.pop("AI_ENV", None)
os.environ.pop("NODE_ENV", None)
os.environ["AI_TOKEN"] = "dev-internal"

import contract  # noqa: E402
import service  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

TOK = {"x-internal": "dev-internal"}
START = "2026-10-25T00:00:00Z"


@pytest.fixture
def client(tmp_path, monkeypatch):
    """A client whose artifact directory is empty, so no real model leaks in."""
    monkeypatch.setattr(service, "REPORTS", tmp_path)
    reset_model(monkeypatch)
    with TestClient(service.app) as c:
        yield c


def reset_model(monkeypatch):
    monkeypatch.setitem(service._MODEL, "loaded", False)
    monkeypatch.setitem(service._MODEL, "pt", None)
    monkeypatch.setitem(service._MODEL, "error", "model artifact missing — run apps/ai/train.py")
    monkeypatch.setitem(service._MODEL, "note", None)
    monkeypatch.setitem(service._MODEL, "meta", None)


def install_model(monkeypatch, seed: int = 0):
    """Put a real (tiny, untrained) network behind the serving path."""
    import torch

    torch.manual_seed(seed)
    net = contract.build_network(contract.INPUT_DIM, [128, 64], contract.HORIZON)
    rng = np.random.default_rng(4)
    conf = contract.conformal_table(rng.normal(0.0, 5.0, size=(600, contract.HORIZON)))
    monkeypatch.setitem(service._MODEL, "pt", {
        "model": net,
        "spec": {"input_dim": contract.INPUT_DIM, "horizon": contract.HORIZON, "hidden": [128, 64]},
        "scaler_mean": [0.0] * contract.INPUT_DIM,
        "scaler_scale": [1.0] * contract.INPUT_DIM,
        "conformal": conf,
        "interval_level": contract.INTERVAL_LEVEL,
    })
    monkeypatch.setitem(service._MODEL, "loaded", True)
    monkeypatch.setitem(service._MODEL, "error", None)
    return net, conf


def history(n=200, base=25.0, stamps=True):
    vals = [round(base + 8 * np.sin(i / 24 * 2 * np.pi) + (i % 5), 3) for i in range(n)]
    if not stamps:
        return vals
    from datetime import datetime, timedelta, timezone

    start = datetime(2026, 8, 3, 0, 0, tzinfo=timezone.utc)
    return {
        "timestamps": [(start + timedelta(hours=i)).isoformat().replace("+00:00", "Z") for i in range(n)],
        "kwh": vals,
    }


# ---- auth ----


def test_health_requires_the_internal_token(client):
    assert client.get("/health").status_code == 401
    assert client.get("/health", headers={"x-internal": "nope"}).status_code == 401
    r = client.get("/health", headers=TOK)
    assert r.status_code == 200
    body = r.json()
    assert body["advisory_only"] is True
    assert body["contract"]["feature_version"] == contract.FEATURE_VERSION
    assert body["contract"]["horizon_hours"] == contract.HORIZON
    assert body["contract"]["min_history_hours"] == contract.MIN_HISTORY_H


def test_every_endpoint_rejects_a_public_caller(client):
    # Body shapes are valid here on purpose: FastAPI validates the payload before the
    # handler runs, so an invalid body would answer 422 and hide the auth check.
    cases = (
        ("/v1/forecast", {"station_ids": [1], "history": {"1": history()}}),
        ("/v1/anomalies", {"ticks": ticks(n=8)}),
        ("/v1/optimize", {"station_id": 1, "station_power_cap_kw": 10, "price_per_kwh": [8.5],
                          "vehicles": [{"id": "v1", "arrive": 0, "deadline": 2, "energy_kwh": 5}]}),
    )
    for path, payload in cases:
        assert client.post(path, json=payload).status_code == 401, path
    assert client.get("/v1/model-card").status_code == 401
    assert client.post("/v1/drift", json={"station_id": 1, "baseline": history(), "recent": history()}).status_code == 401
    assert client.post("/v1/explain", json={"station_id": 1, "history": history()}).status_code == 401


def test_production_refuses_the_published_dev_token():
    """Boot-time guard: a shared secret that is in the repo is not a secret."""
    for bad in ("dev-internal", "change_me", "short", "replace_with_32_random_bytes"):
        r = subprocess.run(
            [sys.executable, "-c", "import service"],
            cwd=str(HERE),
            env={**os.environ, "AI_ENV": "production", "AI_TOKEN": bad},
            capture_output=True,
            text=True,
        )
        assert r.returncode != 0, f"production boot must refuse {bad!r}"
        assert "AI_TOKEN" in (r.stderr + r.stdout)
    good = subprocess.run(
        [sys.executable, "-c", "import service; print('boot-ok')"],
        cwd=str(HERE),
        env={**os.environ, "AI_ENV": "production", "AI_TOKEN": "a" * 40},
        capture_output=True,
        text=True,
    )
    assert good.returncode == 0, good.stderr[-400:]


# ---- forecast: degradation honesty ----


def test_forecast_without_artifact_falls_back_and_says_so(client):
    h = history()
    r = client.post("/v1/forecast", json={"station_ids": [7], "hours": 6, "history": {"7": h}}, headers=TOK)
    assert r.status_code == 200
    body = r.json()
    assert body["advisory"] is True and body["model_loaded"] is False
    assert "train.py" in (body["note"] or ""), "the receipt must name the fix, not hide the gap"
    st = body["stations"]["7"]
    assert st["model"] == "seasonal-naive-168-fallback"
    assert st["p10"] is None and "interval_note" in st, "an uncalibrated fallback must not invent a band"
    assert len(st["hours"]) == 6
    # The fallback must be the SAME baseline the backtest measured the model against.
    series = contract.series_from_timed("7", h["timestamps"], h["kwh"])
    want = contract.naive_row(series, series.hours - 1)[:6]
    assert st["hours"] == [round(float(v), 3) for v in want]


def test_forecast_refuses_a_history_the_contract_cannot_support(client):
    short = client.post("/v1/forecast", json={"station_ids": [1], "history": {"1": history(100)}}, headers=TOK)
    assert short.status_code == 200
    st = short.json()["stations"]["1"]
    assert st["model"] == "no-forecast" and "168" in st["reason"]
    assert short.json()["rejected"] == 1
    holed = history(200)
    del holed["timestamps"][50]
    del holed["kwh"][50]
    gap = client.post("/v1/forecast", json={"station_ids": [2], "history": {"2": holed}}, headers=TOK)
    assert gap.json()["stations"]["2"]["model"] == "no-forecast"
    assert "contiguous" in gap.json()["stations"]["2"]["reason"]


@pytest.mark.parametrize(
    "raw",
    [
        b'{"station_ids": [1], "history": {"1": ["a", "b", "c"]}}',
        b'{"station_ids": [1], "history": {"1": [1.0, NaN, 2.0]}}',
        b'{"station_ids": [1], "history": {"1": [1.0, Infinity, 2.0]}}',
        b'{"station_ids": [1], "history": {"1": "not-a-list"}}',
        b'{"station_ids": [1], "history": {"1": {"kwh": {"not": "a list"}}}}',
    ],
    ids=["non-numeric", "nan", "inf", "string-history", "kwh-not-a-list"],
)
def test_forecast_validates_history_instead_of_trusting_it(client, raw):
    # Sent as raw JSON: Python's serialiser refuses to write NaN/Inf at all, and the
    # sidecar must not be the place that finds out the hard way.
    r = client.post("/v1/forecast", content=raw, headers={**TOK, "content-type": "application/json"})
    assert r.status_code == 422, r.text


def test_forecast_horizon_is_capped_at_what_the_model_was_trained_for(client):
    # v1 trained 24 steps and then served `min(hours, 24)` recursively.
    for hours in (0, 25, 48, -3):
        r = client.post("/v1/forecast", json={"station_ids": [1], "hours": hours, "history": {"1": history()}}, headers=TOK)
        assert r.status_code == 422, f"hours={hours} is outside the trained horizon and must be refused"


# ---- forecast: served path parity ----


def test_served_forecast_equals_the_training_contract(client, monkeypatch):
    """The sidecar must emit exactly what train.py scored: same features, same scaler, same math."""
    net, conf = install_model(monkeypatch)
    import torch

    h = history(220)
    series = contract.series_from_timed("1", h["timestamps"], h["kwh"])
    t = series.hours - 1
    feats = contract.origin_features(series, t)
    mu = float(series.window(t, contract.MIN_HISTORY_H).mean())
    with torch.no_grad():
        raw = net(torch.tensor(contract.standardize(feats, [0.0] * 36, [1.0] * 36)[None, :])).numpy()[0] * mu
    point, low, high = contract.conformal_intervals(np.asarray(raw, dtype=np.float32), conf, contract.INTERVAL_LEVEL)

    r = client.post("/v1/forecast", json={"station_ids": [1], "history": {"1": h}}, headers=TOK)
    assert r.status_code == 200
    st = r.json()["stations"]["1"]
    assert st["model"] == "mlp_128x64"
    assert [round(float(v), 3) for v in st["hours"]] == [round(float(v), 3) for v in point]
    assert [round(float(v), 3) for v in st["p10"]] == [round(float(v), 3) for v in low]
    assert [round(float(v), 3) for v in st["p90"]] == [round(float(v), 3) for v in high]
    assert st["station_scale_kwh_per_hour"] == pytest.approx(round(mu, 4))
    assert st["interval_method"] == conf["method"]
    assert len(st["hours"]) == contract.HORIZON == len(st["lead_hours"])


def test_a_dead_station_is_refused_rather_than_scaled(client, monkeypatch):
    """A flat trailing 168 h has no mean to divide by — the model must say so."""
    install_model(monkeypatch)
    r = client.post("/v1/forecast", json={"station_ids": [2], "history": {"2": [0.0] * 200}}, headers=TOK)
    st = r.json()["stations"]["2"]
    assert st["model"] == "no-forecast" and "flat" in st["reason"]


def test_served_intervals_stay_ordered_when_truncated(client, monkeypatch):
    install_model(monkeypatch)
    full = client.post("/v1/forecast", json={"station_ids": [1], "hours": 24, "history": {"1": history()}}, headers=TOK).json()
    few = client.post("/v1/forecast", json={"station_ids": [1], "hours": 4, "history": {"1": history()}}, headers=TOK).json()
    a, b = full["stations"]["1"], few["stations"]["1"]
    assert b["hours"] == a["hours"][:4] and b["p10"] == a["p10"][:4] and b["p90"] == a["p90"][:4], (
        "asking for 4 hours is a view of the same forecast, not a re-forecast"
    )
    assert all(l <= p <= u for l, p, u in zip(b["p10"], b["hours"], b["p90"]))
    assert all(v >= 0 for v in b["p10"] + b["hours"] + b["p90"])


def test_forecast_is_batched_and_station_scoped(client, monkeypatch):
    install_model(monkeypatch)
    r = client.post(
        "/v1/forecast",
        json={"station_ids": [1, 2, 3], "history": {"1": history(), "2": history(100), "3": history(240, base=90.0)}},
        headers=TOK,
    )
    body = r.json()
    assert set(body["stations"]) == {"1", "2", "3"}
    assert body["stations"]["1"]["model"] == "mlp_128x64"
    assert body["stations"]["2"]["model"] == "no-forecast"
    assert body["rejected"] == 1
    # A 19x larger station must not shift the smaller one's forecast (scale-free pooling).
    assert body["stations"]["3"]["model"] == "mlp_128x64"
    assert body["stations"]["3"]["station_scale_kwh_per_hour"] > 3 * body["stations"]["1"]["station_scale_kwh_per_hour"]


# ---- artifact integrity ----


def write_artifact(tmp_path, payload, digest=None):
    import torch

    torch.save(payload, tmp_path / "model.pt")
    (tmp_path / "model.pt.sha256").write_text((digest if digest is not None else contract.file_sha256(tmp_path / "model.pt")) + "\n", encoding="utf-8")


def good_payload():
    import torch

    torch.manual_seed(1)
    net = contract.build_network(contract.INPUT_DIM, [128, 64], contract.HORIZON)
    pt = {
        "format": contract.ARTIFACT_FORMAT,
        "feature_version": contract.FEATURE_VERSION,
        "trained_at": "2026-10-25T00:00:00+00:00",
        "spec": {"input_dim": contract.INPUT_DIM, "horizon": contract.HORIZON, "hidden": [128, 64]},
        "state_dict": {k: v.detach().cpu() for k, v in net.state_dict().items()},
        "scaler_mean": [0.0] * contract.INPUT_DIM,
        "scaler_scale": [1.0] * contract.INPUT_DIM,
        "conformal": contract.conformal_table(np.random.default_rng(3).normal(0, 4, size=(120, contract.HORIZON))),
        "interval_level": contract.INTERVAL_LEVEL,
    }
    pt["payload_sha256"] = contract.payload_hash(pt)
    return pt


@pytest.mark.parametrize(
    "mutate,expect",
    [
        (lambda p: p.pop("conformal"), "no calibration"),
        (lambda p: p.update(feature_version="vh-feat-v1"), "feature_version"),
        (lambda p: p.update(format="vh-artifact-v1"), "format"),
        (lambda p: p["spec"].update(input_dim=12), "input_dim"),
        (lambda p: p["spec"].update(horizon=12), "horizon"),
        (lambda p: p["conformal"]["quantiles_kwh"].update({"0.1": [0.0] * 6}), "conformal quantile"),
        (lambda p: p["state_dict"]["0.weight"].add_(1e-3), "payload digest"),
    ],
)
def test_a_model_that_does_not_match_its_receipt_is_refused(tmp_path, monkeypatch, mutate, expect):
    monkeypatch.setattr(service, "REPORTS", tmp_path)
    reset_model(monkeypatch)
    pt = good_payload()
    mutate(pt)
    write_artifact(tmp_path, pt)  # digest sidecar recomputed: only the payload gate can catch this
    service._load_model()
    assert service._MODEL["loaded"] is False
    assert expect in (service._MODEL["error"] or ""), service._MODEL["error"]


def test_a_truncated_file_is_caught_by_the_checksum(tmp_path, monkeypatch):
    monkeypatch.setattr(service, "REPORTS", tmp_path)
    reset_model(monkeypatch)
    write_artifact(tmp_path, good_payload(), digest="0" * 64)
    service._load_model()
    assert service._MODEL["loaded"] is False
    assert "checksum mismatch" in service._MODEL["error"]


def test_a_non_weights_only_payload_is_refused(tmp_path, monkeypatch):
    """A numpy/torch scalar anywhere in the artifact makes `weights_only=True` refuse it.

    This is not hypothetical: `torch.__version__` is a TorchVersion str-subclass and
    an early artifact embedded it, which would have kept the sidecar on the naive
    fallback forever. The trainer now refuses to ship such an artifact.
    """
    monkeypatch.setattr(service, "REPORTS", tmp_path)
    reset_model(monkeypatch)
    import torch

    torch.save({"format": contract.ARTIFACT_FORMAT, "note": np.float32(1.0)}, tmp_path / "model.pt")
    (tmp_path / "model.pt.sha256").write_text(contract.file_sha256(tmp_path / "model.pt") + "\n", encoding="utf-8")
    service._load_model()
    assert service._MODEL["loaded"] is False
    assert "model load failed" in service._MODEL["error"]


def test_a_good_artifact_loads_with_its_receipt_visible(tmp_path, monkeypatch):
    monkeypatch.setattr(service, "REPORTS", tmp_path)
    reset_model(monkeypatch)
    pt = good_payload()
    pt["receipt"] = {"intervals": {"empirical_coverage": 0.79}, "models": {"mlp_128x64": {"mae_kwh": 70.2}}}
    pt["payload_sha256"] = contract.payload_hash(pt)
    write_artifact(tmp_path, pt)
    service._load_model()
    assert service._MODEL["loaded"] is True, service._MODEL["error"]
    meta = service._MODEL["meta"]
    assert meta["coverage"] == 0.79 and meta["mae_kwh"] == 70.2
    assert meta["payload_sha256"] == pt["payload_sha256"][:16]


def test_a_missing_artifact_is_reported_not_swallowed(tmp_path, monkeypatch):
    monkeypatch.setattr(service, "REPORTS", tmp_path)
    reset_model(monkeypatch)
    service._MODEL["error"] = None
    service._load_model()
    assert service._MODEL["loaded"] is False
    assert "train.py" in service._MODEL["error"]


# ---- model card, explainability, drift ----


def test_model_card_is_an_honest_receipt_even_without_an_artifact(client):
    r = client.get("/v1/model-card", headers=TOK)
    assert r.status_code == 200
    card = r.json()
    assert card["advisory"] is True
    assert card["model"]["loaded"] is False
    assert "train.py" in (card["model"]["load_error"] or "")
    assert card["contract"]["feature_version"] == contract.FEATURE_VERSION
    assert len(card["contract"]["features"]) == contract.INPUT_DIM == 36
    assert card["contract"]["horizon_hours"] == contract.HORIZON
    assert card["training_data"]["datasets"] == []
    assert card["intended_use"] and card["not_intended_for"] and card["limitations"]
    assert card["monitoring"]["drift_endpoint"] == "POST /v1/drift"


def test_model_card_reads_the_dataset_and_metrics_receipts(client, tmp_path, monkeypatch):
    import json

    (tmp_path / "metrics.json").write_text(
        json.dumps(
            {
                "trained_at": "2026-10-25T00:00:00+00:00",
                "device": "cpu",
                "train_seconds": 642.6,
                "models": {"mlp_128x64": {"mae_kwh": 1.906}},
                "intervals": {"empirical_coverage": 0.8029},
                "backtest": {"protocol": "rolling-origin", "folds": 4},
                "artifact": {"file_sha256": "f" * 64, "payload_sha256": "e" * 64},
                "beats_naive": True,
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "dataset.json").write_text(
        json.dumps(
            {
                "panel": {"series": 87, "station_hours": 754032, "total_kwh": 1331724.4, "sources": ["korea"]},
                "per_source": {
                    "korea": {
                        "stations_kept": 40,
                        "total_kwh": 334765.3,
                        "provenance": {
                            "title": "Korean charging transactions",
                            "license": "CC-BY-4.0",
                            "doi": "10.6084/m9.figshare.22495141.v1",
                        },
                    }
                },
                "citations": ["Baek et al. 2024"],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(service, "REPORTS", tmp_path)
    card = client.get("/v1/model-card", headers=TOK).json()
    assert card["training_data"]["stations"] == 87
    assert card["training_data"]["station_hours"] == 754032
    assert card["training_data"]["datasets"][0]["license"] == "CC-BY-4.0"
    assert card["evaluation"]["intervals"]["empirical_coverage"] == 0.8029
    assert card["evaluation"]["models"]["mlp_128x64"]["mae_kwh"] == 1.906


def test_explain_needs_a_loaded_model(client):
    r = client.post("/v1/explain", json={"station_id": 1, "history": history()}, headers=TOK)
    assert r.status_code == 503
    assert "model not loaded" in r.text


def test_explain_returns_kwh_attributions_for_the_same_forecast(client, monkeypatch):
    install_model(monkeypatch)
    body = client.post(
        "/v1/explain", json={"station_id": 1, "history": history(220), "hours": 6}, headers=TOK
    ).json()
    assert body["advisory"] is True
    assert len(body["forecast_kwh"]) == 6
    assert len(body["raw_forecast_kwh"]) == 6
    assert len(body["p10"]) == len(body["p90"]) == 6
    assert all(lo <= p <= hi for lo, p, hi in zip(body["p10"], body["forecast_kwh"], body["p90"]))
    groups = {a["group"] for a in body["attributions"]}
    assert groups == {"lag_1h_24h_168h", "rolling_mean_24h_168h", "history_earlier_18h", "history_last_6h", "calendar_hour_day_of_week"}
    assert body["top_driver"] == body["attributions"][0]["group"]
    assert all(np.isfinite(a["mean_delta_kwh"]) and np.isfinite(a["mean_abs_delta_kwh"]) for a in body["attributions"])
    # Sorted by absolute contribution, descending.
    mags = [abs(a["mean_delta_kwh"]) for a in body["attributions"]]
    assert mags == sorted(mags, reverse=True)
    assert "not causality" in body["caveat"]


@pytest.mark.parametrize(
    "payload",
    [
        {"station_id": 1, "history": history(100)},
        {"station_id": 1, "history": [0.0] * 200},
        {"station_id": 1, "history": history(200), "hours": 0},
        {"station_id": 1, "history": history(200), "hours": 25},
    ],
    ids=["too-short", "flat", "hours-zero", "hours-over-horizon"],
)
def test_explain_refuses_history_it_cannot_explain(client, monkeypatch, payload):
    install_model(monkeypatch)
    assert client.post("/v1/explain", json=payload, headers=TOK).status_code == 422


def drift_payload(base_n=336, recent_n=168, recent=None):
    base = history(base_n)
    rec = history(recent_n)
    if recent is not None:
        rec = {**rec, "kwh": recent(rec["kwh"], rec["timestamps"])}
    return {"station_id": 1, "baseline": base, "recent": rec}


def test_drift_reports_stable_for_the_same_daily_distribution(client):
    # 120 h = one full phase of the fixture (24 h sine x 5 h saw); whole cycles
    # make the two demand distributions identical, so PSI is exactly zero.
    r = client.post("/v1/drift", json=drift_payload(base_n=240, recent_n=120), headers=TOK)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["verdict"] == "stable"
    assert body["retrain_recommended"] is False
    assert body["psi"] == 0.0
    assert body["states"] == {
        "psi": "stable",
        "ks": "stable",
        "mean": "stable",
        "zeros": "stable",
        "volatility": "stable",
        "hourly_shape": "stable",
    }
    assert "no material distribution shift" in body["reasons"][0]


def test_drift_detects_a_real_regime_change_and_recommends_retraining(client):
    def doubled(values, stamps):
        from datetime import datetime

        return [0.0 if datetime.fromisoformat(s.replace("Z", "+00:00")).hour < 12 else 120.0 for s in stamps]

    body = client.post("/v1/drift", json=drift_payload(recent=doubled), headers=TOK).json()
    assert body["verdict"] == "drift", body
    assert body["retrain_recommended"] is True
    assert body["mean_shift_pct"] > 60
    assert body["zero_share_recent"] > 0.4
    assert body["states"]["ks"] == "drift"
    assert body["states"]["psi"] == "drift"
    assert any("mean demand shifted" in r for r in body["reasons"])
    assert any("load shape" in r for r in body["reasons"])


def test_drift_refuses_undefined_or_malformed_windows(client):
    dead = drift_payload(base_n=48, recent_n=48)
    dead["baseline"]["kwh"] = [0.0] * 48
    dead["recent"]["kwh"] = [5.0] * 48
    body = client.post("/v1/drift", json=dead, headers=TOK).json()
    assert body["verdict"] == "insufficient"
    assert body["retrain_recommended"] is False

    short = drift_payload(base_n=48, recent_n=12)
    short["recent"]["kwh"] = [1.0] * 12
    short["recent"]["timestamps"] = short["recent"]["timestamps"][:12]
    assert client.post("/v1/drift", json=short, headers=TOK).status_code == 422

    mismatch = drift_payload()
    mismatch["baseline"]["kwh"] = mismatch["baseline"]["kwh"][:-1]
    assert client.post("/v1/drift", json=mismatch, headers=TOK).status_code == 422

    negative = drift_payload()
    negative["recent"]["kwh"] = [-1.0] * 168
    assert client.post("/v1/drift", json=negative, headers=TOK).status_code == 422

    bad_ts = drift_payload()
    bad_ts["recent"]["timestamps"][3] = "last Tuesday"
    assert client.post("/v1/drift", json=bad_ts, headers=TOK).status_code == 422


# ---- anomalies ----


def ticks(session=1, n=20, step_minutes=60, kwh_per_step=11.0, start="2026-09-07T00:00:00Z"):
    from datetime import datetime, timedelta, timezone

    t0 = datetime.fromisoformat(start.replace("Z", "+00:00"))
    out, meter = [], 0.0
    for i in range(n):
        meter += kwh_per_step
        out.append(
            {
                "session_id": session,
                "ts": (t0 + timedelta(minutes=step_minutes * i)).isoformat().replace("+00:00", "Z"),
                "meter_kwh": round(meter, 4),
                "power_kw": 11.0,
            }
        )
    return out


def test_meter_spike_is_flagged(client):
    t = ticks(n=20)
    t.append({"session_id": 1, "ts": "2026-09-07T20:00:00Z", "meter_kwh": t[-1]["meter_kwh"] + 40, "power_kw": 11.0})
    r = client.post("/v1/anomalies", json={"ticks": t}, headers=TOK)
    body = r.json()
    assert body["advisory"] is True
    assert body["checked"] == 21
    assert any("z=" in x for f in body["flagged"] for x in f["reasons"]), "a 40 kWh jump must flag"


def test_faster_polling_is_not_mistaken_for_lower_demand(client):
    """v1 scored raw kWh deltas, so a session polled every 6 minutes looked anomalous."""
    t = ticks(n=10, step_minutes=60, kwh_per_step=11.0)
    # Same physical rate (11 kW), reported 10x more often: 1.1 kWh per 6-minute tick,
    # continuing the clock from the last hourly frame.
    from datetime import datetime, timedelta, timezone

    t0 = datetime.fromisoformat("2026-09-07T09:00:00+00:00")
    meter = t[-1]["meter_kwh"]
    for i in range(1, 60):
        meter += 1.1
        t.append(
            {
                "session_id": 1,
                "ts": (t0 + timedelta(minutes=6 * i)).isoformat().replace("+00:00", "Z"),
                "meter_kwh": round(meter, 4),
                "power_kw": 11.0,
            }
        )
    body = client.post("/v1/anomalies", json={"ticks": t}, headers=TOK).json()
    assert body["flagged"] == [], [f["reasons"] for f in body["flagged"][:3]]


def test_a_short_session_is_skipped_not_flagged(client):
    body = client.post("/v1/anomalies", json={"ticks": ticks(n=4), "min_samples": 6}, headers=TOK).json()
    assert body["flagged"] == []
    assert body["skipped"][0]["reason"] == "below min_samples"
    assert client.post("/v1/anomalies", json={"ticks": ticks(n=10), "min_samples": 2}, headers=TOK).status_code == 422
    assert client.post("/v1/anomalies", json={"ticks": []}, headers=TOK).status_code == 422


def test_unparseable_timestamps_are_counted_not_guessed(client):
    t = ticks(n=10)
    t[3]["ts"] = "last Tuesday"
    t[5]["ts"] = "1970-01-01T00:00:00Z"
    body = client.post("/v1/anomalies", json={"ticks": t}, headers=TOK).json()
    assert body["invalid_timestamps"] == 2
    assert body["checked"] == 8


@pytest.mark.parametrize(
    "tamper,needle",
    [
        (lambda t: t.append({"session_id": 1, "ts": t[-1]["ts"], "meter_kwh": t[-1]["meter_kwh"] + 5, "power_kw": 11.0}),
         "duplicate timestamp"),
        (lambda t: t.__setitem__(10, {**t[10], "meter_kwh": 0.5}), "meter regression"),
        (lambda t: t.__setitem__(10, {**t[10], "meter_kwh": t[9]["meter_kwh"]}), "meter stalled"),
    ],
)
def test_physical_impossibilities_are_flagged(client, tamper, needle):
    t = ticks(n=20)
    tamper(t)
    body = client.post("/v1/anomalies", json={"ticks": t}, headers=TOK).json()
    assert any(needle in x for f in body["flagged"] for x in f["reasons"]), (needle, body["flagged"])


def test_a_identical_retransmit_is_not_an_anomaly_but_a_disagreement_is(client):
    t = ticks(n=12)
    twice = t + [dict(t[5])]  # the same frame delivered again
    assert client.post("/v1/anomalies", json={"ticks": twice}, headers=TOK).json()["flagged"] == []


def test_a_steady_session_is_judged_on_rate_not_on_spread(client):
    """MAD == 0 (a perfectly steady charge) must flag a real jump, not every tick."""
    t = ticks(n=20, kwh_per_step=11.0)
    assert client.post("/v1/anomalies", json={"ticks": t}, headers=TOK).json()["flagged"] == []
    jump = [dict(x) for x in t]
    jump[10]["meter_kwh"] = jump[9]["meter_kwh"] + 120.0
    body = client.post("/v1/anomalies", json={"ticks": jump}, headers=TOK).json()
    assert any("z=" in x for f in body["flagged"] for x in f["reasons"]), "a degenerate MAD must still catch a real jump"


def test_connector_cap_overrun_is_flagged(client):
    t = ticks(n=20, kwh_per_step=11.0)
    t.append({"session_id": 1, "ts": "2026-09-07T20:00:00Z", "meter_kwh": t[-1]["meter_kwh"] + 60, "power_kw": 60.0})
    body = client.post("/v1/anomalies", json={"ticks": t, "max_kw": 22}, headers=TOK).json()
    assert any("exceeds connector cap" in x for f in body["flagged"] for x in f["reasons"])


def test_power_disagreement_is_flagged(client):
    t = ticks(n=20, kwh_per_step=11.0)
    t[10] = {**t[10], "meter_kwh": t[9]["meter_kwh"] + 80, "power_kw": 11.0}
    body = client.post("/v1/anomalies", json={"ticks": t}, headers=TOK).json()
    assert any("disagrees with reported power" in x for f in body["flagged"] for x in f["reasons"])


# ---- optimizer (deterministic LP, hard electrical constraints) ----


def opt(client, **over):
    body = {
        "station_id": 1,
        "window_hours": 12,
        "station_power_cap_kw": 60.0,
        "price_per_kwh": [10, 9, 8, 6, 5, 5, 6, 7, 8, 9, 10, 11],
        "vehicles": [
            {"id": "v1", "arrive": 0, "deadline": 6, "energy_kwh": 40, "max_kw": 22},
            {"id": "v2", "arrive": 2, "deadline": 10, "energy_kwh": 50, "max_kw": 11},
        ],
    }
    body.update(over)
    return client.post("/v1/optimize", json=body, headers=TOK)


def test_optimizer_satisfies_every_hard_constraint(client):
    r = opt(client)
    assert r.status_code == 200
    b = r.json()
    assert b["feasible"] is True and b["advisory"] is True
    for h, kwh in enumerate(b["station_hour_kwh"]):
        assert kwh <= 60.0 + 1e-6, f"hour {h} over station cap"
    for vid, delivered in b["delivered_kwh"].items():
        assert delivered >= {"v1": 40.0, "v2": 50.0}[vid] - 1e-3
    for vid, hours in b["schedule_kwh"].items():
        assert len(hours) == 12
        for kwh in hours:
            assert kwh <= {"v1": 22.0, "v2": 11.0}[vid] + 1e-6
    # A vehicle never charges outside its plug-in window.
    for v, spec in zip(b["schedule_kwh"].values(), [{"arrive": 0, "deadline": 6}, {"arrive": 2, "deadline": 10}]):
        for h, kwh in enumerate(v):
            if h < spec["arrive"] or h >= spec["deadline"]:
                assert kwh <= 1e-6, f"energy delivered outside the window at hour {h}"
    # Cheapest hours first: h4/h5 are the 5.0-priced hours.
    assert b["schedule_kwh"]["v1"][4] > 0 and b["schedule_kwh"]["v1"][5] > 0


def test_optimizer_reports_infeasibility_instead_of_truncating(client):
    b = opt(client, window_hours=2, station_power_cap_kw=5.0, price_per_kwh=[1, 1],
            vehicles=[{"id": "v1", "arrive": 0, "deadline": 2, "energy_kwh": 500, "max_kw": 22}]).json()
    assert b["feasible"] is False
    assert b.get("reason"), "an honest no must explain itself"


@pytest.mark.parametrize(
    "over,needle",
    [
        ({"vehicles": [{"id": "v1", "arrive": 0, "deadline": 4, "energy_kwh": 5}, {"id": "v1", "arrive": 0, "deadline": 4, "energy_kwh": 5}]}, "duplicate vehicle ids"),
        ({"vehicles": [{"id": "v1", "arrive": 5, "deadline": 3, "energy_kwh": 5}]}, "deadline must be after arrive"),
        ({"vehicles": [{"id": "v1", "arrive": 40, "deadline": 44, "energy_kwh": 5}]}, "arrives outside the window"),
        ({"vehicles": []}, "least 1 item"),
        ({"station_power_cap_kw": 0}, "greater than"),
        ({"window_hours": 100}, "less than or equal to 72"),
    ],
)
def test_optimizer_rejects_nonsense_before_solving(client, over, needle):
    r = opt(client, **over)
    assert r.status_code == 422, r.text
    assert needle.lower() in r.text.lower(), r.text


def test_carbon_objective_moves_energy_without_breaking_anything(client):
    cheap_but_dirty = [1.0, 1.0, 9.0, 9.0]
    carbon = [900.0, 900.0, 50.0, 50.0]
    vehicle = [{"id": "v1", "arrive": 0, "deadline": 4, "energy_kwh": 20, "max_kw": 22}]
    base = opt(client, window_hours=4, price_per_kwh=cheap_but_dirty, vehicles=vehicle).json()
    green = opt(client, window_hours=4, price_per_kwh=cheap_but_dirty, carbon_g_per_kwh=carbon,
                carbon_weight=2.0, vehicles=vehicle).json()
    assert base["feasible"] and green["feasible"]
    assert sum(base["schedule_kwh"]["v1"][:2]) > 0, "cost-only charges in the cheap hours"
    assert sum(green["schedule_kwh"]["v1"][2:]) > 0, "the carbon term must move energy to clean hours"
    # The cost-only run reports no carbon figure (nothing was measured); score both
    # schedules against the same intensity vector.
    def grams(schedule):
        return sum(k * c for k, c in zip(schedule, carbon))

    assert grams(green["schedule_kwh"]["v1"]) < grams(base["schedule_kwh"]["v1"])
    assert green["objective_carbon_g"] == pytest.approx(grams(green["schedule_kwh"]["v1"]), rel=1e-3)
    assert green["objective_cost"] > base["objective_cost"], "the trade-off must be visible, not hidden"
    assert green["advisory"] is True
