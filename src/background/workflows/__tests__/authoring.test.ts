import { describe, expect, it } from 'vitest';
import { AUTHORING_MARKER, authorSpec, authoredSpecSchema, fromAuthored, toAuthored } from '../authoring';
import type { AuthoredSpec } from '../authoring';
import { morningTechNews } from '../templates';
import { validateSpec } from '../spec';

const now = new Date(2026, 9, 12, 7, 0).getTime();

// What a model answers for "every morning at 7:30 check Hacker News and Hugging Face…"
function newsAnswer(): AuthoredSpec {
  return {
    name: 'Morning tech news',
    description: 'Every morning at 07:30, the best of Hacker News and Hugging Face in the brief.',
    nodes: [
      {
        id: 'morning',
        type: 'trigger.schedule',
        label: 'Every morning',
        params: [
          { key: 'cron', value: '30 7 * * *' },
          { key: 'timezone', value: '' },
        ],
      },
      {
        id: 'hn',
        type: 'step.http_get',
        label: 'Hacker News',
        params: [
          { key: 'url', value: 'https://hn.algolia.com/api/v1/search?tags=front_page' },
          { key: 'format', value: 'json' },
        ],
      },
      {
        id: 'hf',
        type: 'step.http_get',
        label: 'Hugging Face papers',
        params: [
          { key: 'url', value: 'https://huggingface.co/api/daily_papers' },
          { key: 'maxBytes', value: '500000' },
        ],
      },
      {
        id: 'pick',
        type: 'step.llm',
        label: 'Pick the best',
        params: [
          { key: 'instructions', value: 'Pick the five best items.' },
          { key: 'input', value: 'HN: {{steps.hn.output}}\nHF: {{steps.hf.output}}' },
        ],
      },
      {
        id: 'brief',
        type: 'out.brief_section',
        label: 'Brief',
        params: [
          { key: 'title', value: 'Tech news' },
          { key: 'content', value: '{{steps.pick.output}}' },
        ],
      },
    ],
    edges: [
      { from: 'morning', to: 'hn', when: 'always' },
      { from: 'morning', to: 'hf', when: 'always' },
      { from: 'hn', to: 'pick', when: 'always' },
      { from: 'hf', to: 'pick', when: 'always' },
      { from: 'pick', to: 'brief', when: 'always' },
    ],
    // The model forgot huggingface.co; the hosts the steps fetch are added
    allowHosts: ['https://hn.algolia.com'],
  };
}

describe('authorSpec', () => {
  it('turns a request into a checked spec with one structured call', async () => {
    const prompts: { system: string; user: string }[] = [];
    const result = await authorSpec({
      request: 'every morning at 7:30 check Hacker News and Hugging Face and put the best in my brief',
      generate: async prompt => {
        prompts.push(prompt);
        return newsAnswer();
      },
      timezone: 'Europe/Lisbon',
      now,
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0].system.startsWith(AUTHORING_MARKER)).toBe(true);
    expect(prompts[0].user).toContain('every morning at 7:30');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [trigger, , hf] = result.spec.nodes;
    expect(trigger).toMatchObject({ type: 'trigger.schedule', cron: '30 7 * * *', timezone: 'Europe/Lisbon' });
    expect(hf).toMatchObject({ format: 'json', maxBytes: 500000 });
    expect(result.spec.edges.every(edge => edge.when === undefined)).toBe(true);
    expect(result.spec.allowHosts).toEqual(['hn.algolia.com', 'huggingface.co']);
  });

  it("shows the model the connector tools the routine may call, after the user's words", async () => {
    const prompts: string[] = [];
    await authorSpec({
      request: 'post the news to Slack',
      generate: async prompt => {
        prompts.push(prompt.user);
        return newsAnswer();
      },
      timezone: 'UTC',
      tools: '\n[Connector tools]\n- Slack › post_message (asks the user first)',
      now,
    });
    expect(prompts[0]).toMatch(/post the news to Slack\n\n\[Connector tools\]\n- Slack › post_message/);
  });

  it('gives the model one chance to correct problems, and says what is wrong after that', async () => {
    const broken = { ...newsAnswer(), edges: newsAnswer().edges.filter(edge => edge.to !== 'brief') };
    const prompts: string[] = [];
    const fixed = await authorSpec({
      request: 'news in my brief',
      generate: async prompt => {
        prompts.push(prompt.user);
        return prompts.length === 1 ? broken : newsAnswer();
      },
      timezone: 'UTC',
      now,
    });
    expect(fixed.ok).toBe(true);
    expect(prompts[1]).toMatch(/"brief" is not connected to a trigger/);

    const stillBroken = await authorSpec({ request: 'news', generate: async () => broken, timezone: 'UTC', now });
    expect(stillBroken.ok).toBe(false);
    if (!stillBroken.ok) expect(stillBroken.error).toMatch(/not connected to a trigger/);
  });

  it('changes an existing routine: shows it as it is, keeps its budget, and keeps what the change does not touch', async () => {
    const current = {
      ...morningTechNews('Europe/Lisbon'),
      budget: { maxSteps: 20, maxModelCalls: 2, maxTokens: 50_000, maxRunsPerDay: 2 },
    };
    let shown = '';
    const result = await authorSpec({
      request: 'also add GitHub trending',
      current,
      generate: async prompt => {
        shown = prompt.user;
        const answer = toAuthored(current);
        answer.nodes.splice(3, 0, {
          id: 'gh',
          type: 'step.http_get',
          label: 'GitHub trending',
          params: [
            { key: 'url', value: 'https://github.com/trending' },
            { key: 'format', value: 'text' },
          ],
        });
        answer.edges.push({ from: 'morning', to: 'gh', when: 'always' }, { from: 'gh', to: 'pick', when: 'always' });
        return answer;
      },
      timezone: 'UTC',
      now,
    });
    expect(shown).toContain('"id":"hn"');
    expect(shown).toContain('also add GitHub trending');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.budget).toEqual(current.budget);
    expect(result.spec.nodes.map(node => node.id)).toEqual(['morning', 'hn', 'hf', 'gh', 'pick', 'brief']);
    expect(result.spec.nodes.find(node => node.id === 'hn')).toEqual(current.nodes.find(node => node.id === 'hn'));
    expect(result.spec.allowHosts).toContain('github.com');
  });

  it('round-trips a spec through the model shape', () => {
    const spec = morningTechNews('Europe/Lisbon');
    const authored = toAuthored(spec);
    expect(authoredSpecSchema.safeParse(authored).success).toBe(true);
    const back = validateSpec(fromAuthored(authored, 'UTC', spec.budget), now);
    expect(back.ok && back.spec).toEqual(spec);
  });

  it('never offers the model the kinds of steps that are not built yet', () => {
    const answer = newsAnswer();
    answer.nodes[3] = { id: 'pick', type: 'step.sandbox', label: 'Sandbox', params: [{ key: 'command', value: 'x' }] };
    expect(authoredSpecSchema.safeParse(answer).success).toBe(false);
  });
});
