'use client';
import { useEffect, useState } from 'react';
import { api, Kpi, Line, PageHead, PageState, StationPicker, kwh } from '../../lib/ui';

const BAND_COPY = {
  VERY_LOW: 'very low — mostly renewable',
  LOW: 'low — cleaner than the regional average',
  MODERATE: 'moderate — around the regional average',
  HIGH: 'high — evening fossil peak',
  VERY_HIGH: 'very high — avoid if the trip allows',
};

const BANDS = [
  ['VERY_LOW', '≤100'],
  ['LOW', '≤200'],
  ['MODERATE', '≤350'],
  ['HIGH', '≤550'],
  ['VERY_HIGH', '>550'],
];

function grams(kg) {
  const n = Number(kg || 0) * 1000;
  if (n >= 1000) return `${(n / 1000).toFixed(2)} kg`;
  return `${Math.round(n)} g`;
}

export default function Carbon() {
  const [stations, setStations] = useState([]);
  const [sel, setSel] = useState(null);
  const [card, setCard] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [sessionId, setSessionId] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [receiptErr, setReceiptErr] = useState('');

  useEffect(() => {
    api('/stations')
      .then((j) => {
        setStations(j.stations || []);
        setSel(j.stations?.[0]?.station_id ?? null);
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!sel) return;
    setCard(null);
    setErr('');
    api(`/stations/${sel}/carbon`)
      .then(setCard)
      .catch((e) => setErr(e.message));
  }, [sel]);

  const lookup = async (e) => {
    e.preventDefault();
    setReceipt(null);
    setReceiptErr('');
    const id = Number(sessionId);
    if (!Number.isInteger(id) || id <= 0) {
      setReceiptErr('Enter a numeric session id.');
      return;
    }
    try {
      const j = await api(`/carbon/receipt/${id}`);
      setReceipt(j.receipt);
    } catch (e2) {
      setReceiptErr(e2.message);
    }
  };

  const fc = card?.forecast;
  const sum = card?.summary;
  const pts = (fc?.points || []).map((p) => ({ ts: p.at, avg_kw: p.g_per_kwh }));
  return (
    <div className="wrap">
      <PageHead
        eyebrow="CARBONPILOT · MODEL v1 · NOT A METER"
        title="Carbon"
        lede="The grid is cleaner at 03:00 than at 19:00. This page shows the modelled intensity for a station, what its recent sessions actually emitted, and a verifiable receipt for any session you own."
      />
      <StationPicker id="carbon-station" stations={stations} value={sel} onChange={setSel} />
      <PageState loading={loading} error={err} onRetry={() => sel && setSel((x) => x)}>
        {card ? (
          <>
            <div className="grid cards" style={{ marginTop: 'var(--sp-4)' }}>
              <Kpi
                l="Right now"
                v={`${Math.round(card.current?.g_per_kwh || 0)} g/kWh`}
                sub={BAND_COPY[card.current?.band] || card.current?.band}
              />
              <Kpi
                l="Next 48 h average"
                v={`${Math.round(fc?.summary?.average_g_per_kwh || 0)} g/kWh`}
                sub={`cleanest ${Math.round(fc?.summary?.min_g_per_kwh || 0)} · dirtiest ${Math.round(fc?.summary?.max_g_per_kwh || 0)}`}
              />
              <Kpi
                l="Renewable share"
                v={`${Math.round((card.renewable_share || 0) * 100)}%`}
                sub={`${card.region} · ${card.region_label}`}
              />
              <Kpi
                l="Last 30 days"
                v={grams(sum?.carbon_kg)}
                sub={`${kwh(sum?.energy_kwh || 0)} · ${sum?.sessions || 0} sessions`}
              />
            </div>

            <section className="card" style={{ marginTop: 'var(--sp-4)' }}>
              <div className="sec-h" style={{ marginBottom: 'var(--sp-3)' }}>
                <h2 style={{ fontSize: '1rem' }}>48-hour intensity forecast</h2>
                <p>gCO2e per kWh. Lower is cleaner; the evening peak is the fossil margin.</p>
              </div>
              <Line pts={pts} stroke="#9AD46B" id="carbon" unit="g/kWh" />
              <div
                className="micro"
                style={{ display: 'flex', gap: 'var(--sp-4)', flexWrap: 'wrap', marginTop: 'var(--sp-2)' }}
              >
                {BANDS.map(([band, range]) => (
                  <span key={band}>
                    {band.replace('_', ' ')} {range}
                  </span>
                ))}
              </div>
            </section>

            <section className="card" style={{ marginTop: 'var(--sp-4)' }}>
              <div className="sec-h" style={{ marginBottom: 'var(--sp-3)' }}>
                <h2 style={{ fontSize: '1rem' }}>Measured sessions vs the regional baseline</h2>
                <p>
                  Energy is metered; intensity is modelled at each reading. “Avoided” compares the same energy at the
                  region’s annual average of {Math.round(card.current?.base_g_per_kwh || 0)} g/kWh — never against a
                  hand-picked best hour.
                </p>
              </div>
              <div className="grid cards">
                <Kpi l="Avoided vs baseline" v={grams(sum?.avoided_kg)} sub={`${sum?.avoided_pct || 0}% cleaner`} />
                <Kpi
                  l="Average intensity"
                  v={`${Math.round(sum?.intensity_g_per_kwh || 0)} g/kWh`}
                  sub="metered energy"
                />
                <Kpi l="Baseline" v={grams(sum?.baseline_kg)} sub="same kWh at annual average" />
              </div>
            </section>
          </>
        ) : (
          !err && <div className="skel" style={{ height: 220, marginTop: 'var(--sp-4)' }} />
        )}
      </PageState>

      <section className="card" style={{ marginTop: 'var(--sp-4)' }}>
        <div className="sec-h" style={{ marginBottom: 'var(--sp-3)' }}>
          <h2 style={{ fontSize: '1rem' }}>Session carbon receipt</h2>
          <p>Owner or staff only. The receipt hash covers the session, region, intervals and totals.</p>
        </div>
        <form onSubmit={lookup} style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap', alignItems: 'end' }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="micro">Session id</span>
            <input
              className="input"
              inputMode="numeric"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              placeholder="e.g. 42"
              aria-describedby="carbon-receipt-help"
            />
          </label>
          <button className="btn" type="submit">
            Get receipt
          </button>
          <span id="carbon-receipt-help" className="micro">
            Totals are derived from the meter trail and any stop-meter residual.
          </span>
        </form>
        {receiptErr && (
          <p className="err" role="alert" style={{ marginTop: 'var(--sp-3)' }}>
            {receiptErr}
          </p>
        )}
        {receipt && (
          <div style={{ marginTop: 'var(--sp-4)' }}>
            <div className="grid cards">
              <Kpi l="Energy" v={kwh(receipt.energy_kwh)} sub={receipt.connector_ref} />
              <Kpi
                l="Emissions"
                v={grams(receipt.carbon_kg)}
                sub={`${Math.round(receipt.intensity_g_per_kwh || 0)} g/kWh`}
              />
              <Kpi l="Avoided" v={grams(receipt.avoided_kg)} sub={`${receipt.avoided_pct || 0}% vs baseline`} />
            </div>
            <p className="micro" style={{ marginTop: 'var(--sp-3)', wordBreak: 'break-all' }}>
              SHA-256 {receipt.receipt_sha256}
            </p>
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ marginTop: 'var(--sp-3)' }}>
                <caption className="micro" style={{ textAlign: 'left', paddingBottom: 8 }}>
                  Carbon receipt intervals for session {receipt.session_id}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Interval end</th>
                    <th scope="col">Energy</th>
                    <th scope="col">Intensity</th>
                    <th scope="col">Emissions</th>
                  </tr>
                </thead>
                <tbody>
                  {receipt.intervals.map((p, i) => (
                    <tr key={`${p.at}-${i}`}>
                      <td className="num">{new Date(p.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td>
                      <td className="num">{p.kwh.toFixed(3)} kWh</td>
                      <td className="num">{Math.round(p.g_per_kwh)} g/kWh</td>
                      <td className="num">{Math.round(p.carbon_g)} g</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
