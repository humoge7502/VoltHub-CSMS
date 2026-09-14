'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, Pill, inr } from '../../../lib/ui';

export default function Station() {
  // Next 16: dynamic-route params come from useParams(), not the page props.
  const params = useParams();
  const [s, setS] = useState(null);
  const [sel, setSel] = useState(null);
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState('');
  const [start, setStart] = useState('');
  const [dur, setDur] = useState(45);
  const [tariffs, setTariffs] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api(`/stations/${params.id}`)
      .then((j) => {
        setS(j.station);
        const free = j.station.charge_points
          .flatMap((c) => c.connectors.map((x) => ({ ...x, cp_id: c.cp_id })))
          .find((c) => c.status === 'AVAILABLE');
        setSel(free || null);
        const d = new Date(Date.now() + 30 * 60000);
        setStart(d.toISOString().slice(0, 16));
      })
      .catch((e) => setMsg(e.message));
    api('/tariffs/active')
      .then((j) => setTariffs(j.plans))
      .catch(() => {});
    api(`/stations/${params.id}/reviews`)
      .then((j) => setReviews(j.reviews))
      .catch(() => {});
  }, [params.id]);
  const reserve = async () => {
    setMsg('');
    setOk('');
    setBusy(true);
    try {
      const st = new Date(start),
        en = new Date(st.getTime() + Number(dur) * 60000);
      const j = await api('/reservations', {
        method: 'POST',
        body: JSON.stringify({
          cpId: sel.cp_id,
          connectorNo: sel.connector_no,
          startAt: st.toISOString(),
          endAt: en.toISOString(),
        }),
      });
      setOk(`BOOKED #${j.reservation.reservation_id} — see Reservations`);
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };
  if (!s)
    return (
      <div className="wrap">
        <div className="skel" style={{ height: 200 }} />
        {msg && (
          <p className="err" role="alert" style={{ marginTop: 12 }}>
            {msg}
          </p>
        )}
      </div>
    );
  return (
    <div className="wrap">
      <header className="rise" style={{ marginBottom: 'var(--sp-5)' }}>
        <div className="micro">
          {s.city} · {s.amenities?.join(' · ')}
        </div>
        <h1 style={{ marginTop: 'var(--sp-2)' }}>{s.name}</h1>
        <p className="lede" style={{ marginTop: 'var(--sp-2)' }}>
          {s.address_line}
        </p>
      </header>
      <div className="two">
        <div className="grid">
          {s.charge_points.map((cp) => (
            <section key={cp.cp_id} className="card">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <h3 style={{ textTransform: 'none', letterSpacing: 0 }}>
                  {cp.vendor} {cp.model}
                </h3>
                <span className="micro num">{cp.ocpp_identity}</span>
                <span style={{ marginLeft: 'auto' }}>
                  <Pill s={cp.status === 'ONLINE' ? 'AVAILABLE' : 'OFFLINE'} />
                </span>
              </div>
              <div className="tiles" style={{ marginTop: 'var(--sp-3)' }}>
                {cp.connectors.map((c) => {
                  const free = c.status === 'AVAILABLE';
                  const on = sel?.connector_ref === c.connector_ref;
                  return (
                    <button
                      key={c.connector_ref}
                      type="button"
                      className={`tile clickable ${on ? 'sel' : ''}`}
                      onClick={() => free && setSel({ ...c, cp_id: cp.cp_id })}
                      disabled={!free}
                      aria-pressed={on}
                      aria-label={`Connector ${c.connector_no}, ${c.standard_code}, ${c.max_power_kw} kilowatt, ${free ? `available — select for reservation` : c.status.toLowerCase()}`}
                    >
                      <span className="num">
                        {c.standard_code} · {c.max_power_kw} kW
                      </span>
                      <span className="micro num">#{c.connector_no}</span>
                      <Pill s={c.status} />
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
        <aside className="card hl" style={{ position: 'sticky', top: 80 }}>
          <div className="micro">RESERVE · 15–120 MIN</div>
          {sel ? (
            <h3 className="num" style={{ margin: 'var(--sp-2) 0' }}>
              {sel.standard_code} · {sel.max_power_kw} kW
            </h3>
          ) : (
            <p style={{ color: 'var(--tx2)' }}>No free connector right now — availability refreshes as sessions end.</p>
          )}
          <div className="sheet" style={{ marginTop: 'var(--sp-3)' }}>
            <label className="f">
              Start
              <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} disabled={!sel} />
            </label>
            <label className="f">
              Duration (min)
              <input
                type="number"
                min="15"
                max="120"
                value={dur}
                onChange={(e) => setDur(e.target.value)}
                disabled={!sel}
              />
            </label>
            <button className="btn pri" onClick={reserve} disabled={!sel || busy} style={{ justifyContent: 'center' }}>
              {busy ? 'Reserving…' : 'Reserve'}
            </button>
            {ok && (
              <p className="okmsg" role="status">
                {ok}
              </p>
            )}
            {msg && (
              <p className="err" role="alert">
                {msg}
              </p>
            )}
            <p className="micro" style={{ margin: 0 }}>
              A second reservation for the same window returns 409 — the overlap check lives in the database.
            </p>
          </div>
        </aside>
      </div>
      <div className="two" style={{ marginTop: 'var(--sp-6)' }}>
        <section className="card">
          <div className="micro">TARIFFS · SESSIONS PIN THEIR VERSION</div>
          {tariffs.map((p) => (
            <div key={p.plan_id} style={{ padding: 'var(--sp-3) 0', borderBottom: '1px solid var(--hair)' }}>
              <b>{p.name}</b> <span className="num">· {inr(p.session_fee)} session fee</span>
              <div className="micro num" style={{ marginTop: 4 }}>
                {p.bands
                  .map((b) => `${b.start_time.slice(0, 5)}–${b.end_time.slice(0, 5)} ₹${b.price_per_kwh}/kWh`)
                  .join(' · ')}
              </div>
            </div>
          ))}
          {!tariffs.length && <p style={{ color: 'var(--tx2)' }}>Tariffs load with the station.</p>}
        </section>
        <section className="card">
          <div className="micro">
            DRIVER REVIEWS · ONE PER SESSION {s.avg_rating ? `· ★ ${s.avg_rating} (${s.review_count})` : ''}
          </div>
          {reviews.slice(0, 5).map((r) => (
            <div key={r.review_id} style={{ padding: 'var(--sp-3) 0', borderBottom: '1px solid var(--hair)' }}>
              <span className="num" aria-label={`Rated ${r.rating} of 5`}>
                {'★'.repeat(r.rating)}
                <span style={{ color: 'var(--tx3)' }}>{'☆'.repeat(5 - r.rating)}</span>
              </span>{' '}
              <b>{r.driver}</b>
              <div style={{ color: 'var(--tx2)', marginTop: 2 }}>{r.comment_text}</div>
            </div>
          ))}
          {!reviews.length && <p style={{ color: 'var(--tx2)' }}>No reviews yet — charge here and leave the first.</p>}
        </section>
      </div>
    </div>
  );
}
