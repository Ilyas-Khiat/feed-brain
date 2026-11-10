---
type: concept
aliases: [Bounty campaign, Campaign hunting, Sweep hunting]
summary: "A bug-hunting strategy where one primitive or technique is applied across many programs in a short window rather than hunting one target at a time."
tags: [bug-bounty, security, methodology]
created: 2026-09-24
updated: 2026-09-25
---

# Bug bounty campaign

## Definition
A campaign is a repeatable move in bug bounty hunting: find a primitive (a payload, a misconfiguration, an exposed service, a version-detection oracle) on one target, recognise the class of applications that share it, then sweep every program in your set against that primitive inside a short window. It contrasts with one-off hunting where you point 20 different ideas at 20 different targets. Campaigns turn a single insight into 5–100+ reports and produce the "genius quarter" stretches most hunters remember as luck. They also carry variance: a program that doesn't want the bug class can kill an 11-report sweep.

## Seen in
### [[videos/I Gave Claude 12 Years of my Bug Bounty Reports - Here's What I Learned|NahamSec: I Gave Claude 12 Years of my Bug Bounty Reports - Here's…]] · 2026-09-25
- Clustering 1,500 reports showed his career is ~12 campaigns, not 1,500 independent finds. [11:13](https://www.youtube.com/watch?v=wKodzXgXbWg&t=673s)
- One name-field XSS primitive produced 107 reports across 33 programs over 10 years, from 2015 last-name XSS to 2025 prompt injection. [11:31](https://www.youtube.com/watch?v=wKodzXgXbWg&t=691s)

## Related
- [[concepts/Blind XSS|Blind XSS]]: A name-field XSS primitive was the seed for a 10-year, 107-report, 33-program campaign.
- [[concepts/Subdomain takeover|Subdomain takeover]]: A near-ideal campaign target because it has 90% signal, 5% duplicate — sweeps convert cleanly.
- [[concepts/Signal rate|Signal rate]]: Campaigns can spike or crater signal rate depending on whether the target class accepts the bug.
