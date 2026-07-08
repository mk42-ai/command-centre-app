import React from 'react';
// Unified shadcn/Radix-style Badge system (v15).
// One component, consistent size/radius/typography, coherent severity scale:
//   low = slate/green · medium = amber · high = red · brand = deep green.
// Icons are tree-shaken lucide-react named imports; every numeric badge
// carries a labeled tooltip (title attr) so the numbers self-explain.
import {
  Layers,
  Shield,
  Flame,
  TriangleAlert,
  Clock,
  Gem,
  CircleCheck,
  Forward,
  Phone,
} from 'lucide-react';

const ICONS = {
  layers: Layers,
  shield: Shield,
  flame: Flame,
  alert: TriangleAlert,
  clock: Clock,
  gem: Gem,
  'check-circle': CircleCheck,
  forward: Forward,
  phone: Phone,
};

// severity tone to bg / fg / border (light-mode, WCAG-conscious)
const TONES = {
  brand: { bg: '#0B3D2E', fg: '#ffffff', bd: '#0B3D2E' },
  low: { bg: '#EDF7F2', fg: '#0E6245', bd: '#BFE0D3' },
  slate: { bg: '#F1F4F3', fg: '#3D4A45', bd: '#D5DDD9' },
  medium: { bg: '#FDF3E1', fg: '#8A5A00', bd: '#EBD3A2' },
  high: { bg: '#FCEBE8', fg: '#8E1508', bd: '#EFC5BD' },
  outline: { bg: 'transparent', fg: '#0B3D2E', bd: '#BFD5CB' },
};

// map a 0-10 score to a severity tone (used for urgency, risk, days-quiet)
export function toneForScore(v, { invert = false } = {}) {
  const s = Number(v) || 0;
  const hi = s >= 7, mid = s >= 4;
  if (invert) return hi ? 'low' : mid ? 'medium' : 'high';
  return hi ? 'high' : mid ? 'medium' : 'low';
}

export default function Badge({ tone = 'slate', icon, children, title, className = '', style }) {
  const t = TONES[tone] || TONES.slate;
  const IconCmp = icon ? ICONS[icon] : null;
  return (
    <span
      className={`ui-badge ${className}`}
      title={title}
      aria-label={title}
      style={{ background: t.bg, color: t.fg, borderColor: t.bd, ...style }}
    >
      {IconCmp ? <IconCmp size={12} strokeWidth={2} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
