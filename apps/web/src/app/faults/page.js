'use client';
import { useEffect, useState } from 'react';
import { api, Pill } from '../../lib/ui';

export default function Faults() {
  const [list, setList] = useState([]);
  const [msg, setMsg] = useState('');
  const load = () =>
    api('/faults?open=1')
      .then((j) => setList(j.faults))
      .catch((e) => setMsg(e.message));
  useEffect(() => {
    load();
  }, []);
  const ageH = (t) => ((Date.now() - new Date(t).getTime()) / 3600000).toFixed(1);
  const triage = async (f) => {
    const desc = prompt('Work description', 'Inspect connector, reseat cable');
    if (!desc) return;
    const j = await api(`/faults/${f.fault_id}/maintenance`, {
      method: 'POST',
      body: JSON.stringify({ work_type: 'REPAIR', description: desc }),
    });
    if (confirm('Mark resolved → connector back to AVAILABLE?')) {
      await api(`/maintenance/${j.record.record_id}/complete`, {
        method: 'PATCH',
        body: JSON.stringify({ resolution: 'Fixed, tested OK' }),
      });
    }
    load();
  };
  return (
    <div className="wrap">
      <div className="micro">OPERATOR · FAULT → MAINTENANCE → AVAILABLE</div>
      <h1 className="display" style={{ fontSize: '2.4rem' }}>
        Faults
      </h1>
      {msg && <p className="err">{msg}</p>}
      <table className="t" style={{ marginTop: 16 }}>
        <thead>
          <tr>
            <th>ID</th>
            <th>Connector</th>
            <th>Code</th>
            <th>Sev</th>
            <th>Age</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {list.map((f) => (
            <tr key={f.fault_id} style={ageH(f.reported_at) > 48 ? { background: 'rgba(229,72,77,.06)' } : undefined}>
              <td className="n">{f.fault_id}</td>
              <td className="n">{f.connector_ref || f.cp_id}</td>
              <td>{f.error_code}</td>
              <td>
                <Pill s={f.severity === 'CRITICAL' ? 'FAILED' : 'DUE'} />
              </td>
              <td className="n num">{ageH(f.reported_at)}h</td>
              <td>
                <button className="btn" onClick={() => triage(f)}>
                  Triage
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!list.length && <p style={{ color: 'var(--tx2)' }}>Queue clear. Faults older than 48h tint red (Q8).</p>}
    </div>
  );
}
