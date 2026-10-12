import { defineDynamic, defineTool } from 'eve/tools';
import { always } from 'eve/tools/approval';
import { z } from 'zod';
import { profileFor } from '../lib/profiles';

// (b) Per-session tool allowlist; (e) one tool always waits for a person's approval
export default defineDynamic({
  events: {
    'session.started': (_event, ctx) => {
      const allowed = profileFor(ctx.session.auth.initiator?.attributes?.profileId).tools;
      const tools = {
        shout: defineTool({
          description: 'Upper-cases a text.',
          inputSchema: z.object({ text: z.string() }),
          execute: ({ text }) => text.toUpperCase(),
        }),
        add: defineTool({
          description: 'Adds two numbers.',
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: ({ a, b }) => a + b,
        }),
        danger: defineTool({
          description: 'Pretends to send an email.',
          inputSchema: z.object({ to: z.string() }),
          approval: always(),
          execute: ({ to }) => `sent to ${to}`,
        }),
      };
      return Object.fromEntries(Object.entries(tools).filter(([name]) => allowed.includes(name)));
    },
  },
});
