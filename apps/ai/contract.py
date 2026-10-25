# VoltHub AI — feature & artifact contract (single source of truth).
#
# Both train.py and service.py import this module, so a feature the model was
# trained on can never be computed differently at inference time (the class of
# bug that silently degrades a forecaster in production instead of failing loud).
#
# Contract v3 changes vs v1 (each fixes a measured defect):
#  * calendar features are derived from REAL timestamps, never `index % 24`
#    (v1 assumed the training matrix started at 00:00 and served whatever the
#    caller's array length happened to imply — hour-of-day could be off by hours).
#  * the station id is NOT a feature (v1 fed `station_id` into the MLP, so the
#    model memorised dataset station numbers that mean nothing to a CSMS station).
#  * one fixed 24-hour forward horizon, direct multi-output: output j is the
#    demand of anchor_hour + 1 + j (v1 trained a 24-step head but served
#    `y[min(step, ...)]` recursively, i.e. reused the last head for steps > 24).
#  * scale-free targets: every value is divided by the mean of the origin's own
#    trailing 168 h, so one pooled model serves stations of any size.
#  * the last 24 observed hours are features: a direct day-to-day map is what
#    the operator actually wants, and it is what wins on real panels.
#
# Run:  python3 apps/ai/train.py (consumes this module; see docs/ai-platform.md)

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import numpy as np

HORIZON = 24
LAGS: tuple[int, ...] = (1, 24, 168)
MIN_HISTORY_H = max(LAGS)  # a row needs exactly this many observed hours
ROLL_WINDOWS: tuple[int, ...] = (24, 168)
HIST_WINDOW = 24  # the last 24 observed hours travel as features (direct day-to-day map)
FEATURE_VERSION = "vh-feat-v3"
ARTIFACT_FORMAT = "vh-artifact-v2"

# Guard rails for the scale-free ratios: a near-flat trailing window (a station
# that barely charges) must not be able to produce 1e12-sized features, and a
# single extreme session must not make the model emit runaway advisory numbers.
RELATIVE_CLIP = 240.0
EPS = 1e-6

QUANTILE_LEVELS: tuple[float, ...] = (0.1, 0.5, 0.9)
INTERVAL_LEVEL = 0.80  # nominal coverage of [p_low, p_high]
HOURS_SECONDS = 3600

_LAG_NAMES = [f"lag_{lag}h" for lag in LAGS]
_ROLL_NAMES = [f"mean_{w}h" for w in ROLL_WINDOWS]
_CAL_NAMES = [
    "hour_sin",
    "hour_cos",
    "dow_sin",
    "dow_cos",
    "is_weekend",
    "is_morning_peak",
    "is_evening_peak",
]
_HIST_NAMES = [f"hist_-{HIST_WINDOW - 1 - k}h" for k in range(HIST_WINDOW)]
FEATURE_NAMES = _LAG_NAMES + _ROLL_NAMES + _HIST_NAMES + _CAL_NAMES
INPUT_DIM = len(FEATURE_NAMES)


@dataclass(frozen=True)
class Series:
    """One contiguous hourly kWh series for one station, anchored at `start`."""

    label: str
    source: str
    start: datetime
    values: np.ndarray = field(repr=False)

    def __post_init__(self) -> None:
        if self.start.tzinfo is None:
            object.__setattr__(self, "start", self.start.replace(tzinfo=timezone.utc))
        object.__setattr__(self, "start", self.start.astimezone(timezone.utc))

    @property
    def hours(self) -> int:
        return int(len(self.values))

    def ts(self, i: int) -> datetime:
        return self.start + timedelta(hours=int(i))

    def window(self, t: int, n: int) -> np.ndarray:
        """The n hours ending (inclusive) at index t."""
        return self.values[t - n + 1 : t + 1]


def calendar_features(dt: datetime) -> list[float]:
    hour = dt.hour + dt.minute / 60.0
    dow = dt.weekday() + dt.hour / 24.0
    return [
        math.sin(2 * math.pi * hour / 24),
        math.cos(2 * math.pi * hour / 24),
        math.sin(2 * math.pi * dow / 7),
        math.cos(2 * math.pi * dow / 7),
        1.0 if dow >= 5 else 0.0,
        1.0 if 5 <= dt.hour < 10 else 0.0,
        1.0 if 17 <= dt.hour < 22 else 0.0,
    ]


def origin_features(series: Series, t: int) -> np.ndarray | None:
    """Feature row for origin index t (t = last OBSERVED hour).

    Returns None when the origin cannot support the contract (not enough
    history, or a dead-flat trailing window that would make the ratios
    meaningless). Training and serving drop such rows the same way.
    """
    if t + 1 < MIN_HISTORY_H:
        return None
    win = series.window(t, MIN_HISTORY_H).astype(np.float64)
    mu = float(win.mean())
    if not math.isfinite(mu) or mu <= EPS:
        return None
    lags = [float(series.values[t - (lag - 1)]) / mu for lag in LAGS]
    rolls = [float(series.window(t, w).mean()) / mu for w in ROLL_WINDOWS]
    hist = [float(v) / mu for v in series.window(t, HIST_WINDOW)]
    cal = calendar_features(series.ts(t + 1))  # first FORECAST hour drives the calendar
    feats = np.asarray(lags + rolls + hist + cal, dtype=np.float32)
    return np.clip(feats, -RELATIVE_CLIP, RELATIVE_CLIP)


def target_row(series: Series, t: int) -> np.ndarray | None:
    """Next HORIZON hours, station-relative (same mu as the features)."""
    end = t + 1 + HORIZON
    if end > series.hours:
        return None
    win = series.window(t, MIN_HISTORY_H).astype(np.float64)
    mu = float(win.mean())
    if not math.isfinite(mu) or mu <= EPS:
        return None
    y = series.values[t + 1 : end].astype(np.float32) / mu
    return np.clip(y, 0.0, RELATIVE_CLIP)


def build_rows(series_list: list[Series]):
    """Sliding-window rows over every series.

    Returns (X, Y, meta) where meta = [(series_index, origin_index, mu), ...]
    and mu is the station scale needed to map relative predictions back to kWh.
    """
    xs, ys, meta = [], [], []
    for si, series in enumerate(series_list):
        for t in range(MIN_HISTORY_H - 1, series.hours - HORIZON):
            f = origin_features(series, t)
            y = target_row(series, t)
            if f is None or y is None:
                continue
            xs.append(f)
            ys.append(y)
            meta.append((si, t, float(series.window(t, MIN_HISTORY_H).mean())))
    if not xs:
        empty = np.zeros((0, INPUT_DIM), dtype=np.float32)
        return empty, np.zeros((0, HORIZON), dtype=np.float32), []
    return np.stack(xs), np.stack(ys), meta


def kwh_rows(Y_rel: np.ndarray, series_list: list[Series], meta) -> np.ndarray:
    """Absolute kWh targets for the same rows (single source of truth for metrics)."""
    out = np.zeros((len(meta), HORIZON), dtype=np.float32)
    for i, (si, t, _mu) in enumerate(meta):
        out[i] = series_list[si].values[t + 1 : t + 1 + HORIZON]
    return out


def naive_row(series: Series, t: int, lag: int = 168) -> np.ndarray:
    """Seasonal-naive forecast: repeat the same hour-of-week from `lag` hours back."""
    return series.values[t + 1 - lag : t + 1 + HORIZON - lag].astype(np.float32)


def weekly_mean_row(series: Series, t: int, weeks: int = 4) -> np.ndarray:
    """Strong statistical baseline: mean of the same hour-of-week over `weeks` weeks."""
    out = np.zeros(HORIZON, dtype=np.float32)
    for j in range(HORIZON):
        idx = [t + 1 + j - 168 * w for w in range(1, weeks + 1)]
        idx = [i for i in idx if i >= 0]
        out[j] = float(np.mean([series.values[i] for i in idx])) if idx else 0.0
    return out


# ---- serving-side helpers (same code path as training) ----


def parse_ts(value) -> datetime | None:
    """Strict RFC-3339 / ISO-8601 parser that always returns an aware UTC time.

    Returns None instead of raising: a bad caller timestamp must degrade the
    forecast (anchor on the server clock) rather than 500 the sidecar.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    if dt.year < 2000 or dt.year > 2100:
        return None  # a plausible-clock check: 1970 or 9999 is a data bug, not a forecast anchor
    return dt.astimezone(timezone.utc)


def series_from_values(label: str, values, start: datetime | None = None, step_hours: int = 1) -> Series:
    """Wrap a caller-supplied hourly history into the training-time contract."""
    arr = np.asarray(list(values) if not isinstance(values, np.ndarray) else values, dtype=np.float32).ravel()
    arr = np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0)
    arr = np.clip(arr, 0.0, None)
    anchor = (start or datetime.now(timezone.utc)).replace(minute=0, second=0, microsecond=0)
    # `start` is the FIRST observed hour; with a trailing history the origin sits at the end.
    first = anchor - timedelta(hours=step_hours * max(len(arr) - 1, 0))
    return Series(label=label, source="caller-history", start=first, values=arr)


def series_from_timed(label: str, timestamps, values) -> Series:
    """Wrap a timestamped history, refusing a non-contiguous hour grid.

    The whole point of the timestamp anchor is that hour-of-day and day-of-week
    come from the clock. A history with holes would silently shift the calendar
    features, so it is rejected instead of guessed at.
    """
    stamps = [parse_ts(ts) for ts in timestamps]
    if any(s is None for s in stamps):
        raise ValueError("timestamps must be RFC-3339 (e.g. 2026-10-25T13:00:00Z)")
    diffs = {int((b - a).total_seconds()) for a, b in zip(stamps, stamps[1:])}
    if diffs - {HOURS_SECONDS}:
        raise ValueError(f"history must be one contiguous hourly series, got gaps {sorted(diffs - {HOURS_SECONDS})}")
    arr = np.asarray(list(values), dtype=np.float32).ravel()
    arr = np.clip(np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0), 0.0, None)
    return Series(label=label, source="caller-history", start=stamps[0], values=arr)


# ---- conformal calibration (independent of any model family) ----


def conformal_table(residuals: np.ndarray, levels=QUANTILE_LEVELS) -> dict:
    """Per-horizon SIGNED residual quantiles (split conformal / Romano-style).

    residuals: (n_calibration, HORIZON) signed errors (truth - prediction).
    Quantile tau of the residuals, shifted by the finite-sample correction
    ceil(tau*(n+1))/n, is a distribution-free bound on the tau-quantile of the
    future error. Storing the signed quantiles (not |r|) means the interval is
    correctly asymmetric: demand has a long right tail and a hard left bound.
    """
    residuals = np.asarray(residuals, dtype=np.float64)
    if residuals.ndim != 2 or residuals.shape[1] != HORIZON:
        raise ValueError(f"residuals must be (n, {HORIZON}), got {residuals.shape}")
    n = residuals.shape[0]
    if n == 0:
        raise ValueError("conformal calibration needs at least one residual")
    table = {}
    for level in levels:
        adj = min(1.0, math.ceil(level * (n + 1)) / n)
        table[str(float(level))] = np.quantile(residuals, adj, axis=0).astype(np.float32).tolist()
    return {
        "method": "per-horizon signed residual quantiles (split conformal, finite-sample corrected)",
        "levels": [float(x) for x in levels],
        "n_calibration": int(n),
        "quantiles_kwh": table,
    }


def conformal_q(table: dict, level: float, horizon: int | None = None) -> np.ndarray:
    key = str(round(float(level), 6))
    q = table.get("quantiles_kwh", {})
    if key not in q:
        raise ValueError(f"conformal table has no quantile at level {level}")
    out = np.asarray(q[key], dtype=np.float32)
    if horizon is not None and len(out) != horizon:
        raise ValueError("conformal table horizon does not match the forecast")
    return out


def conformal_intervals(pred_kwh: np.ndarray, table: dict, level: float = INTERVAL_LEVEL):
    """Return (point, p_low, p_high) for a central interval at nominal `level`.

    The point estimate carries the median-residual bias correction, so a model
    that systematically under-predicts gets nudged — and what serving returns is
    exactly what the backtest scored (no train/serve drift).
    """
    pred = np.asarray(pred_kwh, dtype=np.float32)
    tail = round((1.0 - level) / 2.0, 6)
    h = pred.shape[-1]
    low_q = conformal_q(table, tail, h)
    high_q = conformal_q(table, round(1.0 - tail, 6), h)
    med = conformal_q(table, QUANTILE_LEVELS[1], h)
    point = np.maximum(pred + med, 0.0)
    low = np.maximum(pred + low_q, 0.0)
    high = np.maximum(pred + high_q, low)
    return point, low, high


def coverage(truth: np.ndarray, low: np.ndarray, high: np.ndarray) -> float:
    truth, low, high = (np.asarray(a, dtype=np.float64) for a in (truth, low, high))
    return float(np.mean((truth >= low - 1e-9) & (truth <= high + 1e-9)))


def pinball(truth: np.ndarray, q_pred: np.ndarray, tau: float) -> float:
    """Quantile (pinball) loss — the proper scoring rule for an interval bound."""
    truth, q_pred = np.asarray(truth, dtype=np.float64), np.asarray(q_pred, dtype=np.float64)
    diff = truth - q_pred
    return float(np.mean(np.maximum(tau * diff, (tau - 1.0) * diff)))


# ---- metrics ----


def metrics_kwh(truth: np.ndarray, pred: np.ndarray) -> dict:
    err = np.asarray(pred, dtype=np.float64) - np.asarray(truth, dtype=np.float64)
    return {"mae": float(np.mean(np.abs(err))), "rmse": float(np.sqrt(np.mean(err**2))), "n": int(err.size)}


def mase(truth: np.ndarray, pred: np.ndarray, naive: np.ndarray) -> float:
    """Mean absolute scaled error vs the seasonal-naive baseline (MASE < 1 = beats it)."""
    truth = np.asarray(truth, dtype=np.float64)
    base = float(np.mean(np.abs(truth - np.asarray(naive, dtype=np.float64))))
    if base <= EPS:
        return float("nan")  # a baseline that is exactly perfect cannot be scaled against
    return float(np.mean(np.abs(truth - np.asarray(pred, dtype=np.float64))) / base)


# ---- artifact integrity ----


def build_network(input_dim: int, hidden, horizon: int, device: str | None = None):
    """The layer stack, shared by the trainer, the backtest and the sidecar.

    Graph construction lives here (not duplicated in train.py and service.py) so
    the artifact can never be loaded into a network with a different topology
    than the one that produced the receipted error numbers.
    """
    import torch.nn as nn

    layers, prev = [], int(input_dim)
    for h in hidden or [128, 64]:
        layers += [nn.Linear(prev, int(h)), nn.ReLU()]
        prev = int(h)
    layers += [nn.Linear(prev, int(horizon))]
    net = nn.Sequential(*layers)
    return net.to(device) if device else net


def standardize(features, mean, scale):
    """Apply the scaler the artifact ships. One formula, used at train and serve."""
    arr = np.asarray(features, dtype=np.float32)
    m = np.asarray(mean, dtype=np.float32)
    s = np.asarray(scale, dtype=np.float32)
    if arr.shape[-1] != m.shape[0] or m.shape != s.shape:
        raise ValueError(f"feature width {arr.shape[-1]} does not match the scaler ({m.shape} vs {s.shape})")
    return (arr - m) / s


def payload_hash(obj: dict) -> str:
    """Deterministic digest of everything that makes the model what it is.

    Covers the architecture/spec, the scaler, the conformal table and every
    tensor byte of the state dict, so a swapped or truncated artifact is
    rejected at load time instead of serving subtly wrong numbers.
    """
    h = hashlib.sha256()
    meta = {k: v for k, v in obj.items() if k != "state_dict" and k != "payload_sha256"}
    h.update(json.dumps(meta, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8"))
    sd = obj.get("state_dict") or {}
    for key in sorted(sd.keys()):
        t = sd[key]
        arr = t.detach().cpu().numpy() if hasattr(t, "detach") else np.asarray(t)
        h.update(key.encode("utf-8") + b"\x00" + arr.astype(np.float32).tobytes() + str(arr.shape).encode())
    return h.hexdigest()


def file_sha256(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


__all__ = [
    "HORIZON",
    "LAGS",
    "MIN_HISTORY_H",
    "HIST_WINDOW",
    "FEATURE_VERSION",
    "ARTIFACT_FORMAT",
    "FEATURE_NAMES",
    "INPUT_DIM",
    "QUANTILE_LEVELS",
    "INTERVAL_LEVEL",
    "HOURS_SECONDS",
    "EPS",
    "RELATIVE_CLIP",
    "Series",
    "calendar_features",
    "origin_features",
    "target_row",
    "build_rows",
    "kwh_rows",
    "naive_row",
    "weekly_mean_row",
    "parse_ts",
    "series_from_values",
    "series_from_timed",
    "conformal_table",
    "conformal_q",
    "conformal_intervals",
    "coverage",
    "pinball",
    "metrics_kwh",
    "mase",
    "payload_hash",
    "file_sha256",
    "build_network",
    "standardize",
]
