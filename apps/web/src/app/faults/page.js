'use client';
import { useEffect, useState } from 'react';
import { api, Pill, PageHead, PageState, ConfirmDialog, EmptyState } from '../../lib/ui';

export default function Faults() {
  const [list, setList] = useState([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState(null);
  const [desc, setDesc] = useState('Inspect connector, reseat cable');
  const [resolve, setResolve] = useState(false);
  const [record, setRecord] = useState(null);
  const load = () =>
    api('/faults?open=1')
      .then((j) => {
        setList(j.faults);
        setErr('');
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  useEffect(() => {
    load();
  }, []);
  const ageH = (t) => ((Date.now() - new Date(t).getTime()) / 3600000).toFixed(1);
  // A failed mutation must not look like a finished one. Both dialogs used to close on
  // the error path (`setTarget(null)` inside the catch), so a rejected `POST`/`PATCH`
  // left the operator with a closed dialog, an unchanged queue and no way to retry —
  // and with no in-flight guard a second click could open two work records for one
  // fault. Errors now stay inside the dialog, and the actions are inert while busy.
  const [busy, setBusy] = useState('');
  const triage = async () => {
    if (busy) return;
    setBusy('triage');
    try {
      const j = await api(`/faults/${target.fault_id}/maintenance`, {
        method: 'POST',
        body: JSON.stringify({ work_type: 'REPAIR', description: desc }),
      });
      setRecord(j.record);
      setResolve(true);
      setMsg('');
    } catch (e) {
      setMsg(e.message);
    } finally {
      setBusy('');
    }
  };
  const complete = async () => {
    if (busy) return;
    setBusy('complete');
    try {
      await api(`/maintenance/${record.record_id}/complete`, {
        method: 'PATCH',
        body: JSON.stringify({ resolution: 'Fixed, tested OK' }),
      });
      setTarget(null);
      setResolve(false);
      setMsg('');
    } catch (e) {
      setMsg(e.message); // the dialog stays open: the connector is NOT back in service
    } finally {
      setBusy('');
      load();
    }
  };
  return (
    <div className="wrap">
      <PageHead
        eyebrow="OPERATOR · FAULT → MAINTENANCE → AVAILABLE"
        title="Faults"
        lede="Open faults age in place. Anything older than 48 hours tints red — the queue is a commitment, not a suggestion."
      />
      {/* `msg` is set only by the two mutations below, and both now keep their dialog
          open on failure and render the error inside it — an alert here would announce
          the same sentence twice and sit behind the modal anyway. */}
      <PageState loading={loading} error={err} onRetry={load}>
        {list.length ? (
          <div className="tscroll">
            <table className="t">
              <caption className="micro" style={{ textAlign: 'left', paddingBottom: 8 }}>
                Open charging faults
              </caption>
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">Connector</th>
                  <th scope="col">Code</th>
                  <th scope="col">Severity</th>
                  <th scope="col">Age</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.map((f) => (
                  <tr
                    key={f.fault_id}
                    style={ageH(f.reported_at) > 48 ? { background: 'rgba(229,72,77,.06)' } : undefined}
                  >
                    <td className="n">#{f.fault_id}</td>
                    <td className="n">{f.connector_ref || f.cp_id}</td>
                    <td>{f.error_code}</td>
                    <td>
                      <Pill s={f.severity === 'CRITICAL' ? 'FAILED' : 'DUE'} />
                    </td>
                    <td className="n num">{ageH(f.reported_at)}h</td>
                    <td>
                      <button className="btn sm" onClick={() => setTarget(f)} disabled={!!busy}>
                        Triage
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="Queue clear"
            body="No open faults. When a charge point reports one, it appears here and starts aging immediately — the 48-hour tint marks anything overdue."
          />
        )}
      </PageState>
      <ConfirmDialog
        open={!!target && !resolve}
        eyebrow="TRIAGE FAULT"
        title={`Open maintenance on ${target?.connector_ref || target?.cp_id || ''}?`}
        body="A maintenance record is created and the connector leaves the available pool until it completes."
        confirmLabel="Open work record"
        busyLabel="Opening…"
        busy={busy === 'triage'}
        onConfirm={triage}
        onCancel={() => {
          setTarget(null);
          setMsg('');
        }}
      >
        <label className="f">
          Work description
          <input value={desc} onChange={(e) => setDesc(e.target.value)} />
        </label>
        {/* The failure belongs INSIDE the dialog the operator is still looking at — the
            page-level alert used to sit behind the modal they had just dismissed. */}
        {msg && (
          <p className="err" role="alert" style={{ marginTop: 'var(--sp-2)' }}>
            {msg}
          </p>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={resolve}
        eyebrow="RESOLVE"
        title="Mark resolved?"
        body="Completing the work record returns the connector to AVAILABLE."
        confirmLabel="Complete & release"
        busyLabel="Completing…"
        busy={busy === 'complete'}
        onConfirm={complete}
        onCancel={() => {
          setResolve(false);
          setTarget(null);
          setMsg('');
          load();
        }}
      >
        {msg && (
          <p className="err" role="alert">
            {msg}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
