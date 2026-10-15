import { DEFAULT_BUDGET, SPEC_VERSION } from './spec';
import type { WorkflowSpec } from './spec';

/** Ready-made workflows the user can start from. */

export const TEMPLATE_IDS = ['morning_tech_news', 'meeting_links'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export const HN_FRONT_PAGE_URL = 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30';
export const HF_DAILY_PAPERS_URL = 'https://huggingface.co/api/daily_papers';

export const PICK_BEST_INSTRUCTIONS =
  'Pick the five most interesting items across both sources for someone who builds AI products. For each: a bold title linked to its address, then one sentence on why it matters. Hacker News items link to their url; papers link to https://huggingface.co/papers/<id>. End with one line on the overall trend, if there is one.';

/** Every morning at 07:30: the best of Hacker News and Hugging Face, summarised into the morning brief. */
export function morningTechNews(timezone: string): WorkflowSpec {
  return {
    v: SPEC_VERSION,
    name: 'Morning tech news',
    description: 'Every morning at 07:30, the best of Hacker News and Hugging Face papers, in the morning brief.',
    nodes: [
      { id: 'morning', type: 'trigger.schedule', label: 'Every morning', cron: '30 7 * * *', timezone },
      {
        id: 'hn',
        type: 'step.http_get',
        label: 'Hacker News front page',
        url: HN_FRONT_PAGE_URL,
        format: 'json',
        maxBytes: 1_000_000,
      },
      {
        id: 'hf',
        type: 'step.http_get',
        label: 'Hugging Face daily papers',
        url: HF_DAILY_PAPERS_URL,
        format: 'json',
        maxBytes: 1_000_000,
      },
      {
        id: 'pick',
        type: 'step.llm',
        label: 'Pick and summarise the best',
        instructions: PICK_BEST_INSTRUCTIONS,
        input: 'Hacker News front page:\n{{steps.hn.output}}\n\nHugging Face daily papers:\n{{steps.hf.output}}',
      },
      {
        id: 'brief',
        type: 'out.brief_section',
        label: 'Add to the morning brief',
        title: 'Tech news',
        content: '{{steps.pick.output}}',
      },
    ],
    edges: [
      { from: 'morning', to: 'hn' },
      { from: 'morning', to: 'hf' },
      { from: 'hn', to: 'pick' },
      { from: 'hf', to: 'pick' },
      { from: 'pick', to: 'brief' },
    ],
    allowHosts: ['hn.algolia.com', 'huggingface.co'],
    budget: { ...DEFAULT_BUDGET },
  };
}

// The pages that mean a meeting: a call link (Zoom, Google Meet, Teams) or a calendar event. A Meet address is
// only a call with its code (abc-defg-hij), so the Meet home page and lobby links do not count.
export const MEETING_LINK_PATTERNS = [
  'zoom.us/j/*',
  '*.zoom.us/j/*',
  'meet.google.com/*-*-*',
  'teams.microsoft.com/l/meetup-join/*',
  'calendar.google.com/calendar/*event*',
] as const;

/**
 * Whenever a meeting link or a calendar event opens in a tab: offer to join it and take notes. The offer waits for
 * the user's click (Inbox, Workflows, and Ava says so when a conversation is on); notes then start on their own.
 */
export function meetingLinks(): WorkflowSpec {
  const triggers = MEETING_LINK_PATTERNS.map((urlPattern, index) => ({
    id: `link_${index + 1}`,
    type: 'trigger.tab' as const,
    label: ['Zoom link', 'Zoom link (company)', 'Google Meet link', 'Teams meeting link', 'Calendar event'][index],
    urlPattern,
  }));
  return {
    v: SPEC_VERSION,
    name: 'Meeting links',
    description:
      'Whenever a Zoom, Google Meet or Teams link or a calendar event opens in a tab, offer to join and take notes.',
    nodes: [...triggers, { id: 'join', type: 'step.meeting_join', label: 'Join and take notes' }],
    edges: triggers.map(trigger => ({ from: trigger.id, to: 'join' })),
    allowHosts: [],
    budget: { ...DEFAULT_BUDGET, maxModelCalls: 0 },
  };
}

/** Whether a spoken or typed request is for the meeting-links routine, so it is drafted without a model call. */
export function isMeetingLinksRequest(request: string): boolean {
  const text = request.toLowerCase();
  const meeting = /\b(zoom|google meet|meet link|teams|calendar link|calendar event|meeting link)/.test(text);
  const always = /\b(always|whenever|every time|each time|any time|hook|automatic|watch|capture|detect)\b/.test(text);
  return meeting && always;
}

export function templateSpec(id: TemplateId, timezone: string): WorkflowSpec {
  switch (id) {
    case 'morning_tech_news':
      return morningTechNews(timezone);
    case 'meeting_links':
      return meetingLinks();
  }
}
