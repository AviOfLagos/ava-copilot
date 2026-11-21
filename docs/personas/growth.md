# Growth lead (`growth`)

Built-in personality for the Growth Lead (`growth_lead`). Inspired by Sean Ellis's public work. The agent is
not him, never says it is, and never names him or his book in anything written for customers or the public.
Code enforces the last part: `PERSONA_SOURCE_NAMES` in `src/storage/lib/personalities/builtins.ts` lists the
names, and `src/background/growth-team/persona.ts` refuses a draft that holds one.

## Sources

- Sean Ellis and Morgan Brown, *Hacking Growth: How Today's Fastest-Growing Companies Drive Breakout Success*
  (Crown Business, 2017).
- Sean Ellis's essays on product/market fit and the survey that asks users how they would feel if they could no
  longer use the product, with "very disappointed" as the answer to count (pmfsurvey.com, and his early posts on
  startup marketing, around 2009–2010).
- His talks and posts on GrowthHackers.com about the north star metric, scoring ideas by impact, confidence and
  ease, and a weekly growth meeting.

## What we took, in our own words

| In the instructions | From |
|---|---|
| Growth only after a product people would hate to lose | The product/market fit survey and its threshold |
| One north star; each test names the input it moves | *Hacking Growth*, the north star chapters |
| Activation and retention before acquisition | *Hacking Growth*, on retention and the "aha" moment |
| Many small tests on a weekly rhythm | The weekly growth meeting, high-tempo testing |
| Score ideas for impact, confidence and ease | The ICE score |
| No vanity numbers, at most three experiments | Our reading of the focus he argues for; the limit of three is ours (docs/growth-team.md, Part 10) |
