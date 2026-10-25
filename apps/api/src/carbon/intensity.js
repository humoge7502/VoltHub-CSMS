// CarbonPilot: grid-carbon accounting and carbon-aware scheduling (ADR-0017).
//
// Why this file exists: a CSMS that shifts a kWh from 19:00 to 03:00 can cut the
// emissions attributable to that kWh by 20–40 % on a coal-heavy grid — but only if
// the decision is made against a stated, reproducible carbon signal and the saving
// is booked with the same rigour as the money. This module is that signal.
//
// Design rules (each one is a defect we refuse to ship):
//  * Deterministic by default. No network call is required for a plan, a receipt or
//    a test. The model is a pure function of (region, timestamp), so the same input
//    always produces the same grams. A live provider can be plugged in later without
//    changing the accounting contract.
//  * Average intensity for ACCOUNTING, marginal intensity for SCHEDULING. A receipt
//    answers "how dirty was the energy I actually used"; a schedule answers "what
//    does one more kWh at this hour displace". Conflating them is how carbon claims
//    become marketing.
//  * The regional baseline is published with every receipt, so "avoided" means
//    "versus the annual average for this grid", never "versus a number we liked".
//  * Unknown station => GLOBAL, not a flattering low-carbon guess.
//
// The model is intentionally simple: a base intensity per grid, a two-peak diurnal
// shape (morning/evening), a midday solar dip, a seasonal term and a deterministic
// ±3 % weather-like modulation. It is calibrated to public annual averages, and the
// output is labelled `model-v1` everywhere so no consumer can mistake it for a
// metered reading or a market price.

'use strict';
const crypto = require('crypto');

const MODEL_VERSION = 'model-v1';
const DEFAULT_REGION = 'GLOBAL';
// Social cost of carbon used to turn grams into the same currency as the tariff.
// Rs 4,200/tCO2e is deliberately mid-range and configurable: the scheduler's job is
// to rank hours, not to claim a universal price of damage.
const SOCIAL_COST_INR_PER_TONNE = clampNumber(process.env.CARBON_SOCIAL_COST_INR_PER_TONNE, 0, 100000, 4200);
const DEFAULT_WEIGHT = clampNumber(process.env.CARBON_DEFAULT_WEIGHT, 0, 1, 0);
const MIN_G = 5;
const MAX_G = 1400;

function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
function round(v, dp = 3) {
  const f = 10 ** dp;
  return Math.round((Number(v) || 0) * f) / f;
}

// Annual average grid intensity (gCO2e/kWh), renewable share and shape parameters.
// Sources are public annual grid averages (IEA/Ember/EA 2023–24); the diurnal shape
// is calibrated so a solar-heavy grid dips at midday and a coal-heavy grid peaks in
// the evening. `peak_doy` is the day of year of the seasonal maximum.
const REGIONS = {
  'IN-TN': {
    label: 'Tamil Nadu, India',
    country: 'IN',
    base_g_per_kwh: 640,
    renewable_share: 0.34,
    solar: 1.0,
    seasonal_amp: 0.05,
    peak_doy: 135,
    utc_offset_h: 5.5,
  },
  IN: {
    label: 'India (national average)',
    country: 'IN',
    base_g_per_kwh: 710,
    renewable_share: 0.23,
    solar: 1.0,
    seasonal_amp: 0.04,
    peak_doy: 135,
    utc_offset_h: 5.5,
  },
  NO: {
    label: 'Norway',
    country: 'NO',
    base_g_per_kwh: 30,
    renewable_share: 0.98,
    solar: 0.15,
    seasonal_amp: 0.12,
    peak_doy: 15,
    utc_offset_h: 1,
  },
  'US-TN': {
    label: 'Tennessee, USA',
    country: 'US',
    base_g_per_kwh: 380,
    renewable_share: 0.28,
    solar: 0.65,
    seasonal_amp: 0.14,
    peak_doy: 15,
    utc_offset_h: -6,
  },
  'US-CA': {
    label: 'California, USA',
    country: 'US',
    base_g_per_kwh: 240,
    renewable_share: 0.54,
    solar: 1.3,
    seasonal_amp: 0.08,
    peak_doy: 210,
    utc_offset_h: -8,
  },
  KR: {
    label: 'Republic of Korea',
    country: 'KR',
    base_g_per_kwh: 420,
    renewable_share: 0.09,
    solar: 0.55,
    seasonal_amp: 0.1,
    peak_doy: 15,
    utc_offset_h: 9,
  },
  GB: {
    label: 'Great Britain',
    country: 'GB',
    base_g_per_kwh: 210,
    renewable_share: 0.47,
    solar: 0.5,
    seasonal_amp: 0.1,
    peak_doy: 15,
    utc_offset_h: 0,
  },
  EU: {
    label: 'European Union (average)',
    country: 'EU',
    base_g_per_kwh: 250,
    renewable_share: 0.45,
    solar: 0.8,
    seasonal_amp: 0.1,
    peak_doy: 15,
    utc_offset_h: 1,
  },
  GLOBAL: {
    label: 'Global average (fallback)',
    country: null,
    base_g_per_kwh: 480,
    renewable_share: 0.3,
    solar: 0.8,
    seasonal_amp: 0.06,
    peak_doy: 15,
    utc_offset_h: 0,
  },
};

const REGION_ALIASES = {
  'IN-TAMILNADU': 'IN-TN',
  'IN-TN': 'IN-TN',
  TAMILNADU: 'IN-TN',
  CHENNAI: 'IN-TN',
  INDIA: 'IN',
  NORWAY: 'NO',
  TENNESSEE: 'US-TN',
  'US-TENNESSEE': 'US-TN',
  'US-TN': 'US-TN',
  CALIFORNIA: 'US-CA',
  'US-CA': 'US-CA',
  KOREA: 'KR',
  'SOUTH-KOREA': 'KR',
  'KR-SE': 'KR',
  UK: 'GB',
  'GREAT-BRITAIN': 'GB',
  EUROPE: 'EU',
  GLOBAL: 'GLOBAL',
};

function normalizeRegion(region) {
  const raw = String(region || '')
    .trim()
    .toUpperCase()
    .replace(/[\s_]+/g, '-');
  if (!raw) return DEFAULT_REGION;
  if (REGIONS[raw]) return raw;
  if (REGION_ALIASES[raw]) return REGION_ALIASES[raw];
  // Accept "IN-TN:something" style labels and ISO suffixes.
  for (const key of Object.keys(REGIONS)) {
    if (raw.startsWith(`${key}-`) || raw.startsWith(`${key}:`)) return key;
  }
  return DEFAULT_REGION;
}

function regionList() {
  const at = Date.now();
  return Object.entries(REGIONS).map(([id, r]) => ({
    region: id,
    label: r.label,
    country: r.country,
    base_g_per_kwh: r.base_g_per_kwh,
    renewable_share: r.renewable_share,
    current_g_per_kwh: intensityAt(id, at).g_per_kwh,
    band: intensityAt(id, at).band,
    model: MODEL_VERSION,
  }));
}

// Map a station row to a grid region. An explicit `carbon_region` wins; otherwise
// state/city/country names are matched. An unrecognised station must not inherit a
// flattering low-carbon default — it gets GLOBAL until an operator sets the region.
function regionForStation(station) {
  if (!station) return DEFAULT_REGION;
  if (station.carbon_region) {
    const explicit = normalizeRegion(station.carbon_region);
    if (explicit !== DEFAULT_REGION || String(station.carbon_region).toUpperCase() === DEFAULT_REGION) return explicit;
  }
  const hay = [station.state, station.city, station.address_line, station.country]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (/tamil\s*nadu|chennai|kanchipuram|chengalpattu/.test(hay)) return 'IN-TN';
  if (/tennessee|nashville|knoxville|memphis|chattanooga/.test(hay)) return 'US-TN';
  if (/california|los angeles|san francisco|san diego|san jose/.test(hay)) return 'US-CA';
  if (/norway|oslo|bergen|trondheim|stavanger/.test(hay)) return 'NO';
  if (/korea|seoul|busan|incheon|daegu|gwangju/.test(hay)) return 'KR';
  if (/united kingdom|\buk\b|london|england|scotland|wales/.test(hay)) return 'GB';
  if (/germany|france|netherlands|spain|italy|belgium|europe|\beu\b/.test(hay)) return 'EU';
  if (station.country) {
    const byCountry = normalizeRegion(station.country);
    if (byCountry !== DEFAULT_REGION) return byCountry;
  }
  return DEFAULT_REGION;
}

// Deterministic ±3 % "weather" term. A hash keeps the model reproducible across
// processes and replicas (Math.random would make two identical plans disagree).
function weatherJitter(regionId, dayKey) {
  const h = crypto.createHash('sha256').update(`${MODEL_VERSION}:${regionId}:${dayKey}`).digest();
  return (h.readUInt16BE(0) / 65535) * 2 - 1;
}

function localParts(at, offsetH) {
  const ms = Number(at instanceof Date ? at.getTime() : at);
  const shifted = new Date(ms + offsetH * 3600000);
  return {
    hour: shifted.getUTCHours() + shifted.getUTCMinutes() / 60,
    dow: shifted.getUTCDay(),
    doy: Math.floor((shifted.getTime() - Date.UTC(shifted.getUTCFullYear(), 0, 1)) / 86400000) + 1,
    dayKey: shifted.toISOString().slice(0, 10),
  };
}

function bandFor(g) {
  if (g <= 100) return 'VERY_LOW';
  if (g <= 200) return 'LOW';
  if (g <= 350) return 'MODERATE';
  if (g <= 550) return 'HIGH';
  return 'VERY_HIGH';
}

// Average grid intensity at an instant. Pure; never throws on a bad region/time
// (a reporting surface must degrade, not 500 in the middle of a plan cycle).
function intensityAt(regionId, at = Date.now()) {
  const id = normalizeRegion(regionId);
  const r = REGIONS[id];
  const ms = Number(at instanceof Date ? at.getTime() : at);
  if (!Number.isFinite(ms))
    return { region: id, at: new Date(0).toISOString(), g_per_kwh: r.base_g_per_kwh, ...meta(r) };
  const p = localParts(ms, r.utc_offset_h);
  // Two demand peaks and one solar dip. Normalised to roughly [-1, +1].
  const morning = Math.exp(-0.5 * ((p.hour - 8.5) / 2.6) ** 2);
  const evening = Math.exp(-0.5 * ((p.hour - 19) / 2.9) ** 2);
  const solar = Math.exp(-0.5 * ((p.hour - 13) / 3.2) ** 2);
  const diurnal = 1 + 0.18 * morning + 0.26 * evening - 0.26 * r.solar * solar;
  const weekend = p.dow === 0 || p.dow === 6 ? 0.97 : 1;
  const seasonal = 1 + r.seasonal_amp * Math.cos((2 * Math.PI * (p.doy - r.peak_doy)) / 365);
  const jitter = 1 + 0.03 * weatherJitter(id, p.dayKey);
  const g = clamp(round(r.base_g_per_kwh * diurnal * weekend * seasonal * jitter, 3), MIN_G, MAX_G);
  return {
    region: id,
    at: new Date(ms).toISOString(),
    g_per_kwh: g,
    // Marginal emissions: the next kWh follows the marginal plant, which is dirtier
    // than the fleet average while the evening peak is on the margin.
    marginal_g_per_kwh: round(g * (1 + 0.12 * evening + 0.04 * morning), 3),
    band: bandFor(g),
    local_hour: round(p.hour, 2),
    ...meta(r),
    model: MODEL_VERSION,
    source: 'model',
  };
}

function meta(r) {
  return { base_g_per_kwh: r.base_g_per_kwh, renewable_share: r.renewable_share, label: r.label };
}

// Hourly (or finer) forecast. `hours` and `step_min` are clamped: this is a public
// surface and an unbounded array is a cheap denial of service.
function forecast({ region = DEFAULT_REGION, from = Date.now(), hours = 48, stepMin = 60 } = {}) {
  const id = normalizeRegion(region);
  const h = Math.round(clampNumber(hours, 1, 168, 48));
  const step = [15, 30, 60].includes(Number(stepMin)) ? Number(stepMin) : 60;
  const start = Math.floor(Number(from) / (step * 60000)) * step * 60000;
  if (!Number.isFinite(start)) return { region: id, step_min: step, points: [], summary: null };
  const points = [];
  const count = Math.ceil((h * 60) / step);
  for (let i = 0; i < count; i++) {
    const at = start + i * step * 60000;
    const row = intensityAt(id, at);
    points.push({ at: row.at, g_per_kwh: row.g_per_kwh, marginal_g_per_kwh: row.marginal_g_per_kwh, band: row.band });
  }
  const vals = points.map((p) => p.g_per_kwh);
  const cleanest = points.reduce((a, b) => (b.g_per_kwh < a.g_per_kwh ? b : a), points[0]);
  const dirtiest = points.reduce((a, b) => (b.g_per_kwh > a.g_per_kwh ? b : a), points[0]);
  return {
    region: id,
    label: REGIONS[id].label,
    renewable_share: REGIONS[id].renewable_share,
    base_g_per_kwh: REGIONS[id].base_g_per_kwh,
    step_min: step,
    hours: h,
    points,
    summary: {
      current_g_per_kwh: points[0].g_per_kwh,
      average_g_per_kwh: round(vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length), 3),
      min_g_per_kwh: cleanest.g_per_kwh,
      max_g_per_kwh: dirtiest.g_per_kwh,
      cleanest_at: cleanest.at,
      dirtiest_at: dirtiest.at,
      spread_pct: cleanest.g_per_kwh
        ? round(((dirtiest.g_per_kwh - cleanest.g_per_kwh) / cleanest.g_per_kwh) * 100, 2)
        : 0,
      band: bandFor(points[0].g_per_kwh),
    },
    model: MODEL_VERSION,
    source: 'model',
  };
}

// Carbon accounting for a solved schedule: energy in each interval × the average
// intensity of that interval. Returns g/CO2e, kg, intensity and the cleanest and
// dirtiest intervals actually used (the audit trail behind the number).
function forSchedule({ schedule, ticks, dtMin = 15, region = DEFAULT_REGION } = {}) {
  const id = normalizeRegion(region);
  const dtH = Number(dtMin) / 60;
  const list = Array.isArray(ticks) && ticks.length ? ticks : [];
  let energy = 0;
  let grams = 0;
  const bySlot = [];
  for (const [sid, row] of Object.entries(schedule || {})) {
    let vehicleEnergy = 0;
    (row || []).forEach((kwh, i) => {
      const e = Math.max(0, Number(kwh) || 0);
      if (e <= 1e-12) return;
      const at = list[i] ?? (list[0] || Date.now()) + i * dtH * 3600000;
      const rowInt = intensityAt(id, at);
      vehicleEnergy += e;
      energy += e;
      grams += e * rowInt.g_per_kwh;
      bySlot.push({ slot: i, at: new Date(Number(at)).toISOString(), g_per_kwh: rowInt.g_per_kwh, kwh: round(e, 4) });
    });
    if (vehicleEnergy) bySlot.push({ session_id: Number(sid), kwh: round(vehicleEnergy, 4) });
  }
  const used = bySlot.filter((x) => x.slot != null);
  const cleanest = used.length ? used.reduce((a, b) => (b.g_per_kwh < a.g_per_kwh ? b : a)) : null;
  const dirtiest = used.length ? used.reduce((a, b) => (b.g_per_kwh > a.g_per_kwh ? b : a)) : null;
  const baselineG = energy * REGIONS[id].base_g_per_kwh;
  return {
    region: id,
    label: REGIONS[id].label,
    model: MODEL_VERSION,
    energy_kwh: round(energy, 4),
    carbon_g: round(grams, 3),
    carbon_kg: round(grams / 1000, 4),
    intensity_g_per_kwh: energy > 0 ? round(grams / energy, 3) : null,
    baseline_g: round(baselineG, 3),
    baseline_kg: round(baselineG / 1000, 4),
    avoided_g: round(baselineG - grams, 3),
    avoided_kg: round((baselineG - grams) / 1000, 4),
    avoided_pct: baselineG > 0 ? round(((baselineG - grams) / baselineG) * 100, 2) : 0,
    cleanest_slot: cleanest,
    dirtiest_slot: dirtiest,
    social_cost_inr_per_tonne: SOCIAL_COST_INR_PER_TONNE,
  };
}

// A per-session carbon receipt derived from the meter trail. Energy is attributed
// to the interval between consecutive readings (trapezoid-free, conservative: the
// delta is booked at the later reading's timestamp, so a spike is charged at the
// dirtier of the two hours, never the cleaner one). The synthetic final segment
// (stop meter above the last reading) is booked at ended_at.
function receiptForSession(store, sessionId, opts = {}) {
  const sid = Number(sessionId);
  const sess = store?.sessions?.get?.(sid);
  if (!sess) return null;
  const cp =
    store.cps.get(Number(sess.cp_id)) || store.cps.get(Number(String(sess.connector_ref || '').split(':')[0])) || null;
  const station = cp ? store.stations.get(cp.station_id) : null;
  const region = normalizeRegion(opts.region || regionForStation(station));
  const readings = (store.readingsFor ? store.readingsFor(sid) : store.readings.filter((r) => r.session_id === sid))
    .slice()
    .sort((a, b) => Date.parse(a.taken_at) - Date.parse(b.taken_at) || Number(a.seq_no) - Number(b.seq_no));
  const points = [];
  let prevKwh = Math.max(0, Number(sess.start_meter_kwh) || 0);
  let prevAt = Date.parse(sess.started_at) || Date.now();
  for (const r of readings) {
    const kwh = Number(r.meter_kwh);
    if (!Number.isFinite(kwh)) continue;
    const at = Date.parse(r.taken_at);
    const delta = kwh - prevKwh;
    if (Number.isFinite(at) && delta > 1e-9) points.push({ at, kwh: delta });
    if (Number.isFinite(kwh) && kwh > prevKwh) prevKwh = kwh;
    if (Number.isFinite(at)) prevAt = at;
  }
  const endKwh = Number(sess.end_meter_kwh);
  if (Number.isFinite(endKwh) && endKwh > prevKwh + 1e-9) {
    const at = Date.parse(sess.ended_at) || prevAt;
    points.push({ at, kwh: endKwh - prevKwh });
  }
  if (!points.length && Number(sess.energy_kwh) > 0) {
    points.push({ at: Date.parse(sess.ended_at) || prevAt, kwh: Number(sess.energy_kwh) });
  }
  const enriched = points.map((p) => {
    const row = intensityAt(region, p.at);
    return {
      at: new Date(p.at).toISOString(),
      kwh: round(p.kwh, 6),
      g_per_kwh: row.g_per_kwh,
      carbon_g: round(p.kwh * row.g_per_kwh, 6),
    };
  });
  const energy = enriched.reduce((a, p) => a + p.kwh, 0);
  const grams = enriched.reduce((a, p) => a + p.carbon_g, 0);
  const baselineG = energy * REGIONS[region].base_g_per_kwh;
  const body = {
    receipt_version: 'carbon-receipt-v1',
    model: MODEL_VERSION,
    session_id: sid,
    connector_ref: sess.connector_ref,
    station_id: cp ? cp.station_id : null,
    station_name: station ? station.name : null,
    user_id: sess.user_id,
    region,
    region_label: REGIONS[region].label,
    renewable_share: REGIONS[region].renewable_share,
    started_at: sess.started_at,
    ended_at: sess.ended_at,
    state: sess.state,
    energy_kwh: round(energy, 4),
    carbon_g: round(grams, 3),
    carbon_kg: round(grams / 1000, 4),
    intensity_g_per_kwh: energy > 0 ? round(grams / energy, 3) : null,
    baseline_g: round(baselineG, 3),
    baseline_kg: round(baselineG / 1000, 4),
    avoided_g: round(baselineG - grams, 3),
    avoided_kg: round((baselineG - grams) / 1000, 4),
    avoided_pct: baselineG > 0 ? round(((baselineG - grams) / baselineG) * 100, 2) : 0,
    cleanest: enriched.length ? enriched.reduce((a, b) => (b.g_per_kwh < a.g_per_kwh ? b : a)) : null,
    dirtiest: enriched.length ? enriched.reduce((a, b) => (b.g_per_kwh > a.g_per_kwh ? b : a)) : null,
    intervals: enriched,
    source: 'model',
    social_cost_inr_per_tonne: SOCIAL_COST_INR_PER_TONNE,
  };
  // A receipt is an auditable artifact: hash the canonical body so a copy can be
  // verified without trusting the database that served it.
  body.receipt_sha256 = crypto.createHash('sha256').update(canonicalJson(body)).digest('hex');
  return body;
}

function canonicalJson(obj) {
  if (obj == null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}

// Station/site carbon summary over a window. Uses receipts (the same arithmetic a
// driver sees) rather than a second, subtly different aggregation path.
function summarize(store, { stationId = null, from = null, to = null, limit = 2000 } = {}) {
  const t0 = from ? Date.parse(from) : 0;
  const t1 = to ? Date.parse(to) : Infinity;
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) {
    return { error: 'INVALID_WINDOW', message: 'from/to must be valid and from < to' };
  }
  const stationIdN = stationId != null ? Number(stationId) : null;
  let sessions = 0;
  let energy = 0;
  let grams = 0;
  let baseline = 0;
  const byDay = new Map();
  const regions = new Map();
  const rows = [...store.sessions.values()]
    .filter((s) => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(s.state))
    .filter((s) => {
      const at = Date.parse(s.ended_at || s.started_at) || 0;
      if (at < t0 || at > t1) return false;
      if (stationIdN == null) return true;
      const ref = String(s.connector_ref || '');
      const cpId = Number(ref.split(':')[0]);
      return store.cps.get(cpId)?.station_id === stationIdN;
    })
    .sort((a, b) => Date.parse(b.ended_at || b.started_at) - Date.parse(a.ended_at || a.started_at))
    .slice(0, Math.max(1, Math.min(Number(limit) || 2000, 5000)));
  for (const s of rows) {
    const rec = receiptForSession(store, s.session_id);
    if (!rec) continue;
    sessions++;
    energy += rec.energy_kwh;
    grams += rec.carbon_g;
    baseline += rec.baseline_g;
    regions.set(rec.region, (regions.get(rec.region) || 0) + rec.energy_kwh);
    const day = String(rec.ended_at || rec.started_at || '').slice(0, 10);
    if (day) {
      const d = byDay.get(day) || { day, energy_kwh: 0, carbon_kg: 0 };
      d.energy_kwh += rec.energy_kwh;
      d.carbon_kg += rec.carbon_g / 1000;
      byDay.set(day, d);
    }
  }
  const region = [...regions.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || DEFAULT_REGION;
  return {
    station_id: stationIdN,
    from: t0 ? new Date(t0).toISOString() : null,
    to: Number.isFinite(t1) ? new Date(t1).toISOString() : null,
    sessions,
    energy_kwh: round(energy, 3),
    carbon_kg: round(grams / 1000, 4),
    intensity_g_per_kwh: energy > 0 ? round(grams / energy, 3) : null,
    baseline_kg: round(baseline / 1000, 4),
    avoided_kg: round((baseline - grams) / 1000, 4),
    avoided_pct: baseline > 0 ? round(((baseline - grams) / baseline) * 100, 2) : 0,
    region,
    region_label: REGIONS[region].label,
    by_day: [...byDay.values()]
      .sort((a, b) => (a.day < b.day ? -1 : 1))
      .map((d) => ({ day: d.day, energy_kwh: round(d.energy_kwh, 3), carbon_kg: round(d.carbon_kg, 4) })),
    model: MODEL_VERSION,
  };
}

// Weight is the only scheduling knob exposed to callers; undefined => env default.
function normalizeWeight(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_WEIGHT;
  return clamp(n, 0, 1);
}

function carbonPricePerKwh(gPerKwh, weight = 1) {
  return ((Number(gPerKwh) || 0) / 1e6) * SOCIAL_COST_INR_PER_TONNE * clamp(Number(weight) || 0, 0, 1);
}

module.exports = {
  MODEL_VERSION,
  DEFAULT_REGION,
  DEFAULT_WEIGHT,
  SOCIAL_COST_INR_PER_TONNE,
  REGIONS,
  normalizeRegion,
  normalizeWeight,
  regionList,
  regionForStation,
  intensityAt,
  forecast,
  forSchedule,
  receiptForSession,
  summarize,
  carbonPricePerKwh,
  canonicalJson,
  bandFor,
};
