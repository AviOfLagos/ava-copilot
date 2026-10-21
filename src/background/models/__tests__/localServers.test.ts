import { describe, expect, it } from 'vitest';
import { COMPANION_DEFAULT_PORT } from '@src/shared/lib/protocol/companion';
import { localModelPorts, originRules } from '../localServers';

describe('local model servers answer the extension', () => {
  it("covers Ollama, LM Studio and local providers' own ports, never Nex Brain's", () => {
    const ports = localModelPorts(
      [
        'http://localhost:8080/v1',
        'http://127.0.0.1:11434',
        'https://api.openai.com/v1',
        undefined,
        'http://localhost:5555',
      ],
      5555,
    );
    expect(ports).toEqual([1234, 8080, 11434]);
    expect(localModelPorts([`http://127.0.0.1:${COMPANION_DEFAULT_PORT}`], 9999)).not.toContain(COMPANION_DEFAULT_PORT);
  });

  it("removes the Origin only from this extension's requests to localhost on those ports", () => {
    const [rule] = originRules([11434], 'abcdefghijklmnopabcdefghijklmnop');
    expect(rule.action.requestHeaders).toEqual([{ header: 'origin', operation: 'remove' }]);
    expect(rule.condition.initiatorDomains).toEqual(['abcdefghijklmnopabcdefghijklmnop']);
    const pattern = new RegExp(rule.condition.regexFilter!);
    expect(pattern.test('http://localhost:11434/api/tags')).toBe(true);
    expect(pattern.test('http://127.0.0.1:11434/v1/chat/completions')).toBe(true);
    expect(pattern.test('http://localhost:114340/api/tags')).toBe(false);
    expect(pattern.test('http://evil.example:11434/api/tags')).toBe(false);
    expect(pattern.test('http://localhost.evil.example:11434/')).toBe(false);
    expect(pattern.test(`http://127.0.0.1:${COMPANION_DEFAULT_PORT}/v1/health`)).toBe(false);
  });
});
