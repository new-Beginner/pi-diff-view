// src/core/host-transcript.ts
function evidenceChunks(text) {
  const chunks = [], encoder2 = new TextEncoder();
  for (let offset = 0; offset < text.length; ) {
    let length = Math.min(24e3, text.length - offset);
    while (encoder2.encode(JSON.stringify(text.slice(offset, offset + length))).length > 28e3) length = Math.floor(length / 2);
    chunks.push(text.slice(offset, offset + length));
    offset += length;
  }
  return chunks;
}

// src/renderer/session-context-publisher.ts
var retryDelays = [500, 1e3, 2e3];
function createSessionContextPublisher(options) {
  let sessionId, generation = 0, disposed = false, publishing = false;
  let pending, uploaded;
  let retryTimer;
  const alive = () => !disposed && options.isCurrent();
  const cancelRetry = () => {
    if (retryTimer !== void 0) clearTimeout(retryTimer);
    retryTimer = void 0;
  };
  const publish = async () => {
    if (publishing || !alive()) return;
    publishing = true;
    try {
      while (pending && alive()) {
        const work = pending, version = generation;
        const currentSession = () => alive() && generation === version;
        const latest = () => currentSession() && pending === work;
        try {
          const { evidence, ...metadata } = work.context;
          const key = JSON.stringify([metadata.sessionId, metadata.root, metadata.evidenceRevision]);
          if (evidence && key !== uploaded) {
            if (new TextEncoder().encode(evidence).length > 8 * 1024 * 1024) throw new Error("Host evidence exceeds 8 MiB");
            const chunks = evidenceChunks(evidence);
            for (const [index, chunk] of chunks.entries()) {
              if (!latest()) break;
              await options.transport.invoke("sessionEvidence", { sessionId: metadata.sessionId, root: metadata.root, revision: metadata.evidenceRevision, index, chunk, final: index === chunks.length - 1 });
              if (!currentSession()) break;
              if (index === chunks.length - 1) uploaded = key;
            }
          }
          if (!latest()) continue;
          const result = await options.transport.invoke("sessionContext", metadata);
          if (!latest()) continue;
          if (result?.ok === false) throw new Error("Session context was not accepted");
          pending = void 0;
          options.wake();
        } catch {
          if (!latest()) continue;
          options.report();
          const delay = retryDelays[work.failures++];
          if (delay !== void 0) retryTimer = setTimeout(() => {
            retryTimer = void 0;
            void publish();
          }, delay);
          return;
        }
      }
    } finally {
      publishing = false;
    }
  };
  return {
    update(nextSessionId, context) {
      if (!alive()) return;
      if (sessionId !== nextSessionId) {
        sessionId = nextSessionId;
        generation++;
        pending = void 0;
        cancelRetry();
      }
      if (!context || !nextSessionId || context.sessionId !== nextSessionId) return;
      cancelRetry();
      pending = { context: { ...context }, failures: 0 };
      void publish();
    },
    dispose() {
      disposed = true;
      generation++;
      pending = void 0;
      uploaded = void 0;
      cancelRetry();
    }
  };
}

// src/core/review-surface-protocol.ts
var surfaceStamp = (value) => JSON.stringify(value);

// src/renderer/review-surface-client.ts
function createReviewSurfaceClient(transport) {
  const id = crypto.randomUUID();
  let seq = 0, sessionId = null, closed = false, timer;
  let version = 0, pending = false;
  const exchange = (extra = {}) => transport.invoke("reviewSurface", { role: "renderer", id, seq: ++seq, sessionId, sessionEpoch: version, ...extra });
  const heartbeat = async () => {
    if (closed || pending) return;
    pending = true;
    const stamp = version;
    try {
      await exchange();
    } catch {
    } finally {
      pending = false;
      if (!closed) {
        if (stamp !== version) void heartbeat();
        else timer = setTimeout(() => void heartbeat(), 2e3);
      }
    }
  };
  const channel = {
    async begin(target, guard) {
      guard();
      if (closed || target !== sessionId) throw new Error("\u4F1A\u8BDD\u5DF2\u5207\u6362 / Session changed");
      const stamp = version;
      await exchange({ locating: true });
      guard();
      if (closed || stamp !== version) throw new Error("\u4F1A\u8BDD\u5DF2\u5207\u6362 / Session changed");
    },
    async prepare(target, location, guard) {
      guard();
      if (closed || target !== sessionId) throw new Error("\u4F1A\u8BDD\u5DF2\u5207\u6362 / Session changed");
      const stamp = version;
      const selected = await transport.invoke("readTurnSelection", { sessionId: target, nonce: location.slice("diff-view:".length) });
      guard();
      if (closed || stamp !== version || selected.sessionId !== target) throw new Error("\u4F1A\u8BDD\u5DF2\u5207\u6362 / Session changed");
      const reply = await exchange({ nonce: selected.nonce, selectionRevision: selected.revision });
      guard();
      if (closed || stamp !== version) throw new Error("\u4F1A\u8BDD\u5DF2\u5207\u6362 / Session changed");
      if (reply.state !== "ready" || reply.sessionId !== target) throw new Error("\u5B58\u5728\u591A\u4E2A\u7A97\u53E3\u6216\u5BA1\u67E5\u89C6\u56FE\uFF0C\u65E0\u6CD5\u552F\u4E00\u5B9A\u4F4D\uFF1B\u8BF7\u53EA\u4FDD\u7559\u4E00\u4E2A\u7A97\u53E3\u548C\u5BA1\u67E5\u89C6\u56FE\u3002");
      return { stamp, nonce: selected.nonce, revision: selected.revision };
    },
    async confirm(value, guard) {
      const ticket = value;
      const deadline = Date.now() + 12e3;
      let after;
      do {
        guard();
        if (closed || version !== ticket.stamp) throw new Error("\u4F1A\u8BDD\u5DF2\u5207\u6362 / Session changed");
        const started = Date.now();
        const reply = await exchange({ after, waitMs: 1e3 });
        guard();
        if (closed || version !== ticket.stamp) throw new Error("\u4F1A\u8BDD\u5DF2\u5207\u6362 / Session changed");
        if (reply.state === "stale") {
          after = void 0;
          continue;
        }
        after = surfaceStamp(reply);
        if (reply.state === "ambiguous") throw new Error("\u5B58\u5728\u591A\u4E2A\u7A97\u53E3\u6216\u5BA1\u67E5\u89C6\u56FE\uFF0C\u5DF2\u505C\u6B62\u5B9A\u4F4D\u3002");
        if (reply.nonce !== ticket.nonce || reply.selectionRevision !== ticket.revision) throw new Error("\u6587\u4EF6\u9009\u62E9\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u70B9\u51FB\u3002");
        if (reply.confirmed) return;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, 50 - (Date.now() - started))));
      } while (Date.now() < deadline);
      throw new Error("\u5BA1\u67E5\u9875\u7B7E\u672A\u786E\u8BA4\u6587\u4EF6\u5B9A\u4F4D\uFF0C\u8BF7\u91CD\u8BD5\uFF1B\u672A\u81EA\u52A8\u91CD\u653E\u6253\u5F00\u8BF7\u6C42\u3002");
    }
  };
  return {
    channel,
    update(next) {
      if (closed) return;
      if (next !== sessionId) {
        sessionId = next;
        version++;
      }
      if (timer) clearTimeout(timer);
      void heartbeat();
    },
    dispose() {
      closed = true;
      version++;
      if (timer) clearTimeout(timer);
      void exchange({ release: true }).catch(() => {
      });
    }
  };
}

// src/renderer/index.tsx
import React4, { useEffect as useEffect3, useState as useState3 } from "react";

// src/view/transport.ts
var realm = globalThis;
var queue = realm.__piDiffBurstQueue ??= { tail: Promise.resolve(), starts: [] };
var background = /* @__PURE__ */ new Set(["sessionEvidence", "gitManage", "selectRepository", "sessionContext", "captureMaintenance", "bootstrap", "review", "action", "batchAction", "copyPatch", "clearHistory", "turnSummary", "runningChanges", "selectTurn", "openSystemFile", "card", "replyCards"]);
var reads = /* @__PURE__ */ new Set(["bootstrap", "review", "reviewFiles", "turnSummary", "runningChanges", "file", "comments", "feedback", "replyCards", "rendererReport", "nativeProbeInfo"]);
var gitReads = /* @__PURE__ */ new Set(["status", "branches", "history", "stashList", "diff", "stats", "commitFiles", "commitDiff", "blame", "stashShow", "discardPreview"]);
var navigationMethods = /* @__PURE__ */ new Set(["openSystemFile", "activeReviewSession", "readTurnSelection", "selectTurn", "reviewSurface"]);
var sessionReadInvalidators = /* @__PURE__ */ new WeakMap();
function boundedTransport(invoke) {
  const wire = (method, args, navigation = navigationMethods.has(method)) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ method, args })).length;
    if (bytes > 48 * 1024) return Promise.reject(new Error("Request exceeds the bridge payload limit (48 KiB)."));
    if (method === "saveComment" && bytes > 24e3) return Promise.reject(new Error("Comment payload too large; shorten the comment or excerpt."));
    const admission = (navigation ? queue.navigationTail ?? Promise.resolve() : queue.tail).catch(() => void 0).then(async () => {
      for (; ; ) {
        queue.starts = queue.starts.filter((at) => Date.now() - at < 1e3);
        if (queue.starts.length < 6) {
          queue.starts.push(Date.now());
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, 1001 - (Date.now() - queue.starts[0]))));
      }
    });
    if (navigation) queue.navigationTail = admission;
    const request2 = admission.then(async () => {
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
    if (!navigation) queue.tail = admission;
    return request2;
  };
  const call = async (method, args) => {
    if (!background.has(method)) return wire(method, args);
    const navigation = method === "selectTurn" || method === "openSystemFile";
    const admissionDeadline = Date.now() + 3e4;
    let started;
    do {
      started = await wire("jobStart", { method, args, waitMs: 40, queueIfBusy: !navigation }, navigation);
      if (started.state !== "busy") break;
      if (Date.now() >= admissionDeadline) throw new Error("\u540E\u53F0\u4EFB\u52A1\u7E41\u5FD9\uFF0C\u5C1A\u672A\u6267\u884C\u672C\u6B21\u64CD\u4F5C\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002");
      await new Promise((resolve) => setTimeout(resolve, 300));
    } while (true);
    if (started.state === "done") return started.result;
    if (started.state === "error") throw Object.assign(new Error(started.error?.message ?? "Review failed"), { code: started.error?.code });
    if (!started.jobId) throw new Error("Invalid background operation response");
    const deadline = Date.now() + 12e4;
    let delay = method === "gitManage" ? 120 : 40;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      const job = await wire("jobPoll", { jobId: started.jobId }, navigation);
      if (job.state === "done") return job.result;
      if (job.state === "error") throw Object.assign(new Error(job.error?.message ?? "Review failed"), { code: job.error?.code });
      delay = Math.min(300, delay * 2);
    }
    throw new Error("Background operation is still running. Refresh to check the result; it was not retried.");
  };
  const request = (method, args) => {
    if (navigationMethods.has(method)) return call(method, args);
    const savedRead = method === "replyCards" || method === "review" && args?.scope === "turn" && !args.retrySync || ["file", "reviewFiles"].includes(method) && String(args?.reviewId ?? "").startsWith("saved:");
    if (savedRead) return call(method, args);
    const read = reads.has(method) || method === "gitManage" && gitReads.has(args?.operation ?? "");
    const repository = method === "gitManage" || method === "action" || method === "batchAction";
    const lane = repository ? "gitTail" : "mutationTail";
    const dependencies = [queue[lane] ?? Promise.resolve()];
    if (method === "clearHistory" || method === "review" && !["turn", "lastTurn"].includes(args?.scope ?? "")) dependencies.push(queue.gitTail ?? Promise.resolve());
    const result = Promise.all(dependencies.map((task) => task.catch(() => void 0))).then(() => call(method, args));
    if (!read) queue[lane] = result.then(() => void 0, () => void 0);
    return result;
  };
  const pendingReads = /* @__PURE__ */ new Map();
  let readEpoch = 0;
  const transport = { invoke(method, args) {
    const read = ["bootstrap", "review", "turnSummary", "runningChanges", "card", "replyCards"].includes(method) || method === "gitManage" && gitReads.has(args?.operation ?? "");
    if (!read) {
      if (!reads.has(method) && !["reviewSurface", "readTurnSelection"].includes(method)) readEpoch++;
      return request(method, args);
    }
    const key = JSON.stringify([readEpoch, method, args]);
    const previous = pendingReads.get(key);
    if (previous) return previous.result;
    const result = request(method, args).finally(() => {
      if (pendingReads.get(key)?.result === result) pendingReads.delete(key);
    });
    pendingReads.set(key, { sessionId: args?.sessionId, result });
    return result;
  } };
  sessionReadInvalidators.set(transport.invoke, (sessionId) => {
    for (const [key, read] of pendingReads) if (read.sessionId === sessionId) pendingReads.delete(key);
  });
  return transport;
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
import React2, { useEffect, useLayoutEffect, useRef, useState } from "react";

// src/view/FilePath.tsx
import React from "react";
function FilePath({ path, external = false }) {
  const split = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("span", { className: "dv-path-directory" }, external ? "\u2026/" : path.slice(0, split)), /* @__PURE__ */ React.createElement("span", { className: "dv-path-basename" }, path.slice(split)));
}

// src/renderer/entry-extra-layout.ts
function adaptEntryExtraViewport(card, onExpanded) {
  const viewport = card.closest(".pi-entry-extra-viewport");
  const directory = card.querySelector(".dv-turn-directory");
  const overflow = card.closest(".dv-turn-layout")?.querySelector(".dv-turn-overflow");
  const header = card.querySelector(".dv-turn-head");
  if (!viewport || !directory || !overflow || !header) return;
  const owned = /* @__PURE__ */ new Map();
  const read = (property) => ({ value: viewport.style.getPropertyValue(property), priority: viewport.style.getPropertyPriority(property) });
  const equal = (left, right) => left.value === right.value && left.priority === right.priority;
  const restore = (property, value) => {
    if (value.value) viewport.style.setProperty(property, value.value, value.priority);
    else viewport.style.removeProperty(property);
  };
  const apply = (property, value) => {
    const current = read(property);
    let setting = owned.get(property);
    if (!setting) {
      if (value == null) return;
      setting = { original: current };
      owned.set(property, setting);
    } else if (!setting.applied || !equal(current, setting.applied)) {
      setting.original = current;
    }
    if (value == null) {
      if (setting.applied && equal(current, setting.applied)) restore(property, setting.original);
      setting.applied = void 0;
      return;
    }
    const next = { value, priority: "important" };
    if (!equal(current, next)) viewport.style.setProperty(property, next.value, next.priority);
    setting.applied = next;
  };
  let previous, frame = 0;
  const children = /* @__PURE__ */ new Set();
  const sync = () => {
    const expanded = viewport.dataset.expanded === "true";
    apply("overflow-x", expanded ? "visible" : "clip");
    apply("overflow-y", expanded ? "visible" : "clip");
    apply("overscroll-behavior", expanded ? "auto" : "contain");
    apply("mask-image", "none");
    apply("max-height", expanded ? "none" : void 0);
    card.dataset.hostFold = expanded ? "expanded" : "collapsed";
    const limit = expanded ? NaN : parseFloat(getComputedStyle(viewport).maxHeight);
    const cardStyle = getComputedStyle(card);
    const bottom = parseFloat(cardStyle.borderBottomWidth) + parseFloat(cardStyle.marginBottom);
    const available = limit - (directory.getBoundingClientRect().top - viewport.getBoundingClientRect().top) - bottom;
    const maxHeight = Number.isFinite(available) ? `${Math.max(0, available)}px` : "none";
    if (directory.style.maxHeight !== maxHeight) directory.style.maxHeight = maxHeight;
    const hiddenHeight = expanded ? 0 : Math.max(0, directory.scrollHeight - directory.clientHeight);
    const height = `${hiddenHeight}px`;
    if (overflow.style.height !== height) overflow.style.height = height;
    for (const child of children) if (child.parentElement !== directory) {
      resize.unobserve(child);
      children.delete(child);
    }
    for (const child of directory.children) if (!children.has(child)) {
      children.add(child);
      resize.observe(child);
    }
    if (expanded !== previous) {
      directory.scrollTop = 0;
      viewport.scrollTop = 0;
      previous = expanded;
      onExpanded(expanded);
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0;
      sync();
    });
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(viewport);
  resize.observe(header);
  resize.observe(directory);
  const observer = new MutationObserver(sync);
  observer.observe(viewport, { attributes: true, attributeFilter: ["data-expanded", "style"] });
  const contentObserver = new MutationObserver(schedule);
  contentObserver.observe(directory, { childList: true, subtree: true, characterData: true });
  sync();
  return () => {
    observer.disconnect();
    contentObserver.disconnect();
    resize.disconnect();
    cancelAnimationFrame(frame);
    delete card.dataset.hostFold;
    directory.style.removeProperty("max-height");
    overflow.style.removeProperty("height");
    for (const [property, setting] of owned) {
      if (setting.applied && equal(read(property), setting.applied)) restore(property, setting.original);
    }
  };
}

// src/renderer/TurnChangeSummary.tsx
function TurnChangeSummary({ run, transport, locale, base, initialSummary, onOpen }) {
  const zh = locale.startsWith("zh");
  const [summary, setSummary] = useState(initialSummary ?? null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const live = useRef(true);
  const cardRef = useRef(null);
  const [hostExpanded, setHostExpanded] = useState(false);
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (card) return adaptEntryExtraViewport(card, setHostExpanded);
  }, [run.id, summary?.fileCount === 0]);
  useEffect(() => {
    let active = true;
    live.current = true;
    setError("");
    if (!initialSummary) transport.invoke("turnSummary", { runId: run.id, sessionId: run.sessionId, limit: 40 }).then((data) => {
      if (active) setSummary(data);
    }).catch((err) => {
      if (active) setError(String(err?.message ?? err));
    });
    return () => {
      active = false;
      live.current = false;
    };
  }, [transport, run.id, run.sessionId, initialSummary]);
  useEffect(() => {
    setSummary(initialSummary ?? null);
  }, [run.id, run.sessionId]);
  useEffect(() => {
    if (initialSummary) setSummary((previous) => previous && previous.fileCount === initialSummary.fileCount && previous.additions === initialSummary.additions && previous.deletions === initialSummary.deletions && previous.unknownFileCount === initialSummary.unknownFileCount && initialSummary.files.every((file) => previous.files.some((old) => old.id === file.id && old.fingerprint === file.fingerprint && old.kind === file.kind && old.statsKnown === file.statsKnown)) ? { ...initialSummary, files: previous.files, nextOffset: previous.nextOffset } : initialSummary);
  }, [initialSummary]);
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
  const loadMore = async () => {
    if (!summary || busy || summary.nextOffset == null) return;
    setBusy(true);
    setError("");
    try {
      const page = await transport.invoke("turnSummary", { runId: run.id, sessionId: run.sessionId, offset: summary.nextOffset, limit: 40 });
      if (page.runId !== run.id || page.sessionId !== run.sessionId || page.offset !== summary.nextOffset || page.nextOffset != null && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= page.offset || !page.files.length)) throw new Error(zh ? "\u65E0\u6548\u7684\u6587\u4EF6\u5217\u8868\u5206\u9875\uFF0C\u8BF7\u91CD\u8BD5\u3002" : "Invalid file-list page; retry.");
      if (live.current) setSummary((previous) => previous && previous.runId === page.runId && previous.sessionId === page.sessionId ? { ...page, offset: 0, files: [...previous.files, ...page.files.filter((file) => !previous.files.some((old) => old.id === file.id))] } : previous);
    } catch (err) {
      if (live.current) setError(String(err.message ?? err));
    } finally {
      if (live.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (hostExpanded && summary?.nextOffset != null && !busy && !error) void loadMore();
  }, [hostExpanded, summary, busy, error]);
  if (summary?.fileCount === 0 && !error) return null;
  const files = summary?.files ?? [];
  return /* @__PURE__ */ React2.createElement("div", { className: "dv-turn-layout" }, /* @__PURE__ */ React2.createElement("section", { ref: cardRef, className: "dv-turn-card dv-reply", "data-base": base, "aria-label": zh ? "\u672C\u6B21\u4EFB\u52A1\u6587\u4EF6\u53D8\u66F4" : "Files changed in this task" }, /* @__PURE__ */ React2.createElement("header", { className: "dv-turn-head" }, /* @__PURE__ */ React2.createElement("span", { className: "dv-turn-icon", "aria-hidden": "true" }, /* @__PURE__ */ React2.createElement("svg", { viewBox: "0 0 24 24", width: "22", height: "22", fill: "none", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round" }, /* @__PURE__ */ React2.createElement("rect", { x: "4", y: "3", width: "16", height: "18", rx: "4" }), /* @__PURE__ */ React2.createElement("path", { d: "M9 9h6M12 6v6M9 16h6" }))), /* @__PURE__ */ React2.createElement("div", { className: "dv-turn-label" }, /* @__PURE__ */ React2.createElement("strong", null, summary ? zh ? `\u5DF2\u7F16\u8F91 ${summary.fileCount} \u4E2A\u6587\u4EF6` : `${summary.fileCount} files changed` : zh ? "\u6B63\u5728\u8BFB\u53D6\u672C\u6B21\u53D8\u66F4\u2026" : "Loading task changes\u2026"), summary && /* @__PURE__ */ React2.createElement("span", { className: "dv-turn-counts" }, (summary.unknownFileCount ?? 0) < summary.fileCount && /* @__PURE__ */ React2.createElement(React2.Fragment, null, /* @__PURE__ */ React2.createElement("span", { className: "dv-turn-add" }, "+", summary.additions), /* @__PURE__ */ React2.createElement("span", { className: "dv-turn-del" }, "\u2212", summary.deletions)), !!summary.unknownFileCount && /* @__PURE__ */ React2.createElement("span", null, zh ? summary.unknownFileCount >= summary.fileCount ? "\u884C\u6570\u672A\u77E5" : "\u90E8\u5206\u7EDF\u8BA1" : "Partial / unknown totals"))), /* @__PURE__ */ React2.createElement("button", { className: "dv-turn-open", disabled: busy || !summary, onClick: () => void open() }, busy ? zh ? "\u6253\u5F00\u4E2D\u2026" : "Opening\u2026" : zh ? "\u67E5\u770B\u53D8\u66F4" : "View changes")), /* @__PURE__ */ React2.createElement("div", { className: "dv-turn-directory", role: "region", "aria-label": zh ? "\u6587\u4EF6\u76EE\u5F55" : "File directory", tabIndex: 0 }, !!files.length && /* @__PURE__ */ React2.createElement("div", { className: "dv-turn-files" }, files.map((file) => {
    const known2 = file.kind === "text" && file.statsKnown !== false;
    const label = file.kind === "binary" ? zh ? "\u4E8C\u8FDB\u5236\u6587\u4EF6" : "Binary file" : file.kind === "large" ? zh ? "\u6587\u4EF6\u8FC7\u5927" : "Large file" : zh ? "\u5FEB\u7167\u4E0D\u5B8C\u6574" : "Incomplete snapshot";
    return /* @__PURE__ */ React2.createElement("button", { key: file.id, className: "dv-turn-file", title: [file.absolutePath ?? file.path, file.note].filter(Boolean).join("\n"), disabled: busy, onClick: () => void open(file) }, /* @__PURE__ */ React2.createElement("span", { className: "dv-turn-path" }, /* @__PURE__ */ React2.createElement(FilePath, { path: file.path }), file.origin === "external" && /* @__PURE__ */ React2.createElement("small", null, zh ? "\u5DE5\u4F5C\u533A\u5916 \xB7 \u53EA\u8BFB" : "Outside workspace \xB7 read-only")), known2 ? /* @__PURE__ */ React2.createElement("span", { className: "dv-turn-counts" }, /* @__PURE__ */ React2.createElement("span", { className: "dv-turn-add" }, "+", file.additions), /* @__PURE__ */ React2.createElement("span", { className: "dv-turn-del" }, "\u2212", file.deletions)) : /* @__PURE__ */ React2.createElement("span", { className: "dv-turn-unknown", title: label }, zh ? "\u884C\u6570\u672A\u77E5" : "Unknown totals"));
  })), summary?.unknownFileCount || summary?.files.some((file) => file.statsKnown === false || file.kind !== "text") ? /* @__PURE__ */ React2.createElement("details", { className: "dv-turn-stats-note" }, /* @__PURE__ */ React2.createElement("summary", null, zh ? "\u7EDF\u8BA1\u8BF4\u660E" : "About these totals"), /* @__PURE__ */ React2.createElement("p", null, zh ? "\u4EC5\u7EDF\u8BA1\u6709\u5B8C\u6574\u5FEB\u7167\u7684\u6587\u672C\u6587\u4EF6\uFF1B\u7F3A\u5931\u5386\u53F2\u5185\u5BB9\u7684\u6587\u4EF6\u4E0D\u8BA1\u5165\u884C\u6570\u3002" : "Totals include text files with complete snapshots; missing historical content is excluded.")) : null, summary?.nextOffset != null && /* @__PURE__ */ React2.createElement("footer", { className: "dv-turn-foot" }, /* @__PURE__ */ React2.createElement("button", { disabled: busy, onClick: () => void loadMore() }, busy ? zh ? "\u52A0\u8F7D\u4E2D\u2026" : "Loading\u2026" : zh ? "\u52A0\u8F7D\u66F4\u591A\u6587\u4EF6" : "Load more files")), error && /* @__PURE__ */ React2.createElement("p", { className: "dv-turn-error", role: "alert" }, error))), /* @__PURE__ */ React2.createElement("div", { className: "dv-turn-overflow", "aria-hidden": "true" }));
}

// src/renderer/summary-style.ts
var summary_style_default = `
/* Same visual scale as view/theme.css, scoped to plugin-owned host surfaces. */
.dv-turn-card,.dv-running-float{--dv-radius-control:8px;--dv-radius-surface:12px;--dv-radius-popup:16px;--dv-radius-pill:20px;--dv-popup-shadow:0 8px 24px rgb(0 0 0 / .08),0 2px 6px rgb(0 0 0 / .04)}
.dv-turn-card[data-base=dark],.dv-running-float[data-base=dark]{--dv-popup-shadow:0 8px 24px rgb(0 0 0 / .24),0 2px 6px rgb(0 0 0 / .12)}
.dv-turn-layout{display:flow-root;max-width:100%}.dv-turn-overflow{height:0;pointer-events:none}.dv-turn-directory{max-height:none;overflow:visible}.dv-turn-card[data-host-fold=collapsed] .dv-turn-directory{overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain}.dv-turn-directory:focus-visible{outline:2px solid var(--ds-focus,currentColor);outline-offset:-2px}
.dv-turn-card{--tc-ink:var(--ds-text-primary,inherit);--tc-muted:var(--ds-text-muted,color-mix(in srgb,currentColor 62%,transparent));--tc-border:var(--ds-border-default,color-mix(in srgb,currentColor 9%,transparent));--tc-hover:var(--ds-bg-hover,color-mix(in srgb,currentColor 7%,transparent));--tc-add:var(--ds-success,#008339);--tc-del:var(--ds-error,#c52b2b);color:var(--tc-ink);background:transparent;border:1px solid var(--tc-border);border-radius:var(--dv-radius-surface);margin:12px 0 4px;font-family:inherit;font-size:14px;line-height:1.45;text-align:left;overflow:clip;max-width:100%;}
.dv-turn-card[data-base=dark]{--tc-add:var(--ds-success,#40c977);--tc-del:var(--ds-error,#ff6764)}
.dv-turn-card *{box-sizing:border-box}.dv-turn-card button{font:inherit;color:inherit;background:transparent;border:0;border-radius:var(--dv-radius-control);cursor:pointer}.dv-turn-card button:hover:not(:disabled){background:var(--tc-hover)}.dv-turn-card button:focus-visible{outline:2px solid var(--ds-focus,currentColor);outline-offset:-2px}.dv-turn-card button:disabled{opacity:.5;cursor:wait}
.dv-turn-head{display:flex;align-items:center;gap:12px;padding:12px 14px}.dv-turn-icon{display:grid;place-items:center;flex:0 0 42px;width:42px;height:42px;border-radius:var(--dv-radius-control);color:var(--tc-muted);background:color-mix(in srgb,currentColor 4%,transparent)}.dv-turn-label{display:flex;flex-direction:column;align-items:flex-start;gap:2px;flex:1;min-width:0}.dv-turn-label strong{font-size:14px;font-weight:600}.dv-turn-counts{display:inline-flex;gap:4px;white-space:nowrap;font-size:12px;font-variant-numeric:tabular-nums}.dv-turn-add{color:var(--tc-add)}.dv-turn-del{color:var(--tc-del)}.dv-turn-card .dv-turn-open{border:1px solid var(--tc-border);border-radius:var(--dv-radius-control);min-height:32px;padding:5px 10px;white-space:nowrap;font-size:13px}
.dv-turn-files{border-top:1px solid var(--tc-border);padding:2px 0}.dv-turn-card .dv-turn-file{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;column-gap:12px;width:100%;min-height:40px;padding:9px 14px;border-radius:0;text-align:left}.dv-turn-path{min-width:0;overflow-wrap:anywhere;color:var(--tc-ink)}.dv-turn-card .dv-path-directory{color:var(--tc-muted)}.dv-turn-card .dv-path-basename{color:var(--tc-ink)}.dv-turn-path small{font-size:11px;margin-left:8px;display:inline-block;color:var(--tc-muted)}.dv-turn-error{margin:0;padding:10px 14px;border-top:1px solid var(--tc-border);border-left:3px solid var(--tc-del);background:color-mix(in srgb,var(--tc-del) 10%,transparent);font-size:12px;line-height:1.6;overflow-wrap:anywhere;color:var(--tc-del)}
.dv-turn-unknown{color:var(--tc-muted);font-size:11px;white-space:nowrap}.dv-turn-stats-note{border-top:1px solid var(--tc-border);padding:8px 14px;color:var(--tc-muted);font-size:12px}.dv-turn-stats-note summary{cursor:pointer;width:fit-content}.dv-turn-stats-note summary:focus-visible{outline:2px solid var(--ds-focus,currentColor);outline-offset:2px}.dv-turn-stats-note p{margin:6px 0 0;max-width:60ch;line-height:1.6}.dv-turn-foot{display:flex;gap:8px;border-top:1px solid var(--tc-border);padding:6px 8px}.dv-turn-foot button{min-height:32px;padding:5px 8px;font-size:12px;color:var(--tc-muted)}
/* The header is a normal-flow sibling, never part of the directory scroll container. */
.dv-turn-card .dv-turn-head{position:static;border-radius:var(--dv-radius-surface) var(--dv-radius-surface) 0 0;background:var(--ds-bg-elevated-opaque,#fafafa);box-shadow:0 1px var(--tc-border)}
.dv-turn-card[data-base=dark] .dv-turn-head{background:var(--ds-bg-elevated-opaque,#212121)}
@media(max-width:420px){.dv-turn-head{padding:10px;gap:9px}.dv-turn-icon{width:36px;height:36px;flex-basis:36px}.dv-turn-label strong{font-size:13px}.dv-turn-card .dv-turn-open{font-size:12px;padding:4px 8px}.dv-turn-card .dv-turn-file{padding:7px 10px;gap:8px;font-size:13px}}
`;

// src/renderer/host-state-adapter.ts
var PluginReviewError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
function runningActivity(context) {
  if (!context?.sessionId || !context.running || context.statusKnown === false) return null;
  const { sessionId, taskId, since, turnId } = context;
  if (typeof taskId === "string" && taskId.trim() && typeof since === "number" && Number.isSafeInteger(since) && since > 0 && since <= Date.now()) return { sessionId, taskId, since, ...turnId ? { turnId } : {} };
  if (typeof turnId === "string" && turnId.trim() && (since === void 0 || since === 0)) return { sessionId, taskId: `turn:${turnId}`, since: 0, turnId };
  return null;
}
function activityDiagnostic(context) {
  if (!context) return "running-idle";
  if (context.statusKnown === false) return "running-identity-missing";
  return runningActivity(context) ? "running-ready" : context.running ? "running-identity-missing" : "running-idle";
}
var unknownContext = (sessionId) => ({ sessionId, running: false, statusKnown: false });
function createHostStateAdapter(options) {
  const subscribers = /* @__PURE__ */ new Set();
  let closed = false, started = false, generation = 0;
  let sessionId, context;
  let observer, timer;
  let flight;
  const alive = () => {
    if (closed) throw new PluginReviewError("SIDEBAR_UNLOADED", "\u63D2\u4EF6\u5DF2\u5378\u8F7D / Plugin unloaded");
  };
  const publish = () => {
    for (const subscriber of [...subscribers]) if (subscribers.has(subscriber)) subscriber.publish();
  };
  const cancelTimer = () => {
    if (timer !== void 0) clearTimeout(timer);
    timer = void 0;
  };
  const schedule = () => {
    cancelTimer();
    timer = setTimeout(() => {
      timer = void 0;
      poll();
    }, 1e3);
  };
  const syncSession = () => {
    const next = options.session();
    if (next === sessionId) return false;
    sessionId = next;
    generation++;
    cancelTimer();
    context = next ? unknownContext(next) : void 0;
    publish();
    return true;
  };
  const poll = () => {
    if (closed || !started) return;
    syncSession();
    if (closed || !started) return;
    schedule();
    if (flight || !sessionId) return;
    const id = sessionId, version = generation;
    flight = Promise.resolve().then(() => !closed && started && generation === version ? options.read(id) : void 0).then((result) => {
      if (closed || !started) return;
      syncSession();
      if (generation !== version) return;
      if (!result || result.sessionId !== id || typeof result.running !== "boolean" || typeof result.statusKnown !== "boolean") {
        context = unknownContext(id);
      } else {
        context = { sessionId: id, root: result.root, running: result.running, mainRunning: result.mainRunning, statusKnown: result.statusKnown, taskId: result.taskId, since: result.since, turnId: result.turnId, evidenceRevision: result.evidenceRevision };
      }
      publish();
    }, () => {
      if (closed || !started) return;
      syncSession();
      if (generation !== version) return;
      context = unknownContext(id);
      publish();
    }).finally(() => {
      flight = void 0;
      if (closed || !started) return;
      syncSession();
      if (generation !== version) poll();
      else schedule();
    });
  };
  const stop = () => {
    started = false;
    generation++;
    cancelTimer();
    observer?.disconnect();
    observer = void 0;
    sessionId = void 0;
    context = void 0;
  };
  const subscribe = (subscriber) => {
    alive();
    subscribers.add(subscriber);
    try {
      if (!started) {
        started = true;
        syncSession();
        alive();
        observer = options.observe?.(() => {
          if (started && !closed && syncSession()) poll();
        });
        poll();
      } else {
        if (syncSession()) poll();
        if (!closed && started) subscriber.publish();
      }
    } catch (error) {
      subscribers.delete(subscriber);
      if (!subscribers.size) stop();
      throw error;
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      subscribers.delete(subscriber);
      if (!subscribers.size) stop();
    };
  };
  return {
    async subscribeEvidence(listener) {
      let previous;
      return subscribe({ publish() {
        const key = JSON.stringify([generation, sessionId, context]);
        if (key !== previous) {
          previous = key;
          listener(sessionId ?? null, context);
        }
      } });
    },
    async subscribeActivity(listener, diagnose) {
      let previous;
      return subscribe({ publish() {
        const activity = runningActivity(context), diagnostic = activityDiagnostic(context);
        const key = JSON.stringify([generation, activity, diagnostic]);
        if (key !== previous) {
          previous = key;
          diagnose?.(diagnostic);
          listener(activity);
        }
      } });
    },
    close() {
      if (closed) return;
      closed = true;
      stop();
      subscribers.clear();
    }
  };
}

// src/renderer/plugin-review-adapter.ts
var REVIEW_TAB_ID = "plugin:local.diff-view/review";
var denied = (code, message) => {
  throw new PluginReviewError(code, message);
};
var validId = (value) => !!value && /^[a-zA-Z0-9-]{1,80}$/.test(value);
function domSession(document2) {
  const panes = [...document2.querySelectorAll('[data-session-pane][data-visible="true"]')];
  const rows = [...document2.querySelectorAll(".thread-item.active[data-sidebar-session-row]")];
  if (panes.length > 1 || rows.length > 1) return null;
  const pane = panes[0]?.getAttribute("data-session-pane") ?? null;
  const row = rows[0]?.getAttribute("data-sidebar-session-row") ?? null;
  if (panes.length && !validId(pane) || rows.length && !validId(row) || pane && row && pane !== row) return null;
  return pane ?? row;
}
function createPluginReviewAdapter(options = {}) {
  let closed = false, opening = false;
  const subscriptions = /* @__PURE__ */ new Set();
  const doc = () => options.document ?? document;
  const observeDom = (document2, publish, invalidate, current) => {
    if (options.observe) return options.observe(publish);
    const observer = new MutationObserver((records) => {
      const previous = current();
      const excursion = records.some((record) => {
        if (record.type !== "attributes" || !previous) return false;
        const node = record.target;
        if (["data-session-pane", "data-sidebar-session-row"].includes(record.attributeName ?? "")) return node.getAttribute(record.attributeName) === previous && validId(record.oldValue) && record.oldValue !== previous;
        if (record.attributeName === "data-visible") return node.getAttribute("data-session-pane") === previous && node.getAttribute("data-visible") === "true" && record.oldValue === "false";
        return record.attributeName === "class" && node.getAttribute("data-sidebar-session-row") === previous && node.classList.contains("active") && !record.oldValue?.split(/\s+/).includes("active");
      });
      if (excursion && previous) invalidate();
      publish();
    });
    observer.observe(document2.documentElement, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ["data-session-pane", "data-visible", "data-sidebar-session-row", "class"] });
    return observer;
  };
  let invalidating = false;
  const source = createHostStateAdapter({
    read: options.read ?? (async () => denied("SIDEBAR_CHANNEL", "\u516C\u5171\u4F1A\u8BDD\u72B6\u6001\u63A5\u53E3\u4E0D\u53EF\u7528 / Public session state unavailable")),
    session: () => invalidating ? null : domSession(doc()),
    observe: (callback) => {
      const document2 = doc();
      let previous = domSession(document2);
      return observeDom(document2, () => {
        previous = domSession(document2);
        callback();
      }, () => {
        previous = null;
        invalidating = true;
        try {
          callback();
        } finally {
          invalidating = false;
        }
      }, () => previous);
    }
  });
  const alive = () => {
    if (closed) denied("SIDEBAR_UNLOADED", "\u63D2\u4EF6\u5DF2\u5378\u8F7D / Plugin unloaded");
  };
  const checkSession = (sessionId, guard) => {
    alive();
    guard?.();
    if (!validId(sessionId) || domSession(doc()) !== sessionId) denied("SIDEBAR_SESSION", "\u4F1A\u8BDD\u5DF2\u5207\u6362\u6216\u4E0D\u552F\u4E00\uFF0C\u8BF7\u5728\u5F53\u524D\u4F1A\u8BDD\u91CD\u8BD5 / Session changed or ambiguous");
  };
  const reveal = async (sessionId, guard) => {
    const document2 = doc(), check = () => checkSession(sessionId, guard), clicked = /* @__PURE__ */ new Set();
    check();
    const one = (selector) => {
      const nodes = [...document2.querySelectorAll(selector)].filter((node) => !node.closest("[hidden], [inert]"));
      if (nodes.length > 1) denied("SIDEBAR_AMBIGUOUS", "\u5BBF\u4E3B\u9875\u7B7E\u63A7\u4EF6\u4E0D\u552F\u4E00 / Ambiguous host controls");
      return nodes[0];
    };
    const click = (node) => {
      check();
      if (!node || clicked.has(node)) return;
      if (node.getAttribute("aria-disabled") === "true" || node.disabled) denied("SIDEBAR_OPEN", "\u5BBF\u4E3B\u9875\u7B7E\u63A7\u4EF6\u4E0D\u53EF\u7528");
      clicked.add(node);
      node.click();
    };
    const deadline = Date.now() + 4e3;
    while (Date.now() < deadline) {
      check();
      const toggle = one(".app-work-panel-toggle");
      if (!toggle || !["true", "false"].includes(toggle.getAttribute("aria-pressed") ?? "")) denied("SIDEBAR_CONTRACT", "\u5BBF\u4E3B\u5DE5\u4F5C\u9762\u677F\u6807\u8BB0\u5DF2\u53D8\u5316 / Work panel markup changed");
      if (toggle.getAttribute("aria-pressed") === "false") click(toggle);
      else {
        const tab = one(`[data-work-panel-tab-id="${REVIEW_TAB_ID}"] button[role="tab"]`);
        if (tab?.getAttribute("aria-selected") === "true") return;
        if (tab) click(tab);
        else {
          const launcher = one('[data-work-panel-launcher-item="local.diff-view/review"]');
          if (launcher) click(launcher);
          else click(one(".work-panel-new-tab"));
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    denied("SIDEBAR_OPEN", "\u672A\u627E\u5230\u6216\u672A\u80FD\u6FC0\u6D3B Diff view \u9875\u7B7E\uFF0C\u8BF7\u68C0\u67E5\u63D2\u4EF6\u662F\u5426\u542F\u7528 / Review tab did not open");
  };
  return {
    async reveal(sessionId, guard) {
      const check = () => checkSession(sessionId, guard);
      check();
      await Promise.all([options.navigation?.begin?.(sessionId, check), reveal(sessionId, guard)]);
      check();
    },
    async subscribeSession(listener) {
      alive();
      const document2 = doc();
      let previous, stopped = false;
      const publish = () => {
        if (closed || stopped) return;
        const id = domSession(document2);
        if (id !== previous) {
          previous = id;
          listener(id);
        }
      };
      const observer = observeDom(document2, publish, () => {
        if (previous && !closed && !stopped) {
          previous = null;
          listener(null);
        }
      }, () => previous);
      const dispose = () => {
        if (stopped) return;
        stopped = true;
        observer.disconnect();
        subscriptions.delete(dispose);
      };
      subscriptions.add(dispose);
      publish();
      return dispose;
    },
    subscribeEvidence: (listener) => source.subscribeEvidence(listener),
    subscribeActivity: (listener, diagnose) => source.subscribeActivity(listener, diagnose),
    async open(sessionId, location, guard) {
      alive();
      if (!/^diff-view:[0-9a-f-]{36}$/i.test(location)) denied("SIDEBAR_TARGET", "\u65E0\u6548\u7684\u63D2\u4EF6\u5B9A\u4F4D\u4EE4\u724C / Invalid selection token");
      if (opening) denied("SIDEBAR_BUSY", "\u6B63\u5728\u6253\u5F00\u5BA1\u67E5\u9875\u7B7E\uFF0C\u8BF7\u52FF\u91CD\u590D\u70B9\u51FB");
      const check = () => checkSession(sessionId, guard);
      check();
      opening = true;
      try {
        const navigation = options.navigation ?? denied("SIDEBAR_CHANNEL", "\u5BA1\u67E5\u5BFC\u822A\u6865\u63A5\u4E0D\u53EF\u7528 / Review navigation unavailable");
        const [ticket] = await Promise.all([navigation.prepare(sessionId, location, check), reveal(sessionId, guard)]);
        check();
        await navigation.confirm(ticket, check);
        check();
      } finally {
        opening = false;
      }
    },
    close() {
      closed = true;
      for (const dispose of [...subscriptions]) dispose();
      source.close();
    }
  };
}

// src/renderer/RunningChangePill.tsx
import React3, { useEffect as useEffect2, useLayoutEffect as useLayoutEffect2, useRef as useRef2, useState as useState2 } from "react";
import { createPortal } from "react-dom";

// src/renderer/running-changes.ts
var caches = /* @__PURE__ */ new WeakMap();
var taskKey = (task) => JSON.stringify([task.sessionId, task.taskId, task.since, task.turnId ?? null]);
function createRunningChangesController(transport, adapter, publish, report2 = () => {
}) {
  const cache = caches.get(transport) ?? /* @__PURE__ */ new Map();
  caches.set(transport, cache);
  let activity = null, epoch = 0, disposed = false;
  let timer;
  let view = { summary: null, busy: false, error: "" };
  let lastDiagnostic = "";
  const diagnose = (stage) => {
    if (stage !== lastDiagnostic) {
      lastDiagnostic = stage;
      report2(stage);
    }
  };
  const emit = (next) => {
    view = next;
    if (!disposed) publish(view);
  };
  const valid = (version) => !disposed && epoch === version && activity !== null;
  const matches = (result, task) => result !== null && result.sessionId === task.sessionId && result.startedAt >= task.since && result.fileCount > 0;
  const remember2 = (task, summary) => {
    const key = taskKey(task);
    cache.delete(key);
    if (summary) cache.set(key, summary);
    while (cache.size > 32) cache.delete(cache.keys().next().value);
  };
  async function poll(version, task) {
    try {
      const result = await transport.invoke("runningChanges", { sessionId: task.sessionId, since: task.since, taskId: task.taskId });
      if (!valid(version)) return;
      const summary = matches(result, task) ? result : null;
      remember2(task, summary);
      diagnose(summary ? "running-visible" : "running-query-empty");
      emit({ ...view, summary, error: "" });
    } catch {
      if (valid(version)) {
        diagnose("running-query-error");
        emit({ ...view, error: "" });
      }
    } finally {
      if (valid(version)) timer = setTimeout(() => {
        timer = void 0;
        void poll(version, task);
      }, 1e3);
    }
  }
  return {
    setActivity(next) {
      if (disposed) return;
      activity = next;
      const version = ++epoch;
      if (timer) clearTimeout(timer);
      timer = void 0;
      const summary = next ? cache.get(taskKey(next)) ?? null : null;
      emit({ summary, busy: false, error: "" });
      diagnose(next ? next.since > 0 ? "running-ready" : "running-identity-missing" : "running-idle");
      if (next) void poll(version, next);
    },
    async open() {
      const sessionId = activity?.sessionId, version = epoch;
      if (!sessionId || view.busy || disposed) return;
      const guard = () => {
        if (!valid(version)) throw new Error("\u4F1A\u8BDD\u6216\u4EFB\u52A1\u5DF2\u5207\u6362 / Session or task changed");
      };
      emit({ ...view, busy: true, error: "" });
      try {
        await adapter.reveal?.(sessionId, guard);
        guard();
        const selection = await transport.invoke("selectTurn", { scope: "lastTurn", sessionId });
        guard();
        await adapter.open(sessionId, `diff-view:${selection.nonce}`, guard);
        guard();
      } catch (error) {
        if (valid(version)) {
          diagnose("running-click-error");
          emit({ ...view, error: String(error.message ?? error) });
        }
      } finally {
        if (valid(version)) emit({ ...view, busy: false });
      }
    },
    dispose() {
      disposed = true;
      epoch++;
      if (timer) clearTimeout(timer);
      timer = void 0;
      activity = null;
      view = { summary: null, busy: false, error: "" };
    }
  };
}

// src/renderer/floating-layer.ts
function openFloatingLayer(ui, document2) {
  if (typeof ui.openLayer === "function") return ui.openLayer();
  const element = document2.createElement("div");
  element.dataset.piPlugin = "local.diff-view";
  element.dataset.diffViewLayer = "compat";
  Object.assign(element.style, { position: "fixed", top: "0", left: "0", width: "0", height: "0" });
  document2.body.append(element);
  return { element, close: () => element.remove() };
}

// src/renderer/RunningChangePill.tsx
var anchors = /* @__PURE__ */ new Set();
var hidden = { left: 0, top: 0, width: 0, visible: false };
function RunningChangePill({ transport, adapter, ui, report: report2 }) {
  const anchor = useRef2(null);
  const controller = useRef2();
  const [view, setView] = useState2({ summary: null, busy: false, error: "" });
  const [position, setPosition] = useState2(hidden);
  const [layer, setLayer] = useState2(null);
  const [layerError, setLayerError] = useState2("");
  useEffect2(() => {
    let live = true, unsubscribe, retry;
    const current = createRunningChangesController(transport, adapter, (next) => {
      if (live) setView(next);
    }, report2);
    controller.current = current;
    report2("composer-mounted");
    const subscribe = () => void adapter.subscribeActivity((activity) => {
      if (live) current.setActivity(activity);
    }, report2).then((dispose) => {
      if (live) unsubscribe = dispose;
      else dispose();
    }).catch(() => {
      if (live) {
        current.setActivity(null);
        report2("composer-source-error");
        retry = setTimeout(subscribe, 2e3);
      }
    });
    subscribe();
    return () => {
      live = false;
      if (retry) clearTimeout(retry);
      current.dispose();
      unsubscribe?.();
      controller.current = void 0;
    };
  }, [transport, adapter, report2]);
  useLayoutEffect2(() => {
    const owner = anchor.current;
    if (!view.summary || !owner) {
      setPosition(hidden);
      return;
    }
    anchors.add(owner);
    let frame = 0, lastStage = "";
    const rectOf = (node) => {
      const shell = node.closest(".composer-shell"), rect = shell?.getBoundingClientRect();
      return shell?.isConnected && shell.getClientRects().length && rect && rect.width > 80 && rect.top > 48 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth ? rect : null;
    };
    const update = () => {
      const shell = owner.closest(".composer-shell"), rect = rectOf(owner);
      const first = [...anchors].find((node) => rectOf(node));
      const visible2 = Boolean(rect && first === owner);
      const stack = shell?.closest(".composer-stack");
      const dock = stack?.querySelector(".todo-dock");
      const dockRect = dock?.getBoundingClientRect();
      const dockStyle = dock && getComputedStyle(dock);
      const dockVisible = dock && dock.getClientRects().length > 0 && dockRect && dockRect.height > 0 && dockRect.width > 0 && dockStyle?.visibility !== "hidden" && dockStyle?.display !== "none" && dockStyle?.opacity !== "0" && rect && dockRect.right > rect.left && dockRect.left < rect.right && dockRect.top < rect.top && dockRect.bottom > 0;
      const ceiling = dockVisible ? Math.min(rect.top, dockRect.top) : rect?.top ?? 0;
      const stage = !shell ? "composer-anchor-missing" : !rect ? "composer-anchor-offscreen" : "composer-positioned";
      if (stage !== lastStage) {
        lastStage = stage;
        report2(stage);
      }
      const next = visible2 && rect && ceiling > 48 ? { left: rect.left + rect.width / 2, top: ceiling - 8, width: Math.min(rect.width - 16, window.innerWidth - 24), visible: visible2 } : hidden;
      setPosition((previous) => previous.visible === next.visible && previous.left === next.left && previous.top === next.top && previous.width === next.width ? previous : next);
      frame = requestAnimationFrame(update);
    };
    update();
    return () => {
      cancelAnimationFrame(frame);
      anchors.delete(owner);
    };
  }, [view.summary?.runId, report2]);
  const visible = !!view.summary && position.visible;
  useLayoutEffect2(() => {
    setLayer(null);
    setLayerError("");
    if (!visible) return;
    let current;
    try {
      current = openFloatingLayer(ui, document);
    } catch (error) {
      setLayerError(error instanceof Error ? error.message : String(error));
      report2("composer-layer-error");
      return;
    }
    setLayer(current);
    return () => current.close();
  }, [visible, ui, report2]);
  const summary = view.summary, zh = summary?.locale.startsWith("zh");
  const unknown = summary?.unknownFileCount ?? 0, allUnknown = !!summary && unknown >= summary.fileCount;
  return /* @__PURE__ */ React3.createElement(React3.Fragment, null, /* @__PURE__ */ React3.createElement("span", { ref: anchor, className: "dv-running-anchor", "aria-hidden": "true" }), layerError && /* @__PURE__ */ React3.createElement("span", { className: "dv-running-error", role: "alert" }, layerError), summary && visible && layer && createPortal(/* @__PURE__ */ React3.createElement("div", { className: "dv-running-float", "data-base": summary.base, style: { left: position.left, top: position.top, maxWidth: position.width } }, /* @__PURE__ */ React3.createElement("button", { type: "button", className: "dv-running-pill", disabled: view.busy, "aria-busy": view.busy, title: zh ? "\u67E5\u770B\u672C\u4F1A\u8BDD\u6700\u8FD1\u8F6E\u6B21\u7684\u53D8\u66F4\uFF1B\u4EC5\u7EDF\u8BA1\u53EF\u9A8C\u8BC1\u6587\u672C" : "Review the latest turn in this session; verified text counts only", onClick: () => void controller.current?.open() }, /* @__PURE__ */ React3.createElement("span", { className: "dv-running-label" }, zh ? `${summary.fileCount} \u4E2A\u6587\u4EF6\u5DF2\u66F4\u6539` : `${summary.fileCount} ${summary.fileCount === 1 ? "file" : "files"} changed`), !allUnknown && /* @__PURE__ */ React3.createElement(React3.Fragment, null, /* @__PURE__ */ React3.createElement("span", { className: "dv-running-add" }, "+", summary.additions), /* @__PURE__ */ React3.createElement("span", { className: "dv-running-del" }, "-", summary.deletions)), unknown > 0 && /* @__PURE__ */ React3.createElement("span", { className: "dv-running-unknown" }, zh ? allUnknown ? "\u884C\u6570\u672A\u77E5" : "\u90E8\u5206\u7EDF\u8BA1" : allUnknown ? "Unknown lines" : "Partial totals")), view.error && /* @__PURE__ */ React3.createElement("p", { className: "dv-running-error", role: "alert" }, view.error)), layer.element));
}
var runningPillStyle = `
.dv-running-anchor{display:none!important}
.dv-running-float{position:fixed;z-index:20;transform:translate(-50%,-100%);font:13px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;--rp-add:var(--ds-success,#008339);--rp-del:var(--ds-error,#c52b2b);--rp-bg:var(--ds-bg-elevated-opaque,#fafafa);--rp-ink:var(--ds-text-muted,var(--ds-text-secondary,#686b6e));--rp-border:var(--ds-border-default,var(--ds-border-subtle,#e6e6e6))}
.dv-running-float[data-base=dark]{--rp-add:var(--ds-success,#40c977);--rp-del:var(--ds-error,#ff6764);--rp-bg:var(--ds-bg-elevated-opaque,#212121);--rp-ink:var(--ds-text-muted,var(--ds-text-secondary,#b5b5b5));--rp-border:var(--ds-border-default,var(--ds-border-subtle,#3a3a3a))}
.dv-running-pill{box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:4px;max-width:100%;min-height:34px;padding:7px 12px;border:1px solid var(--rp-border);border-radius:var(--dv-radius-pill,20px);background:var(--rp-bg);color:var(--rp-ink);font:inherit;cursor:pointer;white-space:nowrap;font-variant-numeric:tabular-nums;box-shadow:var(--dv-popup-shadow,0 2px 8px rgb(0 0 0 / .06))}
.dv-running-label{overflow:hidden;text-overflow:ellipsis;min-width:0}.dv-running-add,.dv-running-del,.dv-running-unknown{flex:none;font-size:12px}.dv-running-add{color:var(--rp-add)}.dv-running-del{color:var(--rp-del)}
.dv-running-pill:hover:not(:disabled){background:var(--ds-bg-hover,color-mix(in srgb,var(--rp-ink) 7%,var(--rp-bg)))}.dv-running-pill:focus-visible{outline:2px solid var(--ds-focus,var(--rp-ink));outline-offset:2px}.dv-running-pill:disabled{cursor:wait;opacity:.5}
.dv-running-error{margin:6px 0 0;padding:10px 12px;border:1px solid var(--rp-border,var(--ds-border-default,#e6e6e6));border-left:3px solid var(--rp-del,var(--ds-error,#c52b2b));border-radius:var(--dv-radius-surface,12px);background:var(--rp-bg,var(--ds-bg-elevated-opaque,#fafafa));color:var(--rp-del,var(--ds-error,#c52b2b));font-size:12px;line-height:1.6;overflow-wrap:anywhere;white-space:normal}
@media(max-width:420px){.dv-running-pill{font-size:13px;padding:7px 10px}}
`;

// src/renderer/json-cache.ts
var JsonCache = class extends Map {
  encoded = /* @__PURE__ */ new Map();
  byteSize = 0;
  set(key, value) {
    const json = JSON.stringify(value), previous = this.encoded.get(key);
    const stable = previous?.json === json ? this.get(key) : value;
    const bytes = previous?.json === json ? previous.bytes : new TextEncoder().encode(json).length;
    this.byteSize += bytes - (previous?.bytes ?? 0);
    super.delete(key);
    super.set(key, stable);
    this.encoded.set(key, { json, bytes });
    return this;
  }
  delete(key) {
    this.byteSize -= this.encoded.get(key)?.bytes ?? 0;
    this.encoded.delete(key);
    return super.delete(key);
  }
  clear() {
    super.clear();
    this.encoded.clear();
    this.byteSize = 0;
  }
};

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
  if (!same(current)) return;
  const dynamic = stage.startsWith("running-") || stage.startsWith("composer-");
  if (!dynamic && current.reported.has(stage)) return;
  current.reported.add(stage);
  void current.transport.invoke("rendererReport", { stage }).catch(() => {
  });
}
function trackSession(current) {
  const publisher = current.sessionPublisher ??= createSessionContextPublisher({
    transport: current.transport,
    isCurrent: () => same(current),
    wake: () => wake(current),
    report: () => report(current, "session-source-error")
  });
  return current.sessionReady ??= current.adapter.subscribeSession((sessionId, context) => {
    if (!same(current)) return;
    if (current.activeSession !== sessionId) {
      current.activeSession = sessionId;
      current.sessionVersion++;
      current.evidenceContext = void 0;
    }
    current.surface?.update(sessionId);
    publisher.update(sessionId, context ?? (current.evidenceContext?.sessionId === sessionId ? current.evidenceContext : void 0));
    void current.transport.invoke("activeReviewSession", { sessionId }).catch(() => {
    });
  }).then((dispose) => {
    if (same(current)) {
      current.unsubscribeSession = dispose;
      report(current, "session-ready");
    } else dispose();
  }).catch((error) => {
    if (same(current)) {
      current.sessionReady = void 0;
      report(current, "session-source-error");
      if (!current.sessionRetry) current.sessionRetry = setTimeout(() => {
        current.sessionRetry = void 0;
        if (same(current)) void trackSession(current).catch(() => {
        });
      }, 2e3);
    }
    throw error;
  });
}
function trackEvidence(current) {
  if (!current.adapter.subscribeEvidence || current.evidenceReady) return;
  current.evidenceReady = current.adapter.subscribeEvidence((_sessionId, context) => {
    if (!same(current)) return;
    current.evidenceContext = context;
    if (context && context.sessionId === current.activeSession) current.sessionPublisher?.update(context.sessionId, context);
  }).then((dispose) => {
    if (same(current)) current.unsubscribeEvidence = dispose;
    else dispose();
  }).catch(() => {
    if (!same(current)) return;
    current.evidenceReady = void 0;
    report(current, "session-source-error");
    current.evidenceRetry = setTimeout(() => {
      current.evidenceRetry = void 0;
      if (same(current)) trackEvidence(current);
    }, 2e3);
  });
}
function remember(current, card) {
  const key = cardKey(card.run.sessionId, card.messageId);
  current.cache.set(key, card);
  card = current.cache.get(key);
  for (const oldKey of current.cache.keys()) {
    if (current.cache.size <= 200 && current.cache.byteSize <= 4 * 1024 * 1024) break;
    if (current.cards.has(oldKey)) continue;
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
    const restored = [];
    const accept = (cards) => {
      for (const card of cards) if (card.run.sessionId !== sessionId || card.summary.sessionId !== sessionId || card.summary.runId !== card.run.id) throw new Error("Invalid recorded card identity");
      for (const card of cards) {
        restored.push(card);
        remember(current, card);
      }
    };
    accept(first.cards);
    let offset = first.nextOffset;
    while (offset !== null) {
      const page = await current.transport.invoke("replyCards", { sessionId, offset });
      if (!same(current)) return feed;
      if (page.revision !== first.revision || page.nextOffset !== null && page.nextOffset <= offset) throw new Error("Card history changed during paging; refresh required");
      accept(page.cards);
      offset = page.nextOffset;
    }
    const keys = new Set(restored.map((card) => cardKey(sessionId, card.messageId)));
    for (const [key, card] of current.cache) if (card.run.sessionId === sessionId && !keys.has(key)) {
      current.cache.delete(key);
      current.cards.get(key)?.listeners.forEach((listener) => listener(null));
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
    const sessions = [.../* @__PURE__ */ new Set([...current.activeSession ? [current.activeSession] : [], ...[...current.cards.values()].map((item) => item.props.sessionId)])];
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
    if (same(current) && (current.activeSession || current.cards.size)) wake(current, current.wakeAgain ? 0 : 2e3);
  }
}
function EntryExtra(props) {
  const current = hub, key = cardKey(props.sessionId, props.messageId);
  const [value, setValue] = useState3(() => ({ key, card: current?.cache.get(key) ?? null }));
  const [, redraw] = useState3(0);
  const contentKey = props.message?.content;
  useEffect3(() => {
    if (!same(current)) return;
    const listener = () => redraw((count) => count + 1);
    current.listeners.add(listener);
    return () => {
      current.listeners.delete(listener);
    };
  }, [current]);
  useEffect3(() => {
    if (!same(current) || !props.sessionId || !props.messageId || props.message?.parentToolCallId || props.message?.meta?.parentMessageId || props.message?.role && props.message.role !== "assistant") return;
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
      if (!current.activeSession && !current.cards.size && current.timer) {
        clearTimeout(current.timer);
        current.timer = void 0;
      }
    };
  }, [current, key, contentKey, props.message?.createdAt, props.message?.parentToolCallId, props.message?.meta?.parentMessageId]);
  const card = value.key === key ? value.card : current?.cache.get(key);
  if (!card || !same(current) || props.message?.parentToolCallId || props.message?.meta?.parentMessageId) return null;
  const run = card.run;
  return /* @__PURE__ */ React4.createElement(TurnChangeSummary, { run, initialSummary: card.summary, transport: current.transport, locale: current.appearance.locale, base: current.appearance.base, onOpen: async (file) => {
    await trackSession(current);
    const version = current.sessionVersion;
    const guard = () => {
      if (!same(current) || current.activeSession !== run.sessionId || current.sessionVersion !== version) throw new Error("\u4F1A\u8BDD\u5DF2\u5207\u6362\uFF0C\u8BF7\u5728\u5F53\u524D\u4F1A\u8BDD\u70B9\u51FB / Session changed");
    };
    guard();
    await current.adapter.reveal?.(run.sessionId, guard);
    guard();
    const selection = await current.transport.invoke("selectTurn", { sessionId: run.sessionId, runId: run.id, fileId: file?.id });
    guard();
    await current.adapter.open(run.sessionId, `diff-view:${selection.nonce}`, guard);
    guard();
    report(current, "sidebar-opened");
  } });
}
function composerReport(stage) {
  if (hub) report(hub, stage);
}
function ComposerControl() {
  const current = hub;
  return same(current) ? /* @__PURE__ */ React4.createElement(RunningChangePill, { transport: current.transport, adapter: current.adapter, ui: current.ui, report: composerReport }) : null;
}
function onLoad(pi, options = {}) {
  realm2.__piDiffRenderer?.dispose();
  onUnload();
  const transport = ensureBounded({ invoke(method, args) {
    if (!same(current)) return Promise.reject(new Error("Renderer unloaded / \u6E32\u67D3\u6269\u5C55\u5DF2\u5378\u8F7D\u3002"));
    return pi.dispatch("plugin.call", { method, args });
  } });
  const surface = options.adapter ? void 0 : createReviewSurfaceClient(transport);
  const current = { transport, surface, ui: pi.ui, disposed: false, pumping: false, wakeAgain: false, appearance: { locale: "zh-CN", base: "light" }, listeners: /* @__PURE__ */ new Set(), cards: /* @__PURE__ */ new Map(), cache: new JsonCache(), feeds: /* @__PURE__ */ new Map(), sessionVersion: 0, reported: /* @__PURE__ */ new Set(), adapter: options.adapter ?? createPluginReviewAdapter({ read: (sessionId) => transport.invoke("sessionState", { sessionId }), navigation: surface.channel }) };
  hub = current;
  realm2.__piDiffRenderer = { hub: current, dispose: onUnload };
  disposers.push(pi.ui.injectStyle(summary_style_default + runningPillStyle));
  disposers.push(pi.slots.register({ slot: "entryExtra", component: EntryExtra }));
  disposers.push(pi.slots.register({ slot: "composerControl", positions: ["left"], component: ComposerControl }));
  void trackSession(current).catch(() => {
  });
  trackEvidence(current);
  report(current, "entry-loaded");
  wake(current);
}
function onUnload() {
  const current = hub;
  if (current) {
    current.surface?.dispose();
    if (current.evidenceRetry) clearTimeout(current.evidenceRetry);
    current.unsubscribeEvidence?.();
  }
  if (current) {
    current.sessionPublisher?.dispose();
    current.disposed = true;
    if (current.timer) clearTimeout(current.timer);
    if (current.sessionRetry) clearTimeout(current.sessionRetry);
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
