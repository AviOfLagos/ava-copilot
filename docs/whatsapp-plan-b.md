# Plan B — Ava gets her own WhatsApp number

Status: superseded, 2026-10-20. Avi chose an unofficial WhatsApp client in Ava Brain to have Ava on WhatsApp now
(open-wa at first; replaced by Baileys on 2026-10-26, because open-wa could not send to WhatsApp's @lid chats), and accepts the risk of WhatsApp restricting the number; see "Ava on WhatsApp, through Nex Brain" in
`docs/task.md`. This Cloud API plan stays as the fallback if that number is restricted. Plan A (Ava inside your open
WhatsApp Web tab) is unchanged.

## What it gives you

You message Ava like a contact — "what's on today?", "summarise the Nexprove workspace", "remind me at 5",
"draft a reply to Tomi" — from your phone, with the browser closed. She answers in the chat, and anything that sends,
posts, buys or deletes still waits for your approval.

## How it works

```
your phone ──WhatsApp──▶ Meta Cloud API ──webhook──▶ relay (small hosted function)
                                                        │  encrypted queue, nothing readable at rest
Nex Brain on your Mac (or the extension) ◀──polls──────┘
        │  runs the request with your models, workspaces and knowledge
        └──reply──▶ Cloud API ──▶ your phone
```

- **Official only:** Meta's WhatsApp Business Platform (Cloud API). No Baileys/WAHA/whatsapp-web.js — those break
  WhatsApp's terms and get numbers banned.
- **Ava's own number:** a second SIM or a virtual number registered to a Meta Business account (verification
  needed). Your personal number stays untouched.
- **Why a relay:** Meta delivers messages by webhook to a public HTTPS address. The extension and Nex Brain (which
  listens only on 127.0.0.1) can't receive that, so a tiny relay (e.g. a Vercel function next to the site, or a
  Cloudflare Worker) checks Meta's signature, encrypts each message with a key only your devices hold, and keeps it
  until your Mac or browser picks it up. The relay can't read what it stores.

## Safety

- **Only you:** Ava answers only allowlisted numbers (yours, set in onboarding with a one-time code). Anyone else gets
  nothing, or a polite "this is a private assistant".
- **Data, not orders:** everything arriving from WhatsApp is untrusted content (`wrapUntrustedContent`), like
  pages and email today; forwarded messages and media never become instructions.
- **Approvals from your phone:** an action that commits (send an email, post, pay) is held; Ava replies with what
  she's about to do and a short code; your reply with the code from your allowlisted number counts as the click.
  GitHub commits and anything touching secrets still need the panel click — no override, as now.
- **Signatures and replay:** verify `X-Hub-Signature-256` with the app secret; drop duplicate message ids; rate-limit
  per number.
- **Secrets:** the Cloud API token lives in the vault (encrypted), never in the relay's code or logs.

## Costs (Meta, as of October 2026)

- Billing is per delivered message (since July 2025), not per conversation.
- Replies inside the 24-hour customer-service window are free text; Meta reintroduced a fee for service messages
  from 1 October 2026, with 1,000 free per number per month — far more than one person needs.
- Messages Ava starts herself (e.g. the morning brief at 7:30 when you haven't written in 24 h) must be approved
  templates; utility templates are cheap, marketing templates cost more. The brief would be a utility template.

## What can borrow from Plan A

The same skills, Inbox, workspace routing, summaries ("where are we at") and the gate. Bulk sending stays a Plan A
(your own WhatsApp Web) feature; on the Cloud API, outbound bulk is marketing-template territory with its own
rules and costs — not planned.

## Groups

Ava in your group chats depends on Meta's Groups support for the Cloud API, which has been limited and rolled out
selectively. To check before promising: whether our Business account can create/join groups via the API. Until then,
groups stay a Plan A capability (in your WhatsApp Web tab).

## Phases

1. **Account and number** (you): Meta Business account + verification, a number for Ava, an app with the WhatsApp
   product; test with Meta's free test number first.
2. **Relay** (~1–2 days): webhook endpoint, signature check, encryption, queue, polling API, deploy next to the site.
3. **Ava over WhatsApp** (~3–4 days): pairing and allowlist in onboarding, the message loop in Nex Brain (and in the
   extension when the browser is open), replies, approvals by code, voice notes in/out with the local speech engines.
4. **Proactive** (~1–2 days): morning brief and reminders as utility templates, quiet hours.
5. **Groups** — after checking Meta's Groups API access.

## Decisions for you

1. Which number for Ava (a new SIM, or a virtual number)?
2. Business account: Nexprove's, or a separate one?
3. Relay host: Vercel (next to the site) or Cloudflare?
