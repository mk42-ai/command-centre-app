import React from 'react';
import Icon from './Icon.jsx';

/*
 * Sidebar — persistent left navigation (v10).
 * 256px expanded / 64px icon-only rail. lucide icons + tracked uppercase
 * labels, brand deep-green active state, 4/8px grid, focus-visible rings.
 * Collapse animation is CSS-only and disabled under prefers-reduced-motion.
 */

export const SECTIONS = [
  { id: 'overview', label: 'Overview', icon: 'layout-dashboard' },
  { id: 'liveops', label: 'Live Ops', icon: 'zap' },
  { id: 'pyramid', label: 'Priority Pyramid', icon: 'layers' },
  { id: 'buckets', label: 'Action Buckets', icon: 'inbox' },
  { id: 'workbench', label: 'Reply Workbench', icon: 'square-pen' },
  { id: 'sendlog', label: 'Send Log', icon: 'history' },
  { id: 'audit', label: 'Algorithm & Audit', icon: 'shield-check' },
  { id: 'chat', label: 'Side Chat', icon: 'message-circle' },
];

export default function Sidebar({ active, onNavigate, collapsed, onToggle }) {
  return (
    <nav className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="Primary">
      <div className="sb-brand">
        <img
          className="sb-logo"
          src={`${import.meta.env.BASE_URL || '/'}logo.png`}
          alt="OnDemand"
          onError={(e) => {
            // bundled-asset failure fallback: swap to an inline text wordmark
            e.currentTarget.style.display = 'none';
            const wm = e.currentTarget.parentElement?.querySelector('.sb-wordmark');
            if (wm) wm.style.display = 'inline';
          }}
        />
        <span className="sb-wordmark" style={{ display: 'none' }} aria-hidden="true">OnDemand</span>
        {!collapsed && <span className="sb-brand-txt">Command Centre</span>}
      </div>

      <ul className="sb-list">
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <button
              className={`sb-item ${active === s.id ? 'active' : ''}`}
              onClick={() => onNavigate(s.id)}
              aria-current={active === s.id ? 'page' : undefined}
              title={s.label}
            >
              <Icon name={s.icon} size={18} />
              {!collapsed && <span className="sb-label">{s.label}</span>}
            </button>
          </li>
        ))}
      </ul>

      <button
        className="sb-toggle"
        onClick={onToggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={collapsed ? 'Expand' : 'Collapse'}
      >
        <Icon name={collapsed ? 'panel-left-open' : 'panel-left-close'} size={16} />
        {!collapsed && <span className="sb-label">Collapse</span>}
      </button>
    </nav>
  );
}
