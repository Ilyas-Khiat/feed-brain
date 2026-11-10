"""Small notes in the vault's own format (server/schema.md), for building test vaults."""

from datetime import date, timedelta


def days_ago(n):
    return (date.today() - timedelta(days=n)).isoformat()


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="")
    return path


def video(vault, name, *, title, channel, verdict, signal, captured, tags, claims, concepts=(),
          spoiler="", video_id="AAAAAAAAAAA", duration="10:00", reason="", trust="solid"):
    """A video note. `claims` are the Key claims bullets, e.g. "**Claim.** [@01:10]"; a line that starts
    with spaces is written as it is (an example under the claim before it)."""
    lines = [
        "---", "type: video", f'title: "{title}"', f'channel: "{channel}"',
        f"url: https://www.youtube.com/watch?v={video_id}", f"video_id: {video_id}",
        "published: 2024-01-01", f'duration: "{duration}"', f"captured: {captured}",
        f"verdict: {verdict}", f"signal: {signal}", "novelty: new", f"tags: [youtube, {', '.join(tags)}]", "---",
        "", f"# {title}", "",
    ]
    if spoiler:
        lines += ["> [!tldr] Spoiler", f"> {spoiler}", ""]
    lines += ["## Key claims", *(c if c.startswith(" ") else f"- {c}" for c in claims), "", "## Sources", "- None cited.", "",
              "## Concepts", *(f"- [[concepts/{c}|{c}]] · new" for c in concepts), "",
              "## Verdict", f"**{verdict.title()}** · signal {signal}/5 · novelty new · trust {trust}", reason, ""]
    return write(vault / "videos" / f"{name}.md", "\n".join(lines))


def post(vault, name, *, author, verdict, signal, captured, tags, gist, claims=(), concepts=(), folder="posts",
         source_tag="linkedin", post_id="P" * 43, original=""):
    lines = [
        "---", "type: post", f'author: "{author}"', 'headline: "Writes about things"',
        "url: https://www.linkedin.com/feed/update/urn:li:activity:7212345678901234567/", f"post_id: {post_id}",
        "published: 2024-06-01", f"captured: {captured}", "action: saved", f"verdict: {verdict}",
        f"signal: {signal}", f"tags: [{source_tag}, {', '.join(tags)}]", "---", "",
        f"# {author}: {name}", "", "> [!tldr] Gist", f"> {gist}", "",
        "## Key claims", *([f"- {c}" for c in claims] or ["None."]), "", "## Links", "- None.", "",
        "## Concepts", " · ".join(f"[[concepts/{c}|{c}]]" for c in concepts), "",
        "## Verdict", f"**{verdict.title()}** · signal {signal}/5 · trust solid", "Worth keeping.", "",
    ]
    text = "\n".join(lines)
    if original:
        text += "\n## Original post\n> [!quote]- " + author + "\n> " + original + "\n"
    return write(vault / folder / f"{name}.md", text)


def concept(vault, name, *, summary, aliases=(), tags=(), definition="", seen=(), related=(), updated="2026-01-01"):
    """A concept note. `seen` is a list of (note link target, label, [points]), e.g.
    ("videos/Some video", "Channel: Some video", ["a point"])."""
    lines = ["---", "type: concept", f"aliases: [{', '.join(aliases)}]", f'summary: "{summary}"',
             f"tags: [{', '.join(tags)}]", "created: 2026-01-01", f"updated: {updated}", "---", "",
             f"# {name}", "", "## Definition", definition or summary, "", "## Seen in"]
    for target, label, points in seen:
        lines += [f"### [[{target}|{label}]] · {updated}", *(f"- {p}" for p in points)]
    lines += ["", "## Related", *(f"- [[concepts/{r}|{r}]]: related." for r in related), ""]
    return write(vault / "concepts" / f"{name}.md", "\n".join(lines))
