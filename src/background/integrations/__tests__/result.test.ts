import { describe, expect, it } from 'vitest';
import { formatToolResult } from '../result';

describe('formatToolResult', () => {
  it('joins text parts and names files, images and sounds without inlining them', () => {
    const result = formatToolResult(
      {
        content: [
          { type: 'text', text: 'Two files found.' },
          { type: 'image', mimeType: 'image/png', data: 'A'.repeat(400) },
          { type: 'resource_link', name: 'plan.md', uri: 'file:///plan.md' },
          { type: 'resource', resource: { uri: 'mem://notes', text: 'The notes' } },
          { type: 'audio', mimeType: 'audio/wav', data: 'AAAA' },
        ],
      },
      1000,
    );
    expect(result.isError).toBe(false);
    expect(result.text).toContain('Two files found.');
    expect(result.text).toContain('[image image/png, 300 bytes, not shown]');
    expect(result.text).toContain('[link] plan.md file:///plan.md');
    expect(result.text).toContain('[mem://notes]\nThe notes');
    expect(result.text).toContain('[audio audio/wav, 3 bytes, not played]');
    expect(result.text).not.toContain('AAAA');
  });

  it('falls back to structured content, says when the tool failed, and cuts long answers', () => {
    expect(formatToolResult({ content: [], structuredContent: { ok: 1 } }, 100).text).toBe('{"ok":1}');
    expect(formatToolResult({ content: [{ type: 'text', text: 'No such order' }], isError: true }, 100)).toMatchObject({
      text: 'No such order',
      isError: true,
    });
    const long = formatToolResult({ content: [{ type: 'text', text: 'x'.repeat(50) }] }, 10);
    expect(long).toMatchObject({ truncated: true, text: `${'x'.repeat(10)}\n[…cut at 10 characters]` });
    expect(formatToolResult({}, 100).text).toBe('(no content)');
  });
});
