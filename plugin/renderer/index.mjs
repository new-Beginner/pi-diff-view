// src/core/review-file-policy.ts
var IMAGE_EXTENSIONS = /* @__PURE__ */ new Set([
  "png",
  "apng",
  "jpg",
  "jpeg",
  "jfif",
  "pjpeg",
  "pjp",
  "gif",
  "webp",
  "bmp",
  "dib",
  "ico",
  "cur",
  "icns",
  "tif",
  "tiff",
  "avif",
  "avifs",
  "heic",
  "heif",
  "heics",
  "heifs",
  "svg",
  "svgz",
  "jxl",
  "psd",
  "raw",
  "dng",
  "cr2",
  "cr3",
  "nef",
  "nrw",
  "arw",
  "orf",
  "raf",
  "rw2",
  "pef",
  "srw",
  "x3f",
  "tga",
  "qoi",
  "exr",
  "hdr",
  "jp2",
  "j2k",
  "jpf",
  "jpx",
  "jpm",
  "mj2",
  "wmf",
  "emf"
]);
function isImagePath(filePath) {
  const basename = filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1);
  const dot = basename.lastIndexOf(".");
  return dot > 0 && dot < basename.length - 1 && IMAGE_EXTENSIONS.has(basename.slice(dot + 1).toLowerCase());
}

// src/core/public-path.ts
function deny(code, message) {
  throw Object.assign(new Error(message), { code });
}
function assertPathSyntax(value) {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\0\r\n]/.test(value)) deny("INVALID_PATH", "Invalid file path");
  const portable = value.replace(/\\/g, "/");
  if (portable.split("/").includes("..")) deny("PATH_DENIED", "Traversal paths cannot be captured");
  if (portable.startsWith("//") || portable.startsWith("/??/") || /^[a-z]:[^/]/i.test(portable) || portable.replace(/^[a-z]:\//i, "").includes(":")) deny("PATH_DENIED", "UNC, device, drive-relative and alternate-stream paths are not reviewable");
}
function assertPublicPath(value) {
  assertPathSyntax(value);
  const portable = value.replace(/\\/g, "/"), parts = portable.split("/");
  for (const [index, part] of parts.entries()) {
    const s = part.toLowerCase();
    if ([".pi-desktoooop", ".pi-desktop"].includes(s) && /^(?:[a-z]:\/|\/[^/])/i.test(portable) && parts[index + 1]?.toLowerCase() === "data" && parts[index + 2]?.toLowerCase() === "scratch" && /^[a-zA-Z0-9-]{1,80}$/.test(parts[index + 3] ?? "")) continue;
    if (s === ".." || /[. ]$/.test(s) && s !== "." || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/.test(s) || [".git", ".ssh", ".aws", ".gnupg", ".gpg", ".npmrc", ".git-credentials", ".netrc", "_netrc", ".pi", ".claude", ".codex", ".pi-desktoooop", ".pi-desktop", ".pi-diff-view", "node_modules"].includes(s) || s.startsWith(".env") || /^id_(rsa|dsa|ecdsa|ed25519)/.test(s) || /\.(pem|key|p12|pfx|keystore|jks)$/.test(s)) deny("PATH_DENIED", "Credential, dependency, internal or escaping paths are not reviewable");
  }
}

// src/core/host-transcript.ts
function hostEvidenceMessages(messages) {
  return messages.flatMap((value) => {
    if (!value || typeof value.id !== "string" || typeof value.role !== "string") return [];
    const meta = { status: value.status ?? value.meta?.status, parentMessageId: value.parentToolCallId ?? value.meta?.parentMessageId, userMessageId: value.meta?.userMessageId, steering: value.steering ?? value.meta?.steering };
    const blocks = [];
    if (value.role === "assistant" && (typeof value.content === "string" && value.content.trim() || value.blocks?.some((b) => b.type === "text"))) blocks.push({ type: "text" });
    const candidates = value.toolCallId ? [{ type: "tool_call", callId: value.toolCallId, name: value.toolName, args: value.toolArgs, status: value.toolStatus, result: value.toolResult, isError: value.isError }] : value.blocks ?? [];
    for (const b of candidates) {
      if (b.type !== "tool_call" || typeof b.callId !== "string") continue;
      const name = String(b.name).split(".").pop().toLowerCase();
      const args = b.args ?? {}, result = b.result ?? {}, review = result.details?.review;
      if (isImagePath(String(review?.path ?? args.path ?? args.file_path ?? ""))) continue;
      try {
        if (args.path !== void 0 || args.file_path !== void 0) assertPublicPath(args.path ?? args.file_path);
        if (review?.path !== void 0) assertPublicPath(review.path);
        if (review?.oldPath !== void 0) assertPublicPath(review.oldPath);
        if (name === "edit" && typeof args.ops === "string") {
          for (const line of args.ops.split("\n")) if (line.startsWith("MV ")) assertPublicPath(line.slice(3).trim());
        }
      } catch {
        continue;
      }
      const safeReview = review && typeof review === "object" ? Object.fromEntries(["version", "sessionId", "messageId", "path", "oldPath", "operation", "status", "state", "beforeExists", "afterExists", "beforeHash", "afterHash", "hunks"].filter((key) => review[key] !== void 0).map((key) => [key, review[key]])) : void 0;
      const editArgs = name === "edit" ? Object.fromEntries(["ops", "old_string", "new_string"].filter((key) => typeof args[key] === "string").map((key) => [key, args[key]])) : {};
      blocks.push({ type: "tool_call", callId: b.callId, name, status: b.status, args: ["write", "edit"].includes(name) ? { path: args.path ?? args.file_path, ...editArgs, ...name === "write" && typeof args.content === "string" ? { content: args.content } : {} } : {}, result: { isError: b.isError ?? result.isError, ...safeReview ? { details: { review: safeReview } } : {} } });
    }
    return [{ type: "message", id: value.id, role: value.role, createdAt: value.createdAt, meta, blocks }];
  });
}
function transcriptEvidence(messages) {
  return JSON.stringify(hostEvidenceMessages(messages));
}
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
function evidenceRevision(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}-${hash >>> 0}`;
}

// src/renderer/index.tsx
import React5, { useEffect as useEffect3, useState as useState3 } from "react";

// src/view/transport.ts
var realm = globalThis;
var queue = realm.__piDiffBurstQueue ??= { tail: Promise.resolve(), starts: [] };
var background = /* @__PURE__ */ new Set(["sessionEvidence", "gitManage", "sessionContext", "bootstrap", "review", "action", "batchAction", "copyPatch", "clearHistory", "turnSummary", "runningChanges", "selectTurn", "card", "replyCards"]);
function boundedTransport(invoke) {
  const wire = (method, args) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ method, args })).length;
    if (bytes > 48 * 1024) return Promise.reject(new Error("Request exceeds the bridge payload limit (48 KiB)."));
    if (method === "saveComment" && bytes > 24e3) return Promise.reject(new Error("Comment payload too large; shorten the comment or excerpt."));
    const navigation = method === "openFile";
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
    const request = admission.then(async () => {
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
    if (!navigation) queue.tail = request;
    return request;
  };
  return { async invoke(method, args) {
    if (!background.has(method)) return wire(method, args);
    const started = await wire("jobStart", { method, args, waitMs: 40 });
    if (started.state === "done") return started.result;
    if (started.state === "error") throw Object.assign(new Error(started.error?.message ?? "Review failed"), { code: started.error?.code });
    const deadline = Date.now() + 12e4;
    let delay = 40;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      const job = await wire("jobPoll", { jobId: started.jobId });
      if (job.state === "done") return job.result;
      if (job.state === "error") throw Object.assign(new Error(job.error?.message ?? "Review failed"), { code: job.error?.code });
      delay = Math.min(300, delay * 2);
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
import React2, { useEffect, useLayoutEffect, useRef, useState } from "react";

// src/view/FilePath.tsx
import React from "react";
function FilePath({ path }) {
  const split = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
  return /* @__PURE__ */ React.createElement(React.Fragment, null, /* @__PURE__ */ React.createElement("span", { className: "dv-path-directory" }, path.slice(0, split)), /* @__PURE__ */ React.createElement("span", { className: "dv-path-basename" }, path.slice(split)));
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
.dv-turn-layout{display:flow-root;max-width:100%}.dv-turn-overflow{height:0;pointer-events:none}.dv-turn-directory{max-height:none;overflow:visible}.dv-turn-card[data-host-fold=collapsed] .dv-turn-directory{overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain}.dv-turn-directory:focus-visible{outline:2px solid var(--ds-focus,currentColor);outline-offset:-2px}
.dv-turn-card{--tc-ink:var(--ds-text-primary,inherit);--tc-muted:color-mix(in srgb,currentColor 62%,transparent);--tc-border:color-mix(in srgb,currentColor 8%,transparent);--tc-hover:var(--ds-bg-hover,color-mix(in srgb,currentColor 4%,transparent));--tc-add:var(--ds-success,#008f39);--tc-del:var(--ds-error,#d63232);color:var(--tc-ink);background:transparent;border:1px solid var(--tc-border);border-radius:12px;margin:12px 0 4px;font-family:inherit;font-size:14px;line-height:1.45;text-align:left;overflow:clip;max-width:100%;}
.dv-turn-card[data-base=dark]{--tc-add:var(--ds-success,#40c977);--tc-del:var(--ds-error,#ff6764)}
.dv-turn-card *{box-sizing:border-box}.dv-turn-card button{font:inherit;color:inherit;background:transparent;border:0;cursor:pointer}.dv-turn-card button:hover:not(:disabled){background:var(--tc-hover)}.dv-turn-card button:focus-visible{outline:2px solid var(--ds-focus,currentColor);outline-offset:-3px}.dv-turn-card button:disabled{opacity:.55;cursor:wait}
.dv-turn-head{display:flex;align-items:center;gap:12px;padding:12px 14px}.dv-turn-icon{display:grid;place-items:center;flex:0 0 42px;width:42px;height:42px;border-radius:10px;color:var(--tc-muted);background:color-mix(in srgb,currentColor 4%,transparent)}.dv-turn-label{display:flex;flex-direction:column;align-items:flex-start;gap:2px;flex:1;min-width:0}.dv-turn-label strong{font-size:14px;font-weight:600}.dv-turn-counts{display:inline-flex;gap:5px;white-space:nowrap;font-size:12px;font-variant-numeric:tabular-nums}.dv-turn-add{color:var(--tc-add)}.dv-turn-del{color:var(--tc-del)}.dv-turn-card .dv-turn-open{border:1px solid var(--tc-border);border-radius:10px;padding:4px 10px;white-space:nowrap;font-size:13px}
.dv-turn-files{border-top:1px solid var(--tc-border);padding:2px 0}.dv-turn-card .dv-turn-file{display:flex;align-items:center;gap:12px;width:100%;padding:8px 12px;text-align:left;min-height:38px}.dv-turn-path{flex:1;min-width:0;overflow-wrap:anywhere;color:var(--tc-ink)}.dv-turn-card .dv-path-directory{color:var(--tc-muted)}.dv-turn-card .dv-path-basename{color:var(--tc-ink)}.dv-turn-path small{font-size:11px;margin-left:8px;display:inline-block;color:var(--tc-muted)}.dv-turn-foot{padding:0 6px 5px;display:flex;gap:8px}.dv-turn-foot button{padding:6px}.dv-turn-error{margin:0;padding:8px 12px;border-top:1px solid var(--tc-border);font-size:12px;overflow-wrap:anywhere;color:var(--tc-del)}
.dv-turn-card .dv-turn-file{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:14px;padding:9px 14px}.dv-turn-unknown{color:var(--tc-muted);font-size:11px;white-space:nowrap}.dv-turn-stats-note{border-top:1px solid var(--tc-border);padding:8px 14px;color:var(--tc-muted);font-size:12px}.dv-turn-stats-note summary{cursor:pointer;width:fit-content}.dv-turn-stats-note p{margin:6px 0 0;max-width:60ch;line-height:1.6}.dv-turn-foot{border-top:1px solid var(--tc-border);padding:3px 8px}.dv-turn-foot button{font-size:12px;color:var(--tc-muted)}
/* The header is a normal-flow sibling, never part of the directory scroll container. */
.dv-turn-card .dv-turn-head{position:static;border-radius:12px 12px 0 0;background:var(--ds-bg-elevated-opaque,#fafafa);box-shadow:0 1px var(--tc-border)}
.dv-turn-card[data-base=dark] .dv-turn-head{background:var(--ds-bg-elevated-opaque,#212121)}
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
function activityDiagnostic(state) {
  const id = state.activeSessionId;
  if (!id || state.selectingSessionId || state.page !== "chat" || (state.runningSessions?.[id] ?? state.isRunning) !== true) return "running-idle";
  return (runningActivity(state)?.since ?? 0) > 0 ? "running-ready" : "running-identity-missing";
}
function runningActivity(state) {
  const sessionId = state.activeSessionId;
  if (!sessionId || state.selectingSessionId || state.page !== "chat" || (state.runningSessions?.[sessionId] ?? state.isRunning) !== true) return null;
  const sources = [state.messages ?? [], state.retainedTranscripts?.[sessionId] ?? []].map((messages) => messages.filter((message) => message.role === "user" && !message.steering && !message.parentToolCallId));
  const users = sources.flat();
  const time = (message) => {
    const value = typeof message.createdAt === "number" ? message.createdAt : Date.parse(message.createdAt ?? "");
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  };
  const turnId = state.agentStatuses?.[sessionId]?.currentTurnId;
  const unavailable = () => turnId ? { sessionId, taskId: `turn:${turnId}`, since: 0, turnId } : null;
  for (const source of sources) {
    const last = source.at(-1);
    if (last && (!last.id || !time(last)) && !users.some((other) => other.id === last.id && time(other) > 0)) return unavailable();
  }
  users.sort((a, b) => time(b) - time(a));
  const user = users[0], since = user ? time(user) : 0;
  if (!user?.id || since <= 0 || since > Date.now()) return unavailable();
  if (users.some((other) => time(other) === since && other.id !== user.id)) return null;
  return { sessionId, taskId: user.id, since, turnId };
}
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
        const activity = runningActivity(state);
        const context = sessionId ? { sessionId, root: state.sessions?.find((s) => s.id === sessionId)?.projectPath, running: (state.runningSessions?.[sessionId] ?? state.isRunning) === true, taskId: activity?.taskId, since: activity?.since, turnId: activity?.turnId } : void 0;
        if (context) {
          const rows = new Map((state.retainedTranscripts?.[sessionId] ?? []).map((m) => [m.id, m]));
          for (const m of state.messages ?? []) rows.set(m.id, m);
          context.evidence = transcriptEvidence([...rows.values()]);
          context.evidenceRevision = evidenceRevision(context.evidence);
        }
        const key = JSON.stringify([sessionId, context && { ...context, evidence: void 0 }]);
        if (key !== previous) {
          previous = key;
          listener(sessionId, context);
        }
        const tab = state.workPanelTabs?.find((t) => t.id === REVIEW_TAB_ID);
        if (sessionId && tab && state.workPanelOpen && state.activeWorkPanelTabId === REVIEW_TAB_ID) {
          const suffix = `?sessionId=${encodeURIComponent(sessionId)}`;
          if (!tab.location?.endsWith(suffix)) state.openWorkPanelTabForSession(sessionId, { ...tab, location: `diff-session:${encodeURIComponent(sessionId)}${suffix}` });
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
    async subscribeActivity(listener, diagnose) {
      const modules = await inspect();
      alive();
      if (typeof modules.store.subscribe !== "function") return denied("SIDEBAR_CONTRACT", "Host activity subscription unavailable");
      let previous, stopped = false;
      const publish = (state) => {
        if (closed || stopped) return;
        const activity = runningActivity(state), key = JSON.stringify(activity);
        if (key !== previous) {
          previous = key;
          diagnose?.(activityDiagnostic(state));
          listener(activity);
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
    async open(sessionId, location, guard) {
      if (!/^diff-view:[0-9a-f-]{36}$/i.test(location)) denied("SIDEBAR_TARGET", "\u65E0\u6548\u7684\u63D2\u4EF6\u5B9A\u4F4D\u4EE4\u724C / Invalid selection token");
      location = `${location}?sessionId=${encodeURIComponent(sessionId)}`;
      const modules = await inspect();
      alive();
      guard?.();
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
    async openFile(sessionId, path, guard) {
      if (typeof path !== "string" || !path || /[\0\r\n]/.test(path)) denied("SIDEBAR_TARGET", "\u65E0\u6548\u7684\u6587\u4EF6\u8DEF\u5F84 / Invalid file path");
      const modules = await inspect();
      alive();
      guard?.();
      const state = modules.store.getState();
      if (!sessionId || state.activeSessionId !== sessionId || state.selectingSessionId) denied("SIDEBAR_SESSION", "\u4F1A\u8BDD\u5DF2\u5207\u6362\uFF0C\u8BF7\u5728\u5F53\u524D\u4F1A\u8BDD\u70B9\u51FB / Session changed");
      if (!Array.isArray(state.pluginViews) || !state.pluginViews.some((view) => view.pluginId === "pi.file-manager" && view.viewId === "manager")) denied("SIDEBAR_VIEW", "PI-Desktop \u6587\u4EF6\u7BA1\u7406\u5668\u4E0D\u53EF\u7528\uFF0C\u8BF7\u542F\u7528\u5185\u7F6E\u6587\u4EF6\u7BA1\u7406\u5668 / File Manager unavailable");
      if (typeof state.openWorkPanelTabForSession !== "function") denied("SIDEBAR_CONTRACT", "\u5BBF\u4E3B\u4E0D\u652F\u6301\u6253\u5F00\u6587\u4EF6\u7BA1\u7406\u5668 / File Manager tab opener unavailable");
      const existing = state.workPanelTabs?.find((tab2) => tab2.id === "plugin:pi.file-manager/manager" && tab2.kind === "plugin" && tab2.resource === "pi.file-manager/manager");
      if (existing?.location === path && state.workPanelOpen && state.activeWorkPanelTabId === existing.id) return;
      const tab = { ...existing ?? modules.tab("pi.file-manager", "manager"), location: path };
      state.openWorkPanelTabForSession(sessionId, tab);
      const opened = modules.store.getState();
      if (opened.activeSessionId !== sessionId || !opened.workPanelOpen || opened.activeWorkPanelTabId !== tab.id) denied("SIDEBAR_OPEN", "\u6587\u4EF6\u7BA1\u7406\u5668\u672A\u6253\u5F00 / File Manager did not open");
    },
    close() {
      closed = true;
      for (const dispose of [...subscriptions]) dispose();
    }
  };
}

// src/renderer/RunningChangePill.tsx
import React4, { useEffect as useEffect2, useLayoutEffect as useLayoutEffect2, useRef as useRef2, useState as useState2 } from "react";
import { createPortal } from "react-dom";

// src/renderer/running-changes.ts
function createRunningChangesController(transport, adapter, publish, report2 = () => {
}) {
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
  async function poll(version, task) {
    try {
      const result = await transport.invoke("runningChanges", { sessionId: task.sessionId, since: task.since, taskId: task.taskId });
      if (!valid(version)) return;
      const summary = matches(result, task) ? result : null;
      diagnose(summary ? "running-visible" : "running-query-empty");
      emit({ ...view, summary, error: "" });
    } catch {
      if (valid(version)) {
        diagnose("running-query-error");
        emit({ summary: null, busy: false, error: "" });
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
      emit({ summary: null, busy: false, error: "" });
      diagnose(next ? next.since > 0 ? "running-ready" : "running-identity-missing" : "running-idle");
      if (next) void poll(version, next);
    },
    async open() {
      const task = activity, summary = view.summary, version = epoch;
      if (!task || !summary || view.busy || disposed) return;
      const guard = () => {
        if (!valid(version) || view.summary?.runId !== summary.runId) throw new Error("\u4EFB\u52A1\u5DF2\u7ED3\u675F\u6216\u5207\u6362 / Task ended or changed");
      };
      emit({ ...view, busy: true, error: "" });
      try {
        const result = await transport.invoke("runningChanges", { sessionId: task.sessionId, since: task.since, taskId: task.taskId });
        guard();
        if (!matches(result, task) || result.runId !== summary.runId) {
          emit({ summary: null, busy: false, error: "" });
          return;
        }
        await transport.invoke("activeReviewSession", { sessionId: task.sessionId });
        guard();
        const selection = await transport.invoke("selectTurn", { sessionId: task.sessionId, runId: summary.runId, runningSince: task.since, taskId: task.taskId });
        guard();
        await adapter.open(task.sessionId, `diff-view:${selection.nonce}`, guard);
        guard();
      } catch (error) {
        if (valid(version) && view.summary?.runId === summary.runId) {
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

// src/renderer/RunningChangePill.tsx
var anchors = /* @__PURE__ */ new Set();
var hidden = { left: 0, top: 0, width: 0, visible: false };
function RunningChangePill({ transport, adapter, report: report2 }) {
  const anchor = useRef2(null);
  const controller = useRef2();
  const [view, setView] = useState2({ summary: null, busy: false, error: "" });
  const [position, setPosition] = useState2(hidden);
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
      const visible = Boolean(rect && first === owner);
      const stage = !shell ? "composer-anchor-missing" : !rect ? "composer-anchor-offscreen" : "composer-positioned";
      if (stage !== lastStage) {
        lastStage = stage;
        report2(stage);
      }
      const next = visible && rect ? { left: rect.left + rect.width / 2, top: rect.top - 8, width: Math.min(rect.width - 16, window.innerWidth - 24), visible } : hidden;
      setPosition((previous) => previous.visible === next.visible && previous.left === next.left && previous.top === next.top && previous.width === next.width ? previous : next);
      frame = requestAnimationFrame(update);
    };
    update();
    return () => {
      cancelAnimationFrame(frame);
      anchors.delete(owner);
    };
  }, [view.summary?.runId, report2]);
  const summary = view.summary, zh = summary?.locale.startsWith("zh");
  const unknown = summary?.unknownFileCount ?? 0, allUnknown = !!summary && unknown >= summary.fileCount;
  return /* @__PURE__ */ React4.createElement(React4.Fragment, null, /* @__PURE__ */ React4.createElement("span", { ref: anchor, className: "dv-running-anchor", "aria-hidden": "true" }), summary && position.visible && createPortal(/* @__PURE__ */ React4.createElement("div", { className: "dv-running-float", "data-base": summary.base, style: { left: position.left, top: position.top, maxWidth: position.width } }, /* @__PURE__ */ React4.createElement("button", { type: "button", className: "dv-running-pill", disabled: view.busy, "aria-busy": view.busy, title: zh ? "\u67E5\u770B\u672C\u8F6E\u5DF2\u6355\u83B7\u53D8\u66F4\uFF1B\u4EC5\u7EDF\u8BA1\u53EF\u9A8C\u8BC1\u6587\u672C" : "Review captured changes in this task; verified text counts only", onClick: () => void controller.current?.open() }, /* @__PURE__ */ React4.createElement("span", { className: "dv-running-label" }, zh ? `${summary.fileCount} \u4E2A\u6587\u4EF6\u5DF2\u66F4\u6539` : `${summary.fileCount} ${summary.fileCount === 1 ? "file" : "files"} changed`), !allUnknown && /* @__PURE__ */ React4.createElement(React4.Fragment, null, /* @__PURE__ */ React4.createElement("span", { className: "dv-running-add" }, "+", summary.additions), /* @__PURE__ */ React4.createElement("span", { className: "dv-running-del" }, "-", summary.deletions)), unknown > 0 && /* @__PURE__ */ React4.createElement("span", { className: "dv-running-unknown" }, zh ? allUnknown ? "\u884C\u6570\u672A\u77E5" : "\u90E8\u5206\u7EDF\u8BA1" : allUnknown ? "Unknown lines" : "Partial totals")), view.error && /* @__PURE__ */ React4.createElement("p", { className: "dv-running-error", role: "alert" }, view.error)), document.body));
}
var runningPillStyle = `
.dv-running-anchor{display:none!important}
.dv-running-float{position:fixed;z-index:20;transform:translate(-50%,-100%);font:14px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;--rp-add:var(--ds-success,#008f39);--rp-del:var(--ds-error,#d63232);--rp-bg:var(--ds-bg-elevated-opaque,#fff);--rp-ink:var(--ds-text-secondary,#7c7c7c);--rp-border:var(--ds-border-subtle,#ececec)}
.dv-running-float[data-base=dark]{--rp-add:var(--ds-success,#40c977);--rp-del:var(--ds-error,#ff6764);--rp-bg:var(--ds-bg-elevated-opaque,#252525);--rp-ink:var(--ds-text-secondary,#b5b5b5);--rp-border:var(--ds-border-subtle,#3a3a3a)}
.dv-running-pill{box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:5px;max-width:100%;min-height:34px;padding:7px 12px;border:1px solid var(--rp-border);border-radius:14px;background:var(--rp-bg);color:var(--rp-ink);font:inherit;cursor:pointer;white-space:nowrap;font-variant-numeric:tabular-nums;box-shadow:0 2px 10px rgb(0 0 0 / .025)}
.dv-running-label{overflow:hidden;text-overflow:ellipsis;min-width:0}.dv-running-add,.dv-running-del,.dv-running-unknown{flex:none;font-size:12px}.dv-running-add{color:var(--rp-add)}.dv-running-del{color:var(--rp-del)}
.dv-running-pill:hover:not(:disabled){border-color:color-mix(in srgb,var(--rp-ink) 30%,var(--rp-border))}.dv-running-pill:focus-visible{outline:2px solid var(--ds-focus,#4384f5);outline-offset:3px}.dv-running-pill:disabled{cursor:wait;opacity:.65}
.dv-running-error{margin:5px 0 0;padding:6px 10px;border:1px solid var(--rp-border);border-radius:8px;background:var(--rp-bg);color:var(--rp-del);font-size:12px;overflow-wrap:anywhere;white-space:normal}
@media(max-width:420px){.dv-running-pill{font-size:13px;padding:7px 10px}}
`;

// src/renderer/file-open-channel.ts
function startFileOpenChannel(transport, sessionId, open, isCurrent) {
  const listenerId = crypto.randomUUID();
  let stopped = false, retryTimer;
  const alive = () => !stopped && isCurrent();
  const receive = async () => {
    while (alive()) {
      try {
        const requests = await transport.invoke("openFile", { listen: true, sessionId, listenerId });
        if (!alive()) return;
        if (!Array.isArray(requests)) throw new Error("Invalid file navigation response");
        for (const request of requests) {
          if (!alive()) return;
          let error;
          try {
            if (request.sessionId !== sessionId) throw new Error("File navigation session changed");
            await open(sessionId, request.path, () => {
              if (!alive()) throw new Error("File navigation session changed");
            });
          } catch (reason) {
            error = String(reason?.message ?? reason);
          }
          if (!alive()) return;
          await transport.invoke("openFile", { requestId: request.requestId, sessionId, complete: true, error });
        }
      } catch {
        if (alive()) retryTimer = setTimeout(() => {
          retryTimer = void 0;
          void receive();
        }, 1e3);
        return;
      }
    }
  };
  void receive();
  return () => {
    if (stopped) return;
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    void transport.invoke("openFile", { cancelListen: listenerId, sessionId }).catch(() => {
    });
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
  if (!same(current)) return;
  const dynamic = stage.startsWith("running-") || stage.startsWith("composer-");
  if (!dynamic && current.reported.has(stage)) return;
  current.reported.add(stage);
  void current.transport.invoke("rendererReport", { stage }).catch(() => {
  });
}
function trackSession(current) {
  let queued, publishing = false, uploaded;
  const publish = async () => {
    if (publishing) return;
    publishing = true;
    try {
      while (queued && same(current)) {
        const context = queued;
        queued = void 0;
        const { evidence, ...metadata } = context;
        const key = JSON.stringify([context.sessionId, context.root, context.evidenceRevision]);
        if (evidence && key !== uploaded) {
          if (new TextEncoder().encode(evidence).length > 8 * 1024 * 1024) throw new Error("Host evidence exceeds 8 MiB");
          const chunks = evidenceChunks(evidence);
          for (const [index, chunk] of chunks.entries()) {
            if (!same(current)) return;
            await current.transport.invoke("sessionEvidence", { sessionId: context.sessionId, root: context.root, revision: context.evidenceRevision, index, chunk, final: index === chunks.length - 1 });
          }
          uploaded = key;
        }
        await current.transport.invoke("sessionContext", metadata);
        wake(current);
      }
    } catch {
      report(current, "session-source-error");
    } finally {
      publishing = false;
      if (queued && same(current)) void publish();
    }
  };
  return current.sessionReady ??= current.adapter.subscribeSession((sessionId, context) => {
    if (!same(current)) return;
    if (current.activeSession !== sessionId) {
      current.stopFileOpen?.();
      current.activeSession = sessionId;
      current.sessionVersion++;
      const version = current.sessionVersion;
      current.stopFileOpen = sessionId ? startFileOpenChannel(current.transport, sessionId, (id, path, guard) => current.adapter.openFile(id, path, guard), () => same(current) && current.activeSession === sessionId && current.sessionVersion === version) : void 0;
      wake(current);
    }
    if (context) {
      queued = context;
      void publish();
    }
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
    if (!same(current) || !props.sessionId || !props.messageId || props.message?.role && props.message.role !== "assistant") return;
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
  }, [current, key, contentKey, props.message?.createdAt]);
  const card = value.key === key ? value.card : current?.cache.get(key);
  if (!card || !same(current)) return null;
  const run = card.run;
  return /* @__PURE__ */ React5.createElement(TurnChangeSummary, { run, initialSummary: card.summary, transport: current.transport, locale: current.appearance.locale, base: current.appearance.base, onOpen: async (file) => {
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
function composerReport(stage) {
  if (hub) report(hub, stage);
}
function ComposerControl() {
  const current = hub;
  return same(current) ? /* @__PURE__ */ React5.createElement(RunningChangePill, { transport: current.transport, adapter: current.adapter, report: composerReport }) : null;
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
  disposers.push(pi.ui.injectStyle(summary_style_default + runningPillStyle));
  disposers.push(pi.slots.register({ slot: "entryExtra", component: EntryExtra }));
  disposers.push(pi.slots.register({ slot: "composerControl", positions: ["left"], component: ComposerControl }));
  void trackSession(current).catch(() => {
  });
  report(current, "entry-loaded");
  wake(current);
}
function onUnload() {
  const current = hub;
  if (current) {
    current.stopFileOpen?.();
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
