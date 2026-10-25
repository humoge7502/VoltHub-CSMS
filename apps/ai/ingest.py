# VoltHub AI — real EV data ingestion (Tier 4 input).
#
# Turns public, licensed EV charging datasets into one contiguous hourly kWh
# panel per charging location, which train.py consumes instead of (or beside)
# the synthetic twin. Raw files never enter git (`data/` is gitignored); the
# derived panel is a regenerable .npz plus a committed provenance receipt.
#
# Sources (accessed 2026-10-25):
#   * "tennessee" — EV Charging Demand Prediction Dataset (public network
#     sessions, Tennessee + neighbouring states, Jan-2024..Jan-2025), CC-BY-4.0,
#     https://huggingface.co/datasets/jtupayac/EV_Charging_demand
#   * "norway"    — 35,000 measured residential charging sessions, 12 locations,
#     2019, CC-BY-4.0, doi:10.5281/zenodo.13896176 (Data in Brief 110883).
#   * "korea"     — 72,856 measured commercial charging transactions across 2,119
#     chargers, Sep-2021..Sep-2022, CC-BY-4.0, doi:10.6084/m9.figshare.22495141.v1
#     (Baek, Lee & Kim, Scientific Data 11:262, 2024). A third continent and a
#     second operator model: adds year-round seasonality and a fast/slow charger mix.
#   * Explicitly NOT used: "Global EV Charging Station Telemetry" — its own
#     README documents a simulation engine, so it would launder synthetic data
#     into a "real data" claim. Rejected on purpose, recorded in the receipt.
#
# Run:  python3 apps/ai/ingest.py [--raw data/raw --out data/hourly --fetch]

from __future__ import annotations

import argparse
import json
import math
import shutil
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
DEFAULT_RAW = HERE.parent.parent / "data" / "raw"
DEFAULT_OUT = HERE.parent.parent / "data" / "hourly"
RECEIPT = HERE / "reports" / "dataset.json"

HOUR = 3600
MIN_HOURS = 24 * 30  # a series this short cannot support a 168 h lag + backtest

TENNESSEE_FILES = [f"Se_{m:02d}_2024.csv" for m in range(1, 13)] + ["Se_01_2025.csv"]
TENNESSEE_URL = "https://huggingface.co/datasets/jtupayac/EV_Charging_demand/resolve/main/raw_charging_stations/{name}"
NORWAY_FILES = ["Dataset1_charging_reports.csv", "Dataset4_hourly_predictions.csv"]
NORWAY_URL = "https://zenodo.org/api/records/13896176/files/{name}/content"
KOREA_FILES = ["ChargingRecords.csv"]
KOREA_URL = "https://ndownloader.figshare.com/files/39952252"

PROVENANCE = {
    "tennessee": {
        "title": "EV Charging Demand Prediction Dataset (public charging network sessions)",
        "license": "CC-BY-4.0",
        "url": "https://huggingface.co/datasets/jtupayac/EV_Charging_demand",
        "period": "2024-01 .. 2025-01",
        "region": "Tennessee and neighbouring US states",
        "note": "Session records: start/end UTC + energy_kwh delivered per charging session.",
    },
    "norway": {
        "title": "Electric vehicle charging dataset with 35,000 charging sessions from 12 residential locations in Norway",
        "license": "CC-BY-4.0",
        "doi": "10.5281/zenodo.13896176",
        "url": "https://zenodo.org/records/13896176",
        "period": "2019",
        "region": "Norway (12 residential parking locations)",
        "note": "Hourly per-session energy from measured load profiles (Dataset4), aggregated to location-hours.",
    },
    "korea": {
        "title": "A dataset for multi-faceted analysis of electric vehicle charging transactions",
        "license": "CC-BY-4.0",
        "doi": "10.6084/m9.figshare.22495141.v1",
        "url": "https://figshare.com/articles/dataset/22495141",
        "period": "2022-09 .. 2023-09",
        "region": "Republic of Korea (commercial charging network, 2,119 chargers)",
        "note": "Measured session start/end (KST, localised to UTC) and delivered kWh; aggregated to charger-hours.",
    },
}

EXCLUDED = {
    "EduDevCommons/Global-EV-Charging-Station-Telemetry": (
        "README states the telemetry is produced by a 'Telemetry Simulation Engine'; "
        "using it would mislabel synthetic data as real observations."
    )
}


# ---- helpers ----


def _floor_hour(dt: datetime) -> datetime:
    return dt.replace(minute=0, second=0, microsecond=0, tzinfo=dt.tzinfo or timezone.utc)


def _to_utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def _blank(start: datetime, hours: int) -> np.ndarray:
    return np.zeros(hours, dtype=np.float32)


def _add_span(grid: np.ndarray, base_hour: datetime, start: datetime, end: datetime, kwh: float) -> None:
    """Spread `kwh` across the hours a session overlaps, weighted by overlap fraction."""
    a = max(0, int((start - base_hour).total_seconds() // HOUR))
    b = min(grid.shape[0], int(math.ceil((end - base_hour).total_seconds() / HOUR)))
    if b <= a:
        return
    if b - a == 1:
        grid[a] += kwh
        return
    dur = max((end - start).total_seconds(), 1.0)
    for i in range(a, b):
        h0 = base_hour + timedelta(hours=i)
        h1 = h0 + timedelta(hours=1)
        overlap = (min(end, h1) - max(start, h0)).total_seconds()
        if overlap > 0:
            grid[i] += kwh * (overlap / dur)


def _contiguous(values: np.ndarray, start: datetime):
    """Trim a grid to [first, last] non-zero hour so leading/trailing dead space is dropped."""
    nz = np.nonzero(values)[0]
    if nz.size == 0:
        return None, None
    lo, hi = int(nz[0]), int(nz[-1]) + 1
    return start + timedelta(hours=lo), values[lo:hi]


# ---- source loaders (each returns contract.Series list + stats) ----


def load_tennessee(raw_dir: Path, max_stations: int = 40):
    from contract import Series

    import pandas as pd

    files = sorted((raw_dir / "tennessee").glob("Se_*.csv"))
    if not files:
        return [], {"error": "no tennessee CSVs"}
    frames = []
    for f in files:
        df = pd.read_csv(
            f,
            usecols=["charger_id", "session_id", "session_start", "session_end", "energy_kwh", "peak_power_kw"],
        )
        frames.append(df)
    df = pd.concat(frames, ignore_index=True)
    raw_sessions = int(len(df))
    df = df.dropna(subset=["session_start", "session_end", "energy_kwh", "charger_id"])
    df["energy_kwh"] = pd.to_numeric(df["energy_kwh"], errors="coerce")
    df = df[df["energy_kwh"] > 0.0]
    start = pd.to_datetime(df["session_start"], utc=True, errors="coerce", format="ISO8601")
    end = pd.to_datetime(df["session_end"], utc=True, errors="coerce", format="ISO8601")
    df = df.assign(_start=start, _end=end)
    df = df.dropna(subset=["_start", "_end"])
    dur_h = (df["_end"] - df["_start"]).dt.total_seconds() / HOUR
    # A public-session record longer than a day is a metering/reporting artefact,
    # not a charging load — smearing it would invent demand.
    df = df[(dur_h > 0) & (dur_h <= 24)]
    by_charger = df.groupby("charger_id")["energy_kwh"].sum().sort_values(ascending=False)
    keep = set(by_charger.head(max_stations).index)
    base = _floor_hour(_to_utc(df["_start"].min().to_pydatetime()))
    horizon = int(((_floor_hour(_to_utc(df["_end"].max().to_pydatetime())) - base).total_seconds() // HOUR)) + 2
    series, total_kwh = [], 0.0
    for charger in sorted(keep):
        rows = df[df["charger_id"] == charger]
        grid = _blank(base, horizon)
        for s, e, kwh in zip(rows["_start"], rows["_end"], rows["energy_kwh"]):
            _add_span(grid, base, _floor_hour(s.to_pydatetime()), _floor_hour(e.to_pydatetime()), float(kwh))
        trimmed, vals = _contiguous(grid, base)
        if trimmed is None or len(vals) < MIN_HOURS:
            continue
        series.append(Series(label=f"US-TN:{charger}", source="tennessee", start=trimmed, values=vals))
        total_kwh += float(vals.sum())
    stats = {
        "raw_rows": raw_sessions,
        "usable_sessions": int(len(df[df["charger_id"].isin(keep)])),
        "stations_kept": len(series),
        "hours_span": horizon,
        "total_kwh": round(total_kwh, 1),
        "zero_share": round(float(np.mean([float(np.mean(s.values == 0)) for s in series])), 4) if series else None,
        "aggregation": "session energy spread over the hours it overlaps (overlap-weighted)",
    }
    return series, stats


def load_norway(raw_dir: Path, max_stations: int = 40):
    from contract import Series

    import pandas as pd

    path = raw_dir / "norway" / "Dataset4_hourly_predictions.csv"
    if not path.exists():
        return [], {"error": "no norway Dataset4 CSV"}
    # Measured hourly per-session energy, semicolon separated with comma decimals.
    df = pd.read_csv(
        path,
        sep=";",
        decimal=",",
        na_values=["NA", ""],
        usecols=["user_id", "session_id", "date_from", "energy_charged_i"],
    )
    raw_rows = int(len(df))
    df["energy_charged_i"] = pd.to_numeric(df["energy_charged_i"], errors="coerce")
    df = df.dropna(subset=["user_id", "date_from", "energy_charged_i"])
    df = df[df["energy_charged_i"] > 0]
    df["date_from"] = pd.to_datetime(df["date_from"], errors="coerce")
    df = df.dropna(subset=["date_from"])
    # The dataset keys spots as "<LOCATION>_Plass<n>" / "<LOCATION>_Bl<n>-<m>";
    # a VoltHub "station" is the physical location, so group on the location prefix.
    df["location"] = df["user_id"].astype(str).str.split("_").str[0]
    per_loc = df.groupby("location")["energy_charged_i"].sum().sort_values(ascending=False)
    keep = list(per_loc.head(max_stations).index)
    series, total_kwh = [], 0.0
    for loc in sorted(keep):
        rows = df[df["location"] == loc]
        agg = rows.groupby("date_from")["energy_charged_i"].sum()
        idx = agg.index.to_pydatetime()
        idx = [_to_utc(pd.Timestamp(d).to_pydatetime()) for d in idx]
        start, end = min(idx), max(idx)
        horizon = int((end - start).total_seconds() // HOUR) + 1
        grid = _blank(start, horizon)
        for ts, kwh in zip(idx, agg.values):
            grid[int((ts - start).total_seconds() // HOUR)] += float(kwh)
        if len(grid) < MIN_HOURS:
            continue
        series.append(Series(label=f"NO:{loc}", source="norway", start=start, values=grid))
        total_kwh += float(grid.sum())
    stats = {
        "raw_rows": raw_rows,
        "usable_rows": int(len(df)),
        "stations_kept": len(series),
        "total_kwh": round(total_kwh, 1),
        "zero_share": round(float(np.mean([float(np.mean(s.values == 0)) for s in series])), 4) if series else None,
        "aggregation": "hourly measured energy summed per location-hour; gaps on the hour grid are true zeros",
    }
    return series, stats


def load_korea(raw_dir: Path, max_stations: int = 40):
    """Measured commercial transactions (Baek et al. 2024), charger-hours in UTC.

    Timestamps in the published CSV are local Korean time (KST, UTC+9, no DST).
    Treating them as UTC would shift every calendar feature by nine hours — the
    model would learn an evening peak at lunchtime. They are converted here, once,
    so train and serve agree about what "18:00" means.
    """
    from contract import Series

    import pandas as pd

    path = raw_dir / "korea" / "ChargingRecords.csv"
    if not path.exists():
        return [], {"error": "no korea ChargingRecords.csv"}
    df = pd.read_csv(
        path,
        usecols=["ChargerID", "Location", "ChargerType", "StartDatetime", "EndDatetime", "Demand"],
    )
    raw_rows = int(len(df))
    df["Demand"] = pd.to_numeric(df["Demand"], errors="coerce")
    df = df.dropna(subset=["ChargerID", "StartDatetime", "EndDatetime", "Demand"])
    df = df[df["Demand"] > 0]
    start = pd.to_datetime(df["StartDatetime"], errors="coerce", format="%Y-%m-%d %H:%M")
    end = pd.to_datetime(df["EndDatetime"], errors="coerce", format="%Y-%m-%d %H:%M")
    df = df.assign(_start=start, _end=end).dropna(subset=["_start", "_end"])
    dur_h = (df["_end"] - df["_start"]).dt.total_seconds() / HOUR
    # Same outlier rule as Tennessee: a "session" longer than a day is a reporting
    # artefact, and smearing it would invent demand.
    df = df[(dur_h > 0) & (dur_h <= 24)]
    df["_start"] = df["_start"] + pd.Timedelta(hours=9)
    df["_end"] = df["_end"] + pd.Timedelta(hours=9)
    by_charger = df.groupby("ChargerID")["Demand"].sum().sort_values(ascending=False)
    keep = set(by_charger.head(max_stations).index)
    base = _floor_hour(_to_utc(df["_start"].min().to_pydatetime()))
    horizon = int(((_floor_hour(_to_utc(df["_end"].max().to_pydatetime())) - base).total_seconds() // HOUR)) + 2
    series, total_kwh, categories = [], 0.0, {}
    for charger in sorted(keep):
        rows = df[df["ChargerID"] == charger]
        grid = _blank(base, horizon)
        for s, e, kwh in zip(rows["_start"], rows["_end"], rows["Demand"]):
            _add_span(grid, base, _floor_hour(s.to_pydatetime()), _floor_hour(e.to_pydatetime()), float(kwh))
        trimmed, vals = _contiguous(grid, base)
        if trimmed is None or len(vals) < MIN_HOURS:
            continue
        label = f"KR:{int(charger)}"
        series.append(Series(label=label, source="korea", start=trimmed, values=vals))
        categories[label] = {
            "location": str(rows["Location"].mode().iloc[0]) if len(rows) else None,
            "charger_type": str(int(rows["ChargerType"].mode().iloc[0])) if len(rows) else None,
        }
        total_kwh += float(vals.sum())
    stats = {
        "raw_rows": raw_rows,
        "usable_sessions": int(len(df[df["ChargerID"].isin(keep)])),
        "stations_kept": len(series),
        "hours_span": horizon,
        "total_kwh": round(total_kwh, 1),
        "zero_share": round(float(np.mean([float(np.mean(s.values == 0)) for s in series])), 4) if series else None,
        "aggregation": "session energy spread over the hours it overlaps (overlap-weighted), KST localised to UTC",
        "categories": categories,
    }
    return series, stats


LOADERS = {"tennessee": load_tennessee, "norway": load_norway, "korea": load_korea}


# ---- fetch (opt-in, checksums recorded) ----


def fetch(raw_dir: Path, timeout: int = 600) -> dict:
    out = {}
    dest = raw_dir / "tennessee"
    dest.mkdir(parents=True, exist_ok=True)
    for name in TENNESSEE_FILES:
        p = dest / name
        if p.exists() and p.stat().st_size > 0:
            out[str(p)] = "cached"
            continue
        url = TENNESSEE_URL.format(name=name)
        with urllib.request.urlopen(url, timeout=timeout) as r, open(p, "wb") as f:
            shutil.copyfileobj(r, f)
        out[str(p)] = url
    dest = raw_dir / "norway"
    dest.mkdir(parents=True, exist_ok=True)
    for name in NORWAY_FILES:
        p = dest / name
        if p.exists() and p.stat().st_size > 0:
            out[str(p)] = "cached"
            continue
        url = NORWAY_URL.format(name=name)
        with urllib.request.urlopen(url, timeout=timeout) as r, open(p, "wb") as f:
            shutil.copyfileobj(r, f)
        out[str(p)] = url
    dest = raw_dir / "korea"
    dest.mkdir(parents=True, exist_ok=True)
    for name in KOREA_FILES:
        p = dest / name
        if p.exists() and p.stat().st_size > 0:
            out[str(p)] = "cached"
            continue
        with urllib.request.urlopen(KOREA_URL, timeout=timeout) as r, open(p, "wb") as f:
            shutil.copyfileobj(r, f)
        out[str(p)] = KOREA_URL
    return out


# ---- panel build + load ----


def build_panel(raw_dir: Path = DEFAULT_RAW, out_dir: Path = DEFAULT_OUT, max_stations: int = 40) -> dict:
    from contract import file_sha256

    all_series, stats = [], {}
    for name, loader in LOADERS.items():
        series, st = loader(raw_dir, max_stations=max_stations)
        st["provenance"] = PROVENANCE[name]
        st["hours"] = int(sum(s.hours for s in series))
        stats[name] = st
        all_series.extend(series)
    if not all_series:
        raise SystemExit(
            f"no real data found under {raw_dir} — run `python3 apps/ai/ingest.py --fetch` first (needs network)"
        )

    # Long format keeps one contiguous grid per series without a sparse matrix.
    station_idx, hour_epoch, kwh, labels = [], [], [], []
    for si, s in enumerate(all_series):
        h = np.arange(s.hours)
        epoch = np.array([int(s.ts(i).timestamp()) for i in h], dtype=np.int64)
        station_idx.append(np.full(s.hours, si, dtype=np.int16))
        hour_epoch.append(epoch)
        kwh.append(s.values.astype(np.float32))
        labels.append({"index": si, "label": s.label, "source": s.source, "hours": s.hours,
                       "start_utc": s.ts(0).isoformat(), "mean_kwh": round(float(s.values.mean()), 4)})
    out_dir.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        out_dir / "panel.npz",
        station_idx=np.concatenate(station_idx),
        hour_epoch=np.concatenate(hour_epoch),
        kwh=np.concatenate(kwh),
    )
    raw_digests = {}
    for p in sorted(
        list((raw_dir / "tennessee").glob("*.csv"))
        + list((raw_dir / "norway").glob("*.csv"))
        + list((raw_dir / "korea").glob("*.csv"))
    ):
        raw_digests[p.name] = file_sha256(p)
    receipt = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "panel": {
            "series": len(all_series),
            "station_hours": int(sum(s.hours for s in all_series)),
            "total_kwh": round(float(sum(float(s.values.sum()) for s in all_series)), 1),
            "sources": sorted({s.source for s in all_series}),
        },
        "per_source": stats,
        "stations": labels,
        "raw_sha256": raw_digests,
        "excluded_sources": EXCLUDED,
        "citations": [
            "EV Charging Demand Prediction Dataset, CC-BY-4.0, huggingface.co/datasets/jtupayac/EV_Charging_demand",
            "Andersen et al., Data in Brief 55 (2024) 110883, doi:10.5281/zenodo.13896176, CC-BY-4.0",
            "Baek, Lee & Kim, Scientific Data 11:262 (2024), doi:10.6084/m9.figshare.22495141.v1, CC-BY-4.0",
        ],
    }
    RECEIPT.parent.mkdir(parents=True, exist_ok=True)
    RECEIPT.write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    (out_dir / "stations.json").write_text(json.dumps(labels, indent=2), encoding="utf-8")
    return receipt


def load_panel(out_dir: Path = DEFAULT_OUT):
    """Read the derived panel back as contract.Series list (empty when absent)."""
    from contract import Series

    path = out_dir / "panel.npz"
    meta = out_dir / "stations.json"
    if not path.exists() or not meta.exists():
        return []
    z = np.load(path)
    labels = json.loads(meta.read_text(encoding="utf-8"))
    idx = z["station_idx"]
    epoch = z["hour_epoch"]
    kwh = z["kwh"]
    series = []
    for row in labels:
        si = row["index"]
        sel = idx == si
        e = np.sort(epoch[sel])
        vals = kwh[sel][np.argsort(epoch[sel])]
        start = datetime.fromtimestamp(int(e[0]), tz=timezone.utc)
        series.append(Series(label=row["label"], source=row["source"], start=start, values=vals.astype(np.float32)))
    return series


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", type=Path, default=DEFAULT_RAW)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--fetch", action="store_true", help="download the licensed source files first")
    ap.add_argument("--max-stations", type=int, default=40)
    args = ap.parse_args()
    if args.fetch:
        print("[ingest] fetching source files ...")
        for p, v in fetch(args.raw).items():
            print(f"  {Path(p).name}: {v}")
    receipt = build_panel(args.raw, args.out, max_stations=args.max_stations)
    print(f"[ingest] panel: {receipt['panel']['series']} stations, "
          f"{receipt['panel']['station_hours']} station-hours, {receipt['panel']['total_kwh']:.0f} kWh")
    for name, st in receipt["per_source"].items():
        print(f"  {name}: {st.get('stations_kept')} stations, {st.get('total_kwh', 0):.0f} kWh "
              f"(zero share {st.get('zero_share')})")
    print(f"[ingest] provenance receipt -> {RECEIPT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
