'use client';
import { useEffect, useState } from 'react';
import { api, Kpi } from '../lib/ui';

export default function Home() {
  const [h, setH] = useState(null);
  useEffect(() => {
    api('/health')
      .then(setH)
      .catch(() => {});
  }, []);
  return (
    <div className="wrap">
      <section className="hero">
        <div className="micro">ORACLE OLTP · TIMESCALEDB TELEMETRY · OCPP 1.6J</div>
        <h1 className="display">
          Certainty is
          <br />a database
          <br />
          property.
        </h1>
        <p>
          VoltHub is a charge-point-operator system where reservations can never double-book, invoices bill exactly
          once, and every meter tick lands in both the money-path and the analytics pipeline. Simulated chargers, real
          constraints.
        </p>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <a href="/discover">
            <button className="btn pri">Find a charger</button>
          </a>
          <a href="/dashboard">
            <button className="btn">Operator view</button>
          </a>
        </div>
      </section>
      <div className="grid cards" style={{ marginTop: 24 }}>
        <Kpi l="Engine A · Oracle 23ai" v="25 rel" sub="6 PL/SQL packages" />
        <Kpi l="Engine B · TimescaleDB" v="1m caggs" sub="10–20x compression" />
        <Kpi l="Race-proof" v="201+409" sub="FOR UPDATE + CI test" />
        <Kpi l="Outbox lag" v={h ? `${h.outbox_lag} ev` : '…'} sub={h ? `api: ${h.oracle}` : 'connecting…'} />
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <div className="micro">NORTH-STAR FLOW · 2 CLICKS TO LIVE KWH</div>
        <p className="num">
          map → reserve CCS2 6:15 PM → plug-in → live kWh/kW/cost → itemized invoice (ToU + fee) → wallet pay
        </p>
        <p style={{ color: 'var(--tx2)' }}>
          Demo logins — admin@volthub.in / Admin@123 · arjun@volthub.in / Operator@123 · any seeded driver / Driver@123
        </p>
      </div>
    </div>
  );
}
