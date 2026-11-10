---
type: concept
aliases: [Blind cross-site scripting, BXSS]
summary: "A stored XSS variant where the payload fires somewhere the attacker never sees, typically an internal back-office tool, and reports itself via an out-of-band callback."
tags: [security, xss, web-vulnerabilities]
created: 2026-09-24
updated: 2026-09-25
---

# Blind XSS

## Definition
Blind XSS is a stored cross-site scripting attack where the injection point and the render point are on different screens, often days apart. The payload is planted in a normal-looking field (name, address, business URL) and later executed inside a support agent's dashboard, an analytics viewer, an internal admin console, or any back-office tool the attacker cannot reach directly. Because the tester never sees it fire, the payload has to phone home — it uses an out-of-band listener (Burp Collaborator, interact.sh, XSS Hunter) to report execution, DOM contents, cookies, and location. The technique became viable as SaaS apps grew large enough to have internal tooling built around user-supplied data.

## Seen in
### [[videos/I Gave Claude 12 Years of my Bug Bounty Reports - Here's What I Learned|NahamSec: I Gave Claude 12 Years of my Bug Bounty Reports - Here's…]] · 2026-09-25
- Blind XSS jumped from 1 report in his first 3 years to 45 in a single year. [08:04](https://www.youtube.com/watch?v=wKodzXgXbWg&t=484s)
- Payload fires days later in an internal back-office tool, not on the next page. [07:26](https://www.youtube.com/watch?v=wKodzXgXbWg&t=446s)

## Related
- [[concepts/Bug bounty campaign|Bug bounty campaign]]: Blind XSS scales as a campaign because the same "name field" primitive works across catalog-driven and object-driven apps.
- [[concepts/Signal rate|Signal rate]]: Stored/blind XSS all beat RCE on signal rate in his data — the impact is visible and hard to argue with.
