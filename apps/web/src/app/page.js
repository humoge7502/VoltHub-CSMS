import Link from 'next/link';
import { LiveKpis } from './live';

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
    title: 'The money path is relational and unashamed of it',
    body: 'Oracle 23ai owns reservations, billing and the ledger. Twenty-nine relations, seven PL/SQL packages, a guard trigger that blocks direct status writes. Double-reserve the same connector from two terminals and you get exactly one 201 — proven in CI on every push.',
  },
  {
    n: 'B',
    title: 'Telemetry is time-series, also unashamed of it',
    body: 'Ninety-plus percent of rows are immutable, time-ordered meter ticks. They land in TimescaleDB hypertables with 1-minute and 1-hour continuous aggregates, 7-day compression and 90-day retention. Billing never waits on analytics.',
  },
  {
    n: 'C',
    title: 'One event, two engines, zero broker',
    body: 'Every MeterValues writes a billing record and an analytics record through an in-transaction outbox. A two-second relay delivers at-least-once; idempotent replay makes it effectively-once. No Kafka, no dual-write divergence.',
  },
];

export default function Home() {
  return (
    <div className="wrap">
      {/* 01 — hero: what, why, who, next */}
      <section className="hero">
        <div className="micro rise">ORACLE OLTP · TIMESCALEDB TELEMETRY · OCPP 1.6J</div>
        <h1 className="display rise d1" style={{ margin: 'var(--sp-4) 0 0' }}>
          Certainty is
          <br />
          a database
          <br />
          property.
        </h1>
        <p className="lede rise d2" style={{ marginTop: 'var(--sp-5)' }}>
          VoltHub is a charge-point-operator system where reservations can never double-book, invoices bill exactly
          once, and every meter tick lands in both the money path and the analytics pipeline. Simulated chargers, real
          constraints.
        </p>
        <div
          className="rise d3"
          style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 'var(--sp-5)', flexWrap: 'wrap' }}
        >
          <Link href="/discover" className="btn pri">
            Find a charger
          </Link>
          <Link href="/dashboard" className="btn">
            Operator view
          </Link>
        </div>
      </section>

      {/* 02 — live system state (client island, the only JS on this page) */}
      <section className="sec" aria-label="Live system state">
        <div className="sec-h">
          <span className="secnum">01</span>
          <h2>Live from the gateway</h2>
          <p>Polling /health on the API — outbox lag is the distance between a meter tick and its analytics copy.</p>
        </div>
        <LiveKpis />
      </section>

      {/* 03 — proof numbers */}
      <section className="sec">
        <div className="statband rise d1">
          <div>
            <div className="micro">Engine A · Oracle 23ai</div>
            <div className="v num">29 rel</div>
            <div className="micro">7 PL/SQL packages</div>
          </div>
          <div>
            <div className="micro">Engine B · TimescaleDB</div>
            <div className="v num">1m caggs</div>
            <div className="micro">10–20× compression</div>
          </div>
          <div>
            <div className="micro">Race-proof</div>
            <div className="v num">201+409</div>
            <div className="micro">FOR UPDATE + CI</div>
          </div>
          <div>
            <div className="micro">API surface</div>
            <div className="v num">66 paths</div>
            <div className="micro">OpenAPI drift-gated</div>
          </div>
        </div>
      </section>

      {/* 04 — the north-star flow, as an index */}
      <section className="sec">
        <div className="sec-h">
          <span className="secnum">02</span>
          <h2>Four steps, two clicks to live kWh</h2>
          <p>The demo path a first-time user takes — every step is a real route in this console.</p>
        </div>
        <div className="idx">
          {FLOWS.map((f) => (
            <Link key={f.n} href={f.href}>
              <span className="secnum">{f.n}</span>
              <span className="t">{f.t}</span>
              <span className="d">{f.d}</span>
              <span className="go" aria-hidden="true">
                →
              </span>
            </Link>
          ))}
        </div>
      </section>

      {/* 05 — what makes it different */}
      <section className="sec">
        <div className="sec-h">
          <span className="secnum">03</span>
          <h2>Two engines. One transaction boundary.</h2>
          <p>Each choice names its trade-off — the full set lives in the ADR index.</p>
        </div>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
          {CAPS.map((c) => (
            <article key={c.n} className="card">
              <div className="secnum">{c.n}</div>
              <h3 style={{ margin: 'var(--sp-2) 0', fontSize: '1.05rem', textTransform: 'none', letterSpacing: 0 }}>
                {c.title}
              </h3>
              <p style={{ color: 'var(--tx2)', margin: 0, fontSize: 13, lineHeight: 1.6 }}>{c.body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* 06 — boot */}
      <section className="sec" style={{ paddingBottom: 0 }}>
        <div
          className="card hl"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--sp-4)',
            alignItems: 'center',
            padding: 'var(--sp-6) var(--sp-5)',
          }}
        >
          <div>
            <div className="micro">TAKE IT FROM THE TOP</div>
            <h2 style={{ margin: 'var(--sp-2) 0 0' }}>Run the whole stack locally</h2>
            <p style={{ color: 'var(--tx2)', margin: 'var(--sp-2) 0 0', maxWidth: '52ch' }}>
              No Docker needed for the local profile. Demo logins —{' '}
              <span className="num">admin@volthub.in / Admin@123</span> ·{' '}
              <span className="num">arjun@volthub.in / Operator@123</span> · any seeded driver with{' '}
              <span className="num">Driver@123</span>.
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
