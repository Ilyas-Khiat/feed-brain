// How X's pages are built, for capture.js (loaded first), which does the rest: a post is sent
// when you bookmark it, like it or repost it (each can be turned off in the popup), when you
// right-click it and pick "Send this post to your brain", or from the popup on a post's own page.
// It only reads the page: it never clicks, types or changes anything on X.
//
// X has two layouts, and this reads both:
// - the new one (seen in November 2026): a post is an <article>, its text the first
//   div[dir="auto"] in it, its date a link to the post ("16h", "21:11 · 4 Nov 2026"). A quoted
//   post is an <article> inside a div[role="link"][data-slot="embedded-tweet-frame"]. The buttons
//   sit in [data-engagement-action="like" | "bookmark" | "retweet"], with aria-pressed saying
//   whether you already did it.
// - the older one, marked with data-testid attributes: the post is article[data-testid="tweet"],
//   its text [data-testid="tweetText"], its author [data-testid="User-Name"], its date a <time>.
//   A quoted post sits inside as a div[role="link"].

(() => {
  const { decode, fold, clean } = window.brainText;

  const TEXT = '[data-testid="tweetText"]';
  const NEW_TEXT = 'div[dir="auto"]';
  const NAME = '[data-testid="User-Name"]';
  const SHOW_MORE = '[data-testid="tweet-text-show-more-link"]';
  const QUOTE = 'div[role="link"]'; // both layouts; the new one adds data-slot="embedded-tweet-frame"
  const STATUS_RE = /\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,20})/;
  const STATUS_LINK_RE = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,20})\/?$/; // the post itself, not /photo/1

  // The post an element is in: the outermost <article>, since a quoted post is one too.
  function postOf(el) {
    let post = el instanceof Element ? el.closest("article") : null;
    for (let up = post?.parentElement?.closest("article"); up; up = up.parentElement?.closest("article")) post = up;
    return post && idOf(post) ? post : null;
  }
  const posts = () => [...document.querySelectorAll("article")].filter((a) => !a.parentElement?.closest("article") && idOf(a));
  const onPostPage = () => STATUS_RE.test(location.pathname);

  // The quoted post an element belongs to, if any: its parts are not the post's own.
  function quoteOf(post, el) {
    const card = el.closest(QUOTE);
    return card && card !== post && post.contains(card) ? card : null;
  }
  const own = (post, selector) => [...post.querySelectorAll(selector)].filter((el) => !quoteOf(post, el));

  // Text as written: the older layout draws emojis as images, whose alt is the emoji. A "Show
  // more" button inside the text is not part of it.
  function textOf(el) {
    let out = "";
    for (const node of el?.childNodes || []) {
      if (node.nodeType === Node.TEXT_NODE) out += node.textContent;
      else if (node.nodeName === "IMG") out += node.getAttribute("alt") || "";
      else if (node.nodeName === "BR") out += "\n";
      else if (node.nodeType === Node.ELEMENT_NODE && !["svg", "BUTTON"].includes(node.nodeName)) out += textOf(node);
    }
    return out;
  }

  // The post's id and its author's handle, from the link on its date ("/simonw/status/185…"):
  // the one on a <time> in the older layout, the first link to a post in the new one.
  function idOf(post) {
    const links = [
      ...[...post.querySelectorAll("time")].map((time) => time.closest("a[href]")),
      ...post.querySelectorAll('a[href*="/status/"]'),
    ];
    for (const link of links) {
      const m = link && !quoteOf(post, link) && decode(link.getAttribute("href")).match(STATUS_LINK_RE);
      if (m) return { handle: m[1], id: m[2] };
    }
    return null;
  }

  // On a post's own page: the post itself, not the replies or the posts it answers.
  function pagePost() {
    const m = location.pathname.match(STATUS_RE);
    const all = posts();
    return all.find((p) => m && idOf(p)?.id === m[2]) || all[0] || null;
  }

  // The display name. Older layout: the first row of the User-Name block (the second has the
  // @handle and the date), without the badges. New layout: the link to the author's profile
  // whose text isn't the @handle.
  function nameOf(scope, handle, mine) {
    const block = mine(NAME)[0];
    if (block) return clean(textOf(block.firstElementChild || block)).split("\n")[0].trim();
    const want = `/${handle}`.toLowerCase();
    for (const a of mine("a[href]")) {
      const text = clean(textOf(a)).split("\n")[0].trim();
      if (decode(a.getAttribute("href")).toLowerCase() === want && text && !text.startsWith("@")) return text;
    }
    return "";
  }

  // Which layout a post is in, and its own text box.
  const older = (post) => post.matches('[data-testid="tweet"]');
  const textBoxOf = (post) => own(post, older(post) ? TEXT : NEW_TEXT)[0] || null;

  // The quoted post, if any: its author and its text (an X article shows a title and a preview,
  // in two boxes).
  function quoteRead(post) {
    const card = [...post.querySelectorAll(QUOTE)].find((c) => c.querySelector(`${TEXT}, ${NEW_TEXT}`));
    if (!card) return null;
    const mine = (sel) => [...card.querySelectorAll(sel)];
    const href = card.getAttribute("data-href") || mine('a[href*="/status/"]').map((a) => a.getAttribute("href"))[0] || "";
    const handle = (decode(href).match(STATUS_RE) || [])[1] || "";
    // A quoted article (older layout) has no tweetText: its title and first lines, under its cover.
    const cover = older(post) && !mine(TEXT).length && card.querySelector('[data-testid="article-cover-image"]');
    const boxes = cover ? [...cover.parentElement.querySelectorAll(NEW_TEXT)] : mine(older(post) ? TEXT : NEW_TEXT);
    const text = boxes.map((box) => clean(textOf(box))).filter(Boolean).join("\n\n");
    return { author: nameOf(card, handle, mine) || (handle && `@${handle}`), text };
  }

  function linksOf(post, box) {
    const out = [];
    const add = (url, text) => {
      if (/^https?:\/\//.test(url) && !/^https:\/\/(x|twitter)\.com\//.test(url) && !out.some((l) => l.url === url)) {
        out.push({ text: clean(text).split("\n")[0].replace(/…$/, "").slice(0, 150), url });
      }
    };
    // Links in the text (X shortens them to t.co, and shows where they go as their text). Its
    // hashtags and @mentions are links within X, so they're left out.
    for (const a of box?.querySelectorAll("a[href]") || []) if (/^https?:/.test(a.getAttribute("href"))) add(a.href, textOf(a));
    // A link card under the text: data-testid="card.wrapper" in the older layout, a t.co link
    // around a picture and its title in the new one (its first link has the title).
    for (const card of own(post, '[data-testid="card.wrapper"]')) {
      const a = card.querySelector("a[href]");
      if (a) add(a.href, card.innerText);
    }
    for (const a of own(post, 'a[href^="https://t.co/"]')) if (!box?.contains(a)) add(a.href, a.innerText);
    return out.slice(0, 15);
  }

  function mediaOf(post, box) {
    const has = (sel) => own(post, sel).length > 0;
    const card = has('[data-testid="card.wrapper"]') || own(post, 'a[href^="https://t.co/"]').some((a) => !box?.contains(a));
    // X wraps a video in the same block as a photo: a photo is one without a video in it.
    const photo = own(post, '[data-testid="tweetPhoto"], img[src*="pbs.twimg.com/media/"]').some(
      (el) => !el.querySelector('[data-testid="videoPlayer"], video') && !el.closest('[data-testid="videoPlayer"]'),
    );
    return [
      photo && "image",
      has('[data-testid="videoPlayer"], video') && "video",
      card && "article",
      has('[data-testid="cardPoll"]') && "poll",
    ].filter(Boolean);
  }

  // The pictures the server can show Claude: X serves them from pbs.twimg.com/media/, and a
  // video's poster comes from elsewhere. Asked for at "medium" size (up to 1200 px): enough to
  // read the text in a screenshot or a chart. `scope` is where to look: the post's own parts,
  // or an article's body.
  const MAX_IMAGES = 8;
  function imagesOf(imgs) {
    const out = [];
    for (const img of imgs) {
      let url;
      try {
        url = new URL(img.currentSrc || img.src);
      } catch {
        continue;
      }
      if (url.hostname !== "pbs.twimg.com" || !url.pathname.startsWith("/media/") || img.closest('[data-testid="videoPlayer"]')) continue;
      url.searchParams.set("name", "medium");
      if (!url.searchParams.has("format") && !/\.\w+$/.test(url.pathname)) url.searchParams.set("format", "jpg");
      const alt = clean(img.getAttribute("alt") || "");
      if (!out.some((i) => i.url === url.href)) out.push({ url: url.href, alt: alt === "Image" ? "" : alt.slice(0, 500) });
      if (out.length === MAX_IMAGES) break;
    }
    return out;
  }

  // ---- X articles: long posts with a title, opened on their own page.
  const ARTICLE_VIEW = '[data-testid="twitterArticleReadView"]';
  const ARTICLE_TITLE = '[data-testid="twitter-article-title"]';
  const ARTICLE_BODY = '[data-testid="longformRichTextComponent"]';
  const ARTICLE_COVER = '[data-testid="article-cover-image"]';

  // An article's body as Markdown-ish text: headings, quotes, lists, code, tables, and where its
  // pictures, videos and embedded posts sit. Its blocks are the body's top-level elements.
  function articleText(body, images) {
    const root = body.children.length === 1 ? body.firstElementChild : body;
    const out = [];
    const photoAt = (img) => images.findIndex((i) => i.url.split("?")[0] === (img.currentSrc || img.src).split("?")[0]) + 1;
    for (const block of root.children) {
      const text = () => clean(block.innerText);
      const heading = block.matches("h1, h2, h3") ? block : block.querySelector("h1, h2, h3");
      const code = block.querySelector('[data-testid="markdown-code-block"]');
      const embed = block.querySelector('[data-testid="simpleTweet"]');
      const table = block.querySelector("table");
      if (heading) out.push(`## ${clean(heading.innerText)}`);
      else if (block.matches("blockquote")) out.push(text().split("\n").map((l) => `> ${l}`).join("\n"));
      else if (block.matches("ul, ol")) {
        out.push([...block.querySelectorAll("li")].map((li, i) => `${block.matches("ol") ? `${i + 1}.` : "-"} ${clean(li.innerText)}`).join("\n"));
      } else if (code) {
        const pre = code.querySelector("pre");
        // Its language is in a header above the code, next to a Copy button (textOf skips buttons).
        const header = [...code.children].find((c) => c.tagName !== "PRE" && !c.querySelector("pre"));
        const lang = clean(textOf(header)).split(/\s/)[0];
        out.push("```" + (pre && lang && !pre.innerText.startsWith(lang) ? lang : "") + "\n" + (pre ? pre.innerText : text()).trimEnd() + "\n```");
      } else if (embed) {
        const who = nameOf(embed, "", (sel) => [...embed.querySelectorAll(sel)]);
        out.push(`[Embedded post by ${who || "someone"}: ${clean(textOf(embed.querySelector(TEXT)))}]`);
      } else if (table) {
        out.push([...table.querySelectorAll("tr")].map((tr) => `| ${[...tr.children].map((c) => clean(c.innerText).replace(/\n/g, " ")).join(" | ")} |`).join("\n"));
      } else if (block.querySelector('[data-testid="videoPlayer"], video')) out.push("[Video]");
      else if (block.querySelector('[data-testid="tweetPhoto"]')) {
        const n = [...block.querySelectorAll("img")].map(photoAt).find((i) => i > 0);
        out.push(n ? `[Image ${n}]` : "[Image]");
      } else if (text()) out.push(text());
    }
    return out.join("\n\n");
  }

  // An article on its own page: the whole text. In a timeline: only its card (title, a few lines,
  // a cover), marked `partial` so the extension reads it from its page instead (background.js).
  function readArticle(post, ident) {
    const view = own(post, ARTICLE_VIEW)[0];
    const author = nameOf(post, ident.handle, (sel) => own(post, sel)) || ident.handle;
    const page = `https://x.com/${ident.handle}/status/${ident.id}`;
    if (view) {
      const body = view.querySelector(ARTICLE_BODY);
      const images = imagesOf([...view.querySelectorAll('[data-testid="tweetPhoto"] img, img')]);
      const text = body ? articleText(body, images) : clean(view.innerText);
      return {
        ...ident, author, text, shared: null,
        article: { title: clean(view.querySelector(ARTICLE_TITLE)?.innerText || "").slice(0, 300) },
        links: linksOf(view, body),
        media: [...new Set([...mediaOf(view, body).filter((m) => m !== "article"), "article"])],
        images,
        truncated: false,
      };
    }
    const cover = own(post, ARTICLE_COVER)[0];
    if (!cover) return null;
    const lines = [...(cover.parentElement?.querySelectorAll('div[dir="auto"]') || [])].map((d) => clean(d.innerText)).filter(Boolean);
    return {
      ...ident, author, text: lines.slice(1).join("\n"), shared: null,
      article: { title: (lines[0] || "").slice(0, 300) },
      links: [], media: ["article"],
      images: imagesOf([...cover.querySelectorAll("img")]),
      truncated: true,
      partial: true, page, // the timeline shows only the start: read the rest from its page
    };
  }

  // Everything the server needs from one post, or null when it has no id and nothing to read.
  function readPost(post) {
    if (!post) return null;
    const ident = idOf(post);
    if (!ident) return null;
    if (older(post) && own(post, `${ARTICLE_VIEW}, ${ARTICLE_COVER}`).length) return readArticle(post, ident);
    const box = textBoxOf(post);
    // X shows the start of a long post, and "Show more": a link under the text in the older
    // layout, a button at the end of the text in the new one.
    const cut = own(post, SHOW_MORE).length > 0 || !!box?.querySelector("button");
    let text = clean(textOf(box));
    if (cut) text = text.replace(/\s*…$/, ""); // the "…" X puts before "Show more"
    const shared = quoteRead(post);
    // The quoted post's pictures count too: they're part of what you saw.
    const images = imagesOf(post.querySelectorAll('[data-testid="tweetPhoto"] img, img[src*="pbs.twimg.com/media/"]'));
    if (!text && !shared?.text && !images.length) return null; // only a video: nothing to read
    return {
      ...ident,
      author: nameOf(post, ident.handle, (sel) => own(post, sel)) || ident.handle,
      text,
      shared,
      links: linksOf(post, box),
      media: mediaOf(post, box),
      images,
      truncated: cut,
    };
  }

  function unreadable(post) {
    if (!idOf(post)) return "couldn't find its link on the page.";
    return "it has no text or picture to read (only a video).";
  }

  // A button in the new layout, if you haven't already pressed it (pressing it again takes it back).
  const fresh = (target, action) => {
    const button = target.closest(`[data-engagement-action="${action}"] button`);
    return !!button && button.getAttribute("aria-pressed") !== "true";
  };

  // What you did: a bookmark (saved), a like, or a repost (confirmed in a menu outside the post).
  function actionOf(target) {
    if (target.closest('[data-testid="bookmark"]') || fresh(target, "bookmark")) return { name: "saved", setting: "save" };
    if (target.closest('[data-testid="like"]') || fresh(target, "like")) return { name: "like", setting: "react" }; // "unlike" is taking it back
    if (target.closest('[data-testid="retweetConfirm"]')) return { name: "repost", setting: "react", menu: true };
    // A menu that opens outside the post: "Repost" (after the repost button; "Undo repost" is
    // taking it back) or "Bookmark" (in the share menu).
    const item = target.closest('[role="menuitem"]');
    const label = item ? fold(item.innerText) : "";
    if (/^(repost|retweet|reposter|republier|retweeter)$/.test(label)) return { name: "repost", setting: "react", menu: true };
    if (/^(bookmark|ajouter aux signets)\b/.test(label)) return { name: "saved", setting: "save", menu: true };
    return null;
  }

  window.brainCapture({
    source: "xpost",
    settingsKey: "x",
    postOf,
    readPost,
    posts,
    pagePost,
    onPostPage,
    unreadable,
    actionOf,
  });
})();
