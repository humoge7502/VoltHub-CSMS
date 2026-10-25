import Link from 'next/link';
import { Database, Activity, ArrowRight, ShieldCheck, Layers } from 'lucide-react';
import { LiveKpis } from './live';
import { Reveal, Ticker, SpotCard, Marquee } from '../lib/fx';

export const metadata = {
  title: { absolute: 'VoltHub CSMS — certainty is a database property' },
  description:
    'Two-engine EV charging management: Oracle 23ai owns the money path, TimescaleDB owns telemetry, an OCPP 1.6J gateway drives the fleet. Reservations never double-book; invoices bill exactly once.',
};

const FLOWS = [
  {
    n: '01',
    t: 'Discover',
    d: 'Live availability across the Chennai corridor — filtered by connector standard, refreshed every 15 seconds.',
    href: '/discover',
  },
  {
    n: '02',
    t: 'Reserve',
    d: 'Pick a connector and a window. Overlap is impossible by construction: the row lock lives in the database, not in hope.',
    href: '/discover',
  },
  {
    n: '03',
    t: 'Charge',
    d: 'Plug in and watch real OCPP MeterValues tick kWh, kW and cost on a five-second cadence.',
    href: '/history',
  },
  {
    n: '04',
    t: 'Settle',
    d: 'Itemized invoice — time-of-use bands, session fee, wallet pay. The ledger appends exactly once.',
    href: '/invoices',
  },
];

const CAPS = [
  {
    n: 'A',
    icon: Database,
    title: 'The money path is relational and unashamed of it',
    body: 'Oracle 23ai owns reservations, billing and the ledger. 35 tables, 8 PL/SQL packages, a guard trigger that blocks direct status writes. Double-reserve the same connector from two terminals and you get exactly one 201 — proven in CI on every push.',
  },
  {
    n: 'B',
    icon: Activity,
    title: 'Telemetry is time-series, also unashamed of it',
    body: 'Ninety-plus percent of rows are immutable, time-ordered meter ticks. They land in TimescaleDB hypertables with 1-minute and 1-hour continuous aggregates, 7-day compression and 90-day retention. Billing never waits on analytics.',
  },
  {
    n: 'C',
    icon: Layers,
    title: 'One event, two engines, zero broker',
    body: 'Every MeterValues writes a billing record and an analytics record through an in-transaction outbox. A two-second relay delivers at-least-once; idempotent replay makes it effectively-once. No Kafka, no dual-write divergence.',
  },
];

const PROOF = [
  'double-booking impossible by construction',
  'invoices bill exactly once',
  'race-tested in CI on every push',
  'signed wallet rail — EIP-191, no card data',
  'openapi drift-gated on every commit',
  'every benchmark has a receipt',
  'conformal forecast intervals with measured coverage',
  'control loop: 2.36% shortfall vs 42.6% baseline',
];

export default function Home() {
  return (
    <div className="wrap">
      {/* 01 — hero */}
      <section className="hero">
        <div className="micro rise d1" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <ShieldCheck size={14} aria-hidden="true" style={{ color: 'var(--lime)' }} /> EVERY CLAIM CARRIES A RECEIPT
        </div>
        <h1 className="display rise d2" style={{ margin: 'var(--sp-3) 0 0' }}>
          Certainty is
          <br />
          a database
          <br />
          property.
        </h1>
        <p className="lede rise d3" style={{ marginTop: 'var(--sp-5)', maxWidth: '58ch' }}>
          VoltHub is the charge-point-operator platform where reservations can never double-book, invoices bill exactly
          once, and every meter tick lands in both the money path and the analytics pipeline. Simulated chargers, real
          constraints, published proofs.
        </p>
        <div
          className="rise d4"
          style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 'var(--sp-5)', flexWrap: 'wrap' }}
        >
          <Link href="/discover" className="btn pri">
            Find a charger <ArrowRight size={14} aria-hidden="true" style={{ verticalAlign: '-2px' }} />
          </Link>
          <Link href="/dashboard" className="btn">
            Operator view
          </Link>
        </div>
        <p className="micro rise d4" style={{ marginTop: 'var(--sp-3)', color: 'var(--tx3)' }}>
          Power users: press <kbd className="cmdk-kbd">ctrl k</kbd> anywhere for the command palette.
        </p>
      </section>

      {/* 02 — live system state (client island) */}
      <Reveal>
        <section className="sec" aria-label="Live system state">
          <div className="sec-h">
            <h2>Live from the gateway</h2>
            <p>Polling /health on the API. Outbox lag is the distance between a meter tick and its analytics copy.</p>
          </div>
          <LiveKpis />
        </section>
      </Reveal>

      {/* 03 — market band (investor receipts, sourced in docs/business-model.md) */}
      <Reveal>
        <section className="sec" aria-label="Market">
          <div className="sec-h">
            <h2>The market is moving; the software isn&apos;t trusted yet</h2>
            <p>
              Sources: GM Insights 2025 base, MRFR pricing survey, public vendor pages — receipts in{' '}
              <code className="num">docs/business-model.md</code>.
            </p>
          </div>
          <div className="statband">
            <div>
              <div className="micro">CSMS SOFTWARE MARKET, 2025</div>
              <div className="v num">
                <Ticker value={3.4} kind="b" />
              </div>
              <div className="micro">growing 24.8%/yr through 2035</div>
            </div>
            <div>
              <div className="micro">TYPICAL SAAS PRICE</div>
              <div className="v num">
                <Ticker value={10} kind="k" suffix="–50/port/mo" />
              </div>
              <div className="micro">enterprise quotes are opaque</div>
            </div>
            <div>
              <div className="micro">VOLTHUB WEDGE</div>
              <div className="v num">transparent</div>
              <div className="micro">per-connector pricing, self-host, proofs</div>
            </div>
          </div>
        </section>
      </Reveal>

      {/* 04 — proof marquee */}
      <Reveal>
        <Marquee items={PROOF} ariaLabel="VoltHub guarantees, scrolling" />
      </Reveal>

      {/* 05 — the north-star flow */}
      <section className="sec">
        <div className="sec-h">
          <h2>Four steps, two clicks to live kWh</h2>
          <p>The demo path a first-time user takes; every step is a real route in this console.</p>
        </div>
        <div className="idx">
          {FLOWS.map((f, i) => (
            <Reveal key={f.n} delay={i * 0.06} className="idx-reveal">
              <Link href={f.href}>
                <span className="secnum">{f.n}</span>
                <span className="t">{f.t}</span>
                <span className="d">{f.d}</span>
                <span className="go" aria-hidden="true">
                  →
                </span>
              </Link>
            </Reveal>
          ))}
        </div>
      </section>

      {/* 06 — what makes it different */}
      <section className="sec">
        <div className="sec-h">
          <h2>Two engines. One transaction boundary.</h2>
          <p>Each choice names its trade-off; the full set lives in the ADR index.</p>
        </div>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
          {CAPS.map((c, i) => {
            const Icon = c.icon;
            return (
              <Reveal key={c.n} delay={i * 0.07}>
                <SpotCard className="card" style={{ height: '100%' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span
                      className="secnum"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 34,
                        height: 34,
                      }}
                    >
                      <Icon size={16} aria-hidden="true" />
                    </span>
                    <span className="micro">
                      {c.n === 'A' ? 'ORACLE 23AI' : c.n === 'B' ? 'TIMESCALEDB' : 'OUTBOX RELAY'}
                    </span>
                  </div>
                  <h3 style={{ margin: 'var(--sp-3) 0', fontSize: '1.05rem', textTransform: 'none', letterSpacing: 0 }}>
                    {c.title}
                  </h3>
                  <p style={{ color: 'var(--tx2)', margin: 0, fontSize: 13, lineHeight: 1.6 }}>{c.body}</p>
                </SpotCard>
              </Reveal>
            );
          })}
        </div>
      </section>

      {/* 07 — business model strip */}
      <Reveal>
        <section className="sec" aria-label="Business model">
          <div className="card hl" style={{ padding: 'var(--sp-6) var(--sp-5)' }}>
            <div className="sec-h" style={{ marginBottom: 'var(--sp-3)' }}>
              <h2 style={{ fontSize: '1.2rem' }}>Priced like infrastructure, not like a quote</h2>
              <p>
                Per connector, per month, published. The receipts discipline that proves the engineering also proves the
                bill: full receipt in <code className="num">docs/business-model.md</code>.
              </p>
            </div>
            <div className="statband">
              <div>
                <div className="micro">GARAGE</div>
                <div className="v num">free</div>
                <div className="micro">≤ 10 connectors · self-host</div>
              </div>
              <div>
                <div className="micro">NETWORK</div>
                <div className="v num">
                  <Ticker value={12} kind="k" suffix="/port" />
                </div>
                <div className="micro">per connector / month · SaaS or self-host</div>
              </div>
              <div>
                <div className="micro">GRID (CONTROL LOOP)</div>
                <div className="v num">
                  <Ticker value={29} kind="k" suffix="/port" />
                </div>
                <div className="micro">adds FC-HCC smart charging + forecast rail</div>
              </div>
            </div>
          </div>
        </section>
      </Reveal>

      {/* 08 — boot */}
      <section className="sec" style={{ paddingBottom: 0 }}>
        <div
          className="card"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--sp-4)',
            alignItems: 'center',
            padding: 'var(--sp-6) var(--sp-5)',
          }}
        >
          <div>
            <h2 style={{ margin: 0 }}>Run the whole stack locally</h2>
            <p style={{ color: 'var(--tx2)', margin: 'var(--sp-2) 0 0', maxWidth: '52ch' }}>
              No Docker needed for the local profile. Demo logins:{' '}
              <span className="num">arjun@volthub.in / Operator@123</span> · any seeded driver with{' '}
              <span className="num">Driver@123</span>. Admin access is provisioned separately.
            </p>
          </div>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
            <Link href="/login" className="btn pri">
              Log in
            </Link>
            <Link href="/discover" className="btn">
              Browse stations
            </Link>
          </span>
        </div>
      </section>
    </div>
  );
}
