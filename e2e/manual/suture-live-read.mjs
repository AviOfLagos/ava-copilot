// Reads the live Suture agent API with the extension's own collector client, to see that every read still fits
// the shape the collector expects. Read-only (GET). The token arrives on stdin and is never printed: only whether
// each read went through, and the counts. Needs Node 24 (it runs the TypeScript source as it is).
//
//   security find-generic-password -s suture-agent-api-token -w | node e2e/manual/suture-live-read.mjs
//
// "NO READING (unexpected_shape)" on a line means the API changed and src/background/growth/suture.ts must follow.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let token = '';
for await (const chunk of process.stdin) token += chunk;
token = token.trim();
if (!token) {
  console.log('no token on stdin');
  process.exit(2);
}

const { createSutureClient } = await import(pathToFileURL(path.join(root, 'src/background/growth/suture.ts')).href);
const client = createSutureClient('https://admin.trysuture.com/api/agent/v1', token);
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

// Only whether each read went through and the shape of what came back: never the token, and no customer text
const show = (name, read) => {
  if (!read.ok) return console.log(`${name}: NO READING (${read.reason}) ${read.detail}`);
  const value = read.value;
  if (value === true) return console.log(`${name}: ok`);
  const parts = Object.entries(value).map(([key, item]) =>
    Array.isArray(item) ? `${key}[${item.length}]` : `${key}=${typeof item === 'string' ? JSON.stringify(item) : item}`,
  );
  console.log(`${name}: ok ${parts.join(' ')}`);
};

show('check', await client.check());
for (const day of [yesterday, today]) {
  show(`signups ${day}`, await client.signups(day));
  show(`waitlist ${day}`, await client.waitlist(day));
  show(`access-requests ${day}`, await client.accessRequests(day));
  show(`feedback ${day}`, await client.feedback(day));
  show(`spend ${day}`, await client.spend(day));
  show(`payments ${day}`, await client.payments(day));
}
show('orgs', await client.orgs());
