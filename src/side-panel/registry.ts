import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { t } from '@extension/i18n';

/**
 * Where Wave 2 features plug into the panel without editing SidePanel.tsx: places in the drawer (top
 * group or the profile menu) and sections in Settings. Each feature registers from its own
 * `register.tsx`, imported once from `registers.ts`.
 */

type MessageKey = Parameters<typeof t>[0];

export type RegisteredPlaceId = 'inbox' | 'workflows' | 'agents' | 'connectors' | 'skills' | 'models' | 'workspaces';

/** What a place may do in the panel: go elsewhere, open a chat, and talk to the background. */
export interface PanelApi {
  go: (place: string) => void;
  openThread: (threadId: string) => void;
  // A command with a reply: resolves with the reply, rejects with the background's error or a timeout
  request: <T = Record<string, unknown>>(message: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
  // A command with no reply
  post: (message: Record<string, unknown>) => void;
}

export interface PlaceDefinition {
  id: RegisteredPlaceId;
  label: MessageKey;
  icon: LucideIcon;
  // The drawer's list, or the profile menu at its foot
  group: 'top' | 'profile';
  order: number;
  Component: ComponentType<{ api: PanelApi }>;
}

const places = new Map<RegisteredPlaceId, PlaceDefinition>();

export function registerPlace(place: PlaceDefinition): void {
  places.set(place.id, place);
}

export function registeredPlace(id: string): PlaceDefinition | undefined {
  return places.get(id as RegisteredPlaceId);
}

export function registeredPlaces(group: PlaceDefinition['group']): PlaceDefinition[] {
  return [...places.values()].filter(place => place.group === group).sort((a, b) => a.order - b.order);
}

export interface SettingsSectionDefinition {
  id: string;
  label: MessageKey;
  order: number;
  Component: ComponentType<{ api: PanelApi }>;
}

const sections = new Map<string, SettingsSectionDefinition>();

export function registerSettingsSection(section: SettingsSectionDefinition): void {
  sections.set(section.id, section);
}

export function registeredSettingsSections(): SettingsSectionDefinition[] {
  return [...sections.values()].sort((a, b) => a.order - b.order);
}
