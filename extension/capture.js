// Shared by the scripts that read posts on a site (linkedin.js, x.js…), loaded before them: the
// message at the bottom of the page, sending a post to the brain, the save/react listeners, and
// the answers to the right-click menu and the popup. A site script only says how its pages are
// built, by calling brainCapture() with:
//   source       the source's key on the server (sources.py): "post", "xpost"…
//   settingsKey  where the popup keeps its two switches (save, react) for this site
//   postOf(el, { inComments })   the post an element is in, or null
//   readPost(post)               what the server needs from it, or null
//   posts(), pagePost(), onPostPage()   every post on the page; the one a post's own page is about
//   actionOf(target, post)       { name, setting: "save" | "react", menu } for a click that saves or reacts
//   ignore(target), onClick(target), onHover(target)   optional: clicks to skip, and the site's own bookkeeping
//   unreadable(post)             why a post couldn't be read
// It only reads the page: it never clicks, types or changes anything on the site.

window.brainText = {
  decode(s) {
    try {
      return decodeURIComponent(s);
    } catch {
      return s; // a malformed %-sequence: read it as it is
    }
  },
  fold: (s) => (s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[’‘]/g, "'").toLowerCase().trim(),
  clean: (t) =>
    (t || "")
      .replace(/ /g, " ")
      .replace(/\bhashtag\s*#/gi, "#") // a hashtag's hidden "hashtag" prefix, for screen readers
      .replace(/(…|\.\.\.)\s*(see more|more|voir plus|plus|afficher plus|show more)\s*$/i, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
};

window.brainCapture = (site) => {
  // After the extension reloads, the copy already in an open page loses its connection to it
  // (chrome.runtime.id goes away) and a fresh copy is added. The old one then stays quiet,
  // and a page never runs two working copies.
  const alive = () => Boolean(chrome.runtime?.id);
  if (window.__feedBrainAlive?.()) return;
  window.__feedBrainAlive = alive;

  const settings = { save: true, react: true };
  let lastPost = null; // the post you last clicked or hovered: its menus can open outside it
  let lastPostAt = 0;
  let lastRightClicked = null;
  let lastRightClickedAt = 0;
  const sentAt = new Map(); // post -> time, so a like followed by a save sends the post once

  chrome.storage.local.get(site.settingsKey).then((stored) => Object.assign(settings, stored[site.settingsKey]));
  chrome.storage.onChanged.addListener((changes) => {
    if (changes[site.settingsKey]) Object.assign(settings, changes[site.settingsKey].newValue);
  });

  // A short message at the bottom of the page: what happened to the post you sent. Windows can
  // hide Chrome's notifications, so this is the feedback that's always seen.
  let toastTimer;
  function toast(text, tone = "info") {
    let host = document.getElementById("feed-brain-toast");
    if (!host) {
      host = document.createElement("div");
      host.id = "feed-brain-toast";
      // A shadow root keeps the site's styles off it, and its styles off the site.
      host.attachShadow({ mode: "open" }).innerHTML = `<style>
        div { position: fixed; z-index: 2147483647; left: 50%; bottom: 24px; transform: translateX(-50%);
              max-width: min(440px, calc(100vw - 32px)); padding: 10px 14px; border-radius: 10px;
              font: 500 13px/1.4 system-ui, "Segoe UI", sans-serif; color: #fff; background: #201d2e;
              box-shadow: 0 6px 24px rgba(0, 0, 0, .25); }
        div.ok { background: #1f6b42; }
        div.error { background: #b3261e; }
      </style><div role="status"></div>`;
      document.documentElement.append(host);
    }
    const box = host.shadowRoot.querySelector("div");
    box.textContent = `Feed Brain · ${text}`;
    box.className = tone;
    host.style.display = "";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (host.style.display = "none"), tone === "error" ? 9000 : 4000);
  }

  async function send(post, action) {
    const id = post.urn || post.key || post.id;
    if (Date.now() - (sentAt.get(id) || 0) < 15000) return;
    sentAt.set(id, Date.now());
    toast(post.partial ? "Reading the whole article in a background tab…" : `Sending ${post.author || "this post"}'s post…`);
    try {
      const res = await chrome.runtime.sendMessage({ type: "capture-post", source: site.source, post, action });
      if (!res?.ok) toast(res?.error || "The post wasn't sent.", "error");
      else toast(res.data.status === "exists" ? "Already in your brain." : "Sent to your brain.", "ok");
    } catch {
      toast("The extension was updated since this page opened: reload the page to send posts.", "error");
    }
  }

  const remember = (post) => {
    if (post) [lastPost, lastPostAt] = [post, Date.now()];
  };

  // Capture phase: the post is read before the site's own handler re-renders it.
  document.addEventListener(
    "click",
    (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!alive() || !target || site.ignore?.(target)) return;
      const post = site.postOf(target);
      remember(post);
      site.onClick?.(target);
      const action = site.actionOf(target, post);
      if (!action || !settings[action.setting]) return;
      const owner = post || (action.menu && Date.now() - lastPostAt < 60000 ? lastPost : null);
      if (!owner?.isConnected) return;
      try {
        const data = site.readPost(owner);
        if (data) send(data, action.name);
        else toast(`This post wasn't sent: ${site.unreadable(owner)}`, "error");
      } catch (err) {
        toast(`This post wasn't sent: ${err.message}`, "error");
      }
    },
    true,
  );

  // A menu that opens on hover (LinkedIn's reactions) can sit outside the post: remember whose it was.
  document.addEventListener(
    "mouseover",
    (e) => {
      if (alive() && e.target instanceof Element) remember(site.onHover?.(e.target));
    },
    { capture: true, passive: true },
  );

  document.addEventListener(
    "contextmenu",
    (e) => {
      if (!alive()) return;
      lastRightClicked = e.target instanceof Element ? e.target : null;
      lastRightClickedAt = Date.now();
    },
    true,
  );

  function answer(post, missing) {
    if (!post) return { error: `${missing} (${site.posts().length} posts recognised on this page)` };
    const data = site.readPost(post);
    return data ? { post: data } : { error: `Found the post but ${site.unreadable(post)}` };
  }

  // What the extension's background asks: the post you right-clicked, the one a post's page is
  // about, how readable this page is (for the popup), or a message to show.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      if (msg.type === "brain-read-clicked") {
        // A right-click from long ago is not the one that opened this menu.
        const target = Date.now() - lastRightClickedAt < 60000 ? lastRightClicked : null;
        const res = answer(site.postOf(target, { inComments: true }), "No post where you right-clicked.");
        if (res.post) toast("Reading the post…");
        sendResponse(res);
      } else if (msg.type === "brain-read-page") {
        sendResponse(answer(site.pagePost(), "No post found on this page."));
      } else if (msg.type === "brain-status") {
        const all = site.posts();
        const page = site.onPostPage() ? site.readPost(site.pagePost()) : null;
        sendResponse({ posts: all.length, readable: all.filter((p) => site.readPost(p)).length, page });
      } else if (msg.type === "brain-toast") {
        toast(msg.text, msg.tone);
        sendResponse({});
      }
    } catch (err) {
      sendResponse({ error: `The extension couldn't read this page: ${err.message}` });
    }
    return false;
  });
};
