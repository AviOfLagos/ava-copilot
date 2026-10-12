import { DEFAULT_BUDGET, SPEC_VERSION } from './spec';
import type { WorkflowSpec } from './spec';

/** Ready-made workflows the user can start from. */

export const TEMPLATE_IDS = ['morning_tech_news'] as const;
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

export function templateSpec(id: TemplateId, timezone: string): WorkflowSpec {
  switch (id) {
    case 'morning_tech_news':
      return morningTechNews(timezone);
  }
}
