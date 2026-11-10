---
type: concept
aliases: [Report signal rate, Valid report ratio]
summary: "In bug bounty, the fraction of submitted reports that a program accepts as valid (not dup/informative/N-A), used as a per-hunter or per-bug-class quality metric."
tags: [bug-bounty, security, metrics]
created: 2026-09-24
updated: 2026-09-25
---

# Signal rate
 
## Definition
Signal rate is the percentage of a hunter's reports that get triaged as valid — resolved or at least accepted — versus closed as duplicate, informative, not applicable, or spam. It is the headline quality metric on platforms like HackerOne and is used both at the hunter level (are you learning to filter before you submit?) and at the bug-class level (does this vulnerability type actually land on this kind of program?). It is not the same as paid rate; a report can be valid and still pay zero (VDPs, accepted-but-not-in-scope). High signal comes from picking bugs whose impact is hard to argue with, not from picking bugs that are hard to find.

## Seen in
### [[videos/I Gave Claude 12 Years of my Bug Bounty Reports - Here's What I Learned|NahamSec: I Gave Claude 12 Years of my Bug Bounty Reports - Here's…]] · 2026-09-25
- Signal rose from 16% paid in 2014 to 75% in 2019 on one-third fewer reports — filtering before submitting drove it. [02:32](https://www.youtube.com/watch?v=wKodzXgXbWg&t=152s)
- 63% baseline: subdomain takeover 90%, RCE 62%, rate-limiting 41%; a bug lands on arguability, not difficulty. [09:01](https://www.youtube.com/watch?v=wKodzXgXbWg&t=541s)

## Related
- [[concepts/Bug bounty campaign|Bug bounty campaign]]: Campaigns can distort signal rate in either direction — one bad target class ruins a quarter.
- [[concepts/Subdomain takeover|Subdomain takeover]]: The extreme example of a high-signal bug class thanks to binary impact.
- [[concepts/Blind XSS|Blind XSS]]: Beats RCE on signal despite being "easier" — impact visibility is what pays.
