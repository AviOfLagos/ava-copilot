# The growth team: three agents that sell a product, and the base they need

Logged 2026-11-20 from Avi's brief. This is a spec; nothing here is built yet.
It was reviewed once against the brief and the code, and the findings are
folded in. Each numbered part maps to one GitHub issue (see "Build order").

Tracking: epic #82 (issues #64 to #81). The Suture side is `AviOfLagos/suture#103`.

First product: **Suture** (trysuture.com, repo `AviOfLagos/suture`, private).
Marketing budget for everything: **$100**.

## What Avi asked for, in one paragraph

Ava should know what is open in the browser and keep going when a tab closes.
A failed task should be retried and, if it still fails, reported, never left
silent. Ava should offer help during the day instead of waiting to be asked.
Three built-in agents should push a product into the market: a product social
media manager, a product marketing manager and a growth lead. They plan each
week, meet every morning, learn from their numbers, use free tools first, and
put a short summary in the morning brief. The morning brief itself should stop
saying zero for everything.

## What exists today (checked in the code, 2026-11-20)

| Area | Today | Where |
|---|---|---|
| Tabs | A task is bound to the active tab (or its group) in the window it was sent from. The model already sees other free tabs and can `switch_tab` to them, but only in windows the task already uses. A task never starts on an already-open tab of the right site. No record of when a tab was opened or last used. | `src/background/threads/binding.ts:55`, `browser/context.ts:66`, `:377` |
| Tab closes | When the task's last tab closes, the task is cancelled with `tab_closed`. It never reopens the tab. | `threads/manager.ts:365` |
| Retry | Model calls retry on 429/5xx. A failed task is never retried or queued again; manual Retry restarts from scratch. The only sign is a banner in the panel. | `usage/meter.ts:18`, `manager.ts:257` |
| Agents | Seven starter templates (`social_watcher`, `research_scout`, `team_mail`, `team_social`, `team_research`, `team_meetings`, `team_calendar`). `team_social` only drafts, on request. There is no marketing agent. | `src/background/agents/templates.ts` |
| Agent shape | Name, instructions, connectors, model role, one `workspaceId`, triggers (cron, topic, inbox), bus topics, budget, `owns`, `charter`, `personalityId`. | `src/storage/lib/agents/types.ts:24` |
| Personalities | A `Personality` has a name, `instructions` (how it thinks and talks) and voices. Built-ins live in one file and already carry "never claim to be him" wording. | `src/storage/lib/personalities/` |
| Products | A workspace has `about`, keywords and accounts. No structured product facts. Avi's own workspaces are seeded only when `VITE_SEED_PROFILE=avi`. Suture is not one yet. | `src/storage/lib/workspaces/workspaces.ts:20`, `:52` |
| Models | Chosen by role (`fast`, `smart`), with per-agent overrides. Claude is supported in the extension (`claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-4-5`). The companion agent only speaks OpenAI-style APIs, and companion-run agents are blocked. | `background/models/roles.ts:54`, `storage/lib/settings/types.ts:32`, `agents/profile.ts:209` |
| Scheduling | One job runner on a 30 second alarm, plus agent cron. Agent runs get their own minimised window. | `jobs/runner.ts:65`, `agents/service.ts:1044`, `agents/window.ts:99` |
| Morning brief | Built once at 08:00. The WhatsApp line shows two counts only. "Meetings" is 0 when the calendar is not connected (#32). "Waiting" counts only chats paused on an approval, so it is nearly always 0. | `brief/manager.ts:102`, `:160` |
| Tools | MCP over HTTP for GitHub, Slack, Gmail, Notion, Linear, Drive, Calendar and the social server (`si_sdk`). Local MCP servers and `gh` run through Ava Brain when it is paired. Notices reach the panel, WhatsApp and the Inbox. | `background/integrations/catalogue.ts`, `integrations/companion.ts`, `notices/index.ts:26` |
| Learning | Run history and usage per agent, a daily reflection, taught skills. No metrics for posts or campaigns, no lessons per agent. | `agents/runlog.ts`, `identity/reflection.ts` |
| Nex Mail | `aviclaw01/local-custom-mailer`: an email gateway with an HTTP API. No MCP server. | that repo's `src/app/api` |
| Suture super admin | Waitlist, sign-ups, access requests, feedback, orgs, spend, audit. Actions: approve waitlist, grant access, override plan, resolve feedback. | `suture/apps/admin/app/actions.ts` |

Already planned elsewhere and reused here, not re-planned: the account check in
code (#43), short answers (#44), agent DMs and shared rules (#47), the floor
for voice (#45), nightly evals (#48), the calendar fix (#32).

## Rules that hold for every part

1. **Deterministic core, model on top.** Code collects numbers, enforces
   limits, keeps the budget, schedules, removes duplicates and decides who may
   send what. The model chooses words, ideas and priorities.
2. **Product facts come from the product profile and the metrics store only.**
   An agent never invents a feature, price, customer, number or testimonial.
   If the fact is missing, it asks or leaves it out.
3. **Nothing goes out in Avi's name without passing the approval mode** for
   that action (Part 9). Money is never spent by an agent.
4. **Never silent.** Every run ends in one of: done, queued to retry, or a
   notice saying what is needed.
5. **Do once.** Anything that sends, posts, submits, grants or creates carries
   a key so it can never happen twice (Part 2).
6. **Free first** (Part 9). Paid tools are a written request against the budget.
7. **Account check before acting** (#43). No agent posts or sends until #43 is
   merged. Its test, restated: with the wrong account signed in on the site,
   the action is refused in code and Avi is told which account is needed.
   Drafting does not wait for it.

---

# Part A. The base

## 1. A closed tab does not end the task

Today `onTabRemoved` cancels the run when its last tab closes.

Change:
- Keep the last URL and window of every bound tab, updated from
  `tabs.onUpdated`, because the tab cannot be read once it is gone.
- One recovery path, keyed by tab id. A closed tab fires both `tabs.onRemoved`
  and `debugger.onDetach` (`target_closed`); whichever arrives first handles
  it and the other is ignored for that tab id.
- **If the run was not in the middle of a form or a send** (no field typed
  into and no submit clicked in the last 3 steps): open a replacement tab on
  the last URL (same window, or the last focused window if the window closed
  too), add it to the binding and make it current. Tell the model in the next
  state message: "The tab was closed and reopened at <url>. It is a fresh
  page: check you are signed in and where you are before continuing."
- **If it was mid-form or mid-send:** do not reopen blindly. End the run as
  Temporary (Part 2), which queues a retry that starts by checking what
  already happened.
- One reopening per run. A second close ends the run as Temporary.
- Pressing Stop is the only signal that Avi wants the task ended.
- Update `boundUrl` as the run moves, so "Reopen and continue" goes to the
  latest page, not the first one.

Done when: closing the tab during reading or navigating reopens it and the
task finishes; closing it while a form is half filled queues a retry and does
not submit anything twice.

## 2. Failed tasks retry, then report

Add a failure class to every ended run:

| Class | Examples | What happens |
|---|---|---|
| Temporary | tab closed, network down, model overloaded, background restarted, page did not load | Queue again after 1, 5, then 15 minutes. Three tries. |
| Needs Avi | sign-in needed, wrong account (#43), approval not given, CAPTCHA, 2FA | No retry. One Inbox item with the exact step needed. |
| Cannot do | site blocks it, the thing asked for does not exist | No retry. One Inbox item saying why. |

**Do-once keys (build this first, it is its own piece of work).**
- Every step that sends, posts, submits, grants or creates writes a record
  *before* it acts: a key (task id + what + target), then "started", then
  "done" with the result.
- A retry reads those records. "Done" steps are skipped. A step left at
  "started" is never repeated automatically: the retry first checks the page
  or the tool for evidence it went through, and if it cannot tell, it asks.
- Tools that act in the world take the key and refuse a repeat: Nex Mail
  `send_email`, the social post tool, issue creation (key = feedback id),
  access grants.
- Test: kill the background right after a send and before the reply is
  recorded. The retry does not send again.

**Retries.**
- The job runner owns the retry timer. A retry resumes from the transcript
  with a note listing what was already done.
- A retry is the same run, not a new one: it does not use up an agent's
  `runsPerDay`, but its model spend counts toward `dailyUsd`, and a run that
  has hit its cap waits for tomorrow instead of retrying.
- After the last failed try: one Inbox item and one WhatsApp line, "Stuck on
  <task>: <reason>. <what I need>." Never more than one per task.
- Agent runs use the same queue. A `tab_closed` agent run is retried, not
  marked failed (`agents/service.ts:837`).
- The unused `retryDelay` option in `agent/types.ts` is removed or wired up.

Done when: a task that fails because the network drops finishes on a later try
with nobody touching it; a task that needs a sign-in produces one Inbox item
that says so; the kill test above passes.

## 3. Ava knows every open tab

New `src/background/browser/tabRegistry.ts`, fed by `tabs.onCreated`,
`onUpdated`, `onActivated`, `onRemoved` and `windows.onRemoved`, kept in
`chrome.storage.session`.

Per tab: id, window, url, host, title, opened at, last active at, which task
holds it (if any).

- `tabsToBind` takes an optional site hint (the site the task names). With a
  hint, it first looks for a free open tab on that host in any normal window,
  and only then falls back to today's rule. "Go to Facebook and reply to X"
  uses the Facebook tab that is already open, and opens one only if there is
  none.
- `_adoptable` (`context.ts:66`) is widened from "windows this task already
  uses" to "any normal window". The other checks stay: http(s), not private,
  allowed by the firewall, not held by another task.
- The state message lists open tabs grouped by site, with age and last used
  time ("facebook.com: 1 tab, open 3 h, last used 20 min ago"). At most 30
  lines, most recent first.
- New action `find_tab(site or title)`.
- Tabs held by another running task are shown as busy and are not taken.
- Private windows are never listed.

**After reuse works: history.** Add `history` under `optional_permissions` in
`wxt.config.ts` (the key is not there today), so an update never disables the
extension. The permission is requested from a button in the panel, because
Chrome only allows that from a user's click. With it, `search_history(text,
days)` lets Ava reopen "the pricing page I had open yesterday". Without it,
Ava says it cannot see history and shows the button.

Done when: with a site already open in another window, a task for that site
uses that tab; asked "what do I have open?", Ava lists it by site.

## 4. Ava offers help instead of waiting

**Rounds first.** Scheduled read-only sweeps that end in one short digest:

| Round | When | Reads | Output |
|---|---|---|---|
| Mail | 09:00, 14:00 | Unread mail in each workspace's account | "14 unread: 3 need you, 2 drafts ready." |
| Product pulse | 08:30, 16:00 | Each product's numbers (Part 7) and its Slack notification channels | Counts per product, and what changed. |
| Stuck work | 12:00 | Failed and waiting tasks, open approvals | What is blocked and on whom. |

- Rounds run in the agents' own minimised window, never in a tab Avi is
  using, and one at a time.
- Slack is read through the Slack connector when it is connected, otherwise
  in the browser at app.slack.com. Channels come from the product profile.
- "What changed" is arithmetic, not a model call: today against the 7 day
  average, flagged when the change is at least 50% **and** at least 5 in
  absolute terms. It is applied to each metric on its own: sign-ups, payments,
  revenue, errors, feedback, and the count of each kind of Slack notification.
- Each round posts one Inbox item. The product's notify channel (Part 6) gets
  a line only when something is flagged.
- Browser closed at the scheduled time: the round runs once when the browser
  next opens, if it is still the same day. It never runs several missed rounds
  in a row.

**Then check-ins.** If Avi has given no task for 3 hours between 09:00 and
18:00, Ava sends one offer built from what the rounds found: "Want me to sort
your mail? 14 unread." At most 2 a day. "Not today" silences them until
tomorrow. Never during a meeting on the calendar.

Done when: a day with no instructions still produces the round digests, and at
most two offers.

## 5. The morning brief tells the truth

**5a. Truth (first, extends #32).**
- A source that is not connected shows as "Calendar: not connected", never as
  0. Same for every source. The strings go through the locale files, like
  `brief_counts` does today.
- "Waiting on you" counts Inbox items needing a decision, agent runs waiting
  for a click, failed tasks from Part 2 and chats paused on an approval.
- Calendar events are stored, so a background restart does not empty them.
- The WhatsApp line names the top item, not just counts: "2 meetings, first
  at 10:00. 3 waiting on you: approve Suture post, 2 beta replies."
- A brief with nothing in it says which sources it read, so "nothing" can be
  trusted.

**5b. Team section (after Part 10).**
- At most 200 words, written by the Growth Lead from the standup: what moved
  yesterday, the one thing today, what is needed from Avi.
- The brief is built when the standup finishes, or at 07:58 if it has not. If
  the standup did not run, the section says "Standup did not run: <reason>".

Done when: with the calendar disconnected the brief says so; with one pending
approval the count is 1; the Team section appears on days the standup ran and
says why on days it did not.

---

# Part B. The team

## 6. Product profile

One product per workspace to start. The profile is stored with the workspace
and injected next to `workspaceSection` (`workspaces/inject.ts`) for every
agent in that workspace. A separate `productId` on agents comes later, when a
workspace needs two products.

```ts
interface ProductProfile {
  workspaceId: string;
  name: string; url: string; oneLiner: string;
  audience: string[];        // who it is for, most valuable first
  problem: string;           // what hurts without it
  alternatives: string[];    // what people use instead
  differentiators: string[]; // why this one, each one provable
  pricing: string;           // exactly as on the site, or "free during beta"
  stage: 'beta' | 'live';
  repo: string;              // owner/name, where issues go
  superAdmin?: { url: string; account: string };
  slackChannels: string[];   // where its notifications land
  social: Partial<Record<'x' | 'linkedin' | 'youtube' | 'instagram' | 'reddit',
    { handle: string; account: string }>>;   // account = the login #43 checks
  email?: { from: string; replyTo?: string; via: 'nexmail' };
  notify: 'whatsapp' | 'slack' | 'both';     // where Avi hears about it
  northStar: { metric: string; weeklyTarget: number };
  budget: { totalUsd: number; spentUsd: number };
  betaRule?: { testersPerWeek: number; days: number; plan: string };
  never: string[];           // claims and places that are off limits
}
```

- Edited in the workspace screen, or by Ava through a confirmed tool call.
- Rule 2 points here: this is where product facts come from.
- A Suture workspace and profile are seeded **only under
  `VITE_SEED_PROFILE=avi`**, so Avi's data never ships in the public build:
  "LLM observability, evals and drift detection that end in a fix"; repo
  `AviOfLagos/suture`; stage beta; budget $100.
- Later: "Fill from the site" proposes a profile for Avi to confirm.

## 7. Numbers the agents work from

New table `growthMetrics`: product, date, source, metric, value, and optional
channel, campaign and post id.

Collectors are plain code on a schedule, with no model:

| Collector | Metrics | How |
|---|---|---|
| Product | sign-ups (with source), waitlist, access requests, active orgs, feedback items, payments | The product's agent API (Part 13). Until that exists, the super admin pages in Ava's window with Avi signed in. |
| Social | per post: views, likes, replies, clicks | The social server (`si_sdk`) where it reports them, otherwise the post page. |
| Email | sent, delivered, opened, replied, bounced, unsubscribed | Nex Mail (Part 12). |
| Slack | counts of sign-up, payment and error notifications | Part 4's product pulse. |
| Links | clicks per link | Every outgoing link is made by `make_link`, which adds `utm_source`, `utm_medium`, `utm_campaign`. |

- A collector that reads a page first checks the page is the one it expects
  (the labels it reads are present). If not, it records "no reading" and
  raises one notice. It never guesses and never records 0 for a failed read.
- `metrics_query(product, metric, range, by?)` is the only way an agent reads
  numbers. It returns the numbers and when they were read.
- Where sales come from depends on the product saving the `utm_*` values at
  sign-up. For Suture that is part of Part 13.

## 8. The three agents

All three are built-in templates in a "Growth team" group, off until Avi turns
the group on for a workspace. They run in the extension (`executor:
'browser'`), because that side supports Claude and companion-run agents are
blocked today.

### Growth Lead (new, `growth_lead`)

- **Job.** Owns the product's one number. Runs the weekly plan and the daily
  standup. Reads the product numbers and customer feedback, turns real
  problems into issues, tells the other two where sales come from, and keeps
  everyone on the plan.
- **Owns.** North star metric, weekly experiments, the standup, spending
  requests, customer feedback triage.
- **Feedback, every day.** Sorts each new item: bug, confusion, feature
  request, billing, praise.
  - Bug or confusion we should fix: search the product repo for an existing
    issue; comment on it, or open a new one with label `from-customer` and a
    priority by rule (below). The feedback id is the do-once key, so one piece
    of feedback never makes two issues. Then one line to Avi on the product's
    notify channel.
  - Feature request: counted; the third request for the same thing opens an
    issue.
  - Praise: passed to the Social Manager as a possible post. A customer is
    never named without their written yes.
- **Priority rule (code, not the model).** P0: data loss, security, cannot
  sign in, payment broken. P1: a main flow is broken for a paying customer or
  three users. P2: there is a workaround. P3: nice to have. The model picks
  the facts (what broke, for whom); code maps them to the priority.
- **Privacy (code, not the model).** Before an issue or a post is created, a
  check blocks email addresses, phone numbers, the names and company in the
  feedback record, and links carrying a user id. The issue links to the
  feedback id in the super admin instead.
- **Signals.** Publishes `growth.signal` on the bus when a channel's sign-ups
  move (Part 4's test), so the other two act on it the same day.
- **Beta access.** Grants beta access or credits only inside the product's
  `betaRule`. The weekly count is kept by the ledger in code, which refuses
  the grant once the limit is reached. Anything outside the rule is a request
  to Avi.
- **Personality.** Built from Sean Ellis's public work: the must-have survey,
  one north star, ranked experiments, a regular growth meeting.

### Product Marketing Manager (new, `growth_marketing`)

- **Job.** Decides who the product is for and where to reach them, then runs
  outreach: where to list and post, who to email, beta tester recruiting,
  follow-ups.
- **Owns.** Positioning, the channel list, outreach emails, the tester
  programme, the listing sites.
- **Works by.** Positioning first (who, instead of what, why us). Then a
  ranked list of channels; test the top three cheaply for a week each; keep
  the one that moves the number.
- **Email.** Sends through Nex Mail from the address in the product profile
  (Part 12 holds the limits). Until Part 12 ships it drafts only. Finds people
  through public, relevant sources only, and records why each is relevant.
- **Free feedback before paid.** Asks design and developer communities for a
  critique of the site, recruits early users for a short call or a form, and
  only then proposes paid tests.
- **Personality.** Built from April Dunford's public work on positioning,
  with the channel-testing method from "Traction" as a working tool.

### Product Social Manager (new `growth_social`, built on `team_social`)

- **Job.** Sells the product in public: a weekly content plan tied to the
  week's experiment, posts and replies drafted in the product's voice, then
  reading the numbers and doing more of what worked.
- **Adds to today's agent.** A schedule; the product profile; the week's
  context; a content plan; scheduling through the social server; metrics per
  post; lessons.
- **Works by.** Show the product working (real screens, real numbers from the
  metrics store), teach what was learned building it, answer people where
  they already talk. Replies and comments before broadcasts.
- **New accounts.** It cannot create accounts. It prepares the handle, bio
  and images and gives Avi the exact clicks.
- **Personality.** Built from Arvid Kahl's public work on building in public
  and joining existing communities.

`team_social` stays for people who want the simple drafting agent.

### Personalities

Use what exists: three new built-in `Personality` entries in
`src/storage/lib/personalities/builtins.ts`, linked from each template by
`personalityId`. No new store.

- The `instructions` text holds, in this order: 5 to 7 beliefs, "when X, do Y"
  decision rules, the questions this person always asks first, and what this
  approach says not to do. It must fit `PERSONALITY_INSTRUCTIONS_MAX`.
- Written from the person's published books, talks and essays, summarised in
  our own words. The sources are listed in `docs/personas/<id>.md`. No long
  quotes.
- The agent is "inspired by" the person. It never says it is them, and their
  name never appears in anything sent to a customer or posted.
- The personality shapes thinking and talk with Avi and the team. Outgoing
  words follow the product's voice.

### Models

Set per agent through the existing role overrides (`agentRoles`), using the
model ids in `storage/lib/settings/types.ts`:

| Work | Model |
|---|---|
| Daily judgement for all three agents | `claude-sonnet-5-5` |
| Sorting feedback, reading notifications | the Claude Haiku id (add `claude-haiku-5-5` to the list; `claude-haiku-4-5` is there today) |
| Monday plan | `claude-opus-5-5`, once a week |
| Collecting numbers, limits, budget, links, priority, privacy check, schedules | Code |

With no Claude key in Ava's settings, the agents fall back to whatever Avi's
`smart` and `fast` roles point at, and say so once in the Inbox. Each agent
keeps a daily spend cap in its `budget` field. Model spend is tracked apart
from the $100 marketing budget and shown beside it.

## 9. Approval, budget and tools

**Approval modes.** Two ship first:

| Mode | Meaning | Used for |
|---|---|---|
| Approve the batch | The agent queues the day's items. Avi approves the batch with one tap, or item by item. | Posts, replies, outreach email, follow-ups, listings. Also the first batch of every new email template, always. |
| Auto, inside a hard limit | The agent acts and reports after. The limit is enforced by code. | Issues labelled `from-customer`; beta access inside `betaRule`. |

Always asked, whatever the mode: spending, a new channel, a new account, a
plan change outside the rule, anything naming a customer. If the account check
(#43) fails, the item drops to a draft for Avi. Moving an action from
"approve" to "auto" per agent is a later setting.

**Budget.** A ledger in code holds the $100 and the beta grant counts. Agents
cannot pay. How an idea becomes spending:

1. Any agent raises an idea in the standup with the number it should move.
2. The Growth Lead ranks it against the week's experiments.
3. If it is free, it joins the plan. If it costs money, the Growth Lead files
   a spending request: amount, what it buys, what was tried for free first,
   the result expected.
4. Avi pays or declines. The ledger records it.

Suggested split to start: nothing in the first two weeks; up to $30 for paid
site critiques or user tests; up to $50 for a channel that already showed
results for free; $20 kept back.

**Tools, free first.** When an agent needs a tool it takes the first that
works: (1) something already connected, (2) a free API or MCP server, (3) the
site in the browser, (4) a free tier that needs a new account, which is a
request to Avi with the clicks, (5) a paid tool, which is a spending request.
`request_tool` is a new tool that puts that request in the Inbox.

## 10. Weekly plan, daily standup, staying on plan

**Monday 07:30, weekly plan.** The Growth Lead reads last week's numbers and
lessons and sets one focus and at most three experiments, each with: what we
try, the number it should move, how we will know by Friday, the owner. Each
agent then writes its week against those experiments.

**Every day 07:45, standup.** It starts at 07:45 so the result is in the 08:00
brief. Fixed steps:

1. Code reads yesterday and the last 7 days from the metrics store.
2. Each agent writes at most 80 words: did, learned, today, blocked.
3. Code checks every "today" item names one of the week's experiments. An
   item that does not is marked off-plan with the agent's reason.
4. The Growth Lead writes at most 200 words: what went well yesterday and
   over 7 days, what to double down on, the one goal today, decisions needed
   from Avi. More than one off-plan item is called out by name.

Four model calls a day. The result goes to the morning brief (Part 5b), to an
Inbox thread called "Growth standup", and onto the bus as `growth.standup`.
It is text; it does not need the voice floor (#45). A missed standup runs once
if the browser opens before 12:00, otherwise it is skipped and the brief says
so.

## 11. Learning

New table `lessons`: agent, product, date, the claim, the evidence (a metrics
query and its result), status (active or retired).

- Starts once there are two weeks of numbers.
- Friday 16:00: each agent proposes at most three lessons, each with evidence
  from the metrics store, and names one thing it did badly and what it
  changes next week. The Growth Lead keeps, merges or rejects them. Code
  rejects a lesson with no number behind it.
- Each agent's prompt carries its active lessons, at most 15. A 16th retires
  the oldest.
- Agents never rewrite their own instructions or personality. Lessons are the
  only thing that changes between releases, so the evals stay meaningful.

## 12. Nex Mail for agents

Nex Mail (`aviclaw01/local-custom-mailer`) has an HTTP API and no MCP server.

- A small local MCP server in Ava Brain's `mcp.json` wraps that API:
  `list_inbox`, `get_thread`, `draft_email`, `send_email`,
  `schedule_follow_up`, `email_stats`.
- Extension agents reach it through the companion tool bridge
  (`integrations/companion.ts`), listed in `catalogue.ts` as connector
  `nexmail`. It needs Ava Brain paired; without it the agent says so and
  drafts only.
- The Nex Mail API key stays in Ava Brain (the vault once Ava Keys lands). It
  never reaches the model.

Limits live in the server, not in the prompt:

- The sender is the address in the product profile and nothing else.
- Cold outreach: at most 20 new people a day per sender to start. Plain text.
  One follow-up after 3 working days, then stop.
- Stops for good on a reply, an unsubscribe or a bounce. One suppression list
  shared by all agents and products.
- Every email names a real sender and a postal address, says why this person
  is getting it and how to opt out. That covers the usual rules for business
  email (CAN-SPAM in the US; for people in the EU and UK, only business
  contacts where the product is clearly relevant to their job). No bought
  lists, no personal addresses.
- `send_email` takes the do-once key (Part 2) and obeys the approval mode.
- The sending domain needs SPF, DKIM and DMARC. The server refuses to send
  until a check passes.

## 13. Suture agent API (in `AviOfLagos/suture`)

- A small API with its own token: read sign-ups (with source), waitlist,
  access requests, feedback, orgs and payments; approve a waitlist entry,
  grant beta access, resolve feedback. Every write goes to the audit log as
  "agent".
- Save `utm_source`, `utm_medium` and `utm_campaign` at sign-up, so sales can
  be traced to a channel.
- Starts alongside Phase 1, because the collectors are much steadier on an
  API than on pages. Until it ships, Ava reads the super admin pages in its
  own window with Avi signed in and uses the existing buttons for the few
  writes.

## 14. Building the next agent the same way

`docs/agent-kit.md`: the checklist every built-in agent ships with.

1. A charter: one job, what it owns, what it never does.
2. A personality built from a named person's public work (Part 8's rules).
3. Its tools, chosen by the free-first ladder.
4. An approval mode for each thing it can do in the world, with do-once keys.
5. The numbers it owns in the metrics store.
6. A place in the standup, and lessons.
7. At least 10 eval cases.
8. A daily spend cap.

Later, once the three agents work: a scaffold command and a CI check that
fails a template missing any of these.

## Evals

Replay cases per agent, run with the rest of the suite (#48):

- **All three:** never states a product fact that is not in the profile or
  the metrics store; never acts on the wrong account; respects the approval
  mode.
- **Growth Lead:** sorts feedback correctly; the priority rule gives the
  expected priority; finds the existing issue instead of opening a duplicate;
  customer details are blocked from issues; off-plan work is flagged; a grant
  beyond the beta limit is refused.
- **Marketing:** never emails a suppressed address; stays under the daily
  limit; stops after one follow-up; ranks channels from numbers.
- **Social:** no invented numbers or quotes; drafts in the product's voice;
  stops at the approval step.
- **Base:** a closed tab is reopened; a temporary failure is retried; nothing
  is sent twice after a kill; a sign-in failure is reported once.

## Build order

Each line is one issue. Earlier lines unblock later ones.

| Phase | Issue | Needs |
|---|---|---|
| 0 | 2a. Do-once keys for sends, posts and grants | none |
| 0 | 1. Closed tab reopens | 2a |
| 0 | 2b. Failed tasks retry, then report | 2a |
| 0 | 5a. Morning brief tells the truth | #32 |
| 1 | 3. Tab registry and reuse (history after) | 1 |
| 1 | 6. Product profile and the Suture workspace | none |
| 1 | 13. Suture agent API and sign-up source | none (Suture repo) |
| 1 | 7. Metrics store and collectors | 6 |
| 1 | 4. Rounds, then check-ins | 2b, 6, 7 |
| 2 | 9. Approval modes, budget ledger, tool requests | 2a, #43 |
| 2 | 8a. Three personalities | none |
| 2 | 8b. Growth Lead | 6, 7, 8a, 9 |
| 2 | 8c. Product Marketing Manager (drafting) | 6, 7, 8a, 9 |
| 2 | 8d. Product Social Manager | 6, 7, 8a, 9 |
| 2 | 10. Weekly plan and daily standup | 8b, 8c, 8d |
| 2 | 5b. Team section in the brief | 5a, 10 |
| 3 | 12. Nex Mail server and limits (turns on sending for 8c) | 2a, 6, 9 |
| 3 | 11. Lessons and Friday review | 10, two weeks of numbers |
| 3 | 14. Agent kit | 8b, 8c, 8d |

Phase 0 goes first on purpose: agents that run every day on a base that stops
silently, or sends twice, would do the same.

## Needed from Avi

1. Sign in to the Suture super admin in Ava's window.
2. The Slack channels where product notifications land.
3. The email address Suture outreach should come from, and a postal address
   for the footer.
4. Social accounts for Suture (Ava prepares everything, Avi clicks create).
5. A Claude API key in Ava's model settings, if it is not there already.
6. The beta rule: how many testers a week, on which plan, for how long.

## Not in this spec

Voice standups (waits for #45), paid ads, payouts or refunds, any agent
spending money itself, two products in one workspace, and the desktop app's
own screens (#38).
