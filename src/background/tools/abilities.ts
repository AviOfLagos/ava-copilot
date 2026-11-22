import type { ThreadRecord } from '@extension/storage';
import type { Capabilities } from '../capabilities/catalog';
import { chatActionAllowed, channelOfOrigin } from './channels';
import type { ChannelFacts } from './channels';

/**
 * What Ava says she can do in one channel: the catalogue without the tools that channel is not offered, so a
 * WhatsApp chat is never told about "open_place" or a call control it cannot use. The panel gets the whole list.
 */
export function capabilitiesForOrigin(
  capabilities: Capabilities,
  origin: ThreadRecord['origin'],
  facts: ChannelFacts,
): Capabilities {
  const channel = channelOfOrigin(origin);
  const allowed = (name: string) => chatActionAllowed(name, channel, facts);
  const opensPlaces = allowed('open_place');
  return {
    ...capabilities,
    groups: capabilities.groups
      .map(group => ({ ...group, entries: group.entries.filter(entry => allowed(entry.name)) }))
      .filter(group => group.entries.length > 0),
    agentActions: capabilities.agentActions.filter(action => allowed(action.name)),
    places: opensPlaces ? capabilities.places : [],
    settingsSections: opensPlaces ? capabilities.settingsSections : [],
  };
}
