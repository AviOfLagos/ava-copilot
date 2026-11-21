import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { t } from '@extension/i18n';
import type { ThreadRecord } from '@extension/storage';

/**
 * Where Wave 2 features plug into the panel without editing SidePanel.tsx: places in the drawer (top
 * group or the profile menu) and sections in Settings. Each feature registers from its own
 * `register.tsx`, imported once from `registers.ts`.
 */

type MessageKey = Parameters<typeof t>[0];

export type RegisteredPlaceId =
  'inbox' | 'tasks' | 'workflows' | 'agents' | 'connectors' | 'skills' | 'models' | 'workspaces';

/** What a place may do in the panel: go elsewhere, open a chat, and talk to the background. */
export interface PanelApi {
  go: (place: string) => void;
  openThread: (threadId: string) => void;
  // Starts a new chat with `prompt` already in the composer, focused, so the user only has to send it.
  // Used by a place's "New …" button to hand off to the chat agent (create_workflow, create_agent, …).
  startThread: (prompt: string) => void;
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

/** The pages of the full-page Settings (options.html#<page>); src/side-panel/settings/pages.ts has their names. */
export type SettingsPageId =
  'general' | 'models' | 'voice' | 'personalities' | 'memory' | 'connections' | 'meetings' | 'privacy' | 'help';

export interface SettingsSectionDefinition {
  // Also its anchor: options.html#<page>/<id without the "<page>-" prefix>
  id: string;
  label: MessageKey;
  // The page it sits on, and its place there
  page: SettingsPageId;
  order: number;
  // More words the Settings search finds it by (its label always counts)
  keywords?: string[];
  // Drawn without the page's card, for a section that brings its own cards (Models)
  bare?: boolean;
  // `anchor` is the rest of the hash when it names no section of the page (e.g. a tab: #models/local)
  Component: ComponentType<{ api: PanelApi; anchor?: string }>;
}

const sections = new Map<string, SettingsSectionDefinition>();

export function registerSettingsSection(section: SettingsSectionDefinition): void {
  sections.set(section.id, section);
}

export function registeredSettingsSections(page?: SettingsPageId): SettingsSectionDefinition[] {
  return [...sections.values()].filter(section => !page || section.page === page).sort((a, b) => a.order - b.order);
}

/** What a chat turn's add-on is given: the chat, the user's message that turn answers, and the panel. */
export interface TurnAddonProps {
  thread: ThreadRecord;
  // The seq of the user's message the turn starts with; null for a turn that has none
  requestSeq: number | null;
  api?: PanelApi;
}

const turnAddons = new Map<string, ComponentType<TurnAddonProps>>();

/** Something a feature shows under a chat turn's steps, before its answer (e.g. the agents' hand-off cards). */
export function registerTurnAddon(id: string, Component: ComponentType<TurnAddonProps>): void {
  turnAddons.set(id, Component);
}

export function registeredTurnAddons(): [string, ComponentType<TurnAddonProps>][] {
  return [...turnAddons.entries()];
}
