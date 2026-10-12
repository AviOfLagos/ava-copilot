import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, BookOpen, Globe, Keyboard, MousePointerClick, Search, Sparkles } from 'lucide-react';

/** A step's icon on the run trail, as the panel picks them (src/side-panel/chat/ChatView.tsx). */
export const STEP_ICONS: Record<string, LucideIcon> = {
  read: BookOpen,
  navigate: Globe,
  type: Keyboard,
  click: MousePointerClick,
  search: Search,
  note: Sparkles,
  error: AlertTriangle,
};
