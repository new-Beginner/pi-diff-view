// src/renderer/index.tsx
import React4, { useEffect as useEffect2, useState as useState2 } from "react";

// src/view/transport.ts
var realm = globalThis;
var queue = realm.__piDiffQueue ??= { tail: Promise.resolve(), last: 0 };
var background = /* @__PURE__ */ new Set(["bootstrap", "review", "action", "batchAction", "copyPatch", "clearHistory", "turnSummary", "selectTurn", "card", "replyCards"]);
function boundedTransport(invoke) {
  const wire = (method, args) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ method, args })).length;
    if (bytes > 48 * 1024) return Promise.reject(new Error("Request exceeds the bridge payload limit (48 KiB)."));
    if (method === "saveComment" && bytes > 24e3) return Promise.reject(new Error("Comment payload too large; shorten the comment or excerpt."));
    const request = queue.tail.catch(() => void 0).then(async () => {
      const wait = 160 - (Date.now() - queue.last);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      queue.last = Date.now();
      let timer;
      try {
        const response = await Promise.race([
          invoke(method, args),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Bridge request timed out. Refresh to check the result; the operation was not retried.")), 1950);
          })
        ]);
        if (bytes + new TextEncoder().encode(JSON.stringify(response) ?? "").length > 62 * 1024) throw new Error("Combined request/response exceeds the bridge payload limit.");
        return response;
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
    queue.tail = request;
    return request;
  };
  return { async invoke(method, args) {
    if (!background.has(method)) return wire(method, args);
    const { jobId } = await wire("jobStart", { method, args });
    const deadline = Date.now() + 12e4;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const job = await wire("jobPoll", { jobId });
      if (job.state === "done") return job.result;
      if (job.state === "error") throw Object.assign(new Error(job.error?.message ?? "Review failed"), { code: job.error?.code });
    }
    throw new Error("Background operation is still running. Refresh to check the result; it was not retried.");
  } };
}
var known = /* @__PURE__ */ new WeakMap();
var knownInvokes = /* @__PURE__ */ new WeakSet();
function ensureBounded(transport) {
  const previous = known.get(transport);
  if (previous) return previous;
  const result = { ...knownInvokes.has(transport.invoke) ? { invoke: transport.invoke } : boundedTransport(transport.invoke.bind(transport)), insertText: transport.insertText };
  knownInvokes.add(result.invoke);
  known.set(transport, result);
  known.set(result, result);
  return result;
}

// src/core/reply-content.ts
var MAX_REPLY_PAYLOAD = 24e3;
var encoder = new TextEncoder();
function replyTail(content) {
  const tail = content.slice(-MAX_REPLY_PAYLOAD);
  let low = 0, high = tail.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (encoder.encode(JSON.stringify(tail.slice(mid))).length <= MAX_REPLY_PAYLOAD) high = mid;
    else low = mid + 1;
  }
  if (low > 0 && tail.charCodeAt(low) >= 56320 && tail.charCodeAt(low) <= 57343) low++;
  return tail.slice(low);
}

// src/renderer/TurnChangeSummary.tsx
import React2, { useEffect, useRef, useState } from "react";

// src/view/FilePath.tsx
import React from "react";
function FilePath({ path }) {
  const split = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("span", { className: "dv-path-directory" }, path.slice(0, split)), /* @__PURE__ */ React.createElement("span", { className: "dv-path-basename" }, path.slice(split)));
}

// src/renderer/TurnChangeSummary.tsx
function TurnChangeSummary({ run, transport, locale, base, initialSummary, onOpen }) {
  const zh = locale.startsWith("zh");
  const [summary, setSummary] = useState(initialSummary ?? null);
  const [expanded, setExpanded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const live = useRef(true);
  useEffect(() => {
    let active = true;
    live.current = true;
    setSummary(initialSummary ?? null);
    setError("");
    setExpanded(false);
    if (!initialSummary) transport.invoke("turnSummary", { runId: run.id, sessionId: run.sessionId, limit: 3 }).then((data) => {
      if (active) setSummary(data);
    }).catch((err) => {
      if (active) setError(String(err?.message ?? err));
    });
    return () => {
      active = false;
      live.current = false;
    };
  }, [transport, run.id, run.sessionId, initialSummary]);
  const open = async (file) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onOpen(file);
    } catch (err) {
      if (live.current) setError(String(err.message ?? err));
    } finally {
      if (live.current) setBusy(false);
    }
  };
  const expand = async (loadMore = false) => {
    if (!summary || busy) return;
    if (expanded && !loadMore) {
      setExpanded(false);
      return;
    }
    if (!loadMore && summary.files.length > 3 || summary.nextOffset == null) {
      setExpanded(true);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const page = await transport.invoke("turnSummary", { runId: run.id, sessionId: run.sessionId, offset: summary.nextOffset, limit: 40 });
      if (live.current) {
        setSummary((previous) => previous && { ...page, offset: 0, files: [...previous.files, ...page.files.filter((file) => !previous.files.some((old) => old.id === file.id))] });
        setExpanded(true);
      }
    } catch (err) {
      if (live.current) setError(String(err.message ?? err));
    } finally {
      if (live.current) setBusy(false);
    }
  };
  if (summary?.fileCount === 0 && !error) return null;
  const files = summary ? expanded ? summary.files : summary.files.slice(0, 3) : [];
  return /* @__PURE__ */ React2.createElement("section", { className: "dv-turn-card dv-reply", "data-base": base, "aria-label": zh ? "\u672C\u6B21\u4EFB\u52A1\u6587\u4EF6\u53D8\u66F4" : "Files changed in this task" }, /* @__PURE__ */ React2.createElement("header", { className: "dv-turn-head" }, /* @__PURE__ */ React2.createElement("span", { className: "dv-turn-icon", "aria-hidden": "true" }, /* @__PURE__ */ React2.createElement("svg", { viewBox: "0 0 24 24", width: "22", height: "22", fill: "none", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ React2.createElement("rect", { x: "4", y: "3", width: "16", height: "18", rx: "4" }), /* @__PURE__ */ React2.createElement("path", { d: "M9 9h6M12 6v6M9 16h6" }))), /* @__PURE__ */ React2.createElement("div", { className: "dv-turn-label" }, /* @__PURE__ */ React2.createElement("strong", null, summary ? zh ? `\u5DF2\u7F16\u8F91 ${summary.fileCount} \u4E2A\u6587\u4EF6` : `${summary.fileCount} files changed` : zh ? "\u6B63\u5728\u8BFB\u53D6\u672C\u6B21\u53D8\u66F4\u2026" : "Loading task changes\u2026"), summary && /* @__PURE__ */ React2.createElement("span", { className: "dv-turn-counts" }, /* @__PURE__ */ React2.createElement("span", { className: "dv-turn-add" }, "+", summary.additions), /* @__PURE__ */ React2.createElement("span", { className: "dv-turn-del" }, "\u2212", summary.deletions))), /* @__PURE__ */ React2.createElement("button", { className: "dv-turn-open", disabled: busy || !summary, onClick: () => void open() }, busy ? zh ? "\u6253\u5F00\u4E2D\u2026" : "Opening\u2026" : zh ? "\u67E5\u770B\u53D8\u66F4" : "View changes")), !!files.length && /* @__PURE__ */ React2.createElement("div", { className: "dv-turn-files" }, files.map((file) => /* @__PURE__ */ React2.createElement("button", { key: file.id, className: "dv-turn-file", title: file.absolutePath ?? file.path, disabled: busy, onClick: () => void open(file) }, /* @__PURE__ */ React2.createElement("span", { className: "dv-turn-path" }, /* @__PURE__ */ React2.createElement(FilePath, { path: file.path }), file.origin === "external" && /* @__PURE__ */ React2.createElement("small", null, zh ? "\u5DE5\u4F5C\u533A\u5916 \xB7 \u53EA\u8BFB" : "Outside workspace \xB7 read-only"), file.kind !== "text" && /* @__PURE__ */ React2.createElement("small", null, file.kind)), /* @__PURE__ */ React2.createElement("span", { className: "dv-turn-counts" }, /* @__PURE__ */ React2.createElement("span", { className: "dv-turn-add" }, "+", file.additions), /* @__PURE__ */ React2.createElement("span", { className: "dv-turn-del" }, "\u2212", file.deletions))))), summary && summary.fileCount > 3 && /* @__PURE__ */ React2.createElement("footer", { className: "dv-turn-foot" }, /* @__PURE__ */ React2.createElement("button", { "aria-expanded": expanded, disabled: busy, onClick: () => void expand() }, expanded ? zh ? "\u6536\u8D77\u6587\u4EF6" : "Collapse files" : zh ? `\u518D\u663E\u793A ${Math.max(0, summary.fileCount - 3)} \u4E2A\u6587\u4EF6` : `Show ${Math.max(0, summary.fileCount - 3)} more files`, " ", /* @__PURE__ */ React2.createElement("span", { "aria-hidden": "true" }, expanded ? "\u2303" : "\u2304")), expanded && summary.nextOffset != null && /* @__PURE__ */ React2.createElement("button", { disabled: busy, onClick: () => void expand(true) }, zh ? "\u52A0\u8F7D\u66F4\u591A" : "Load more")), error && /* @__PURE__ */ React2.createElement("p", { className: "dv-turn-error", role: "alert" }, error));
}

// src/renderer/summary-style.ts
var summary_style_default = `
.dv-turn-card{--tc-ink:var(--ds-text-primary,inherit);--tc-muted:color-mix(in srgb,currentColor 62%,transparent);--tc-border:color-mix(in srgb,currentColor 8%,transparent);--tc-hover:var(--ds-bg-hover,color-mix(in srgb,currentColor 4%,transparent));--tc-add:var(--ds-success,#008f39);--tc-del:var(--ds-error,#d63232);color:var(--tc-ink);background:transparent;border:1px solid var(--tc-border);border-radius:12px;margin:12px 0 4px;font-family:inherit;font-size:14px;line-height:1.45;text-align:left;overflow:hidden;max-width:100%;}
.dv-turn-card[data-base=dark]{--tc-add:var(--ds-success,#40c977);--tc-del:var(--ds-error,#ff6764)}
.dv-turn-card *{box-sizing:border-box}.dv-turn-card button{font:inherit;color:inherit;background:transparent;border:0;cursor:pointer}.dv-turn-card button:hover:not(:disabled){background:var(--tc-hover)}.dv-turn-card button:focus-visible{outline:2px solid var(--ds-focus,currentColor);outline-offset:-3px}.dv-turn-card button:disabled{opacity:.55;cursor:wait}
.dv-turn-head{display:flex;align-items:center;gap:12px;padding:12px 14px}.dv-turn-icon{display:grid;place-items:center;flex:0 0 42px;width:42px;height:42px;border-radius:10px;color:var(--tc-muted);background:color-mix(in srgb,currentColor 4%,transparent)}.dv-turn-label{display:flex;flex-direction:column;align-items:flex-start;gap:2px;flex:1;min-width:0}.dv-turn-label strong{font-size:14px;font-weight:600}.dv-turn-counts{display:inline-flex;gap:5px;white-space:nowrap;font-size:12px;font-variant-numeric:tabular-nums}.dv-turn-add{color:var(--tc-add)}.dv-turn-del{color:var(--tc-del)}.dv-turn-card .dv-turn-open{border:1px solid var(--tc-border);border-radius:10px;padding:4px 10px;white-space:nowrap;font-size:13px}
.dv-turn-files{border-top:1px solid var(--tc-border);padding:2px 0}.dv-turn-card .dv-turn-file{display:flex;align-items:center;gap:12px;width:100%;padding:8px 12px;text-align:left;min-height:38px}.dv-turn-path{flex:1;min-width:0;overflow-wrap:anywhere;color:var(--tc-ink)}.dv-turn-card .dv-path-directory{color:var(--tc-muted)}.dv-turn-card .dv-path-basename{color:var(--tc-ink)}.dv-turn-path small{font-size:11px;margin-left:8px;display:inline-block;color:var(--tc-muted)}.dv-turn-foot{padding:0 6px 5px;display:flex;gap:8px}.dv-turn-foot button{padding:6px}.dv-turn-error{margin:0;padding:8px 12px;border-top:1px solid var(--tc-border);font-size:12px;overflow-wrap:anywhere;color:var(--tc-del)}
@media(max-width:420px){.dv-turn-head{padding:10px;gap:9px}.dv-turn-icon{width:36px;height:36px;flex-basis:36px}.dv-turn-label strong{font-size:13px}.dv-turn-card .dv-turn-open{font-size:12px;padding:4px 8px}.dv-turn-card .dv-turn-file{padding:7px 10px;gap:8px;font-size:13px}}
`;

// src/renderer/plugin-review-adapter.ts
import React3 from "react";
var REVIEW_TAB_ID = "plugin:local.diff-view/review";
var PluginReviewError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
var denied = (code, message) => {
  throw new PluginReviewError(code, message);
};
function hostEntryUrl(documentUrl, scriptUrls) {
  const page = new URL(documentUrl);
  if (page.protocol !== "file:") denied("SIDEBAR_ORIGIN", "\u4E0D\u662F\u672C\u5730\u5BBF\u4E3B\u9875 / Not a local host document");
  const assets = new URL("assets/", page);
  const entries = scriptUrls.map((url) => new URL(url, page)).filter((url) => url.protocol === "file:" && url.host === assets.host && url.pathname.startsWith(assets.pathname) && /^index(?:-[^/]+)?\.js$/.test(url.pathname.slice(assets.pathname.length)));
  if (entries.length !== 1) denied("SIDEBAR_ENTRY", "\u5BBF\u4E3B\u4E3B\u6A21\u5757\u7F3A\u5931\u6216\u4E0D\u552F\u4E00 / Host entry module missing or ambiguous");
  return entries[0].href;
}
function resolvePluginReviewModules(module) {
  return {
    store: module.R,
    hostReact: module.r,
    tab: (pluginId, viewId) => {
      const resource = `${pluginId}/${viewId}`;
      return { id: `plugin:${resource}`, kind: "plugin", resource };
    }
  };
}
async function loadPinned() {
  const scripts = Array.from(document.querySelectorAll('script[type="module"][src]')).map((script) => script.src);
  const main = hostEntryUrl(document.location.href, scripts);
  const module = await import(
    /* @vite-ignore */
    main
  );
  return resolvePluginReviewModules(module);
}
function createPluginReviewAdapter(options = {}) {
  let closed = false, pending;
  const subscriptions = /* @__PURE__ */ new Set();
  const alive = () => {
    if (closed) denied("SIDEBAR_UNLOADED", "\u63D2\u4EF6\u5DF2\u5378\u8F7D / Plugin unloaded");
  };
  const inspect = () => pending ??= (async () => {
    alive();
    const result = await (options.load ?? loadPinned)();
    alive();
    if (typeof result.store?.getState !== "function" || typeof result.tab !== "function" || result.hostReact?.createElement !== React3.createElement || result.hostReact?.useState !== React3.useState) denied("SIDEBAR_CONTRACT", "\u5BBF\u4E3B\u9875\u7B7E\u63A5\u53E3\u5DF2\u53D8\u5316 / Host tab contract changed");
    const tab = result.tab("local.diff-view", "review");
    if (tab.id !== REVIEW_TAB_ID || tab.kind !== "plugin" || tab.resource !== "local.diff-view/review") denied("SIDEBAR_CONTRACT", "\u63D2\u4EF6\u9875\u7B7E\u6807\u8BC6\u4E0D\u5339\u914D / Plugin tab identity mismatch");
    return result;
  })().catch((error) => {
    pending = void 0;
    throw error;
  });
  return {
    async subscribeSession(listener) {
      const modules = await inspect();
      alive();
      if (typeof modules.store.subscribe !== "function") return denied("SIDEBAR_CONTRACT", "\u5BBF\u4E3B\u4F1A\u8BDD\u8BA2\u9605\u63A5\u53E3\u5DF2\u53D8\u5316 / Host session subscription unavailable");
      let previous, stopped = false;
      const publish = (state) => {
        if (closed || stopped) return;
        const sessionId = state.selectingSessionId ? null : state.activeSessionId ?? null;
        if (sessionId !== null && typeof sessionId !== "string") denied("SIDEBAR_CONTRACT", "\u65E0\u6548\u7684\u5BBF\u4E3B\u4F1A\u8BDD\u72B6\u6001 / Invalid host session state");
        if (sessionId !== previous) {
          previous = sessionId;
          listener(sessionId);
        }
      };
      const unsubscribe = modules.store.subscribe(publish);
      const dispose = () => {
        if (!stopped) {
          stopped = true;
          subscriptions.delete(dispose);
          unsubscribe();
        }
      };
      subscriptions.add(dispose);
      try {
        publish(modules.store.getState());
        return dispose;
      } catch (error) {
        dispose();
        throw error;
      }
    },
    async open(sessionId, location) {
      if (!/^diff-view:[0-9a-f-]{36}$/i.test(location)) denied("SIDEBAR_TARGET", "\u65E0\u6548\u7684\u63D2\u4EF6\u5B9A\u4F4D\u4EE4\u724C / Invalid selection token");
      const modules = await inspect();
      alive();
      const state = modules.store.getState();
      if (!sessionId || state.activeSessionId !== sessionId || state.selectingSessionId) denied("SIDEBAR_SESSION", "\u4F1A\u8BDD\u5DF2\u5207\u6362\uFF0C\u8BF7\u5728\u5F53\u524D\u4F1A\u8BDD\u70B9\u51FB / Session changed");
      if (!Array.isArray(state.pluginViews) || !state.pluginViews.some((view) => view.pluginId === "local.diff-view" && view.viewId === "review")) denied("SIDEBAR_VIEW", "Diff view \u9875\u7B7E\u4E0D\u53EF\u7528\uFF0C\u8BF7\u68C0\u67E5\u63D2\u4EF6\u662F\u5426\u542F\u7528 / Diff view tab unavailable");
      if (typeof state.openWorkPanelTabForSession !== "function") denied("SIDEBAR_CONTRACT", "\u5BBF\u4E3B\u4E0D\u652F\u6301\u6253\u5F00\u63D2\u4EF6\u9875\u7B7E / Plugin tab opener unavailable");
      const existing = state.workPanelTabs?.find((tab) => tab.id === REVIEW_TAB_ID && tab.kind === "plugin" && tab.resource === "local.diff-view/review" && tab.location === location);
      if (existing && state.workPanelOpen && state.activeWorkPanelTabId === REVIEW_TAB_ID) return;
      state.openWorkPanelTabForSession(sessionId, existing ?? { ...modules.tab("local.diff-view", "review"), location });
      const opened = modules.store.getState();
      if (opened.activeSessionId !== sessionId || !opened.workPanelOpen || opened.activeWorkPanelTabId !== REVIEW_TAB_ID) denied("SIDEBAR_OPEN", "\u4FA7\u680F\u672A\u6253\u5F00 / Sidebar did not open");
    },
    close() {
      closed = true;
      for (const dispose of [...subscriptions]) dispose();
    }
  };
}

// src/renderer/index.tsx
var hub = null;
var realm2 = globalThis;
var disposers = [];
var cardKey = (sessionId, messageId) => JSON.stringify([sessionId, messageId]);
var timestamp = (props) => typeof props.message.createdAt === "number" ? props.message.createdAt : Date.parse(props.message.createdAt ?? "");
function same(current) {
  return Boolean(current && current === hub && !current.disposed);
}
function report(current, stage) {
  if (!same(current) || current.reported.has(stage)) return;
  current.reported.add(stage);
  void current.transport.invoke("rendererReport", { stage }).catch(() => {
  });
}
function trackSession(current) {
  return current.sessionReady ??= current.adapter.subscribeSession((sessionId) => {
    if (same(current) && current.activeSession !== sessionId) {
      current.activeSession = sessionId;
      current.sessionVersion++;
      void current.transport.invoke("activeReviewSession", { sessionId }).catch(() => {
      });
    }
  }).then((dispose) => {
    if (same(current)) {
      current.unsubscribeSession = dispose;
      report(current, "session-ready");
    } else dispose();
  }).catch((error) => {
    if (same(current)) {
      current.sessionReady = void 0;
      report(current, "session-source-error");
    }
    throw error;
  });
}
function remember(current, card) {
  const key = cardKey(card.run.sessionId, card.messageId), previous = current.cache.get(key);
  if (previous && JSON.stringify(previous) === JSON.stringify(card)) card = previous;
  current.cache.delete(key);
  current.cache.set(key, card);
  let bytes = [...current.cache.values()].reduce((n, value) => n + new TextEncoder().encode(JSON.stringify(value)).length, 0);
  for (const [oldKey, value] of current.cache) {
    if (current.cache.size <= 200 && bytes <= 4 * 1024 * 1024) break;
    if (current.cards.has(oldKey)) continue;
    bytes -= new TextEncoder().encode(JSON.stringify(value)).length;
    current.cache.delete(oldKey);
  }
  current.cards.get(key)?.listeners.forEach((listener) => listener(card));
}
async function restoreFeed(current, sessionId) {
  const feed = current.feeds.get(sessionId) ?? { pending: [] };
  current.feeds.set(sessionId, feed);
  const first = await current.transport.invoke("replyCards", { sessionId, revision: feed.revision });
  if (!same(current)) return feed;
  report(current, "bootstrap-ok");
  if (current.appearance.locale !== first.locale || current.appearance.base !== first.base) {
    current.appearance = { locale: first.locale, base: first.base };
    current.listeners.forEach((listener) => listener());
  }
  if (!first.unchanged) {
    const restored = [...first.cards];
    let offset = first.nextOffset;
    while (offset !== null) {
      const page = await current.transport.invoke("replyCards", { sessionId, offset });
      if (!same(current)) return feed;
      if (page.revision !== first.revision || page.nextOffset !== null && page.nextOffset <= offset) throw new Error("Card history changed during paging; refresh required");
      restored.push(...page.cards);
      offset = page.nextOffset;
    }
    const keys = new Set(restored.map((card) => cardKey(sessionId, card.messageId)));
    for (const [key, card] of current.cache) if (card.run.sessionId === sessionId && !keys.has(key)) {
      current.cache.delete(key);
      current.cards.get(key)?.listeners.forEach((listener) => listener(null));
    }
    for (const card of restored) {
      if (card.run.sessionId !== sessionId || card.summary.sessionId !== sessionId || card.summary.runId !== card.run.id) throw new Error("Invalid recorded card identity");
      remember(current, card);
    }
    if (restored.length) {
      report(current, "card-bound");
      void trackSession(current).catch(() => {
      });
    }
  }
  feed.revision = first.revision;
  feed.pending = first.pending;
  while (current.feeds.size > 32) {
    const removable = [...current.feeds.keys()].find((id) => ![...current.cards.values()].some((item) => item.props.sessionId === id));
    if (!removable) break;
    current.feeds.delete(removable);
  }
  return feed;
}
function wake(current, delay = 0) {
  if (!same(current)) return;
  if (current.pumping) {
    if (!delay) current.wakeAgain = true;
    return;
  }
  if (current.timer) clearTimeout(current.timer);
  current.timer = setTimeout(() => {
    current.timer = void 0;
    void refresh(current);
  }, delay);
}
async function refresh(current) {
  if (!same(current) || current.pumping) return;
  current.pumping = true;
  current.wakeAgain = false;
  try {
    const sessions = [...new Set([...current.cards.values()].map((item) => item.props.sessionId))];
    for (const sessionId of sessions) {
      const feed = await restoreFeed(current, sessionId);
      if (!same(current)) return;
      const items = [...current.cards.values()].filter((item) => item.props.sessionId === sessionId && !current.cache.has(cardKey(sessionId, item.props.messageId)) && item.checkedRevision !== feed.revision && feed.pending.some((time) => Math.abs(time - timestamp(item.props)) < 3e3)).sort((a, b) => timestamp(b.props) - timestamp(a.props));
      for (const item of items) {
        if (!same(current)) return;
        const response = await current.transport.invoke("card", { sessionId, messageId: item.props.messageId, content: replyTail(String(item.props.message.content)), createdAt: new Date(timestamp(item.props)).toISOString() });
        if (!same(current)) return;
        item.checkedRevision = feed.revision;
        if (response.run && response.summary) {
          remember(current, { messageId: item.props.messageId, run: response.run, summary: response.summary });
          report(current, "card-bound");
          void trackSession(current).catch(() => {
          });
          break;
        }
      }
    }
  } catch {
    if (same(current)) report(current, "card-query-error");
  } finally {
    current.pumping = false;
    if (same(current) && current.cards.size) wake(current, current.wakeAgain ? 0 : 2e3);
  }
}
function EntryExtra(props) {
  const current = hub, key = cardKey(props.sessionId, props.messageId);
  const [value, setValue] = useState2(() => ({ key, card: current?.cache.get(key) ?? null }));
  const [, redraw] = useState2(0);
  const contentKey = props.message?.content;
  useEffect2(() => {
    if (!same(current)) return;
    const listener = () => redraw((count) => count + 1);
    current.listeners.add(listener);
    return () => {
      current.listeners.delete(listener);
    };
  }, [current]);
  useEffect2(() => {
    if (!same(current) || !props.sessionId || !props.messageId || typeof contentKey !== "string" || !contentKey || !Number.isFinite(timestamp(props))) return;
    report(current, "reply-slot-mounted");
    let item = current.cards.get(key);
    if (!item) {
      item = { props, listeners: /* @__PURE__ */ new Set() };
      current.cards.set(key, item);
    } else {
      item.props = props;
      item.checkedRevision = void 0;
    }
    const listener = (card2) => setValue({ key, card: card2 });
    item.listeners.add(listener);
    listener(current.cache.get(key) ?? null);
    wake(current);
    return () => {
      item.listeners.delete(listener);
      if (!item.listeners.size) current.cards.delete(key);
      if (!current.cards.size && current.timer) {
        clearTimeout(current.timer);
        current.timer = void 0;
      }
    };
  }, [current, key, contentKey, props.message?.createdAt]);
  const card = value.key === key ? value.card : current?.cache.get(key);
  if (!card || !same(current)) return null;
  const run = card.run;
  return /* @__PURE__ */ React4.createElement(TurnChangeSummary, { run, initialSummary: card.summary, transport: current.transport, locale: current.appearance.locale, base: current.appearance.base, onOpen: async (file) => {
    await trackSession(current);
    const version = current.sessionVersion;
    const guard = () => {
      if (!same(current) || current.activeSession !== run.sessionId || current.sessionVersion !== version) throw new Error("\u4F1A\u8BDD\u5DF2\u5207\u6362\uFF0C\u8BF7\u5728\u5F53\u524D\u4F1A\u8BDD\u70B9\u51FB / Session changed");
    };
    guard();
    const selection = await current.transport.invoke("selectTurn", { sessionId: run.sessionId, runId: run.id, fileId: file?.id });
    guard();
    await current.adapter.open(run.sessionId, `diff-view:${selection.nonce}`);
    guard();
    report(current, "sidebar-opened");
  } });
}
function onLoad(pi, options = {}) {
  realm2.__piDiffRenderer?.dispose();
  onUnload();
  const transport = ensureBounded({ invoke(method, args) {
    if (!same(current)) return Promise.reject(new Error("Renderer unloaded / \u6E32\u67D3\u6269\u5C55\u5DF2\u5378\u8F7D\u3002"));
    return pi.dispatch("plugin.call", { method, args });
  } });
  const current = { transport, disposed: false, pumping: false, wakeAgain: false, appearance: { locale: "zh-CN", base: "light" }, listeners: /* @__PURE__ */ new Set(), cards: /* @__PURE__ */ new Map(), cache: /* @__PURE__ */ new Map(), feeds: /* @__PURE__ */ new Map(), sessionVersion: 0, reported: /* @__PURE__ */ new Set(), adapter: options.adapter ?? createPluginReviewAdapter() };
  hub = current;
  realm2.__piDiffRenderer = { hub: current, dispose: onUnload };
  disposers.push(pi.ui.injectStyle(summary_style_default));
  disposers.push(pi.slots.register({ slot: "entryExtra", component: EntryExtra }));
  report(current, "entry-loaded");
}
function onUnload() {
  const current = hub;
  if (current) {
    current.disposed = true;
    if (current.timer) clearTimeout(current.timer);
    current.unsubscribeSession?.();
    current.cards.clear();
    current.cache.clear();
    current.feeds.clear();
    current.listeners.clear();
    current.adapter.close();
  }
  for (const dispose of disposers.splice(0).reverse()) dispose();
  if (realm2.__piDiffRenderer?.hub === current) delete realm2.__piDiffRenderer;
  hub = null;
}
export {
  onLoad,
  onUnload
};
