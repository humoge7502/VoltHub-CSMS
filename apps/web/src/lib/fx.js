'use client';
// Motion primitives (Grid Current edition): the signature interaction pieces from the
// Magic UI / Aceternity / Motion Primitives class of components, implemented natively
// in the design language instead of copy-pasting a foreign styling system.
// Motion rules: enter ease-OUT, one-shot in-view reveals, compositor-only properties,
// and every effect collapses under prefers-reduced-motion.
import { motion, useReducedMotion } from 'motion/react';
import { useRef } from 'react';
import { useCountUp } from './ui';

const EASE = [0.23, 1, 0.32, 1];

// Scroll reveal: one-shot fade+rise when the block enters the viewport.
export function Reveal({ children, delay = 0, y = 16, className, style }) {
  const reduce = useReducedMotion();
  if (reduce)
    return (
      <div className={className} style={style}>
        {children}
      </div>
    );
  return (
    <motion.div
      className={className}
      style={style}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-70px' }}
      transition={{ duration: 0.55, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

// Number ticker: a polled/statistic number that glides to its new value (spring-free
// cubic ease keeps it legible in a statband). `kind` picks the formatter so the
// component can be rendered from a server component (no function props).
export function Ticker({ value, kind = 'plain', suffix = '', className }) {
  const v = useCountUp(Number(value) || 0);
  const fmt = (n) => {
    if (kind === 'inr') return `₹${Math.round(n).toLocaleString('en-IN')}`;
    if (kind === 'pct') return `${n.toFixed(1)}%`;
    if (kind === 'b') return `$${n.toFixed(1)}B`;
    if (kind === 'k') return `${Math.round(n).toLocaleString('en-IN')}`;
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  };
  return (
    <span className={`num ${className || ''}`} style={{ fontVariantNumeric: 'tabular-nums' }}>
      {fmt(v)}
      {suffix}
    </span>
  );
}

// Spotlight card: a soft radial glow follows the pointer (Aceternity signature),
// tinted to the brand lime and clipped to the card. Pure CSS variables + one listener.
export function SpotCard({ children, className = '', style }) {
  const ref = useRef(null);
  const onMove = (e) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${e.clientX - r.left}px`);
    el.style.setProperty('--my', `${e.clientY - r.top}px`);
  };
  return (
    <div ref={ref} onMouseMove={onMove} className={`spot ${className}`} style={style}>
      {children}
    </div>
  );
}

// Marquee: an infinite horizontal band for proof phrases. Duplicated track for a
// seamless loop; pauses on hover; wraps statically under reduced motion (CSS).
export function Marquee({ items, ariaLabel }) {
  const row = (hidden) => (
    <div className="marquee-half" aria-hidden={hidden || undefined}>
      {items.map((t, i) => (
        <span key={`${t}-${i}`} className="marquee-item">
          {t}
          <i aria-hidden="true" />
        </span>
      ))}
    </div>
  );
  return (
    <div className="marquee" role="marquee" aria-label={ariaLabel}>
      <div className="marquee-track">
        {row(false)}
        {row(true)}
      </div>
    </div>
  );
}
