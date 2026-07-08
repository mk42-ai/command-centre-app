import React from 'react';
// lucide-react icon layer — tree-shakeable named imports only.
// Consistent 24px grid, strokeWidth 1.75 default, currentColor so every
// icon inherits the OnDemand brand ink (#0B3D2E context colors).
import {
  Sparkles,
  RefreshCw,
  Check,
  X,
  Undo2,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  PanelRightClose,
  Zap,
  PenLine,
  Calendar,
  TriangleAlert,
  Users,
  Archive,
  MessageSquare,
  Send,
  History,
  ShieldCheck,
  LayoutDashboard,
  Layers,
  Inbox,
  SquarePen,
  MessageCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
} from 'lucide-react';

const MAP = {
  sparkles: Sparkles,
  paperclip: Paperclip,
  refresh: RefreshCw,
  check: Check,
  x: X,
  undo: Undo2,
  send: Send,
  'chevron-up': ChevronUp,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  'panel-close': PanelRightClose,
  zap: Zap,
  'pen-line': PenLine,
  calendar: Calendar,
  'alert-triangle': TriangleAlert,
  users: Users,
  archive: Archive,
  'message-square': MessageSquare,
  history: History,
  'shield-check': ShieldCheck,
  'layout-dashboard': LayoutDashboard,
  layers: Layers,
  inbox: Inbox,
  'square-pen': SquarePen,
  'message-circle': MessageCircle,
  'panel-left-close': PanelLeftClose,
  'panel-left-open': PanelLeftOpen,
};

export default function Icon({ name, size = 16, strokeWidth = 1.75, className = '', style, title }) {
  const Cmp = MAP[name];
  if (!Cmp) return null;
  return (
    <Cmp
      className={`icon ${className}`}
      size={size}
      strokeWidth={strokeWidth}
      color="currentColor"
      absoluteStrokeWidth={false}
      aria-hidden={title ? undefined : true}
      aria-label={title || undefined}
      role={title ? 'img' : undefined}
      style={style}
    />
  );
}
