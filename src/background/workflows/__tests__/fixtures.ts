import { DEFAULT_BUDGET } from '../spec';
import type { WorkflowSpec } from '../spec';

/** A small workflow that feeds the brief, with nothing that needs a browser: fetch → summarise → brief. */
export function conditionFreeSpec(): WorkflowSpec {
  return {
    v: 1,
    name: 'Brief feeder',
    description: '',
    nodes: [
      { id: 'start', type: 'trigger.schedule', label: 'Morning', cron: '30 7 * * *', timezone: 'UTC' },
      {
        id: 'fetch',
        type: 'step.http_get',
        label: 'Fetch',
        url: 'https://example.com/a',
        format: 'json',
        maxBytes: 10_000,
      },
      { id: 'sum', type: 'step.llm', label: 'Summarise', instructions: 'Summarise', input: '{{steps.fetch.output}}' },
      { id: 'brief', type: 'out.brief_section', label: 'Brief', title: 'Tech news', content: '{{steps.sum.output}}' },
    ],
    edges: [
      { from: 'start', to: 'fetch' },
      { from: 'fetch', to: 'sum' },
      { from: 'sum', to: 'brief' },
    ],
    allowHosts: ['example.com'],
    budget: { ...DEFAULT_BUDGET },
  };
}
