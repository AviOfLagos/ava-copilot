import { z } from 'zod';
import type { PanelPlaceEntry } from './catalog';

/**
 * The side panel's places and settings sections, as the panel last reported them (it registers them, the
 * background cannot import React). Kept in storage.local so Ava knows them while the panel is closed, and in
 * memory so a prompt can read them without waiting.
 */

export const PANEL_CATALOG_KEY = 'capabilities-panel';
// A place Ava was asked to open while no panel was there to show it: the panel opens it when it next starts
export const PENDING_PLACE_KEY = 'capabilities-pending-place';

const entry = z.object({ id: z.string().min(1).max(60), label: z.string().min(1).max(80) });
export const panelCatalogSchema = z.object({
  places: z.array(entry).max(60),
  settingsSections: z.array(entry).max(80),
});
export type PanelCatalog = z.infer<typeof panelCatalogSchema>;

// Before any panel has reported: the panel's own places, in English, so Ava is never without them
export const DEFAULT_PANEL_CATALOG: PanelCatalog = {
  places: [
    { id: 'chat', label: 'Chat' },
    { id: 'today', label: 'Today' },
    { id: 'meetings', label: 'Meetings' },
    { id: 'memory', label: 'Knowledge' },
    { id: 'settings', label: 'Settings' },
    { id: 'help', label: 'Help' },
  ],
  settingsSections: [],
};

let cached: PanelCatalog = DEFAULT_PANEL_CATALOG;

export function panelCatalog(): PanelCatalog {
  return cached;
}

export async function loadPanelCatalog(): Promise<PanelCatalog> {
  const area = (await chrome.storage.local.get(PANEL_CATALOG_KEY).catch(() => ({}))) as Record<string, unknown>;
  const stored = area?.[PANEL_CATALOG_KEY];
  const parsed = panelCatalogSchema.safeParse(stored);
  if (parsed.success && parsed.data.places.length) cached = parsed.data;
  return cached;
}

export async function savePanelCatalog(catalog: PanelCatalog): Promise<void> {
  cached = catalog;
  await chrome.storage.local.set({ [PANEL_CATALOG_KEY]: catalog }).catch(() => {});
}

export type OpenOutcome = 'shown' | 'pending';

/**
 * Asks an open side panel to show a place (and a settings section in it, or a chat). With no panel open, it is kept
 * for the panel to open when it next starts: an extension cannot open its own side panel without the user's click.
 */
export async function openInPanel(target: {
  place: string;
  label?: string;
  section?: PanelPlaceEntry;
  threadId?: string;
}): Promise<OpenOutcome> {
  const message = {
    type: 'panel_open_place',
    place: target.place,
    label: target.label ?? null,
    sectionLabel: target.section?.label ?? null,
    threadId: target.threadId ?? null,
  };
  const reply = await chrome.runtime.sendMessage(message).catch(() => null);
  if ((reply as { ok?: boolean } | null)?.ok) return 'shown';
  await chrome.storage.session.set({ [PENDING_PLACE_KEY]: { ...message, at: Date.now() } }).catch(() => {});
  return 'pending';
}
