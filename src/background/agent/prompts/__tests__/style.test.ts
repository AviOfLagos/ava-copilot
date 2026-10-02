import { describe, expect, it } from 'vitest';
import { buildStyleSection } from '../style';
import { NavigatorPrompt } from '../navigator';
import { PlannerPrompt } from '../planner';
import { plannerSystemPromptTemplate } from '../templates/planner';

const STYLE = 'Be short and direct. Give the answer first.';

describe('buildStyleSection', () => {
  it('returns nothing when no style is set', () => {
    expect(buildStyleSection(undefined, 'the answer')).toBe('');
    expect(buildStyleSection('   \n', 'the answer')).toBe('');
  });

  it('wraps the style and names the field it applies to', () => {
    const section = buildStyleSection(`  ${STYLE}  `, 'the "final_answer" field');
    expect(section).toContain(`<user_response_style>\n${STYLE}\n</user_response_style>`);
    expect(section).toContain('Apply it to the "final_answer" field only.');
  });
});

describe('PlannerPrompt', () => {
  it('adds no style section without a style', () => {
    const content = new PlannerPrompt().getSystemMessage().content;
    expect(content.startsWith(plannerSystemPromptTemplate)).toBe(true);
    expect(content).not.toContain('user_response_style');
  });

  it('appends the style to the system prompt', () => {
    const content = new PlannerPrompt(STYLE).getSystemMessage().content;
    expect(content.startsWith(plannerSystemPromptTemplate)).toBe(true);
    expect(content).toContain(STYLE);
  });
});

describe('NavigatorPrompt', () => {
  it('adds no style section without a style', () => {
    const content = new NavigatorPrompt(5).getSystemMessage().content;
    expect(content).not.toContain('user_response_style');
    expect(content.endsWith('</system_instructions>')).toBe(true);
  });

  it('puts the style inside the system instructions', () => {
    const content = new NavigatorPrompt(5, STYLE).getSystemMessage().content;
    expect(content.endsWith('</system_instructions>')).toBe(true);
    expect(content.indexOf(STYLE)).toBeLessThan(content.lastIndexOf('</system_instructions>'));
    expect(content).not.toContain('{{max_actions}}');
  });

  it('keeps a style containing replacement patterns intact', () => {
    const content = new NavigatorPrompt(5, 'Costs in $& and $1 only').getSystemMessage().content;
    expect(content).toContain('Costs in $& and $1 only');
  });
});
