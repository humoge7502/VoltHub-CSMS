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
  const [start, setStart] = useState('');
  const [dur, setDur] = useState(45);
  const [tariffs, setTariffs] = useState([]);
  const [reviews, setReviews] = useState([]);
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
  }, []);
  const reserve = async () => {
    setMsg('');
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
      setMsg(`BOOKED #${j.reservation.reservation_id} — see Reservations`);
    } catch (e) {
      setMsg(`${e.code || ''} ${e.message}`);
    }
  };
  if (!s)
    return (
      <div className="wrap">
        <div className="skel" style={{ height: 200 }} />
        {msg && <p className="err">{msg}</p>}
      </div>
    );
  return (
    <div className="wrap">
      <div className="micro">
        {s.city} · {s.amenities?.join(' · ')}
      </div>
      <h1 className="display" style={{ fontSize: '2.4rem' }}>
        {s.name}
      </h1>
      <p style={{ color: 'var(--tx2)' }}>{s.address_line}</p>
      <div className="two">
        <div className="grid">
          {s.charge_points.map((cp) => (
            <div key={cp.cp_id} className="card">
              <div className="micro">
                {cp.ocpp_identity} · {cp.vendor} {cp.model} ·{' '}
                <Pill s={cp.status === 'ONLINE' ? 'AVAILABLE' : 'OFFLINE'} />
              </div>
              <div className="tiles" style={{ marginTop: 8 }}>
                {cp.connectors.map((c) => (
                  <div
                    key={c.connector_ref}
                    className={`tile ${sel?.connector_ref === c.connector_ref ? 'sel' : ''}`}
                    onClick={() => c.status === 'AVAILABLE' && setSel({ ...c, cp_id: cp.cp_id })}
                    style={{ cursor: c.status === 'AVAILABLE' ? 'pointer' : 'default' }}
                  >
                    <div className="num">
                      {c.standard_code} · {c.max_power_kw} kW
                    </div>
                    <div className="micro num">#{c.connector_no}</div>
                    <Pill s={c.status} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="card">
          <div className="micro">RESERVE · 15–120 MIN</div>
          {sel ? (
            <h3 className="num">
              {sel.standard_code} · {sel.max_power_kw} kW
            </h3>
          ) : (
            <p className="err">No free connector right now.</p>
          )}
          <div className="sheet" style={{ marginTop: 12 }}>
            <label className="f">
              Start
              <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label className="f">
              Duration (min)
              <input type="number" min="15" max="120" value={dur} onChange={(e) => setDur(e.target.value)} />
            </label>
            <button className="btn pri" onClick={reserve} disabled={!sel}>
              Reserve
            </button>
            {msg && <div className={msg.startsWith('BOOKED') ? 'okmsg' : 'err'}>{msg}</div>}
            <div className="micro">
              OVERLAP IMPOSSIBLE BY CONSTRUCTION — RESERVATION_PKG HOLDS A ROW LOCK (ORA-20503 → 409)
            </div>
          </div>
        </div>
      </div>
      <div className="two" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="micro">TARIFF PREVIEW · VERSIONED, SESSIONS PIN THEIR VERSION</div>
          {tariffs.map((p) => (
            <div key={p.plan_id} style={{ padding: '8px 0', borderBottom: '1px solid var(--hair)' }}>
              <b>{p.name}</b> <span className="num">· {inr(p.session_fee)} session fee</span>
              <div className="micro num">
                {p.bands
                  .map((b) => `${b.start_time.slice(0, 5)}–${b.end_time.slice(0, 5)} ₹${b.price_per_kwh}/kWh`)
                  .join(' · ')}
              </div>
            </div>
          ))}
        </div>
        <div className="card">
          <div className="micro">
            DRIVER REVIEWS · ONE PER SESSION {s.avg_rating ? `· ★ ${s.avg_rating} (${s.review_count})` : ''}
          </div>
          {reviews.slice(0, 5).map((r) => (
            <div key={r.review_id} style={{ padding: '8px 0', borderBottom: '1px solid var(--hair)' }}>
              <span className="num">
                {'★'.repeat(r.rating)}
                {'☆'.repeat(5 - r.rating)}
              </span>{' '}
              <b>{r.driver}</b>
              <div style={{ color: 'var(--tx2)' }}>{r.comment_text}</div>
            </div>
          ))}
          {!reviews.length && <p style={{ color: 'var(--tx2)' }}>No reviews yet — charge here and leave the first.</p>}
        </div>
      </div>
    </div>
  );
}
