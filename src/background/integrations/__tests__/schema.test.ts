import { describe, expect, it } from 'vitest';
import { argumentNames, checkArgs } from '../schema';

const schema = {
  type: 'object',
  properties: {
    channel: { type: 'string', pattern: '^#' },
    text: { type: 'string', minLength: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  },
  required: ['channel', 'text'],
  additionalProperties: false,
};

describe('checkArgs', () => {
  it('lets arguments that fit through', () => {
    expect(checkArgs(schema, { channel: '#general', text: 'hello', limit: 5 })).toEqual({ ok: true });
  });

  it('says what does not fit, where', () => {
    const check = checkArgs(schema, { channel: 'general', limit: 500, extra: true });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    const all = check.errors.join(' | ');
    expect(all).toMatch(/text/);
    expect(check.errors.length).toBeLessThanOrEqual(4);
  });

  it('reads draft-07 schemas, and treats a missing schema as any object', () => {
    const draft7 = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', required: ['id'] };
    expect(checkArgs(draft7, {}).ok).toBe(false);
    expect(checkArgs(draft7, { id: 1 }).ok).toBe(true);
    expect(checkArgs(undefined, { anything: 1 }).ok).toBe(true);
  });
});

describe('argumentNames', () => {
  it('names the arguments, marking the required ones', () => {
    expect(argumentNames(schema)).toEqual(['channel*', 'text*', 'limit']);
    expect(argumentNames({ type: 'object' })).toEqual([]);
  });
});
