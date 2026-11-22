---
title: "Code mode and tool search: cut an AI assistant's tool tokens"
description: "What Cloudflare and Anthropic found about code mode, tool search and memory, what it costs one real browser assistant, and the small steps we plan first."
slug: code-mode-tool-search-cut-ai-tool-tokens
datePublished: TBD (set when published)
author: The Ava Copilot team
keywords:
  - code mode MCP
  - reduce LLM tool token usage
  - AI agent tool search
  - programmatic tool calling
  - MCP token cost
  - AI assistant memory
  - Chrome extension sandbox
canonical: https://ava.nexprove.com/blog/code-mode-tool-search-cut-ai-tool-tokens
status: DRAFT for the website session. Facts verified against sources on 2026-11-22; see docs/research/.
---

# Code mode and tool search: how an AI assistant can cut its tool tokens

Every time an AI assistant takes a step, it is shown the list of everything it can do. Add forty new tools and every call gets longer, on every channel, even when the question is "what time is it?". Here is what Cloudflare and Anthropic found, what it costs one real assistant today, and the plan we are following. We have **not shipped this yet**: this is the research and the plan, with the numbers we measured.

## The short version

- **Code mode** shows the model a short typed API and lets it write a small program, run in a sandbox, instead of calling tools one at a time. Cloudflare reports about 1,000 tokens in place of 1.17 million for its own very large API.
- **Tool search** keeps a few tools loaded and lets the model look up the rest when it needs them. Anthropic reports an 85% cut in its five-server example.
- **Trimming and caching** (shorter descriptions, a stable start of the prompt) is the cheapest first step and has no risk.
- For an assistant that mostly works on web pages, **start with trimming and tool search; try code mode on data jobs only**, and keep one click for every send, post or delete.

## What Cloudflare published

In September 2025 Cloudflare described [Code Mode](https://blog.cloudflare.com/code-mode/): turn an MCP server's tools into a TypeScript API, give the model one tool ("run this code"), and run the code in a V8 isolate with no internet. The code reaches your tools only through bindings, so it never holds an API key. In February 2026 it showed a [server for the whole Cloudflare API](https://blog.cloudflare.com/code-mode-mcp/) with two tools, `search()` and `execute()`, in about 1,000 tokens against 1.17 million for the same API as ordinary tools. These are Cloudflare's own measurements.

## What Anthropic published

In November 2025 Anthropic published [code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) (150,000 tokens down to 2,000 in one worked example) and [advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use): a tool search tool (their five-server example: about 77,000 tokens down to 8,700) and programmatic tool calling (37% fewer tokens on complex research tasks). Their [memory tool and context editing](https://www.anthropic.com/news/context-management) keep notes outside the model's window and clear old tool results; they report 84% fewer tokens in a 100-turn test. They say less: tool search helps less under ten tools, programmatic calling helps less for single calls, and running agent code needs sandboxing, limits and monitoring.

## What it costs one real assistant

Ava Copilot is a browser extension. We counted from the source (characters divided by four, so treat these as estimates):

| Where | Tools sent | Tokens before the task starts |
|---|---|---|
| Browser steps (panel, WhatsApp, agents, routines) | 85 | about 14,000 to 19,000 per step |
| Planner | none | about 2,500 per planning round |
| Voice | 64 | about 8,000 at the start of a session |

The same 85 tools go to a WhatsApp message asking for the time. Nothing in the code chooses tools by channel, and no one can see tool tokens as a number.

## The plan, in the order we would do it

1. **Measure.** A test that prints the size of each part of each prompt, so every later change shows a number.
2. **Trim and cache.** Shorter descriptions, one shared field instead of 85 copies, a stable start of the prompt. Low risk.
3. **One catalogue of tools.** Every tool described once, with a rule for each channel (for example: nothing that needs a person at the screen on WhatsApp). Each channel's list, and the answer to "what can you do?", is generated from it.
4. **Load tools on demand.** Keep about 25 core tools and add a `find_tool` step. Our estimate: about half the tool tokens per step.
5. **Code mode, as a pilot.** Read-only tools first, in a JavaScript engine compiled to WebAssembly inside an extension page. Writes only after that, and each send, post, delete or spend still gets its own click.

## Try it in your own product

These snippets are small and illustrative. We ran each once on sample data; they are not production code.

**1. Turn tool definitions into a short typed API** (the code-mode idea, without the sandbox):

```ts
type Param = { type: 'string' | 'number' | 'boolean'; optional?: boolean };
type Tool = { name: string; description: string; params: Record<string, Param> };

export function toDeclaration(tools: Tool[]): string {
  const members = tools.map(tool => {
    const fields = Object.entries(tool.params)
      .map(([key, p]) => `${key}${p.optional ? '?' : ''}: ${p.type}`)
      .join('; ');
    return `  /** ${tool.description} */\n  ${tool.name}(input: { ${fields} }): Promise<unknown>;`;
  });
  return `declare const tools: {\n${members.join('\n')}\n};`;
}
```

**2. A tiny `find_tool` that works with any model provider** (no vendor feature needed):

```ts
export function findTools(query: string, tools: Tool[], limit = 5): Tool[] {
  const words = query.toLowerCase().split(/\W+/).filter(w => w.length > 2);
  return tools
    .map(tool => ({
      tool,
      score: words.reduce(
        (sum, w) => sum + (tool.name.includes(w) ? 3 : 0) + (tool.description.toLowerCase().includes(w) ? 1 : 0),
        0,
      ),
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.tool);
}
```

**3. One catalogue, one list per channel, one honest "what I can do":**

```ts
type Channel = 'panel' | 'voice' | 'whatsapp' | 'agent';
type Spec = {
  id: string;
  title: string;          // plain words for a person
  needsScreen: boolean;   // only makes sense with the user at the computer
  channels: Partial<Record<Channel, 'direct' | 'hand-over'>>;
};

export const toolsFor = (specs: Spec[], channel: Channel) => specs.filter(s => s.channels[channel] === 'direct');
export const whatICanDo = (specs: Spec[], channel: Channel) =>
  toolsFor(specs, channel).map(s => s.title).join(', ');
```

**4. If you run model-written code in a Chrome extension**, ordinary extension pages may not build code from text; a page declared as a sandbox may, but has no extension APIs and can talk only by `postMessage` ([Chrome docs](https://developer.chrome.com/docs/extensions/reference/manifest/sandbox)):

```json
{
  "sandbox": { "pages": ["sandbox.html"] },
  "content_security_policy": {
    "sandbox": "sandbox allow-scripts; script-src 'self' 'unsafe-eval'"
  }
}
```

Keep these rules whatever you choose: a tool that sends, posts, deletes, spends or shares asks first, one question per effect, even inside a program; a retried program must not repeat an effect (give each effect a key and skip the ones already done); text from web pages and other people's messages is data, never code; secrets stay outside the model.

## Frequently asked questions

**Is code mode better than tool search?** They solve different parts. Tool search shrinks the list of tools the model sees. Code mode also keeps in-between results out of the model's view. For work that is mostly looking at web pages, tool search and trimming come first.

**Does code mode work with small local models?** Often badly: small models write code less reliably. We would allow it only for the stronger model and fall back to normal tool calls on failure.

**Is it safe to run model-written code?** Only inside a sandbox that has no network, no secrets and no way to act except through functions you hand it. Cloudflare's own docs say hardening a sandbox is hard and needs extra layers. Every side effect should still need the user's click.

**Do I need Anthropic's memory tool?** Not if your product already stores memory in code with sources and caps. The useful ideas are to clear old tool results early and to keep memory outside the window.

## Sources

Cloudflare: [Code Mode](https://blog.cloudflare.com/code-mode/) (2025-09-26), [Code Mode MCP server](https://blog.cloudflare.com/code-mode-mcp/) (2026-02-20), [Dynamic Workers](https://blog.cloudflare.com/dynamic-workers) (2026-03-24). Anthropic: [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) (2025-11-04), [Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use) (2025-11-24), [Managing context](https://www.anthropic.com/news/context-management) (2025-09-29). Our full notes, with every number and its source: `docs/research/code-mode.md`, `tool-awareness.md` and `memory.md` in the [Ava Copilot repository](https://github.com/AviOfLagos/ava-copilot).

---

## Notes for the website session (not part of the post)

- **Scope.** `site/docs/BRIEF.md` lists a blog as out of scope for v1; this needs that decision changed before it can publish. The site has no analytics and loads nothing from anyone else, so the post should too.
- **SEO.** Title 60 characters, description 155. One H1. Suggested `Article` plus `FAQPage` JSON-LD from the FAQ above. Add to the sitemap and `llms.txt`. Add an OG image in the site's existing link-preview style. Link `/install` and `/roadmap` from the end.
- **Cross-posting to Nexprove and Suture.** Embed or copy with `<link rel="canonical" href="https://ava.nexprove.com/blog/…">` pointing back here, so search engines credit one page.
- **Do not publish yet:** the numbers about Ava are estimates (characters divided by four, from source text, nothing run); the post says so. Re-check them after the measuring issue ships and replace the table.
- **Links to the research files** work only after the research pull request is merged.
- **Dates.** Set `datePublished` on the day. Nothing has been posted or scheduled.
