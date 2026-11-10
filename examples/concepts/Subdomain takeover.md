---
type: concept
aliases: [Dangling DNS takeover, DNS takeover]
summary: "A vulnerability where a subdomain points via DNS (usually CNAME) to a third-party service that no longer owns the target, letting an attacker claim it and serve content on that subdomain."
tags: [security, recon, web-vulnerabilities]
created: 2026-09-24
updated: 2026-09-25
---

# Subdomain takeover

## Definition
A subdomain takeover happens when an organisation has a DNS record — typically a CNAME — pointing at a third-party service (S3 bucket, Heroku app, GitHub Pages site, Azure Blob, etc.) that the organisation no longer controls. An attacker registers the dangling resource on the third-party service under the same name and can then host arbitrary content on the victim's subdomain, enabling phishing, cookie theft, CSP bypass, and OAuth abuse. Detection is largely mechanical: DNS enumeration plus fingerprinting the third-party's "not found" responses. Reporting is unusually clean because the vulnerability is binary — either the subdomain resolves to attacker-controlled content or it doesn't.

## Seen in
### [[videos/I Gave Claude 12 Years of my Bug Bounty Reports - Here's What I Learned|NahamSec: I Gave Claude 12 Years of my Bug Bounty Reports - Here's…]] · 2026-09-25
- Highest signal rate across 12 years of reports: 90% valid, 5% duplicates, 28 points above RCE. [09:01](https://www.youtube.com/watch?v=wKodzXgXbWg&t=541s)
- Lands because impact is binary — the subdomain is yours or it isn't, no argument to lose. [10:04](https://www.youtube.com/watch?v=wKodzXgXbWg&t=604s)

## Related
- [[concepts/Signal rate|Signal rate]]: Subdomain takeover is the video's example of "arguability > difficulty" — high signal comes from binary impact, not sophistication.
- [[concepts/Bug bounty campaign|Bug bounty campaign]]: The mechanical detection loop makes takeovers ideal to sweep across a program set.
