import * as coreActionSchemas from '../agent/actions/schemas';
import { registeredActionSchemas, registeredVoiceTools } from '../registry';
import { VOICE_TOOLS } from '../voice/prompt';
import { buildCapabilities } from './catalog';
import type { Capabilities, CapabilityEntry } from './catalog';
import { panelCatalog } from './panel';

/** The browser agent's own actions (click, type, scroll, tabs…), from their schemas. */
function coreActions(): CapabilityEntry[] {
  return Object.values(coreActionSchemas).flatMap(value => {
    const schema = value as { name?: unknown; description?: unknown };
    return typeof schema?.name === 'string' && typeof schema.description === 'string'
      ? [{ name: schema.name, description: schema.description }]
      : [];
  });
}

/** What Ava can do right now: every voice tool, chat action, panel place and settings section registered. */
export function currentCapabilities(): Capabilities {
  const panel = panelCatalog();
  return buildCapabilities({
    voiceTools: [
      ...VOICE_TOOLS.map(tool => ({ name: tool.name, description: tool.description })),
      ...registeredVoiceTools().map(tool => ({
        name: tool.declaration.name,
        description: tool.declaration.description,
      })),
    ],
    agentActions: [...coreActions(), ...registeredActionSchemas()],
    places: panel.places,
    settingsSections: panel.settingsSections,
  });
}
