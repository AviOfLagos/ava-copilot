import type { ProductProfile } from '@extension/storage';
import { connectorService } from '../integrations/instance';
import type { ConnectorService } from '../integrations/service';

/**
 * Counts a product's Slack notifications by kind, through the Slack connector the user already has (docs/
 * growth-team.md, Part 4). Nothing here needs a new Slack app, and nothing is posted: one read of each channel
 * in the product profile, by a tool the user set to run without asking.
 *
 * The product's feed starts each message with its kind in square brackets ("[signup] …", "[payment] plan
 * changed …"), so counting is plain code: no model reads the messages.
 */

export type SlackCounts =
  | { ok: true; counts: Record<string, number>; channels: number }
  // Why nothing was counted, as a short word: 'no_channels', 'not_connected', 'needs_sign_in', 'asks_first',
  // 'no_read_tool', 'failed'
  | { ok: false; reason: string; detail: string };

// A kind is a short lower-case word in square brackets. "[source: x]" lines are where a sign-up came from, not a kind.
const KIND = /\[([a-z][a-z_-]{1,24})\]/g;

/** How many messages of each kind a channel's text holds. */
export function countKinds(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const match of text.matchAll(KIND)) {
    const kind = match[1]!.replace(/-/g, '_');
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

const READ_TOOL = /read_channel|channel_history|conversations?_history|get_channel_messages/i;

/** The arguments a "read a channel" tool takes, from its own schema: the channel, and since when. */
export function readArgs(
  schema: Record<string, unknown> | undefined,
  channelId: string,
  sinceSeconds: number,
): Record<string, unknown> | null {
  const properties = (schema?.properties ?? {}) as Record<string, unknown>;
  const channel = ['channel_id', 'channel', 'channelId'].find(key => key in properties);
  const since = ['oldest', 'since', 'after'].find(key => key in properties);
  // Without a way to say "since", the answer would mix days: better no count than a wrong one
  if (!channel || !since) return null;
  const args: Record<string, unknown> = { [channel]: channelId, [since]: String(sinceSeconds) };
  if ('limit' in properties) args.limit = 200;
  return args;
}

/**
 * Reads the product's notification channels since a moment and counts the messages by kind.
 *
 * @param since - Count messages from this time on (the start of the day)
 */
export async function slackCounts(
  profile: Pick<ProductProfile, 'workspaceId' | 'slackChannels'>,
  since: number,
  service: Pick<ConnectorService, 'usableTools' | 'prepare' | 'invoke'> = connectorService,
): Promise<SlackCounts> {
  const channels = profile.slackChannels.filter(channel => channel.id);
  if (!channels.length) {
    return { ok: false, reason: 'no_channels', detail: 'The product profile names no Slack channel with its id.' };
  }
  const scope = { workspaceId: profile.workspaceId };
  const { tools, needSignIn } = await service.usableTools(scope);
  const isSlack = (name: string, url: string | null) => /slack/i.test(`${name} ${url ?? ''}`);
  const slack = tools.filter(tool => isSlack(tool.connector.name, tool.connector.url));
  if (!slack.length) {
    return needSignIn.some(connector => isSlack(connector.name, connector.url))
      ? { ok: false, reason: 'needs_sign_in', detail: 'The Slack connector needs you to sign in again.' }
      : { ok: false, reason: 'not_connected', detail: 'No Slack connector is on for this workspace.' };
  }
  const reader = slack.find(tool => READ_TOOL.test(tool.fingerprint.tool));
  if (!reader)
    return { ok: false, reason: 'no_read_tool', detail: 'The Slack connector has no tool that reads a channel.' };
  // A round runs with nobody there to click: only a tool the user set to run freely is used
  if (reader.policy !== 'read') {
    return {
      ok: false,
      reason: 'asks_first',
      detail: `The Slack tool "${reader.fingerprint.tool}" asks before it runs: set it to run without asking to have notifications counted.`,
    };
  }

  const counts: Record<string, number> = {};
  for (const channel of channels) {
    const args = readArgs(reader.fingerprint.inputSchema, channel.id, Math.floor(since / 1000));
    if (!args)
      return { ok: false, reason: 'no_read_tool', detail: 'The Slack read tool cannot be asked for one day only.' };
    try {
      const prepared = await service.prepare(scope, reader.connector.id, reader.fingerprint.tool, args);
      if ('refused' in prepared) return { ok: false, reason: 'failed', detail: prepared.refused };
      const result = await service.invoke(prepared, { retry: true, maxChars: 200_000 });
      if (result.isError) return { ok: false, reason: 'failed', detail: 'Slack answered with an error.' };
      for (const [kind, count] of Object.entries(countKinds(result.text))) counts[kind] = (counts[kind] ?? 0) + count;
    } catch {
      return { ok: false, reason: 'failed', detail: 'Slack could not be read.' };
    }
  }
  return { ok: true, counts, channels: channels.length };
}
