/**
 * A scan for secrets in text about to leave the Mac (a GitHub issue, a comment). It names what it
 * found, never the secret itself. A hit stops the write; there is no override.
 */

export interface SecretFinding {
  kind: string;
  // Where in the text, for the user to look (no excerpt of the secret)
  index: number;
}

const RULES: { kind: string; pattern: RegExp }[] = [
  {
    kind: 'private key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  { kind: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { kind: 'OpenAI or Anthropic key', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'Stripe key', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/g },
  { kind: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    kind: 'password or key assignment',
    pattern: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']?[^\s"']{12,}/gi,
  },
];

export function scanForSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.pattern)) findings.push({ kind: rule.kind, index: match.index ?? 0 });
  }
  return findings.sort((a, b) => a.index - b.index);
}

/** A sentence about what was found, for the refusal. */
export function describeFindings(findings: SecretFinding[]): string {
  const kinds = [...new Set(findings.map(finding => finding.kind))];
  return `It looks like it contains a secret (${kinds.join(', ')}), so nothing was sent. Remove it and try again.`;
}
