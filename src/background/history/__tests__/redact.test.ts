import { describe, expect, it } from 'vitest';
import { redactConversation } from '../importer';
import { redactSecrets } from '../redact';

// Fake secrets, built from pieces so no scanner mistakes this file for a leak
const fake = {
  anthropic: 'sk-' + 'ant-' + 'api03-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4',
  openai: 'sk-' + 'proj-' + 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1',
  github: 'gh' + 'p_' + 'abcdefghijklmnopqrstuvwxyz0123456789AB',
  aws: 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP',
  google: 'AI' + 'za' + 'SyA1234567890abcdefghijklmnopqrstuv',
  jwt: 'ey' + 'JhbGciOiJIUzI1NiJ9.ey' + 'JzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl',
  pem: [
    '-----BEGIN ' + 'RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEAfakefakefake',
    'fakefakefake==',
    '-----END ' + 'RSA PRIVATE KEY-----',
  ].join('\n'),
};

describe('redactSecrets', () => {
  it('takes out keys, tokens and private keys, and says what they were', () => {
    const text = [
      `export ANTHROPIC_API_KEY=${fake.anthropic}`,
      `openai: ${fake.openai}`,
      `git push https://${fake.github}@github.com/x/y`,
      `aws ${fake.aws}`,
      `google ${fake.google}`,
      `Authorization: Bearer ${fake.jwt}`,
      fake.pem,
      'DATABASE_URL=postgres://admin:hunter2secret@db.example.com/app',
      'STRIPE_SECRET=whsec_abcdefghijklmnop',
      'password = "correcthorsebattery"',
    ].join('\n');
    const { text: out, count } = redactSecrets(text);
    for (const secret of [...Object.values(fake), 'hunter2secret', 'whsec_abcdefghijklmnop', 'correcthorse']) {
      expect(out).not.toContain(secret);
    }
    expect(out).not.toContain('MIIEowIBAAKCAQEA');
    expect(out).toContain('[redacted: private key]');
    expect(out).toContain('ANTHROPIC_API_KEY=[redacted');
    expect(out).toContain('postgres://admin:[redacted: password in URL]@db.example.com');
    expect(count).toBeGreaterThanOrEqual(9);
  });

  it('leaves ordinary text alone', () => {
    const text = 'We decided the token budget is 4k and the key point is pricing. See https://example.com/docs.';
    expect(redactSecrets(text)).toEqual({ text, count: 0 });
  });
});

describe('redactConversation', () => {
  it('scrubs the title, the project and every turn', () => {
    const { conversation, count } = redactConversation({
      id: 'x',
      tool: 'claude-code',
      title: `Rotate ${fake.github}`,
      project: '/Users/me/app',
      branch: null,
      startedAt: 1,
      updatedAt: 2,
      turns: [
        { role: 'user', text: `my key is ${fake.openai}`, at: 1 },
        { role: 'assistant', text: 'Rotated.', at: 2 },
      ],
    });
    expect(JSON.stringify(conversation)).not.toMatch(new RegExp(`${fake.github}|${fake.openai}`));
    expect(count).toBe(2);
    expect(conversation.turns[1].text).toBe('Rotated.');
  });
});
