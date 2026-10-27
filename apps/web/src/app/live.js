'use client';
import { useState } from 'react';
import { api, usePoll, Statband, StaleChip } from '../lib/ui';

// The one client island on the home page: live gateway state, polled.
// Everything around it is server-rendered (fast LCP, no hydration cost).
export function LiveKpis() {
  const [h, setH] = useState(null);
  // usePoll: one request in flight, paused while the tab is hidden, aborted on unmount.
  // 'error' = the gateway never answered (show the offline card); 'stale' = it answered
  // before and went quiet, so the last good numbers stay on screen under a chip.
  const { status } = usePoll(({ signal }) => api('/health', { signal }).then(setH), { intervalMs: 10000 });
  if (status === 'error' && !h)
    return (
      <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span className="micro">GATEWAY OFFLINE</span>
        <span style={{ color: 'var(--tx2)', fontSize: 13 }}>
          Start the API with <code className="num">npm run dev:api</code> — the numbers land here the moment it answers.
        </span>
      </div>
    );
  return (
    <>
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
      {status === 'stale' && (
        <div style={{ marginTop: 'var(--sp-3)' }}>
          <StaleChip />
        </div>
      )}
    </>
  );
}
