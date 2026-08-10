// ============================================================
// Meera's Command Centre — static DESIGN-SYSTEM configuration ONLY.
//
// v41 (LIVE-ONLY UI): the embedded July-2026 intelligence fixture
// (THREADS, QUIET_THREADS, REPLY_DEBT, SENTIMENT_RADAR,
// OPPORTUNITY_MAP, ACTION_BUCKETS, MACHINE_SUMMARY, TIER_COUNTS)
// has been DELETED from the bundle. Every dashboard section now
// renders exclusively from the live /api/dashboard/meera payload —
// no fixture email content can exist in the built JS. Only brand
// metadata (no dates) and the tier colour/label design system stay.
// ============================================================

export const META = {
  title: "Meera's Command Centre",
  tagline: "Managing the CEO's Inbox",
  preparedFor: 'Meera AlDhaheri, Chief of Staff to MK',
  mailbox: 'mk@airev.ae',
  org: 'AIREV',
};

// Priority-tier design system (colours/labels/descriptions only — no data).
export const TIER_INFO = {
  1: { label: 'Tier 1 · Critical', desc: 'Act today — hard deadline or executive-blocking item.', color: '#0B3D2E', text: '#ffffff', ink: '#0B3D2E' },
  2: { label: 'Tier 2 · High', desc: 'Needs a reply or decision within 48 hours.', color: '#1B7355', text: '#ffffff', ink: '#135C43' },
  3: { label: 'Tier 3 · Medium', desc: 'Active thread — keep momentum, no hard deadline.', color: '#2E8B6E', text: '#ffffff', ink: '#1B7355' },
  4: { label: 'Tier 4 · Low', desc: 'Monitor — awaiting the other side or long-cycle.', color: '#7FB8A4', text: '#0B3D2E', ink: '#2E8B6E' },
  5: { label: 'Tier 5 · FYI', desc: 'Informational — no action required.', color: '#C9E0D7', text: '#0B3D2E', ink: '#4E7A6A' },
};
