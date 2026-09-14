'use client';
import { useEffect, useState } from 'react';
import { api, Statband } from '../lib/ui';

// The one client island on the home page: live gateway state, polled.
// Everything around it is server-rendered (fast LCP, no hydration cost).
export function LiveKpis() {
  const [h, setH] = useState(null);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const f = () =>
      api('/health')
        .then((x) => {
          setH(x);
          setOffline(false);
        })
        .catch(() => setOffline(true));
    f();
    const t = setInterval(f, 10000);
    return () => clearInterval(t);
  }, []);
  if (offline)
    return (
      <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span className="micro">GATEWAY OFFLINE</span>
        <span style={{ color: 'var(--tx2)', fontSize: 13 }}>
          Start the API with <code className="num">npm run dev:api</code> — the numbers land here the moment it answers.
        </span>
      </div>
    );
  return (
    <div className="statband">
      <div>
        <div className="micro">Engine mode</div>
        <div className="v num">{h ? h.mode : '…'}</div>
        <div className="micro">{h ? h.oracle : 'connecting'}</div>
      </div>
      <div>
        <div className="micro">Telemetry</div>
        <div className="v num">{h ? h.timescale : '…'}</div>
        <div className="micro">{h ? 'hypertables + caggs' : 'connecting'}</div>
      </div>
      <div>
        <div className="micro">Outbox lag</div>
        <div className="v num live-dot">{h ? `${h.outbox_lag} ev` : '…'}</div>
        <div className="micro">{h && h.mirror_errors ? `${h.mirror_errors} mirror errors` : 'mirror clean'}</div>
      </div>
    </div>
  );
}
