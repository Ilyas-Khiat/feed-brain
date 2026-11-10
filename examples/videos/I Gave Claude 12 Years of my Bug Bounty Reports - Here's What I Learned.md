---
type: video
title: "I Gave Claude 12 Years of my Bug Bounty Reports - Here's What I Learned"
channel: "NahamSec"
url: https://www.youtube.com/watch?v=wKodzXgXbWg
video_id: wKodzXgXbWg
published: 2026-09-07
duration: "21:31"
captured: 2026-09-25
verdict: watch
signal: 4
novelty: partial
tags: [youtube, bug-bounty, xss, web-security, career]
---

# I Gave Claude 12 Years of my Bug Bounty Reports - Here's What I Learned

> [!tldr] Spoiler
> After feeding 1,500 HackerOne reports to an LLM, NahamSec found his best bugs came from campaigns (one primitive swept across many programs), not from chasing prestigious bug classes.

## Key claims
- **Signal rate rose from 16% paid in 2014 to 75% in 2019 on one-third fewer reports.** [02:32](https://www.youtube.com/watch?v=wKodzXgXbWg&t=152s)
  - e.g. ~28 paid reports in 2014 vs ~84 in 2019 — filtered before hitting submit.
- **Subdomain takeover lands 90% of the time; RCE only 62%, below his 63% baseline.** [09:01](https://www.youtube.com/watch?v=wKodzXgXbWg&t=541s)
  - e.g. RCE fails from impact arguments (sandbox, third-party, out of scope), not duplicates.
- **CSRF, SQLi and standalone info-disclosure went to zero for him in the last 3 years.** [05:53](https://www.youtube.com/watch?v=wKodzXgXbWg&t=353s)
  - e.g. Frameworks (Rails, Django, React) fixed them at the framework layer.
- **Stored XSS is now 40% of his reports; blind XSS jumped from 1 to 45 per year.** [07:08](https://www.youtube.com/watch?v=wKodzXgXbWg&t=428s)
  - e.g. Payload lands in an internal support tool days later, not on the next page.
- **One "name field" XSS primitive produced 107 reports across 33 programs over a decade.** [11:31](https://www.youtube.com/watch?v=wKodzXgXbWg&t=691s)
  - e.g. 2015 last name → 2017 gaming platform objects → 2025 prompt injection into AI shopping assistant.
- **Duplicate rate barely budged in 12 years: 19% in 2014, still ~27% recently.** [04:39](https://www.youtube.com/watch?v=wKodzXgXbWg&t=279s)
  - e.g. 292 duplicates out of 1,500 — the cost of hunting where others hunt.

## Sources
- HackerOne API (his own report history) [01:15](https://www.youtube.com/watch?v=wKodzXgXbWg&t=75s)
- Alex Chapman (collaborator on the Chromium user-agent campaign) [15:55](https://www.youtube.com/watch?v=wKodzXgXbWg&t=955s)

## Concepts
[[concepts/Bug bounty campaign|Bug bounty campaign]] · [[concepts/Signal rate|Signal rate]] · [[concepts/Subdomain takeover|Subdomain takeover]] · [[concepts/Blind XSS|Blind XSS]]

## Verdict
**Watch** · signal 4/5 · novelty partial · trust solid
Data-driven retrospective with concrete numbers behind campaigns and per-class signal rates — rare honesty about what pays vs. what impresses.
