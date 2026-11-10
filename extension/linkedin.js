// How LinkedIn's pages are built, for capture.js (loaded first), which does the rest: a post is
// sent when you save it or react to it (each can be turned off in the popup), when you right-click
// it and pick "Send this post to your brain", or from the popup on a single post's page.
// It only reads the page: it never clicks, types or changes anything on LinkedIn.
//
// LinkedIn has two layouts, and both are read:
// - The current one (seen October 2026) has random class names. A post is a list item of the
//   feed (data-testid="mainFeed"), its text is data-testid="expandable-text-box", its author is
//   the profile link around a div labelled with their name, and its buttons are known by their
//   aria-label (in English or French). It usually has no link to the post itself: the post is
//   known by a key in its componentkey attributes, which is SHA-256 of its id
//   (urn:li:activity:…), and by that id when the page shows it.
// - The older one has stable class names and the id in data-urn.

(() => {
  const { decode, fold, clean } = window.brainText;

  const URN_RE = /urn:li:(activity|ugcPost|share):(\d{15,22})/;
  const KEY_RE = /^(?:update-card-focus|expanded|commentary-)([A-Za-z0-9_-]{43})/;

  const FEED_ITEM = '[data-testid="mainFeed"] > *';
  const OLD_POST = [
    '[data-urn^="urn:li:activity:"]', '[data-urn^="urn:li:ugcPost:"]', '[data-urn^="urn:li:share:"]',
    '[data-id^="urn:li:activity:"]', '[data-id^="urn:li:ugcPost:"]', '[data-id^="urn:li:share:"]',
    '[data-view-name="feed-full-update"]', ".feed-shared-update-v2",
  ].join(",");
  const POST = `${OLD_POST}, ${FEED_ITEM}`;
  const COMMENTS = [
    '[data-id^="urn:li:comment"]', ".comments-comments-list", ".comments-comment-entity",
    ".comments-comment-item", ".comments-comment-box",
  ].join(",");
  const NEW_TEXT = '[data-testid="expandable-text-box"]';
  const OLD_TEXT = [
    ".update-components-text", ".feed-shared-inline-show-more-text", ".feed-shared-update-v2__description",
    ".feed-shared-text", '[data-view-name="feed-commentary"]', ".attributed-text-segment-list__content",
  ].join(",");
  const PROFILE_PATHS = ["/in/", "/company/", "/showcase/", "/school/"];
  // Current layout: an author's link wraps a div labelled "Name Badges Degree".
  const PROFILE = PROFILE_PATHS.map((p) => `a[href*="${p}"]`).join(",");
  const NEW_ACTOR_NAME = PROFILE_PATHS.map((p) => `a[href*="${p}"] div[aria-label]`).join(",");
  const OLD_ACTOR = ".update-components-actor, .feed-shared-actor";
  const OLD_ACTOR_NAME = [
    ".update-components-actor__title", ".update-components-actor__name", ".feed-shared-actor__name",
    ".update-components-actor__single-line-truncate",
  ].join(",");
  const OLD_ACTOR_HEADLINE = ".update-components-actor__description, .feed-shared-actor__description";
  // The post's own reaction button. Comments have theirs further down, so only the first counts.
  const REACT_BUTTON = [
    "button.react-button__trigger", 'button[aria-label^="React"]', 'button[aria-label^="Réagir"]',
    'button[aria-label^="Reaction button state"]', 'button[aria-label^="État du bouton de réaction"]',
  ].join(",");
  const REACTIONS_MENU_BUTTON = 'button[aria-label^="Open reactions menu"], button[aria-label^="Ouvrir le menu des réactions"]';
  const CONTROL_MENU_BUTTON = [
    ".feed-shared-control-menu__trigger", 'button[aria-label^="Open control menu"]',
    'button[aria-label^="Ouvrir le menu de commandes"]',
  ].join(",");
  const OLD_MENU = '[role="menu"], .artdeco-dropdown__content, .feed-shared-control-menu__content';
  const OLD_REACTION_PICK = '.reactions-menu button, [class*="reactions-menu"] button, button[class*="reactions-menu__reaction"]';
  // Reaction names as LinkedIn labels them, in English and French; anything else is "reacted".
  const REACTIONS = {
    like: ["like", "j'aime"], celebrate: ["celebrate", "bravo"], support: ["support", "soutien"],
    love: ["love", "j'adore"], insightful: ["insightful", "instructif"], funny: ["funny", "drole", "amusant"],
  };
  const REACTION_LABELS = new Set(Object.values(REACTIONS).flat());
  const MONTHS = "jan|janv|feb|fev|fevr|mar|mars|apr|avr|may|mai|jun|juin|jul|juil|aug|aou|aout|sep|sept|oct|nov|dec";
  // "3 h", "1 j", "2 sem.", "5 mo", "25 oct.", "3 mars 2025": when the post was published.
  const DATE_RE = new RegExp(`^(\\d+\\s*(s|min|h|j|d|sem|w|mo|mois|an|ans|y|yr)\\b|\\d{1,2}\\s+(${MONTHS})\\b)`);

  let menuOpenedAt = 0; // when you last opened a post's "…" menu
  let pickerOpenedAt = 0; // when you last opened (or hovered) a post's reactions

  // A name or a headline. LinkedIn writes names twice (once for screen readers) and follows
  // them with "• 2nd" or "• Following".
  function firstLine(el) {
    if (!el) return "";
    const shown = el.querySelector('[aria-hidden="true"]');
    return clean(shown?.innerText || el.innerText).split("\n")[0].split(/\s+•\s+/)[0].trim();
  }

  // ---------------------------------------------------------------- finding posts

  // The smallest block around el that has a post's text and a reaction button: the post, on a
  // page laid out in a way none of the selectors above know.
  function cardOf(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.querySelector(REACT_BUTTON) && n.querySelector(`${NEW_TEXT}, ${OLD_TEXT}`)) return n;
    }
    return null;
  }

  function postOf(el, { inComments = false } = {}) {
    if (!(el instanceof Element) || (!inComments && el.closest(COMMENTS))) return null;
    return el.closest(POST) || cardOf(el);
  }

  const isPost = (p) => p.matches(OLD_POST) || Boolean(p.querySelector(NEW_TEXT) || p.querySelector(REACT_BUTTON));

  // The posts on the page, without the elements nested inside another post.
  function posts() {
    const all = [...document.querySelectorAll(POST)].filter((p) => !p.closest(COMMENTS) && isPost(p));
    return all.filter((p) => !all.some((other) => other !== p && other.contains(p)));
  }

  function pageUrn() {
    const m = decode(location.href).match(URN_RE);
    if (m) return m[0];
    const slug = location.pathname.match(/activity-(\d{15,22})/);
    return slug ? `urn:li:activity:${slug[1]}` : null;
  }

  // On a single post's page: the post itself, not the ones suggested next to it.
  function pagePost() {
    const id = pageUrn()?.split(":").pop();
    const all = posts();
    return all.find((p) => id && urnOf(p)?.endsWith(id)) || all[0] || cardOf(document.querySelector(NEW_TEXT));
  }

  const firstReact = (post) => post.querySelector(REACT_BUTTON);

  // Whether el comes before the post's reaction bar: what's after it is comments.
  function aboveBar(post) {
    const bar = firstReact(post);
    return (el) => !bar || Boolean(el.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  // ---------------------------------------------------------------- reading a post

  function urnOf(post) {
    for (let el = post; el && el !== document.body; el = el.parentElement) {
      for (const attr of ["data-urn", "data-id"]) {
        const value = el.getAttribute(attr) || "";
        const m = !value.startsWith("urn:li:comment") && value.match(URN_RE);
        if (m) return m[0];
      }
    }
    // The current layout names the post in its header's anchor ("feed-header-urn:li:activity:…").
    const above = aboveBar(post);
    for (const el of post.querySelectorAll("[data-sdui-anchor-id], [componentkey]")) {
      if (!above(el)) continue;
      const m = `${el.getAttribute("data-sdui-anchor-id") || ""} ${el.getAttribute("componentkey") || ""}`.match(URN_RE);
      if (m) return m[0];
    }
    // The older layout's link on the post's date.
    for (const a of post.querySelectorAll('a[href*="/feed/update/urn"], a[href*="activity-"]')) {
      if (a.closest(COMMENTS)) continue;
      const href = decode(a.getAttribute("href") || "");
      const m = href.match(URN_RE) || href.match(/activity-(\d{15,22})/);
      if (m) return m[2] ? m[0] : `urn:li:activity:${m[1]}`;
    }
    return pageUrn();
  }

  // The current layout's key for the post: SHA-256 of its id, base64url.
  function keyOf(post) {
    const above = aboveBar(post);
    for (const el of [post, ...post.querySelectorAll("[componentkey]")]) {
      const m = (el.getAttribute("componentkey") || "").match(KEY_RE);
      if (m && above(el)) return m[1];
    }
    return null;
  }

  // Which actor (author) a block of text sits under: in a reshare, the first actor wrote the
  // commentary and the second one the shared post.
  function ownerOf(el, actors) {
    let owner = 0;
    actors.forEach((a, i) => {
      if (a.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) owner = i;
    });
    return owner;
  }

  function blocksOf(boxes, actors) {
    const seen = new Set();
    return boxes
      .map((el) => ({ owner: ownerOf(el, actors), text: clean(el.innerText) }))
      .filter((b) => b.text && !seen.has(b.text) && seen.add(b.text));
  }

  // The headline, publication date and profile link next to an author's name (current layout).
  function actorMeta(nameDiv) {
    const link = nameDiv?.closest("a");
    const block = link?.parentElement;
    if (!block) return { headline: "", when: "", url: "" };
    const texts = [...block.querySelectorAll("span, p")]
      .filter((s) => !s.closest("a") && [...s.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
      .map((s) => clean(s.textContent))
      .filter(Boolean);
    const when = texts.find((t) => DATE_RE.test(fold(t))) || "";
    const headline = texts.find((t) => t !== when && !/^[•·]/.test(t) && t.length > 2) || "";
    let url = "";
    try {
      const u = new URL(link.href);
      url = `${u.origin}${u.pathname}`;
    } catch {
      // not a usable link
    }
    return { headline, when, url };
  }

  function linksOf(post, above) {
    const out = [];
    for (const a of post.querySelectorAll("a[href]")) {
      if (a.closest(COMMENTS) || !above(a)) continue;
      let url;
      try {
        url = new URL(a.href);
        // LinkedIn sends outside links through a redirect: keep where it goes.
        if (url.hostname.endsWith("linkedin.com") && /^\/(redir\/|safety\/go)/.test(url.pathname)) {
          url = new URL(url.searchParams.get("url") || "");
        }
      } catch {
        continue;
      }
      if (!/^https?:$/.test(url.protocol) || /(^|\.)(linkedin\.com|licdn\.com)$/.test(url.hostname)) continue;
      if (out.some((l) => l.url === url.href)) continue;
      out.push({ text: clean(a.innerText).split("\n")[0].slice(0, 150), url: url.href });
      if (out.length === 15) break;
    }
    return out;
  }

  function mediaOf(post, above) {
    const has = (sel) => [...post.querySelectorAll(sel)].some((el) => !el.closest(COMMENTS) && above(el));
    return [
      has('[class*="update-components-document"], iframe[src*="document"]') && "document",
      has('[data-testid^="carousel"]') && "carousel",
      has('[class*="update-components-image"], [class*="feed-shared-image"]') && "image",
      has('video, [class*="update-components-linkedin-video"]') && "video",
      has('[class*="update-components-poll"]') && "poll",
      has('[class*="update-components-article"]') && "article",
      has('[class*="update-components-event"]') && "event",
    ].filter(Boolean);
  }

  // The pictures the server can show Claude: a post's photos and the pages of its document
  // (carousel), which LinkedIn draws as images whose alt is the page's text. They come from
  // media.licdn.com/dms/image/<id>/<kind>/…, the kind saying what it is: "feedshare-shrink_800"
  // for a photo, "feedshare-document-images_480" for a page; video covers, link previews and
  // profile pictures are other kinds, left out. The URL is signed, so a bigger size is picked
  // from the srcset, never rewritten.
  const MAX_IMAGES = 10;
  const GENERIC_ALT = /^(voir la photo|view photo|image|photo)$/i;
  function imagesOf(post, above) {
    const out = [];
    const kind = (src) => {
      try {
        const url = new URL(src);
        return url.hostname === "media.licdn.com" && url.pathname.startsWith("/dms/image/") ? url.pathname.split("/")[5] || "" : "";
      } catch {
        return "";
      }
    };
    for (const img of post.querySelectorAll("img")) {
      if (img.closest(COMMENTS) || !above(img) || !/^feedshare-(shrink|image|document-images)/.test(kind(img.src))) continue;
      // The largest size up to 1280 px wide, from "url 160w, url 800w, …".
      const sizes = (img.getAttribute("srcset") || "").split(",").map((s) => s.trim().split(/\s+/))
        .map(([u, w]) => ({ u, w: parseInt(w, 10) || 0 })).filter((s) => kind(s.u) && s.w <= 1280);
      const best = sizes.sort((a, b) => b.w - a.w)[0]?.u || img.currentSrc || img.src;
      const alt = clean(img.getAttribute("alt") || "");
      if (!out.some((i) => i.url === best)) out.push({ url: best, alt: GENERIC_ALT.test(alt) ? "" : alt.slice(0, 500) });
      if (out.length === MAX_IMAGES) break;
    }
    return out;
  }

  function readNew(post) {
    const above = aboveBar(post);
    const actors = [];
    for (const div of post.querySelectorAll(NEW_ACTOR_NAME)) {
      const name = firstLine(div.querySelector("span") || div);
      if (above(div) && name && !actors.some((a) => a.name === name)) actors.push({ name, el: div });
    }
    const blocks = blocksOf([...post.querySelectorAll(NEW_TEXT)].filter(above), actors.map((a) => a.el));
    const urn = urnOf(post);
    const key = keyOf(post);
    const images = imagesOf(post, above);
    if ((!blocks.length && !images.length) || !(urn || key)) return null; // a photo alone is readable now
    const meta = actorMeta(actors[0]?.el);
    const own = blocks.filter((b) => b.owner === 0);
    const shared = blocks.filter((b) => b.owner > 0);
    return {
      urn, key,
      author: actors[0]?.name || "",
      author_url: meta.url,
      headline: meta.headline,
      when: meta.when,
      text: own.map((b) => b.text).join("\n\n"),
      shared: shared.length ? { author: actors[shared[0].owner]?.name || "", text: shared.map((b) => b.text).join("\n\n") } : null,
      // Not the links next to an author's name (their website): only what the post shares.
      links: linksOf(post, (el) => above(el) && !actors.some((a) => a.el.closest("a")?.parentElement?.contains(el))),
      // The current layout has none of the class names mediaOf knows: what's attached comes from
      // the pictures found (a photo, a document's pages) and from a video player.
      media: [...new Set([
        ...mediaOf(post, above),
        ...images.map((i) => (/\/feedshare-document-images/.test(i.url) ? "document" : "image")),
        ...([...post.querySelectorAll(".video-js, video")].some(above) ? ["video"] : []),
      ])],
      images,
    };
  }

  function readOld(post) {
    const urn = urnOf(post);
    if (!urn) return null;
    const actors = [...post.querySelectorAll(OLD_ACTOR)].filter((a) => !a.closest(COMMENTS));
    const found = [...post.querySelectorAll(OLD_TEXT)].filter((el) => !el.closest(COMMENTS));
    // Of nested matches keep the innermost: the outer ones add the "…more" button.
    let boxes = found.filter((el) => !found.some((other) => other !== el && el.contains(other)));
    if (!boxes.length) {
      // An unknown variant: the longest run of text that isn't a comment, a name or a button.
      let best = null;
      for (const el of post.querySelectorAll('[dir="ltr"], .break-words, p')) {
        if (el.closest(COMMENTS) || el.closest(OLD_ACTOR) || el.closest("button")) continue;
        if (clean(el.innerText).length > clean(best?.innerText).length) best = el;
      }
      boxes = best && clean(best.innerText).length >= 20 ? [best] : [];
    }
    const blocks = blocksOf(boxes, actors);
    if (!blocks.length) return null;
    const nameOf = (actor) => firstLine(actor?.querySelector(OLD_ACTOR_NAME)) || firstLine(actor?.querySelector(PROFILE));
    // No author block at all: the first profile link outside the comments.
    const anyName = () => [...post.querySelectorAll(PROFILE)].filter((a) => !a.closest(COMMENTS)).map(firstLine).find(Boolean);
    const own = blocks.filter((b) => b.owner === 0);
    const shared = blocks.filter((b) => b.owner > 0);
    const everything = () => true;
    return {
      urn, key: null,
      author: nameOf(actors[0]) || anyName() || "",
      author_url: "",
      headline: firstLine(actors[0]?.querySelector(OLD_ACTOR_HEADLINE)),
      when: "",
      text: own.map((b) => b.text).join("\n\n"),
      shared: shared.length ? { author: nameOf(actors[shared[0].owner]), text: shared.map((b) => b.text).join("\n\n") } : null,
      links: linksOf(post, everything),
      media: mediaOf(post, everything),
      images: imagesOf(post, everything),
    };
  }

  // Everything the server needs from one post, or null when it has no id or no text.
  function readPost(post) {
    if (!post) return null;
    return (post.matches(OLD_POST) && readOld(post)) || readNew(post);
  }

  // ---------------------------------------------------------------- what you did

  // Already reacted: a click takes the reaction back. The older layout says so with aria-pressed,
  // the current one by naming the reaction instead of "no reaction" in the button's label.
  function reacted(button) {
    if (button.getAttribute("aria-pressed") === "true") return true;
    const label = fold(button.getAttribute("aria-label"));
    return /^(reaction button state|etat du bouton de reaction)/.test(label) && !/(no reaction|aucune reaction)/.test(label);
  }

  function reactionName(el) {
    const label = fold(el.getAttribute("aria-label") || el.querySelector("img")?.alt || el.innerText)
      .replace(/^(react with|reagir avec)\s+/, "");
    return Object.keys(REACTIONS).find((name) => REACTIONS[name].some((w) => label.includes(w))) || "reacted";
  }

  // A reaction picked from the picker (current layout): a button named after a reaction,
  // shortly after you opened or hovered a post's reactions.
  function reactionPick(target) {
    const old = target.closest(OLD_REACTION_PICK);
    if (old) return old;
    if (Date.now() - pickerOpenedAt > 30000) return null;
    const el = target.closest('button, [role="button"], [role="menuitem"], [role="radio"]');
    if (!el || el.matches(REACT_BUTTON) || el.hasAttribute("aria-pressed")) return null;
    const label = fold(el.getAttribute("aria-label") || el.querySelector("img")?.alt || el.innerText)
      .replace(/^(react with|reagir avec)\s+/, "");
    return REACTION_LABELS.has(label) ? el : null;
  }

  // "Save" / "Enregistrer" in a post's "…" menu (not "Unsave", "Ne plus enregistrer").
  function saveItem(target) {
    if (target.closest(".option-save")) return target.closest(".option-save");
    if (Date.now() - menuOpenedAt > 30000 && !target.closest(OLD_MENU)) return null;
    for (let el = target, i = 0; el && i < 5; el = el.parentElement, i++) {
      const text = (el.innerText || "").trim();
      if (!text || text.length > 80) break;
      const leaf = [...el.querySelectorAll("*")].find((c) => !c.children.length && c.textContent.trim());
      const labels = [el.getAttribute("aria-label"), text.split("\n")[0], leaf?.textContent];
      if (labels.some((label) => /^(save|enregistrer)\b/.test(fold(label)))) return el;
    }
    return null;
  }

  function actionOf(target) {
    const pick = reactionPick(target);
    if (pick) return { name: reactionName(pick), setting: "react", menu: true };
    const react = target.closest(REACT_BUTTON);
    if (react) return reacted(react) ? null : { name: "like", setting: "react", button: react };
    if (saveItem(target)) return { name: "saved", setting: "save", menu: true };
    return null;
  }

  // Why a post couldn't be read, in words that say where it went wrong.
  function unreadable(post) {
    if (!urnOf(post) && !keyOf(post)) return "couldn't find its id on the page.";
    return "couldn't find its text on the page.";
  }

  window.brainCapture({
    source: "post",
    settingsKey: "linkedin",
    ignore: (target) => Boolean(target.closest(COMMENTS)),
    postOf,
    readPost,
    posts,
    pagePost,
    onPostPage: () => Boolean(pageUrn()),
    unreadable,
    onClick(target) {
      if (target.closest(CONTROL_MENU_BUTTON)) menuOpenedAt = Date.now();
      if (target.closest(REACTIONS_MENU_BUTTON)) pickerOpenedAt = Date.now();
    },
    // The reactions picker opens on hover, often outside the post.
    onHover(target) {
      const button = target.closest(`${REACT_BUTTON}, ${REACTIONS_MENU_BUTTON}`);
      if (!button) return null;
      pickerOpenedAt = Date.now();
      return postOf(button);
    },
    actionOf(target, post) {
      const action = actionOf(target);
      // A comment's reaction button is further down the post: only the post's own counts.
      if (action?.button && post && firstReact(post) !== action.button) return null;
      return action;
    },
  });
})();
