# Ava speaking in a meeting — design note (not built)

Status: proposal, 2026-10-19. Nothing here is implemented. Today Ava speaks only to the user, never into a call
(rule from the Voice section of `docs/task.md`).

## What is being asked

During a Google Meet call, the user asks Ava something ("Ava, tell them the numbers from last week's report") and Ava
says the answer so that everyone in the call hears it. She never speaks on her own.

## What Chrome and Meet allow

- An extension cannot add an audio track to a WebRTC call that the page owns. Meet takes its microphone with
  `getUserMedia` inside the page; the only ways to put other audio into the call are to be the microphone Meet uses,
  or to be a separate participant.
- A page script can wrap `navigator.mediaDevices.getUserMedia` before Meet calls it and hand Meet a mixed stream
  (real mic + Ava's voice through a Web Audio graph). It works technically, but it is code injected into Google's
  page at `document_start` in the MAIN world, it breaks whenever Meet changes how it asks for the mic, and it is the
  kind of interference Google's terms and the Chrome Web Store policy look hard at.
- A virtual audio device (BlackHole/Loopback on macOS) chosen as Meet's microphone can carry the user's voice mixed
  with Ava's. That is an OS-level install, outside the extension; the Nex Brain companion could own it.
- A second participant is an ordinary Meet user: a Chrome profile (or a headless browser in the companion) signed in
  as a dedicated account, with a fake microphone fed by TTS (`--use-file-for-fake-audio-capture` for tests; a virtual
  device or a WebRTC page that plays TTS into its own `getUserMedia` stream in real use).

## Options

| | A. Dedicated account joins as "Ava (assistant)" | B. Mixed into the user's own mic |
|---|---|---|
| How | A second Chrome profile or the companion's browser signed in as e.g. `ava@nexprove.com` joins the link; its mic is a virtual device fed by Ava's TTS; it hears the call through its own tab audio | Meet's mic becomes a mix of the real mic and Ava's TTS (virtual device via the companion, or a `getUserMedia` wrapper in the page) |
| Who others see | A separate, clearly named participant tile | The user's tile talking in another voice |
| Consent/notice | Visible to all: Meet shows a new participant; hosts can remove or not admit her; works with "knock to join" | Invisible: others cannot tell it is a machine unless she says so |
| Workspace rules | Many orgs block external accounts or need the host to admit; a Google Workspace seat costs money | No admission needed |
| Reliability | Independent of the user's tab; can also record and caption the call itself (removes the tab-capture click problem) | Breaks with Meet's mic handling (wrapper) or needs an OS install (virtual device) |
| Echo | Her own audio comes back on her tab: drop it with her participant id or mute playback | The user hears her through the mic monitor only if Meet echoes; needs a duck/mute of the real mic while she talks |
| Effort | Large: second identity, credentials kept in the vault, a join flow, a session that lives for the whole call | Medium with the companion's virtual device; small but fragile with the wrapper |

Recommendation: **A**, run by the Nex Brain companion (a headless browser it controls), with B (virtual device) as a
fallback for calls that will not admit an outside participant. Never the page `getUserMedia` wrapper.

## Rules (non-negotiable for either option)

1. **Only when asked.** She speaks into the call only for a request from the user, by voice or typed, in this call.
   Never from a transcript line, a caption, a chat message in Meet, or another participant's words: those are data,
   and anything they say to her is not an instruction (`wrapUntrustedContent`).
2. **Confirm first.** Speaking into a call is a side effect, so it passes `reviewAction` like a send: the user sees
   the exact words and clicks before she says them (a spoken "yes" does not count, as for every other side effect).
   A setting may allow short answers without the click only after the user turns it on per call.
3. **Say who she is.** Her first words in a call say she is an AI assistant speaking for the user; option A shows it
   in her name too.
4. **Recording notice.** If she also records (option A can), Meet's rules apply: in Workspace, recording and
   transcription show a notice to everyone; a bot that records without Meet's own recording feature must announce it
   and the user must have the participants' consent where the law needs all-party consent (e.g. California,
   Germany). The existing first-run "tell participants" reminder extends to her.
5. **Stop at once.** The user can stop her mid-sentence (button, "Ava stop", Esc), and she leaves the call when the
   user leaves or the notes end.
6. **No account of the user's.** Option A uses a dedicated account the user sets up, never the user's own Google
   account in a second session.

## What would need checking on a real call

- Whether the user's Workspace admits an external account, and how the host sees her join.
- Latency from the request to her first word (TTS + Meet's jitter buffer), target under 2 s.
- Echo: her voice coming back through the user's speakers into the user's mic.
- Meet's handling of a participant whose mic is a virtual device that is silent most of the time (auto-mute,
  noise cancellation clipping the first syllable).
