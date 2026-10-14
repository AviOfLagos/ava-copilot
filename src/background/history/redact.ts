/**
 * Removes secrets from text brought in from another tool's history before it is stored or shown to a
 * model. The rules are the companion's commit scan (`companion/src/security/secrets.ts`), widened for
 * what session logs hold: whole private key blocks, bearer headers, credentials in URLs and `NAME=value`
 * lines from env files. A secret is replaced by `[redacted: kind]`; the name in front of it stays, so
 * the text still reads.
 */

interface Rule {
  kind: string;
  pattern: RegExp;
  // Which part to keep in front of the redaction (a name, a header), by capture group
  keep?: number;
}

const RULES: Rule[] = [
  {
    kind: 'private key',
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  { kind: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { kind: 'API key', pattern: /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'Google OAuth token', pattern: /\b(?:ya29\.[0-9A-Za-z_-]{20,}|GOCSPX-[0-9A-Za-z_-]{20,})/g },
  { kind: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'Stripe key', pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { kind: 'bearer token', pattern: /(\b(?:Bearer|Basic|token)\s+)[A-Za-z0-9._~+/=-]{16,}/g, keep: 1 },
  { kind: 'password in URL', pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]{3,}(?=@)/gi, keep: 1 },
  {
    kind: 'secret',
    pattern:
      /(\b[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|token|credential)s?[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)[^\s"',;]{8,}/gi,
    keep: 1,
  },
];

export interface Redacted {
  text: string;
  // How many secrets were taken out
  count: number;
}

export function redactSecrets(text: string): Redacted {
  let count = 0;
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (...match: string[]) => {
      // An earlier rule already took it out
      if (match[0].includes('[redacted')) return match[0];
      count++;
      return `${rule.keep ? match[rule.keep] : ''}[redacted: ${rule.kind}]`;
    });
  }
  return { text: out, count };
}
