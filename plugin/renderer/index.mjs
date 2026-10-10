// src/renderer/index.tsx
import React4, { useEffect as useEffect2, useState as useState2 } from "react";

// src/view/transport.ts
var realm = globalThis;
var queue = realm.__piDiffQueue ??= { tail: Promise.resolve(), last: 0 };
var background = /* @__PURE__ */ new Set(["bootstrap", "review", "action", "batchAction", "copyPatch", "clearHistory", "turnSummary", "selectTurn"]);
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

// src/renderer/TurnChangeSummary.tsx
import React, { useEffect, useRef, useState } from "react";
function TurnChangeSummary({ run, transport, locale, base, onOpen }) {
  const zh = locale.startsWith("zh");
  const [summary, setSummary] = useState(null);
  const [expanded, setExpanded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const live = useRef(true);
  useEffect(() => {
    let active = true;
    live.current = true;
    setSummary(null);
    setError("");
    setExpanded(false);
    transport.invoke("turnSummary", { runId: run.id, sessionId: run.sessionId, limit: 3 }).then((data) => {
      if (active) setSummary(data);
    }).catch((err) => {
      if (active) setError(String(err?.message ?? err));
    });
    return () => {
      active = false;
      live.current = false;
    };
  }, [transport, run.id, run.sessionId]);
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
  return /* @__PURE__ */ React.createElement("section", { className: "dv-turn-card dv-reply", "data-base": base, "aria-label": zh ? "\u672C\u6B21\u4EFB\u52A1\u6587\u4EF6\u53D8\u66F4" : "Files changed in this task" }, /* @__PURE__ */ React.createElement("header", { className: "dv-turn-head" }, /* @__PURE__ */ React.createElement("span", { className: "dv-turn-icon", "aria-hidden": "true" }, "\xB1"), /* @__PURE__ */ React.createElement("div", { className: "dv-turn-label" }, /* @__PURE__ */ React.createElement("strong", null, summary ? zh ? `\u5DF2\u66F4\u6539 ${summary.fileCount} \u4E2A\u6587\u4EF6` : `${summary.fileCount} files changed` : zh ? "\u6B63\u5728\u8BFB\u53D6\u672C\u6B21\u53D8\u66F4\u2026" : "Loading task changes\u2026"), summary && /* @__PURE__ */ React.createElement("span", { className: "dv-turn-counts" }, /* @__PURE__ */ React.createElement("span", { className: "dv-turn-add" }, "+", summary.additions), /* @__PURE__ */ React.createElement("span", { className: "dv-turn-del" }, "\u2212", summary.deletions))), /* @__PURE__ */ React.createElement("button", { className: "dv-turn-open", disabled: busy || !summary, onClick: () => void open() }, busy ? zh ? "\u6253\u5F00\u4E2D\u2026" : "Opening\u2026" : zh ? "\u67E5\u770B\u53D8\u66F4" : "View changes")), !!files.length && /* @__PURE__ */ React.createElement("div", { className: "dv-turn-files" }, files.map((file) => /* @__PURE__ */ React.createElement("button", { key: file.id, className: "dv-turn-file", title: file.absolutePath ?? file.path, disabled: busy, onClick: () => void open(file) }, /* @__PURE__ */ React.createElement("span", { className: "dv-turn-path" }, file.path, file.origin === "external" && /* @__PURE__ */ React.createElement("small", null, zh ? "\u5DE5\u4F5C\u533A\u5916 \xB7 \u53EA\u8BFB" : "Outside workspace \xB7 read-only"), file.kind !== "text" && /* @__PURE__ */ React.createElement("small", null, file.kind)), /* @__PURE__ */ React.createElement("span", { className: "dv-turn-counts" }, /* @__PURE__ */ React.createElement("span", { className: "dv-turn-add" }, "+", file.additions), /* @__PURE__ */ React.createElement("span", { className: "dv-turn-del" }, "\u2212", file.deletions))))), summary && summary.fileCount > 3 && /* @__PURE__ */ React.createElement("footer", { className: "dv-turn-foot" }, /* @__PURE__ */ React.createElement("button", { "aria-expanded": expanded, disabled: busy, onClick: () => void expand() }, expanded ? zh ? "\u6536\u8D77\u6587\u4EF6" : "Collapse files" : zh ? `\u518D\u663E\u793A ${Math.max(0, summary.fileCount - 3)} \u4E2A\u6587\u4EF6` : `Show ${Math.max(0, summary.fileCount - 3)} more files`, " ", /* @__PURE__ */ React.createElement("span", { "aria-hidden": "true" }, expanded ? "\u2303" : "\u2304")), expanded && summary.nextOffset != null && /* @__PURE__ */ React.createElement("button", { disabled: busy, onClick: () => void expand(true) }, zh ? "\u52A0\u8F7D\u66F4\u591A" : "Load more")), (summary?.incomplete || summary?.notice) && /* @__PURE__ */ React.createElement("p", { className: "dv-turn-notice" }, summary.notice || (zh ? "\u8BB0\u5F55\u4E0D\u5B8C\u6574\uFF1A\u4EC5\u663E\u793A\u5DF2\u53EF\u9760\u91C7\u96C6\u7684\u6587\u4EF6\u53D8\u66F4\u3002" : "Incomplete capture: only recorded file changes are shown.")), error && /* @__PURE__ */ React.createElement("p", { className: "dv-turn-error", role: "alert" }, error));
}

// src/renderer/summary-style.ts
var summary_style_default = `
.dv-turn-card{--tc-border:#e4e7ec;--tc-bg:#fff;--tc-ink:#30343b;--tc-muted:#737b87;--tc-hover:#f6f8fa;--tc-add:#18723b;--tc-del:#b02c35;color:var(--tc-ink);background:var(--tc-bg);border:1px solid var(--tc-border);border-radius:12px;margin:14px 0 6px;font:13px/1.5 'Segoe UI',system-ui,sans-serif;text-align:left;overflow:hidden;max-width:100%;}
.dv-turn-card[data-base=dark]{--tc-border:#353c46;--tc-bg:#1e2229;--tc-ink:#e5e9ef;--tc-muted:#a0aab8;--tc-hover:#282f39;--tc-add:#8bddab;--tc-del:#ffa0a8;}
.dv-turn-card *{box-sizing:border-box}.dv-turn-card button{font:inherit;color:inherit;background:transparent;border:0;cursor:pointer}.dv-turn-card button:hover:not(:disabled){background:var(--tc-hover)}.dv-turn-card button:focus-visible{outline:2px solid #4285d4;outline-offset:-3px}.dv-turn-card button:disabled{opacity:.55;cursor:wait}
.dv-turn-head{display:flex;align-items:center;gap:12px;padding:13px 15px}.dv-turn-icon{display:grid;place-items:center;font:21px/1.2 Consolas,monospace;width:36px;height:36px;border:1px solid var(--tc-border);border-radius:9px;color:var(--tc-muted);background:var(--tc-hover)}.dv-turn-label{flex:1;min-width:0}.dv-turn-label strong{display:block;font-size:14px;font-weight:600}.dv-turn-counts{display:inline-flex;gap:5px;white-space:nowrap;font-variant-numeric:tabular-nums}.dv-turn-add{color:var(--tc-add)}.dv-turn-del{color:var(--tc-del)}.dv-turn-card .dv-turn-open{border:1px solid var(--tc-border);border-radius:7px;padding:4px 9px;white-space:nowrap}
.dv-turn-files{border-top:1px solid var(--tc-border)}.dv-turn-card .dv-turn-file{display:flex;align-items:center;gap:16px;width:100%;padding:8px 15px;text-align:left;min-height:38px}.dv-turn-path{flex:1;min-width:0;overflow-wrap:anywhere;color:var(--tc-muted)}.dv-turn-path small{font-size:11px;margin-left:8px;color:var(--tc-muted);display:inline-block}.dv-turn-foot{border-top:1px solid var(--tc-border);padding:3px 7px;display:flex;gap:8px}.dv-turn-foot button{padding:7px 8px}.dv-turn-notice,.dv-turn-error{margin:0;padding:8px 15px;border-top:1px solid var(--tc-border);font-size:12px;overflow-wrap:anywhere}.dv-turn-notice{color:var(--tc-muted)}.dv-turn-error{color:var(--tc-del)}
@media(max-width:420px){.dv-turn-head{padding:11px;gap:8px}.dv-turn-icon{width:30px;height:30px}.dv-turn-label strong{font-size:13px}.dv-turn-card .dv-turn-file{padding:8px 11px;gap:8px}}
`;

// src/renderer/plugin-review-adapter.ts
import React3 from "react";

// src/core/native-build-contract.ts
var NATIVE_BUILD = {
  version: "0.17.0",
  assets: {
    main: { name: "index-DKEhNN1e.js", sha256: "f89d7fd4d428fc8ece04a65a7021af4983aa8ede1349eeddbe743f3865380e6b" },
    transcript: { name: "use-transcript-view-BZJWhb9_.js", sha256: "92c227ce4c98bdeacc676163d6e1f0065f01c2d03f142122e86017d7c5cb34e4" },
    panel: { name: "WorkPanel-C3oPGQMI.js", sha256: "6621ca03f19b3ccbf78777e7c05affaf79502facd356e9e77da41013508b8a79" }
  }
};
function matchesNativeBuild(version, hashes) {
  return version === NATIVE_BUILD.version && Object.values(NATIVE_BUILD.assets).every((asset) => hashes[asset.name] === asset.sha256);
}

// src/renderer/native-review-adapter.ts
import React2 from "react";
import { createRoot } from "react-dom/client";
var NativeReviewError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
function denied(code, message) {
  throw new NativeReviewError(code, message);
}
function pinnedModuleUrls(documentUrl, scriptUrls) {
  const page = new URL(documentUrl);
  if (page.protocol !== "file:" || !/\/app\.asar\/out\/renderer\/index\.html$/.test(page.pathname)) denied("NATIVE_ORIGIN", "Not the inspected native renderer document");
  const main = new URL(`assets/${NATIVE_BUILD.assets.main.name}`, page).href;
  if (scriptUrls.filter((url) => new URL(url, page).href === main).length !== 1) denied("NATIVE_ENTRY", "Pinned main module is not the document entry");
  return { main, transcript: new URL(`assets/${NATIVE_BUILD.assets.transcript.name}`, page).href };
}

// src/renderer/plugin-review-adapter.ts
var REVIEW_TAB_ID = "plugin:local.diff-view/review";
var PluginReviewError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
var denied2 = (code, message) => {
  throw new PluginReviewError(code, message);
};
async function loadPinned() {
  const scripts = Array.from(document.querySelectorAll('script[type="module"][src]')).map((script) => script.src);
  const { main } = pinnedModuleUrls(document.location.href, scripts);
  const module = await import(
    /* @vite-ignore */
    main
  );
  return { store: module.R, tab: module.aO, hostReact: module.r };
}
function createPluginReviewAdapter(options) {
  let closed = false, pending;
  const alive = () => {
    if (closed) denied2("SIDEBAR_UNLOADED", "\u63D2\u4EF6\u5DF2\u5378\u8F7D / Plugin unloaded");
  };
  const inspect = () => pending ??= (async () => {
    alive();
    const info = await options.info();
    alive();
    if (!info.supported || !matchesNativeBuild(info.version, info.hashes)) denied2("SIDEBAR_BUILD", info.reason ?? "\u4E0D\u652F\u6301\u5F53\u524D\u5BBF\u4E3B\u6784\u5EFA / Unsupported host build");
    const result = await (options.load ?? loadPinned)();
    alive();
    if (typeof result.store?.getState !== "function" || typeof result.tab !== "function" || result.hostReact?.createElement !== React3.createElement || result.hostReact?.useState !== React3.useState) denied2("SIDEBAR_CONTRACT", "\u5BBF\u4E3B\u9875\u7B7E\u63A5\u53E3\u5DF2\u53D8\u5316 / Host tab contract changed");
    const tab = result.tab("local.diff-view", "review");
    if (tab.id !== REVIEW_TAB_ID || tab.kind !== "plugin" || tab.resource !== "local.diff-view/review") denied2("SIDEBAR_CONTRACT", "\u63D2\u4EF6\u9875\u7B7E\u6807\u8BC6\u4E0D\u5339\u914D / Plugin tab identity mismatch");
    return result;
  })();
  return {
    async open(sessionId, location) {
      if (!/^diff-view:[0-9a-f-]{36}$/i.test(location)) denied2("SIDEBAR_TARGET", "\u65E0\u6548\u7684\u63D2\u4EF6\u5B9A\u4F4D\u4EE4\u724C / Invalid selection token");
      const modules = await inspect();
      alive();
      const state = modules.store.getState();
      if (!sessionId || state.activeSessionId !== sessionId || state.selectingSessionId) denied2("SIDEBAR_SESSION", "\u4F1A\u8BDD\u5DF2\u5207\u6362\uFF0C\u8BF7\u5728\u5F53\u524D\u4F1A\u8BDD\u70B9\u51FB / Session changed");
      if (!Array.isArray(state.pluginViews) || !state.pluginViews.some((view) => view.pluginId === "local.diff-view" && view.viewId === "review")) denied2("SIDEBAR_VIEW", "Diff view \u9875\u7B7E\u4E0D\u53EF\u7528\uFF0C\u8BF7\u68C0\u67E5\u63D2\u4EF6\u662F\u5426\u542F\u7528 / Diff view tab unavailable");
      if (typeof state.openWorkPanelTabForSession !== "function") denied2("SIDEBAR_CONTRACT", "\u5BBF\u4E3B\u4E0D\u652F\u6301\u6253\u5F00\u63D2\u4EF6\u9875\u7B7E / Plugin tab opener unavailable");
      state.openWorkPanelTabForSession(sessionId, { ...modules.tab("local.diff-view", "review"), location });
      const opened = modules.store.getState();
      if (opened.activeSessionId !== sessionId || !opened.workPanelOpen || opened.activeWorkPanelTabId !== REVIEW_TAB_ID) denied2("SIDEBAR_OPEN", "\u4FA7\u680F\u672A\u6253\u5F00 / Sidebar did not open");
    },
    close() {
      closed = true;
    }
  };
}

// src/renderer/index.tsx
var hub = null;
var realm2 = globalThis;
var disposers = [];
function same(current) {
  return Boolean(current && current === hub && !current.disposed);
}
function report(current, stage) {
  if (!same(current) || current.reported.has(stage)) return;
  current.reported.add(stage);
  void current.transport.invoke("rendererReport", { stage }).catch(() => {
  });
}
async function poll(current) {
  let bootstrapSucceeded = false;
  if (!same(current)) return;
  try {
    const data = await current.transport.invoke("bootstrap");
    if (!same(current)) return;
    current.bootstrapError = "";
    report(current, "bootstrap-ok");
    bootstrapSucceeded = true;
    current.bootstrap = data;
    current.listeners.forEach((listener) => listener(data));
    const items = [...current.cards.values()].filter((item) => item.listeners.size && (!item.checked || !item.run || item.run.state === "running"));
    for (let index = 0; index < Math.min(2, items.length); index++) {
      const item = items[(current.cursor + index) % items.length];
      const response = await current.transport.invoke("card", { sessionId: item.props.sessionId, messageId: item.props.messageId, content: item.props.message.content, createdAt: typeof item.props.message.createdAt === "number" ? new Date(item.props.message.createdAt).toISOString() : item.props.message.createdAt });
      if (!same(current)) return;
      item.run = response.run;
      item.checked = true;
      item.listeners.forEach((listener) => listener(response.run));
    }
    current.cursor += 2;
  } catch (error) {
    if (same(current) && !bootstrapSucceeded) {
      current.bootstrapError = String(error.message ?? error).slice(0, 240);
      report(current, "bootstrap-error");
      current.listeners.forEach((listener) => listener(current.bootstrap));
    }
  } finally {
    if (same(current)) current.timer = setTimeout(() => void poll(current), 6e3);
  }
}
function useBootstrap(current) {
  const [boot, setBoot] = useState2(current?.bootstrap ?? null);
  useEffect2(() => {
    if (!same(current)) return;
    const listener = (data) => setBoot(data);
    setBoot(current.bootstrap);
    current.listeners.add(listener);
    return () => {
      current.listeners.delete(listener);
    };
  }, [current]);
  return boot;
}
function EntryExtra(props) {
  const current = hub;
  const boot = useBootstrap(current);
  const [run, setRun] = useState2(null);
  const contentKey = JSON.stringify(props.message?.content);
  useEffect2(() => {
    setRun(null);
    if (!same(current) || !props.sessionId || !props.messageId || typeof props.message?.content !== "string" || !props.message.createdAt || !contentKey || new TextEncoder().encode(contentKey).length > 4e4) return;
    const key = `${props.sessionId}:${props.messageId}:${contentKey}`;
    let item = current.cards.get(key);
    if (!item) {
      item = { props, listeners: /* @__PURE__ */ new Set(), run: null, checked: false };
      current.cards.set(key, item);
    }
    item.listeners.add(setRun);
    setRun(item.run);
    return () => {
      item.listeners.delete(setRun);
      if (!item.listeners.size) current.cards.delete(key);
    };
  }, [current, props.sessionId, props.messageId, contentKey, props.message?.createdAt]);
  if (!run || run.state === "running" || !same(current)) return null;
  return /* @__PURE__ */ React4.createElement(TurnChangeSummary, { run, transport: current.transport, locale: boot?.locale ?? "zh-CN", base: boot?.base ?? "light", onOpen: async (file) => {
    const guard = () => {
      if (!same(current) || current.activeSession !== run.sessionId) throw new Error("\u4F1A\u8BDD\u5DF2\u5207\u6362\uFF0C\u8BF7\u5728\u5F53\u524D\u4F1A\u8BDD\u70B9\u51FB / Session changed");
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
  const current = { host: pi, transport, disposed: false, bootstrap: null, listeners: /* @__PURE__ */ new Set(), cards: /* @__PURE__ */ new Map(), cursor: 0, reported: /* @__PURE__ */ new Set(), adapter: options.adapter ?? createPluginReviewAdapter({ info: () => transport.invoke("nativeProbeInfo") }) };
  hub = current;
  realm2.__piDiffRenderer = { hub: current, dispose: onUnload };
  current.unsubscribeDraft = pi.composer.subscribeDraft((draft) => {
    if (same(current) && current.activeSession !== draft?.sessionId) {
      current.activeSession = draft?.sessionId;
      void transport.invoke("activeReviewSession", { sessionId: draft?.sessionId ?? null }).catch(() => {
      });
    }
  });
  disposers.push(pi.ui.injectStyle(summary_style_default));
  disposers.push(pi.slots.register({ slot: "entryExtra", component: EntryExtra }));
  report(current, "entry-loaded");
  void poll(current);
}
function onUnload() {
  const current = hub;
  if (current) {
    current.disposed = true;
    if (current.timer) clearTimeout(current.timer);
    current.unsubscribeDraft?.();
    current.cards.clear();
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
