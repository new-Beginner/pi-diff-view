"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  onLoad: () => onLoad,
  onPanelInvoke: () => onPanelInvoke,
  onRendererCall: () => onRendererCall,
  onUnload: () => onUnload
});
module.exports = __toCommonJS(main_exports);
var import_promises7 = __toESM(require("node:fs/promises"), 1);
var import_node_path8 = __toESM(require("node:path"), 1);
var import_node_crypto8 = require("node:crypto");

// src/core/storage.ts
var import_promises2 = __toESM(require("node:fs/promises"), 1);
var import_node_path2 = __toESM(require("node:path"), 1);
var import_node_os = __toESM(require("node:os"), 1);
var import_node_crypto2 = require("node:crypto");

// src/core/path-policy.ts
var import_promises = __toESM(require("node:fs/promises"), 1);
var import_node_fs = require("node:fs");
var import_node_path = __toESM(require("node:path"), 1);
var import_node_crypto = require("node:crypto");

// src/core/contracts.ts
var MAX_TEXT_BYTES = 2 * 1024 * 1024;

// src/core/path-policy.ts
function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}
function digest(value) {
  return (0, import_node_crypto.createHash)("sha256").update(value).digest("hex");
}
function canonical(value) {
  const p = import_node_path.default.resolve(value);
  return process.platform === "win32" ? p.toLowerCase() : p;
}
function inside(root, target) {
  const rel = import_node_path.default.relative(canonical(root), canonical(target));
  return !import_node_path.default.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${import_node_path.default.sep}`);
}
function assertPathSyntax(value) {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\0\r\n]/.test(value)) fail("INVALID_PATH", "Invalid file path");
  const portable = value.replace(/\\/g, "/");
  if (portable.split("/").includes("..")) fail("PATH_DENIED", "Traversal paths cannot be captured");
  if (portable.startsWith("//") || portable.startsWith("/??/") || /^[a-z]:[^/]/i.test(portable) || portable.replace(/^[a-z]:\//i, "").includes(":")) fail("PATH_DENIED", "UNC, device, drive-relative and alternate-stream paths are not reviewable");
}
function assertPublicPath(value) {
  assertPathSyntax(value);
  const parts = value.replace(/\\/g, "/").split("/");
  for (const part of parts) {
    const s = part.toLowerCase();
    if (s === ".." || /[. ]$/.test(s) && s !== "." || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/.test(s) || [".git", ".ssh", ".aws", ".gnupg", ".gpg", ".npmrc", ".git-credentials", ".netrc", "_netrc", ".pi", ".claude", ".codex", ".pi-desktoooop", ".pi-desktop", ".pi-diff-view", "node_modules"].includes(s) || s.startsWith(".env") || /^id_(rsa|dsa|ecdsa|ed25519)/.test(s) || /\.(pem|key|p12|pfx|keystore|jks)$/.test(s)) fail("PATH_DENIED", "Credential, dependency, internal or escaping paths are not reviewable");
  }
}
async function safeResolve(root, value) {
  assertPathSyntax(value);
  const realRoot = await import_promises.default.realpath(root);
  const target = import_node_path.default.resolve(realRoot, value);
  if (!inside(realRoot, target) || canonical(target) === canonical(realRoot)) fail("PATH_ESCAPE", "File is outside the authorized project root");
  const rel = import_node_path.default.relative(realRoot, target);
  assertPublicPath(rel);
  let cursor = realRoot;
  for (const segment of rel.split(import_node_path.default.sep)) {
    cursor = import_node_path.default.join(cursor, segment);
    try {
      const stat = await import_promises.default.lstat(cursor);
      if (stat.isSymbolicLink()) fail("SYMLINK_DENIED", "Symlinks and junctions are read-only metadata");
      const resolved = await import_promises.default.realpath(cursor);
      if (!inside(realRoot, resolved)) fail("PATH_ESCAPE", "Resolved path escapes the project");
      assertPublicPath(import_node_path.default.relative(realRoot, resolved));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return target;
}
function absentSnapshot() {
  return { exists: false, text: null, hash: "absent", size: 0, mode: 0, kind: "text" };
}
function snapshotFromBytes(bytes, mode = 33188) {
  let kind = bytes.length > MAX_TEXT_BYTES ? "large" : "text";
  let text = null;
  if (kind === "text") {
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      if (text.includes("\0")) {
        kind = "binary";
        text = null;
      }
    } catch {
      kind = "binary";
    }
  }
  return { exists: true, text, hash: digest(bytes), size: bytes.length, mode, kind };
}
function snapshotOfText(text, mode = 33188) {
  return snapshotFromBytes(Buffer.from(text), mode);
}
function sameSnapshot(a, b) {
  return a.exists === b.exists && a.hash === b.hash && (!a.exists || (a.mode & 511) === (b.mode & 511));
}
async function readSnapshot(root, value) {
  const target = await safeResolve(root, value);
  return readRegularSnapshot(target, () => safeResolve(root, value));
}
async function readRegularSnapshot(target, resolve) {
  let handle;
  try {
    const initial = await import_promises.default.lstat(target);
    if (!initial.isFile() || initial.isSymbolicLink()) fail("NOT_FILE", "Only regular files can be captured");
    handle = await import_promises.default.open(target, import_node_fs.constants.O_RDONLY | (process.platform === "win32" ? 0 : import_node_fs.constants.O_NONBLOCK | import_node_fs.constants.O_NOFOLLOW));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.ino !== initial.ino || stat.dev !== initial.dev) fail("NOT_FILE", "Only the validated regular file can be captured");
    if (stat.size > MAX_TEXT_BYTES) {
      await resolve();
      return { exists: true, text: null, hash: `large:${stat.size}:${stat.mtimeMs}`, size: stat.size, mode: stat.mode, kind: "large" };
    }
    const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_TEXT_BYTES) fail("FILE_CHANGED", "File grew beyond the snapshot limit during capture");
    const bytes = buffer.subarray(0, length);
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail("FILE_CHANGED", "File changed during capture");
    await resolve();
    const live = await import_promises.default.lstat(target);
    if (!live.isFile() || live.isSymbolicLink() || live.ino !== stat.ino || live.dev !== stat.dev || live.size !== after.size || live.mtimeMs !== after.mtimeMs) fail("FILE_CHANGED", "File identity changed during capture");
    return snapshotFromBytes(bytes, stat.mode);
  } catch (error) {
    if (error.code === "ENOENT") return absentSnapshot();
    throw error;
  } finally {
    await handle?.close();
  }
}

// src/core/storage.ts
var MAX_RUNS = 200;
var MAX_HISTORY_BYTES = 128 * 1024 * 1024;
async function atomicJson(file, value) {
  await import_promises2.default.mkdir(import_node_path2.default.dirname(file), { recursive: true, mode: 448 });
  const temp = `${file}.${(0, import_node_crypto2.randomUUID)()}.tmp`;
  try {
    await import_promises2.default.writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 384 });
    await import_promises2.default.rename(temp, file);
  } finally {
    await import_promises2.default.rm(temp, { force: true });
  }
}
async function readJson(file, fallback) {
  try {
    const s = await import_promises2.default.stat(file);
    if (s.size > 16 * 1024 * 1024) fail("STORE_LIMIT", "Store record too large");
    return JSON.parse(await import_promises2.default.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== void 0) return fallback;
    throw error;
  }
}
async function locatorPath(pluginRoot2) {
  return import_node_path2.default.join(import_node_os.default.homedir(), ".pi-diff-view", "locators", `${digest(canonical(await import_promises2.default.realpath(pluginRoot2)))}.json`);
}
function validId(id) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) fail("INVALID_ID", "Invalid record identifier");
}
function validRun(run, id) {
  if (!run || ![1, 2].includes(run.version) || run.id !== id || typeof run.sessionId !== "string" || !import_node_path2.default.isAbsolute(run.root) || !run.changes || Array.isArray(run.changes) || Object.keys(run.changes).length > 256 || !Array.isArray(run.replies) || !run.bindings) return false;
  try {
    for (const [value, change] of Object.entries(run.changes)) {
      assertPublicPath(value);
      for (const snapshot of [change.before, change.after]) if (!snapshot || typeof snapshot.exists !== "boolean" || typeof snapshot.hash !== "string" || !Number.isFinite(snapshot.size) || snapshot.size < 0 || !Number.isFinite(snapshot.mode) || !["text", "binary", "large", "symlink", "submodule", "conflict", "unavailable"].includes(snapshot.kind)) return false;
      if (run.version === 1) {
        if (import_node_path2.default.isAbsolute(value) || !inside(run.root, import_node_path2.default.resolve(run.root, value))) return false;
      } else {
        const c = change.capture;
        if (!c || c.path !== value || !import_node_path2.default.isAbsolute(c.absolutePath) || c.identity !== canonical(c.absolutePath) || c.id !== digest(c.identity).slice(0, 24)) return false;
        if (c.origin === "workspace") {
          if (import_node_path2.default.isAbsolute(value) || !inside(run.root, c.absolutePath) || canonical(import_node_path2.default.resolve(run.root, value)) !== c.identity) return false;
        } else if (c.origin !== "external" || inside(run.root, c.absolutePath) || canonical(value) !== c.identity) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
var SnapshotStore = class {
  constructor(directory) {
    this.directory = directory;
  }
  async init() {
    for (const sub of ["blobs", "inbox", "runs", "backups"]) await import_promises2.default.mkdir(import_node_path2.default.join(this.directory, sub), { recursive: true, mode: 448 });
  }
  async captureLock(work) {
    const lock = import_node_path2.default.join(this.directory, "capture.lock");
    let handle;
    for (let attempt = 0; attempt < 80 && !handle; attempt++) {
      try {
        handle = await import_promises2.default.open(lock, "wx", 384);
        await handle.writeFile(JSON.stringify({ pid: process.pid }));
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const owner = await readJson(lock, null).catch(() => null);
        if (owner?.pid && owner.pid !== process.pid) {
          try {
            process.kill(owner.pid, 0);
          } catch (e) {
            if (e.code === "ESRCH") await import_promises2.default.rm(lock, { force: true });
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (!handle) fail("STORE_BUSY", "Capture store is busy; retry after active Agents stop");
    try {
      return await work();
    } finally {
      await handle.close();
      await import_promises2.default.rm(lock, { force: true });
    }
  }
  async saveBlob(snapshot) {
    if (snapshot.kind === "text" && snapshot.exists && snapshot.text !== null) {
      if (!/^[a-f0-9]{64}$/.test(snapshot.hash) || digest(snapshot.text) !== snapshot.hash) fail("SNAPSHOT_INVALID", "Snapshot content hash does not match");
      const file = import_node_path2.default.join(this.directory, "blobs", snapshot.hash);
      if (!await import_promises2.default.stat(file).catch(() => null)) {
        const lock = import_node_path2.default.join(this.directory, "quota.lock");
        let handle;
        for (let attempt = 0; attempt < 40 && !handle; attempt++) {
          try {
            handle = await import_promises2.default.open(lock, "wx", 384);
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
            const s = await import_promises2.default.stat(lock).catch(() => null);
            if (s && Date.now() - s.mtimeMs > 6e4) await import_promises2.default.rm(lock, { force: true });
            else await new Promise((r) => setTimeout(r, 25));
          }
        }
        if (!handle) fail("STORE_BUSY", "Snapshot store is busy; capture marked incomplete");
        try {
          const entries = await import_promises2.default.readdir(import_node_path2.default.dirname(file));
          if (entries.length > 4096) fail("STORE_LIMIT", "Snapshot limit reached; clear plugin history after stopping Agents");
          let size = 0;
          for (const entry of entries) size += (await import_promises2.default.stat(import_node_path2.default.join(import_node_path2.default.dirname(file), entry))).size;
          if (size + snapshot.size > MAX_HISTORY_BYTES) fail("STORE_LIMIT", "128 MiB snapshot capacity reached; clear plugin history after stopping Agents");
          try {
            await import_promises2.default.writeFile(file, snapshot.text, { flag: "wx", mode: 384 });
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
          }
        } finally {
          await handle.close();
          await import_promises2.default.rm(lock, { force: true });
        }
      }
    }
    return { ...snapshot, text: null };
  }
  async hydrate(snapshot) {
    if (!snapshot.exists || snapshot.kind !== "text") return { ...snapshot };
    if (!/^[a-f0-9]{64}$/.test(snapshot.hash)) return { ...snapshot, kind: "unavailable", text: null };
    try {
      const file = import_node_path2.default.join(this.directory, "blobs", snapshot.hash);
      const stat = await import_promises2.default.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("Unsafe blob");
      const bytes = await import_promises2.default.readFile(file);
      if (digest(bytes) !== snapshot.hash) throw new Error("Corrupt blob");
      return { ...snapshot, text: bytes.toString("utf8") };
    } catch {
      return { ...snapshot, kind: "unavailable", text: null };
    }
  }
  async writeRun(run, inbox = false) {
    const save = async () => {
      validId(run.id);
      const changes2 = /* @__PURE__ */ Object.create(null);
      if (Object.keys(run.changes).length > 256) fail("STORE_LIMIT", "Turn exceeds 256 captured files");
      const fileCount = Object.values(run.changes).filter((c) => !sameSnapshot(c.before, c.after)).length;
      if (!fileCount) {
        if (run.state === "running") {
          const { prompt: _prompt, finalReply: _reply, cardPreview: _preview, ...marker } = run;
          await atomicJson(import_node_path2.default.join(this.directory, inbox ? "inbox" : "runs", `${run.id}.json`), { ...marker, fileCount: 0, changes: {}, replies: [], bindings: {} });
        } else {
          for (const sub of ["runs", "inbox"]) await import_promises2.default.rm(import_node_path2.default.join(this.directory, sub, `${run.id}.json`), { force: true });
        }
        return;
      }
      for (const [p, c] of Object.entries(run.changes)) changes2[p] = { ...c, before: await this.saveBlob(c.before), after: await this.saveBlob(c.after) };
      await atomicJson(import_node_path2.default.join(this.directory, inbox ? "inbox" : "runs", `${run.id}.json`), { ...run, fileCount, changes: changes2 });
    };
    if (inbox) await this.captureLock(save);
    else await save();
  }
  async getRun(id, inbox = false, hydrate = true) {
    validId(id);
    const run = await readJson(import_node_path2.default.join(this.directory, inbox ? "inbox" : "runs", `${id}.json`), null);
    if (!run || !validRun(run, id)) return null;
    if (hydrate) for (const [p, c] of Object.entries(run.changes)) run.changes[p] = { ...c, before: await this.hydrate(c.before), after: await this.hydrate(c.after) };
    return run;
  }
  async importInbox(generation2) {
    await this.captureLock(async () => {
      const entries = (await import_promises2.default.readdir(import_node_path2.default.join(this.directory, "inbox"))).filter((e) => /^[\w-]+\.json$/.test(e)).slice(0, MAX_RUNS);
      for (const entry of entries) {
        const id = entry.slice(0, -5);
        try {
          const run = await this.getRun(id, true, false);
          if (!run) continue;
          const current = await this.getRun(id, false, false);
          const sameReply = run.finalReply?.hash === current?.finalReply?.hash && run.finalReply?.timestamp === current?.finalReply?.timestamp;
          run.bindings = sameReply ? current?.bindings ?? {} : {};
          if (run.generation !== generation2 && run.state === "running") {
            run.state = "incomplete";
            run.incomplete = true;
          }
          await this.writeRun(run);
          if (run.state !== "running") await import_promises2.default.rm(import_node_path2.default.join(this.directory, "inbox", entry), { force: true });
        } catch {
        }
      }
    });
  }
  async listRuns(hydrate = true, includeUnchanged = false) {
    const files = (await import_promises2.default.readdir(import_node_path2.default.join(this.directory, "runs"))).filter((e) => /^[\w-]+\.json$/.test(e));
    const runs = [];
    for (const file of files.slice(-MAX_RUNS * 2)) {
      try {
        const run = await this.getRun(file.slice(0, -5), false, hydrate);
        if (run && (includeUnchanged || Object.values(run.changes).some((c) => !sameSnapshot(c.before, c.after)))) runs.push(run);
      } catch {
      }
    }
    return runs.sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_RUNS);
  }
  async comments() {
    return readJson(import_node_path2.default.join(this.directory, "comments.json"), []);
  }
  async saveComments(comments) {
    if (comments.length > 1e3 || Buffer.byteLength(JSON.stringify(comments)) > 16 * 1024 * 1024) fail("COMMENT_LIMIT", "Comment count or byte limit reached");
    await atomicJson(import_node_path2.default.join(this.directory, "comments.json"), comments);
  }
  async audit(event) {
    const file = import_node_path2.default.join(this.directory, "actions.jsonl");
    const size = (await import_promises2.default.stat(file).catch(() => ({ size: 0 }))).size;
    if (size > 1024 * 1024) await import_promises2.default.rename(file, `${file}.previous`).catch(() => {
    });
    await import_promises2.default.appendFile(file, `${JSON.stringify({ timestamp: Date.now(), event })}
`, { mode: 384 });
  }
  async prune() {
    const runs = await this.listRuns(false, true);
    let used = 0;
    const keep = /* @__PURE__ */ new Set();
    for (const run of runs) {
      const hashes = Object.values(run.changes).flatMap((c) => [c.before, c.after]).filter((s) => s.exists && s.kind === "text");
      const cost = hashes.reduce((n, s) => n + s.size, 0);
      if (used + cost <= MAX_HISTORY_BYTES || run.state === "running") {
        used += cost;
        keep.add(run.id);
      }
    }
    for (const file of await import_promises2.default.readdir(import_node_path2.default.join(this.directory, "runs"))) if (/^[\w-]+\.json$/.test(file) && !keep.has(file.slice(0, -5))) await import_promises2.default.rm(import_node_path2.default.join(this.directory, "runs", file), { force: true });
  }
  async clear() {
    await this.captureLock(async () => {
      for (const inbox of [false, true]) for (const file of await import_promises2.default.readdir(import_node_path2.default.join(this.directory, inbox ? "inbox" : "runs"))) {
        if (!/^[\w-]+\.json$/.test(file)) continue;
        const run = await this.getRun(file.slice(0, -5), inbox, false);
        if (run?.state === "running") fail("AGENT_BUSY", "Stop active captures before clearing history");
      }
      for (const sub of ["runs", "inbox", "blobs", "backups"]) {
        const dir = import_node_path2.default.join(this.directory, sub);
        if (!inside(this.directory, dir)) fail("STORE_ESCAPE", "Invalid store path");
        for (const file of await import_promises2.default.readdir(dir)) {
          const target = import_node_path2.default.join(dir, file);
          const s = await import_promises2.default.lstat(target);
          if (s.isFile() && !s.isSymbolicLink()) await import_promises2.default.unlink(target);
        }
      }
      await this.saveComments([]);
      await import_promises2.default.rm(import_node_path2.default.join(this.directory, "restores.json"), { force: true });
    });
  }
};

// src/core/reply-content.ts
var MAX_REPLY_PAYLOAD = 24e3;
var encoder = new TextEncoder();
function finalReplyCandidates(content) {
  if (encoder.encode(JSON.stringify(content)).length > MAX_REPLY_PAYLOAD) return [];
  const candidates = /* @__PURE__ */ new Set([content.trim()]);
  let end = content.length;
  for (let count = 0; count < 256; count++) {
    const boundary = content.lastIndexOf("\n\n", end - 1);
    if (boundary < 0) break;
    candidates.add(content.slice(boundary + 2).trim());
    end = boundary;
  }
  return [...candidates].filter(Boolean);
}

// src/core/review-service.ts
var import_node_path6 = __toESM(require("node:path"), 1);
var import_node_crypto5 = require("node:crypto");

// node_modules/diff/libesm/diff/base.js
var Diff = class {
  diff(oldStr, newStr, options = {}) {
    let callback;
    if (typeof options === "function") {
      callback = options;
      options = {};
    } else if ("callback" in options) {
      callback = options.callback;
    }
    const oldString = this.castInput(oldStr, options);
    const newString = this.castInput(newStr, options);
    const oldTokens = this.removeEmpty(this.tokenize(oldString, options));
    const newTokens = this.removeEmpty(this.tokenize(newString, options));
    return this.diffWithOptionsObj(oldTokens, newTokens, options, callback);
  }
  diffWithOptionsObj(oldTokens, newTokens, options, callback) {
    var _a;
    const done = (value) => {
      value = this.postProcess(value, options);
      if (callback) {
        setTimeout(function() {
          callback(value);
        }, 0);
        return void 0;
      } else {
        return value;
      }
    };
    const newLen = newTokens.length, oldLen = oldTokens.length;
    let editLength = 1;
    let maxEditLength = newLen + oldLen;
    if (options.maxEditLength != null) {
      maxEditLength = Math.min(maxEditLength, options.maxEditLength);
    }
    const maxExecutionTime = (_a = options.timeout) !== null && _a !== void 0 ? _a : Infinity;
    const abortAfterTimestamp = Date.now() + maxExecutionTime;
    const bestPath = [{ oldPos: -1, lastComponent: void 0 }];
    let newPos = this.extractCommon(bestPath[0], newTokens, oldTokens, 0, options);
    if (bestPath[0].oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
      return done(this.buildValues(bestPath[0].lastComponent, newTokens, oldTokens));
    }
    let minDiagonalToConsider = -Infinity, maxDiagonalToConsider = Infinity;
    const execEditLength = () => {
      for (let diagonalPath = Math.max(minDiagonalToConsider, -editLength); diagonalPath <= Math.min(maxDiagonalToConsider, editLength); diagonalPath += 2) {
        let basePath;
        const removePath = bestPath[diagonalPath - 1], addPath = bestPath[diagonalPath + 1];
        if (removePath) {
          bestPath[diagonalPath - 1] = void 0;
        }
        let canAdd = false;
        if (addPath) {
          const addPathNewPos = addPath.oldPos - diagonalPath;
          canAdd = addPath && 0 <= addPathNewPos && addPathNewPos < newLen;
        }
        const canRemove = removePath && removePath.oldPos + 1 < oldLen;
        if (!canAdd && !canRemove) {
          bestPath[diagonalPath] = void 0;
          continue;
        }
        if (!canRemove || canAdd && removePath.oldPos < addPath.oldPos) {
          basePath = this.addToPath(addPath, true, false, 0, options);
        } else {
          basePath = this.addToPath(removePath, false, true, 1, options);
        }
        newPos = this.extractCommon(basePath, newTokens, oldTokens, diagonalPath, options);
        if (basePath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
          return done(this.buildValues(basePath.lastComponent, newTokens, oldTokens)) || true;
        } else {
          bestPath[diagonalPath] = basePath;
          if (basePath.oldPos + 1 >= oldLen) {
            maxDiagonalToConsider = Math.min(maxDiagonalToConsider, diagonalPath - 1);
          }
          if (newPos + 1 >= newLen) {
            minDiagonalToConsider = Math.max(minDiagonalToConsider, diagonalPath + 1);
          }
        }
      }
      editLength++;
    };
    if (callback) {
      (function exec() {
        setTimeout(function() {
          if (editLength > maxEditLength || Date.now() > abortAfterTimestamp) {
            return callback(void 0);
          }
          if (!execEditLength()) {
            exec();
          }
        }, 0);
      })();
    } else {
      while (editLength <= maxEditLength && Date.now() <= abortAfterTimestamp) {
        const ret = execEditLength();
        if (ret) {
          return ret;
        }
      }
    }
  }
  addToPath(path9, added, removed, oldPosInc, options) {
    const last = path9.lastComponent;
    if (last && !options.oneChangePerToken && last.added === added && last.removed === removed) {
      return {
        oldPos: path9.oldPos + oldPosInc,
        lastComponent: { count: last.count + 1, added, removed, previousComponent: last.previousComponent }
      };
    } else {
      return {
        oldPos: path9.oldPos + oldPosInc,
        lastComponent: { count: 1, added, removed, previousComponent: last }
      };
    }
  }
  extractCommon(basePath, newTokens, oldTokens, diagonalPath, options) {
    const newLen = newTokens.length, oldLen = oldTokens.length;
    let oldPos = basePath.oldPos, newPos = oldPos - diagonalPath, commonCount = 0;
    while (newPos + 1 < newLen && oldPos + 1 < oldLen && this.equals(oldTokens[oldPos + 1], newTokens[newPos + 1], options)) {
      newPos++;
      oldPos++;
      commonCount++;
      if (options.oneChangePerToken) {
        basePath.lastComponent = { count: 1, previousComponent: basePath.lastComponent, added: false, removed: false };
      }
    }
    if (commonCount && !options.oneChangePerToken) {
      basePath.lastComponent = { count: commonCount, previousComponent: basePath.lastComponent, added: false, removed: false };
    }
    basePath.oldPos = oldPos;
    return newPos;
  }
  equals(left, right, options) {
    if (options.comparator) {
      return options.comparator(left, right);
    } else {
      return left === right || !!options.ignoreCase && left.toLowerCase() === right.toLowerCase();
    }
  }
  removeEmpty(array) {
    const ret = [];
    for (let i = 0; i < array.length; i++) {
      if (array[i]) {
        ret.push(array[i]);
      }
    }
    return ret;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  castInput(value, options) {
    return value;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  tokenize(value, options) {
    return Array.from(value);
  }
  join(chars) {
    return chars.join("");
  }
  postProcess(changeObjects, options) {
    return changeObjects;
  }
  get useLongestToken() {
    return false;
  }
  buildValues(lastComponent, newTokens, oldTokens) {
    const components = [];
    let nextComponent;
    while (lastComponent) {
      components.push(lastComponent);
      nextComponent = lastComponent.previousComponent;
      delete lastComponent.previousComponent;
      lastComponent = nextComponent;
    }
    components.reverse();
    const componentLen = components.length;
    let componentPos = 0, newPos = 0, oldPos = 0;
    for (; componentPos < componentLen; componentPos++) {
      const component = components[componentPos];
      if (!component.removed) {
        if (!component.added && this.useLongestToken) {
          let value = newTokens.slice(newPos, newPos + component.count);
          value = value.map(function(value2, i) {
            const oldValue = oldTokens[oldPos + i];
            return oldValue.length > value2.length ? oldValue : value2;
          });
          component.value = this.join(value);
        } else {
          component.value = this.join(newTokens.slice(newPos, newPos + component.count));
        }
        newPos += component.count;
        if (!component.added) {
          oldPos += component.count;
        }
      } else {
        component.value = this.join(oldTokens.slice(oldPos, oldPos + component.count));
        oldPos += component.count;
      }
    }
    return components;
  }
};

// node_modules/diff/libesm/diff/line.js
var LineDiff = class extends Diff {
  constructor() {
    super(...arguments);
    this.tokenize = tokenize;
  }
  equals(left, right, options) {
    if (options.ignoreWhitespace) {
      if (!options.newlineIsToken || !left.includes("\n")) {
        left = left.trim();
      }
      if (!options.newlineIsToken || !right.includes("\n")) {
        right = right.trim();
      }
    } else if (options.ignoreNewlineAtEof && !options.newlineIsToken) {
      if (left.endsWith("\n")) {
        left = left.slice(0, -1);
      }
      if (right.endsWith("\n")) {
        right = right.slice(0, -1);
      }
    }
    return super.equals(left, right, options);
  }
};
var lineDiff = new LineDiff();
function diffLines(oldStr, newStr, options) {
  return lineDiff.diff(oldStr, newStr, options);
}
function tokenize(value, options) {
  if (options.stripTrailingCr) {
    value = value.replace(/\r\n/g, "\n");
  }
  const retLines = [], linesAndNewlines = value.split(/(\n|\r\n)/);
  if (!linesAndNewlines[linesAndNewlines.length - 1]) {
    linesAndNewlines.pop();
  }
  for (let i = 0; i < linesAndNewlines.length; i++) {
    const line = linesAndNewlines[i];
    if (i % 2 && !options.newlineIsToken) {
      retLines[retLines.length - 1] += line;
    } else {
      retLines.push(line);
    }
  }
  return retLines;
}

// node_modules/diff/libesm/patch/create.js
function structuredPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, options) {
  let optionsObj;
  if (!options) {
    optionsObj = {};
  } else if (typeof options === "function") {
    optionsObj = { callback: options };
  } else {
    optionsObj = options;
  }
  if (typeof optionsObj.context === "undefined") {
    optionsObj.context = 4;
  }
  const context = optionsObj.context;
  if (optionsObj.newlineIsToken) {
    throw new Error("newlineIsToken may not be used with patch-generation functions, only with diffing functions");
  }
  if (!optionsObj.callback) {
    return diffLinesResultToPatch(diffLines(oldStr, newStr, optionsObj));
  } else {
    const { callback } = optionsObj;
    diffLines(oldStr, newStr, Object.assign(Object.assign({}, optionsObj), { callback: (diff) => {
      const patch = diffLinesResultToPatch(diff);
      callback(patch);
    } }));
  }
  function diffLinesResultToPatch(diff) {
    if (!diff) {
      return;
    }
    diff.push({ value: "", lines: [] });
    function contextLines(lines) {
      return lines.map(function(entry) {
        return " " + entry;
      });
    }
    const hunks = [];
    let oldRangeStart = 0, newRangeStart = 0, curRange = [], oldLine = 1, newLine = 1;
    for (let i = 0; i < diff.length; i++) {
      const current = diff[i], lines = current.lines || splitLines(current.value);
      current.lines = lines;
      if (current.added || current.removed) {
        if (!oldRangeStart) {
          const prev = diff[i - 1];
          oldRangeStart = oldLine;
          newRangeStart = newLine;
          if (prev) {
            curRange = context > 0 ? contextLines(prev.lines.slice(-context)) : [];
            oldRangeStart -= curRange.length;
            newRangeStart -= curRange.length;
          }
        }
        for (const line of lines) {
          curRange.push((current.added ? "+" : "-") + line);
        }
        if (current.added) {
          newLine += lines.length;
        } else {
          oldLine += lines.length;
        }
      } else {
        if (oldRangeStart) {
          if (lines.length <= context * 2 && i < diff.length - 2) {
            for (const line of contextLines(lines)) {
              curRange.push(line);
            }
          } else {
            const contextSize = Math.min(lines.length, context);
            for (const line of contextLines(lines.slice(0, contextSize))) {
              curRange.push(line);
            }
            const hunk = {
              oldStart: oldRangeStart,
              oldLines: oldLine - oldRangeStart + contextSize,
              newStart: newRangeStart,
              newLines: newLine - newRangeStart + contextSize,
              lines: curRange
            };
            hunks.push(hunk);
            oldRangeStart = 0;
            newRangeStart = 0;
            curRange = [];
          }
        }
        oldLine += lines.length;
        newLine += lines.length;
      }
    }
    for (const hunk of hunks) {
      for (let i = 0; i < hunk.lines.length; i++) {
        if (hunk.lines[i].endsWith("\n")) {
          hunk.lines[i] = hunk.lines[i].slice(0, -1);
        } else {
          hunk.lines.splice(i + 1, 0, "\\ No newline at end of file");
          i++;
        }
      }
    }
    return {
      oldFileName,
      newFileName,
      oldHeader,
      newHeader,
      hunks
    };
  }
}
function formatPatch(patch) {
  if (Array.isArray(patch)) {
    return patch.map(formatPatch).join("\n");
  }
  const ret = [];
  if (patch.oldFileName == patch.newFileName) {
    ret.push("Index: " + patch.oldFileName);
  }
  ret.push("===================================================================");
  ret.push("--- " + patch.oldFileName + (typeof patch.oldHeader === "undefined" ? "" : "	" + patch.oldHeader));
  ret.push("+++ " + patch.newFileName + (typeof patch.newHeader === "undefined" ? "" : "	" + patch.newHeader));
  for (let i = 0; i < patch.hunks.length; i++) {
    const hunk = patch.hunks[i];
    if (hunk.oldLines === 0) {
      hunk.oldStart -= 1;
    }
    if (hunk.newLines === 0) {
      hunk.newStart -= 1;
    }
    ret.push("@@ -" + hunk.oldStart + "," + hunk.oldLines + " +" + hunk.newStart + "," + hunk.newLines + " @@");
    for (const line of hunk.lines) {
      ret.push(line);
    }
  }
  return ret.join("\n") + "\n";
}
function createTwoFilesPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, options) {
  if (typeof options === "function") {
    options = { callback: options };
  }
  if (!(options === null || options === void 0 ? void 0 : options.callback)) {
    const patchObj = structuredPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, options);
    if (!patchObj) {
      return;
    }
    return formatPatch(patchObj);
  } else {
    const { callback } = options;
    structuredPatch(oldFileName, newFileName, oldStr, newStr, oldHeader, newHeader, Object.assign(Object.assign({}, options), { callback: (patchObj) => {
      if (!patchObj) {
        callback(void 0);
      } else {
        callback(formatPatch(patchObj));
      }
    } }));
  }
}
function splitLines(text) {
  const hasTrailingNl = text.endsWith("\n");
  const result = text.split("\n").map((line) => line + "\n");
  if (hasTrailingNl) {
    result.pop();
  } else {
    result.push(result.pop().slice(0, -1));
  }
  return result;
}

// src/core/diff.ts
function buildHunks(before, after, context = 3) {
  const patch = structuredPatch("before", "after", before, after, "", "", { context, maxEditLength: 2e5, timeout: 1e3 });
  if (!patch) throw Object.assign(new Error("Diff exceeds computation budget"), { code: "DIFF_LIMIT" });
  return patch.hunks.map((h, index) => {
    let old = h.oldStart, next = h.newStart;
    const lines = h.lines.map((line) => {
      const sign = line[0];
      if (sign === "\\") return { kind: "notice", text: line, oldLine: null, newLine: null };
      const kind = sign === "+" ? "add" : sign === "-" ? "del" : "context";
      return { kind, text: line.slice(1), oldLine: kind === "add" ? null : old++, newLine: kind === "del" ? null : next++ };
    });
    return { id: `${index}:${h.oldStart}:${h.newStart}`, header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines };
  });
}
function publicFile(file) {
  const { before: _before, after: _after, indexFingerprint: _index, ...rest } = file;
  return rest;
}
function patchText(file) {
  if (file.kind !== "text") return `${file.path}: ${file.kind}
`;
  const quote = (s) => /[\s"\\]/.test(s) ? JSON.stringify(s) : s;
  return createTwoFilesPatch(file.before.exists ? quote(`a/${file.oldPath ?? file.path}`) : "/dev/null", file.after.exists ? quote(`b/${file.path}`) : "/dev/null", file.before.text ?? "", file.after.text ?? "", "", "", { context: 3 });
}
function stats(before, after) {
  let additions = 0, deletions = 0;
  for (const hunk of buildHunks(before, after)) for (const line of hunk.lines) {
    if (line.kind === "add") additions++;
    if (line.kind === "del") deletions++;
  }
  return { additions, deletions };
}
function selectHunkText(before, after, hunkId) {
  const hunks = buildHunks(before, after);
  const h = hunks.find((h2) => h2.id === hunkId);
  if (!h) throw Object.assign(new Error("Hunk changed; refresh the review"), { code: "STALE_HUNK" });
  const split = (s) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const left = split(before), right = split(after);
  const start = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
  const newStart = h.newLines === 0 ? h.newStart : h.newStart - 1;
  return [...left.slice(0, start), ...right.slice(newStart, newStart + h.newLines), ...left.slice(start + h.oldLines)].join("");
}

// src/core/rollback.ts
var import_promises3 = __toESM(require("node:fs/promises"), 1);
var import_node_fs2 = require("node:fs");
var import_node_path3 = __toESM(require("node:path"), 1);
var import_node_crypto3 = require("node:crypto");
async function replaceSnapshot(root, value, expected, desired, backupDir) {
  if (expected.kind !== "text" || desired.kind !== "text" || desired.exists && (desired.text === null || digest(desired.text) !== desired.hash)) fail("RESTORE_UNAVAILABLE", "Complete validated text snapshots are required");
  const target = await safeResolve(root, value);
  if (!sameSnapshot(await readSnapshot(root, value), expected)) fail("FILE_CONFLICT", "File changed outside this review; refresh before retrying");
  await import_promises3.default.mkdir(backupDir, { recursive: true, mode: 448 });
  const backups = await import_promises3.default.readdir(backupDir);
  let backupBytes = 0;
  for (const file of backups) backupBytes += (await import_promises3.default.stat(import_node_path3.default.join(backupDir, file))).size;
  if (backups.length >= 998 || backupBytes + 2 * expected.size + desired.size + 8192 > 64 * 1024 * 1024) fail("BACKUP_LIMIT", "Recovery backup limit reached; export needed backups before clearing plugin history");
  const id = (0, import_node_crypto3.randomUUID)(), record = import_node_path3.default.join(backupDir, `${id}.json`);
  await atomicJson(record, { version: 1, root, path: value, before: expected, after: desired });
  if (!expected.exists && !desired.exists) return;
  await import_promises3.default.mkdir(import_node_path3.default.dirname(target), { recursive: true });
  await safeResolve(root, value);
  const temp = import_node_path3.default.join(import_node_path3.default.dirname(target), `.diff-view-${id}.tmp`);
  const original = import_node_path3.default.join(import_node_path3.default.dirname(target), `.diff-view-${id}.original`);
  const originalRel = import_node_path3.default.relative(root, original);
  let held = false;
  try {
    if (desired.exists) {
      const handle = await import_promises3.default.open(temp, "wx", desired.mode & 511 || 420);
      try {
        await handle.writeFile(desired.text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (process.platform !== "win32") await import_promises3.default.chmod(temp, desired.mode & 511);
    }
    await safeResolve(root, value);
    if (!sameSnapshot(await readSnapshot(root, value), expected)) fail("FILE_CONFLICT", "File changed before restore");
    if (expected.exists) {
      await import_promises3.default.rename(target, original);
      held = true;
      const actual = await readSnapshot(root, originalRel);
      if (!sameSnapshot(actual, expected)) fail("FILE_CONFLICT", "Actual moved file changed; original content will be preserved");
      const rawBackup = import_node_path3.default.join(backupDir, `${id}.original`);
      await import_promises3.default.copyFile(original, rawBackup, import_node_fs2.constants.COPYFILE_EXCL);
      await import_promises3.default.chmod(rawBackup, 384);
      if (!sameSnapshot(await readSnapshot(root, originalRel), expected)) fail("FILE_CONFLICT", "Moved file changed while backing up");
    }
    if (desired.exists) await import_promises3.default.link(temp, target);
    else if ((await readSnapshot(root, value)).exists) fail("FILE_CONFLICT", "Another file appeared before deletion completed");
    if (held) {
      await import_promises3.default.unlink(original);
      held = false;
    }
  } catch (error) {
    if (held) {
      try {
        await safeResolve(root, value);
        await import_promises3.default.link(original, target);
        await import_promises3.default.unlink(original);
        held = false;
      } catch {
      }
    }
    if (held) throw Object.assign(new Error(`${error.message}. Original preserved at ${original}`), { code: "FILE_CONFLICT" });
    if (error.code === "EEXIST") fail("FILE_CONFLICT", "Another file appeared; it was not overwritten");
    throw error;
  } finally {
    await import_promises3.default.rm(temp, { force: true });
  }
}

// src/git/repository.ts
var import_promises4 = __toESM(require("node:fs/promises"), 1);
var import_node_path4 = __toESM(require("node:path"), 1);
var import_node_crypto4 = require("node:crypto");

// src/git/runner.ts
var import_node_child_process = require("node:child_process");
var devNull = "/dev/null";
var OUTPUT_LIMIT = 16 * 1024 * 1024;
async function git(root, args, options = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_GRAFT_FILE: devNull,
    LC_ALL: "C"
  });
  if (options.index) env.GIT_INDEX_FILE = options.index;
  const fixed = [
    "-c",
    `core.hooksPath=${devNull}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "core.splitIndex=false",
    "-c",
    "index.sparse=false",
    "-c",
    "diff.external=",
    "-c",
    "protocol.allow=never",
    "-c",
    "core.pager=cat",
    "--no-pager",
    ...args
  ];
  return new Promise((resolve, reject) => {
    const child = (0, import_node_child_process.spawn)("git", fixed, { cwd: root, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const out = [], err = [];
    let size = 0, error;
    const abort = (code, message) => {
      error ??= Object.assign(new Error(message), { code });
      child.kill();
    };
    const timer2 = setTimeout(() => abort("GIT_TIMEOUT", "Git exceeded the time budget"), options.timeout ?? 15e3);
    const collect = (parts, bytes) => {
      size += bytes.length;
      if (size > (options.limit ?? OUTPUT_LIMIT)) abort("GIT_LIMIT", "Git output exceeds the review budget");
      else parts.push(bytes);
    };
    child.stdout.on("data", (bytes) => collect(out, bytes));
    child.stderr.on("data", (bytes) => collect(err, bytes));
    child.on("error", (cause) => {
      error ??= cause;
    });
    child.stdin.on("error", (cause) => {
      if (cause.code !== "EPIPE") error ??= cause;
    });
    child.on("close", (code) => {
      clearTimeout(timer2);
      if (error) {
        reject(error);
        return;
      }
      const result = { stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8"), code: code ?? -1 };
      if (result.code !== 0 && !options.allowFailure) {
        try {
          fail("GIT_FAILED", `Git ${args[0]} failed (${result.code})`);
        } catch (cause) {
          reject(cause);
        }
      } else resolve(result);
    });
    child.stdin.end(options.input);
  });
}
function validateRef(ref) {
  if (typeof ref !== "string" || !ref || ref.length > 512 || ref.startsWith("-") || /[\s\x00-\x1f\x7f\\:?[\]{}*]/u.test(ref) || ref.includes(".."))
    fail("INVALID_REF", "Use a single local branch, tag or commit reference");
}
async function resolveCommit(root, ref) {
  validateRef(ref);
  const value = (await git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { limit: 4096 })).stdout.toString().trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) fail("INVALID_REF", "Reference did not resolve to a commit");
  return value;
}
async function headCommit(root) {
  const result = await git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"], { allowFailure: true, limit: 4096 });
  if (result.code === 1) return void 0;
  if (result.code !== 0) fail("GIT_FAILED", "Could not resolve HEAD");
  const value = result.stdout.toString().trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) fail("GIT_FAILED", "Invalid HEAD object");
  return value;
}

// src/git/repository.ts
var states = /* @__PURE__ */ new WeakMap();
function reviewState(review) {
  const state = states.get(review);
  if (!state) fail("INVALID_REVIEW", "Refresh the Git review before acting");
  return state;
}
async function discoverRepository(authorizedRoot) {
  const root = await import_promises4.default.realpath(authorizedRoot);
  if (!(await import_promises4.default.stat(root)).isDirectory()) fail("INVALID_ROOT", "Project root is not a directory");
  const result = { root, name: import_node_path4.default.basename(root), git: false };
  const top = await git(root, ["rev-parse", "--show-toplevel"], { allowFailure: true, limit: 16384 });
  if (top.code !== 0) return result;
  const gitRoot = await import_promises4.default.realpath(top.stdout.toString("utf8").replace(/\r?\n$/, ""));
  if (canonical(gitRoot) !== canonical(root)) return result;
  result.git = true;
  const branch = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true, limit: 4096 });
  if (branch.code === 0) result.branch = branch.stdout.toString("utf8").replace(/\r?\n$/, "");
  return result;
}
async function boundedRead(handle, size, code) {
  const buffer = Buffer.alloc(size + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (offset > size) fail(code, "File grew during bounded capture");
  return buffer.subarray(0, offset);
}
async function readIndex(indexPath) {
  let handle;
  try {
    const stat = await import_promises4.default.lstat(indexPath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("INDEX_DENIED", "Git index must be a regular file");
    if (stat.size > OUTPUT_LIMIT) fail("GIT_LIMIT", "Git index exceeds the size budget");
    handle = await import_promises4.default.open(indexPath, "r");
    const bytes = await boundedRead(handle, stat.size, "STALE_INDEX");
    if (bytes.length > OUTPUT_LIMIT) fail("GIT_LIMIT", "Git index exceeds the size budget");
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail("STALE_INDEX", "Index changed during capture");
    return { bytes, fingerprint: digest(bytes) };
  } catch (error) {
    if (error.code === "ENOENT") return { bytes: null, fingerprint: "absent" };
    throw error;
  } finally {
    await handle?.close();
  }
}
function bytesSnapshot(bytes, mode) {
  const snapshot = snapshotFromBytes(bytes, mode);
  if (snapshot.kind === "text") snapshot.text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return snapshot;
}
function metadata(kind, hash, mode, size = 0) {
  return { exists: true, text: null, hash, size, mode, kind };
}
async function workingSnapshot(root, rel, budget = MAX_TEXT_BYTES) {
  assertPublicPath(rel);
  const parent = import_node_path4.default.posix.dirname(rel);
  if (parent !== ".") await safeResolve(root, parent);
  let target;
  try {
    target = await safeResolve(root, rel);
  } catch (error) {
    if (error.code !== "SYMLINK_DENIED") throw error;
    const leaf = import_node_path4.default.resolve(root, rel);
    const stat = await import_promises4.default.lstat(leaf);
    if (!stat.isSymbolicLink()) throw error;
    return metadata("symlink", digest(await import_promises4.default.readlink(leaf)), 40960, stat.size);
  }
  let handle;
  try {
    const stat = await import_promises4.default.lstat(target);
    if (stat.isDirectory()) return metadata("submodule", `directory:${stat.mtimeMs}`, 57344);
    if (!stat.isFile()) return metadata("unavailable", `special:${stat.mode}`, stat.mode);
    if (stat.size > MAX_TEXT_BYTES) return metadata("large", `large:${stat.size}:${stat.mtimeMs}`, stat.mode, stat.size);
    if (stat.size > budget) return metadata("unavailable", `budget:${stat.size}:${stat.mtimeMs}`, stat.mode, stat.size);
    handle = await import_promises4.default.open(target, "r");
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== stat.ino || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs)
      fail("FILE_CHANGED", "Working file changed during capture");
    const bytes = await boundedRead(handle, stat.size, "FILE_CHANGED");
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail("FILE_CHANGED", "Working file changed during capture");
    await safeResolve(root, rel);
    return bytesSnapshot(bytes, stat.mode);
  } catch (error) {
    if (error.code === "ENOENT") return absentSnapshot();
    throw error;
  } finally {
    await handle?.close();
  }
}
function records(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes).split("\0").filter(Boolean);
  } catch {
    fail("INVALID_PATH", "Git filenames are not valid UTF-8; this repository is read-only");
  }
}
function parseEntries(bytes, tree) {
  const result = /* @__PURE__ */ new Map();
  for (const row of records(bytes)) {
    const match = tree ? /^(\d{6}) (?:blob|commit) ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(row) : /^(\d{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/.exec(row);
    if (!match) fail("GIT_FAILED", "Invalid Git entry record");
    const rel = match[tree ? 3 : 4];
    const entry = { mode: parseInt(match[1], 8), oid: match[2], stage: tree ? 0 : Number(match[3]) };
    result.set(rel, [...result.get(rel) ?? [], entry]);
  }
  return result;
}
async function treeEntries(root, commit) {
  return commit ? parseEntries((await git(root, ["ls-tree", "-r", "-z", "--full-tree", commit, "--"])).stdout, true) : /* @__PURE__ */ new Map();
}
function changes(bytes) {
  const rows = records(bytes), result = [];
  for (let i = 0; i < rows.length; ) {
    const code = rows[i++];
    if (!/^[ADMRTUC](?:\d+)?$/.test(code) || !rows[i]) fail("GIT_FAILED", "Invalid Git change record");
    const first = rows[i++];
    if (code[0] === "R" || code[0] === "C") {
      const next = rows[i++];
      if (!next) fail("GIT_FAILED", "Invalid Git rename record");
      result.push(code[0] === "R" ? { path: next, oldPath: first, status: "renamed" } : { path: next, status: "added" });
    } else result.push({ path: first, status: code[0] === "A" ? "added" : code[0] === "D" ? "deleted" : "modified" });
  }
  return result;
}
async function readGitReview(requestedRoot, scope, ref) {
  if (!["unstaged", "staged", "commit", "branch"].includes(scope)) fail("INVALID_SCOPE", "Invalid Git review scope");
  const repo = await discoverRepository(requestedRoot);
  if (!repo.git) return { root: repo.root, scope, files: [], notice: "Selected project is not a Git root; enclosing repositories are not authorized." };
  const root = repo.root;
  const indexPath = (await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"], { limit: 16384 })).stdout.toString().replace(/\r?\n$/, "");
  const index = await readIndex(indexPath), head = await headCommit(root);
  const indexEntries = parseEntries((await git(root, ["ls-files", "--stage", "-z", "--"])).stdout, false);
  const objectLength = (await git(root, ["rev-parse", "--show-object-format"], { limit: 1024 })).stdout.toString().trim() === "sha256" ? 64 : 40;
  const filemodeResult = await git(root, ["config", "--type=bool", "--get", "core.filemode"], { allowFailure: true, limit: 1024 });
  const filemode = filemodeResult.stdout.toString().trim() !== "false";
  const diffOptions = ["--name-status", "-z", "--no-ext-diff", "--no-textconv", "--find-renames=50%", "-l200", "--ignore-submodules=none"];
  let beforeEntries, afterEntries;
  let listed, notice, selectedRef;
  if (scope === "unstaged") {
    beforeEntries = indexEntries;
    afterEntries = /* @__PURE__ */ new Map();
    listed = [...indexEntries.keys()].map((rel) => ({ path: rel, status: "modified" }));
    for (const rel of records((await git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--"])).stdout))
      listed.push({ path: rel, status: "added" });
  } else if (scope === "staged") {
    beforeEntries = await treeEntries(root, head);
    afterEntries = indexEntries;
    listed = changes((await git(root, ["diff", "--cached", ...diffOptions, ...head ? [head] : [], "--"])).stdout);
    if (!head) notice = "Unborn HEAD: staged changes are compared with an empty tree.";
  } else if (scope === "commit") {
    selectedRef = await resolveCommit(root, ref ?? "HEAD");
    const header = (await git(root, ["cat-file", "commit", selectedRef])).stdout.toString("utf8").split("\n\n", 1)[0];
    const parents = header.split("\n").filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
    if (parents.some((parent) => !new RegExp(`^[a-f0-9]{${objectLength}}$`).test(parent))) fail("GIT_FAILED", "Invalid commit parent");
    beforeEntries = await treeEntries(root, parents[0]);
    afterEntries = await treeEntries(root, selectedRef);
    listed = changes((await git(root, [
      "diff-tree",
      "--root",
      "--no-commit-id",
      "-r",
      ...diffOptions,
      ...parents.length ? [parents[0], selectedRef] : [selectedRef],
      "--"
    ])).stdout);
    notice = parents.length > 1 ? "Merge commit: compared with its first parent only." : parents.length === 0 ? "Root commit: compared with an empty tree." : "Commit: compared with its parent.";
  } else {
    if (!head) fail("NO_HEAD", "Branch comparison requires a committed HEAD");
    if (!ref) fail("INVALID_REF", "Branch comparison requires a local base reference");
    selectedRef = await resolveCommit(root, ref);
    const base = (await git(root, ["merge-base", "--all", selectedRef, head], { limit: 4096 })).stdout.toString().trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base)) fail("INVALID_REF", "No unique merge base");
    beforeEntries = await treeEntries(root, base);
    afterEntries = await treeEntries(root, head);
    listed = changes((await git(root, ["diff", ...diffOptions, base, head, "--"])).stdout);
    notice = `Branch: merge-base(${ref}, HEAD) ${base.slice(0, 12)} \u2192 HEAD ${head.slice(0, 12)}.`;
  }
  if (scope === "unstaged" || scope === "staged") {
    for (const [rel, entries] of indexEntries)
      if (entries.some((entry) => entry.stage !== 0)) listed.push({ path: rel, status: "modified" });
  }
  listed = [...new Map(listed.map((change) => [change.path, change])).values()];
  if (listed.length > (scope === "unstaged" ? 1e4 : 1e3)) fail("GIT_LIMIT", "Repository path count exceeds the review budget");
  const review = { root, scope, files: [], notice, ...selectedRef ? { ref: selectedRef } : {} };
  const state = {
    root,
    scope,
    indexPath,
    indexFingerprint: index.fingerprint,
    head,
    files: /* @__PURE__ */ new Map(),
    working: /* @__PURE__ */ new Map(),
    objectLength
  };
  let skipped = 0, remaining = OUTPUT_LIMIT;
  const deadline = Date.now() + 3e4;
  const blob = async (entry) => {
    if (!entry) return absentSnapshot();
    if (entry.mode === 40960) {
      const bytes = (await git(root, ["cat-file", "blob", entry.oid], { limit: 8192 })).stdout;
      return metadata("symlink", digest(bytes), entry.mode, bytes.length);
    }
    if (entry.mode === 57344) return metadata("submodule", `git:${entry.oid}`, entry.mode);
    const size = Number((await git(root, ["cat-file", "-s", entry.oid], { limit: 1024 })).stdout.toString().trim());
    if (!Number.isSafeInteger(size) || size < 0) fail("GIT_FAILED", "Invalid Git blob size");
    if (size > MAX_TEXT_BYTES) return metadata("large", `git:${entry.oid}`, entry.mode, size);
    if (size > remaining || Date.now() > deadline) return metadata("unavailable", `git:${entry.oid}`, entry.mode, size);
    remaining -= size;
    return bytesSnapshot((await git(root, ["cat-file", "blob", entry.oid], { limit: MAX_TEXT_BYTES + 4096 })).stdout, entry.mode);
  };
  for (const change of listed) {
    if (Date.now() > deadline) fail("GIT_TIMEOUT", "Review exceeded the time budget; use a smaller repository");
    let working, oldWorking;
    try {
      assertPublicPath(change.path);
      if (change.oldPath) assertPublicPath(change.oldPath);
      working = await workingSnapshot(root, change.path, remaining);
      if (working.kind === "text" || working.kind === "binary") remaining -= working.size;
      if (change.oldPath) {
        oldWorking = await workingSnapshot(root, change.oldPath, remaining);
        if (oldWorking.kind === "text" || oldWorking.kind === "binary") remaining -= oldWorking.size;
      }
    } catch (error) {
      if (["PATH_DENIED", "INVALID_PATH", "PATH_ESCAPE", "SYMLINK_DENIED"].includes(error.code)) {
        skipped++;
        continue;
      }
      throw error;
    }
    const conflict = (scope === "unstaged" || scope === "staged") && indexEntries.get(change.path)?.some((entry) => entry.stage !== 0);
    const leftEntry = beforeEntries.get(change.oldPath ?? change.path)?.find((entry) => entry.stage === 0);
    const rightEntry = afterEntries.get(change.path)?.find((entry) => entry.stage === 0);
    if (scope === "unstaged" && !conflict) {
      if (leftEntry && working.kind === "text" && working.text !== null) {
        const bytes = Buffer.from(working.text);
        const oid = (0, import_node_crypto4.createHash)(objectLength === 64 ? "sha256" : "sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
        const mode = filemode ? working.mode & 73 ? 33261 : 33188 : leftEntry.mode === 33261 ? 33261 : 33188;
        if (oid === leftEntry.oid && mode === leftEntry.mode) {
          remaining += working.size;
          continue;
        }
      }
      change.status = !working.exists ? "deleted" : !leftEntry ? "added" : "modified";
    }
    let before = conflict ? metadata("conflict", "unmerged", 0) : await blob(leftEntry);
    let after = conflict ? metadata("conflict", "unmerged", 0) : scope === "unstaged" ? { ...working } : await blob(rightEntry);
    if (scope === "unstaged" && after.exists && ["text", "binary", "large", "unavailable"].includes(after.kind)) {
      after.mode = filemode ? working.mode & 73 ? 33261 : 33188 : leftEntry?.mode === 33261 ? 33261 : 33188;
    }
    if (!conflict && !change.oldPath && before.kind === after.kind && sameSnapshot(before, after)) {
      if (before.kind === "text" || before.kind === "binary") remaining += before.size + working.size;
      continue;
    }
    if (before.kind === "text" && after.kind === "text" && before.exists && after.exists && before.hash === after.hash) {
      if ((before.mode & 511) === (after.mode & 511) && !change.oldPath) continue;
      if (!change.oldPath) change.status = "mode";
    }
    let kind = "text";
    for (const candidate of ["conflict", "symlink", "submodule", "large", "binary", "unavailable"])
      if (before.kind === candidate || after.kind === candidate || working.kind === candidate) {
        kind = candidate;
        break;
      }
    let counts = { additions: 0, deletions: 0 }, note;
    if (kind === "text") {
      try {
        counts = stats(before.text ?? "", after.text ?? "");
      } catch (error) {
        if (error.code !== "DIFF_LIMIT") throw error;
        kind = "unavailable";
        note = "Diff exceeds the computation budget.";
      }
    }
    let actions = [];
    if (kind !== "text") {
      note ??= `${kind}: read-only metadata; no destructive actions.`;
      if (scope === "unstaged" && (kind === "large" || kind === "submodule"))
        note = `${kind}: content/dirty status is not inspected; conservative read-only metadata.`;
    } else if (change.status === "mode") note = "Mode-only change: read-only metadata.";
    else if (change.status === "renamed") {
      if (scope === "staged" && working.kind === "text" && oldWorking?.kind === "text") actions = ["unstage"];
      note = "Rename: only whole-file index unstage is supported; working rename/revert and hunks are read-only.";
    } else if (scope === "unstaged") actions = ["stage", "revert"];
    else if (scope === "staged") actions = ["unstage"];
    const id = digest(`${root}\0${scope}\0${change.path}\0${change.oldPath ?? ""}`).slice(0, 32);
    const fingerprint = digest(JSON.stringify({ scope, change, before, after, index: index.fingerprint, working, oldWorking }));
    const file = { id, ...change, kind, ...counts, fingerprint, actions, before, after, indexFingerprint: index.fingerprint, ...note ? { note } : {} };
    if (review.files.length >= 1e3) fail("GIT_LIMIT", "More than 1000 changed files; use a smaller repository");
    review.files.push(file);
    state.files.set(id, structuredClone(file));
    state.working.set(change.path, working);
    if (change.oldPath && oldWorking) state.working.set(change.oldPath, oldWorking);
  }
  if (scope === "unstaged") {
    const removed = review.files.filter((f) => f.kind === "text" && f.status === "deleted");
    const added = review.files.filter((f) => f.kind === "text" && f.status === "added");
    const discarded = /* @__PURE__ */ new Set();
    for (const previous of removed) {
      const matches = added.filter((f) => f.after.hash === previous.before.hash);
      if (matches.length !== 1 || removed.filter((f) => f.before.hash === previous.before.hash).length !== 1) continue;
      const next = matches[0];
      state.files.delete(previous.id);
      state.files.delete(next.id);
      discarded.add(previous.id);
      next.oldPath = previous.path;
      next.status = "renamed";
      next.before = previous.before;
      next.additions = 0;
      next.deletions = 0;
      next.actions = ["stage"];
      next.note = "Exact-byte rename: whole-file stage only; working rename/revert and hunks are unsupported.";
      next.id = digest(`${root}\0${scope}\0${next.path}\0${next.oldPath}`).slice(0, 32);
      next.fingerprint = digest(JSON.stringify({
        scope,
        path: next.path,
        oldPath: next.oldPath,
        before: next.before,
        after: next.after,
        index: index.fingerprint,
        working: state.working.get(next.path),
        oldWorking: state.working.get(next.oldPath)
      }));
      state.files.set(next.id, structuredClone(next));
    }
    review.files = review.files.filter((f) => !discarded.has(f.id));
  }
  if ((await readIndex(indexPath)).fingerprint !== index.fingerprint) fail("STALE_INDEX", "Index changed; refresh the review");
  for (const file of state.files.values()) if (file.actions.length) for (const rel of [file.path, ...file.oldPath ? [file.oldPath] : []]) {
    if (!sameSnapshot(await workingSnapshot(root, rel), state.working.get(rel))) fail("FILE_CHANGED", "Working file changed; refresh the review");
  }
  if (skipped) review.notice = [review.notice, `${skipped} credential/internal/unsafe path(s) omitted.`].filter(Boolean).join(" ");
  states.set(review, state);
  return review;
}

// src/git/actions.ts
var import_promises5 = __toESM(require("node:fs/promises"), 1);
var import_node_path5 = __toESM(require("node:path"), 1);
var import_node_os2 = __toESM(require("node:os"), 1);
function reverseHunkText(before, after, hunkId) {
  const hunk = buildHunks(before, after).find((h) => h.id === hunkId);
  if (!hunk) fail("STALE_HUNK", "Hunk changed; refresh the review");
  const split = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const left = split(before), right = split(after);
  const oldStart = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
  const newStart = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
  const desired = [
    ...right.slice(0, newStart),
    ...left.slice(oldStart, oldStart + hunk.oldLines),
    ...right.slice(newStart + hunk.newLines)
  ].join("");
  const inverse = buildHunks(after, desired);
  if (inverse.length !== 1) fail("STALE_HUNK", "Cannot isolate the exact reverse edit safely");
  const selected = selectHunkText(after, desired, inverse[0].id);
  if (selected !== desired) fail("STALE_HUNK", "Cannot isolate the exact reverse edit safely");
  return selected;
}
function desiredSnapshot(file, action, hunkId) {
  if (!hunkId) return structuredClone(action === "stage" ? file.after : file.before);
  const before = file.before.text ?? "", after = file.after.text ?? "";
  const text = action === "stage" ? selectHunkText(before, after, hunkId) : reverseHunkText(before, after, hunkId);
  const target = action === "stage" ? file.after : file.before;
  if (!target.exists && text === "") return absentSnapshot();
  const mode = action === "stage" ? file.before.exists ? file.before.mode : file.after.mode : file.after.mode || file.before.mode;
  return snapshotOfText(text, mode);
}
async function guard(state, file, action) {
  if ((await readIndex(state.indexPath)).fingerprint !== state.indexFingerprint || file.indexFingerprint !== state.indexFingerprint)
    fail("STALE_INDEX", "Index changed; refresh the review");
  if (action === "unstage" && await headCommit(state.root) !== state.head)
    fail("STALE_HEAD", "HEAD changed; refresh the review");
  for (const rel of [file.path, ...file.oldPath ? [file.oldPath] : []]) {
    assertPublicPath(rel);
    await safeResolve(state.root, rel);
    const expected = state.working.get(rel);
    if (!expected || !sameSnapshot(expected, await workingSnapshot(state.root, rel)))
      fail("FILE_CHANGED", "Working file changed; refresh the review");
  }
}
async function applyGitAction(review, fileId, action, fingerprint, hunkId, backupDir) {
  const state = reviewState(review), file = state.files.get(fileId);
  if (!file || file.fingerprint !== fingerprint) fail("STALE_FILE", "File changed; refresh the review");
  if (!file.actions.includes(action) || file.kind !== "text") fail("ACTION_DENIED", "This change is read-only for the requested action");
  if (file.oldPath && hunkId) fail("ACTION_DENIED", "Rename actions require the whole file");
  if (action === "revert" && !backupDir) fail("BACKUP_REQUIRED", "A recovery backup directory is required");
  const desired = desiredSnapshot(file, action, hunkId);
  if (action === "revert" && desired.exists && state.working.get(file.path)?.exists) desired.mode = state.working.get(file.path).mode;
  const lockPath = `${state.indexPath}.lock`;
  let lock;
  try {
    lock = await import_promises5.default.open(lockPath, "wx", 384);
  } catch (error) {
    if (error.code === "EEXIST") fail("INDEX_LOCKED", "Git index is locked; retry after the other operation finishes");
    throw error;
  }
  let tempDir, installed = false;
  try {
    await guard(state, file, action);
    if (action === "revert") {
      await guard(state, file, action);
      await replaceSnapshot(state.root, file.path, state.working.get(file.path), desired, backupDir);
      return;
    }
    tempDir = await import_promises5.default.mkdtemp(import_node_path5.default.join(process.env.PI_SCRATCH_DIR ?? import_node_os2.default.tmpdir(), "pi-git-index-"));
    const tempIndex = import_node_path5.default.join(tempDir, "index");
    const current = await readIndex(state.indexPath);
    if (current.fingerprint !== state.indexFingerprint) fail("STALE_INDEX", "Index changed; refresh the review");
    if (current.bytes) await import_promises5.default.writeFile(tempIndex, current.bytes, { flag: "wx", mode: 384 });
    else await git(state.root, ["read-tree", "--empty"], { index: tempIndex, limit: 4096 });
    await git(state.root, ["update-index", "--no-split-index"], { index: tempIndex, limit: 4096 });
    const changes2 = file.oldPath ? action === "stage" ? [{ path: file.oldPath, snapshot: absentSnapshot() }, { path: file.path, snapshot: desired }] : [{ path: file.path, snapshot: absentSnapshot() }, { path: file.oldPath, snapshot: file.before }] : [{ path: file.path, snapshot: desired }];
    const rows = [];
    for (const change of changes2) {
      assertPublicPath(change.path);
      await safeResolve(state.root, change.path);
      if (!change.snapshot.exists) rows.push(`0 ${"0".repeat(state.objectLength)}	${change.path}\0`);
      else {
        if (change.snapshot.kind !== "text" || change.snapshot.text === null) fail("ACTION_DENIED", "Only exact UTF-8 text index content can be changed");
        const oid = (await git(state.root, ["hash-object", "--no-filters", "-w", "--stdin"], {
          input: Buffer.from(change.snapshot.text, "utf8"),
          limit: 4096
        })).stdout.toString().trim();
        if (!new RegExp(`^[a-f0-9]{${state.objectLength}}$`).test(oid)) fail("GIT_FAILED", "Invalid new blob object");
        rows.push(`${(change.snapshot.mode & 73 ? 33261 : 33188).toString(8)} ${oid}	${change.path}\0`);
      }
    }
    await git(state.root, ["update-index", "-z", "--index-info"], { index: tempIndex, input: Buffer.from(rows.join("")), limit: 4096 });
    const replacement = await readIndex(tempIndex);
    if (!replacement.bytes) fail("GIT_FAILED", "Temporary index was not created");
    await lock.writeFile(replacement.bytes);
    await lock.sync();
    await guard(state, file, action);
    await lock.close();
    await import_promises5.default.rename(lockPath, state.indexPath);
    installed = true;
  } finally {
    await lock.close().catch(() => {
    });
    if (!installed) await import_promises5.default.unlink(lockPath).catch(() => {
    });
    if (tempDir) await import_promises5.default.rm(tempDir, { recursive: true, force: true });
  }
}

// src/core/review-service.ts
function runSummary(run) {
  return { id: run.id, sessionId: run.sessionId, root: run.root, startedAt: run.startedAt, endedAt: run.endedAt, state: run.state, fileCount: Object.values(run.changes).filter((c) => !sameSnapshot(c.before, c.after)).length, incomplete: run.incomplete };
}
function turnNotice(run) {
  const notices = [];
  if (run.version === 1) notices.push("Legacy capture: final USER-task reply and explicit path attribution cannot be verified. Read-only; pre-installation history is not reconstructed.");
  if (run.boundary === "uncertain") notices.push("USER-task boundary was not observed; final reply binding and restore are disabled.");
  if (run.version === 2 && run.boundary === "user" && run.state !== "running" && !run.finalReply) notices.push("No verified final assistant reply was recorded; no reply card is attached.");
  if (run.incomplete || run.state === "running" || run.state === "aborted") notices.push("Capture incomplete or unsettled. Only explicitly captured files are shown; Bash, unsupported tools and unobserved changes are not reconstructed.");
  return notices.length ? notices.join(" ") : void 0;
}
var ReviewService = class {
  constructor(store2, host, generation2) {
    this.store = store2;
    this.host = host;
    this.generation = generation2;
  }
  reviews = /* @__PURE__ */ new Map();
  allowed = /* @__PURE__ */ new Set();
  mutableRoots = /* @__PURE__ */ new Set();
  summaries = /* @__PURE__ */ new Map();
  mutations = Promise.resolve();
  async bootstrap(sessionId) {
    const workspace = await this.host.workspace();
    const roots = workspace ? [workspace.path, ...(workspace.roots ?? []).map((r) => typeof r === "string" ? r : r.path)] : [];
    const repositories = [];
    this.allowed = new Set(roots.map(canonical));
    for (const root of roots) {
      if (repositories.some((r) => canonical(r.root) === canonical(root))) continue;
      try {
        const repo = await discoverRepository(root);
        if (!repositories.some((r) => canonical(r.root) === canonical(repo.root))) repositories.push(repo);
        this.allowed.add(canonical(repo.root));
      } catch {
        repositories.push({ root, name: import_node_path6.default.basename(root), git: false });
      }
    }
    this.mutableRoots = new Set(this.allowed);
    const runs = await this.store.listRuns(false);
    const filtered = runs.filter((r) => (!sessionId || r.sessionId === sessionId) && (this.allowed.has(canonical(r.root)) || !!sessionId && r.sessionId === sessionId));
    for (const r of filtered) if (sessionId && r.sessionId === sessionId) this.allowed.add(canonical(r.root));
    const appearance = await this.host.appearance().catch(() => ({})), settings = await this.host.settings();
    return { repositories, runs: filtered.map(runSummary).slice(0, 100), locale: appearance.locale ?? "zh-CN", base: appearance.base === "light" ? "light" : "dark", settings: { layout: settings.layout === "split" ? "split" : "unified", wordWrap: settings.wordWrap === true, nativePreflight: settings.nativePreflight === true } };
  }
  validateTurn(args, requireRun = true) {
    if (typeof args.sessionId !== "string" || !args.sessionId || args.sessionId.length > 256 || /[\0\r\n]/.test(args.sessionId)) fail("SESSION_REQUIRED", "A valid sessionId is required for recorded turns");
    if (requireRun && (typeof args.runId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(args.runId))) fail("INVALID_ID", "A valid runId is required");
  }
  turnFile(run, value, change, states2) {
    assertPublicPath(value);
    const { before, after, capture } = change, origin = capture?.origin ?? "workspace";
    const kind = before.kind !== "text" ? before.kind : after.kind;
    const reverted = origin === "workspace" && states2[`${run.id}:${value}`] === "reverted";
    const writable = run.version === 2 && run.boundary === "user" && run.state === "completed" && !run.incomplete && this.mutableRoots.has(canonical(run.root)) && origin === "workspace";
    return { id: capture?.id ?? digest(value).slice(0, 24), path: value, origin, absolutePath: capture?.absolutePath, status: !before.exists ? "added" : !after.exists ? "deleted" : before.hash === after.hash ? "mode" : "modified", kind, before, after, fingerprint: digest(JSON.stringify([before.hash, after.hash, before.mode, after.mode])), ...kind === "text" ? stats(before.text ?? "", after.text ?? "") : { additions: 0, deletions: 0 }, actions: kind === "text" && writable ? [reverted ? "reapply" : "revert"] : [], state: reverted ? "reverted" : "active", note: origin === "external" ? "Explicit external tool capture; read-only. No filesystem mutation is authorized." : run.version === 1 ? "Legacy attribution cannot be verified; read-only." : !writable ? "Capture incomplete, unsettled or project not authorized for restore." : kind !== "text" ? `Cannot restore ${kind} snapshot.` : void 0 };
  }
  async turnSummary(args) {
    this.validateTurn(args);
    const run = await this.store.getRun(args.runId, false, false);
    if (!run || run.sessionId !== args.sessionId) fail("RUN_NOT_FOUND", "Recorded run not found in this session");
    await this.bootstrap(args.sessionId);
    if (!this.allowed.has(canonical(run.root))) fail("ROOT_DENIED", "Recorded project is not authorized in this view");
    return this.summarizeRun(run, args);
  }
  async summarizeRun(run, args, readOnly = false) {
    const states2 = readOnly ? {} : await readJson(import_node_path6.default.join(this.store.directory, "restores.json"), {});
    const { bindings: _bindings, cardPreview: _preview, ...content } = run;
    const key = digest(JSON.stringify([content, states2, readOnly ? [] : [...this.mutableRoots].sort(), readOnly]));
    let cached = this.summaries.get(run.id);
    if (!cached || cached.key !== key || Date.now() - cached.createdAt > 3e4) {
      const files = [];
      let additions = 0, deletions = 0, incomplete = run.incomplete || run.state !== "completed" || run.version === 1 || run.boundary !== "user";
      const started = Date.now();
      for (const [value, change] of Object.entries(run.changes)) {
        if (sameSnapshot(change.before, change.after)) continue;
        if (Date.now() - started > 4e3) fail("DIFF_LIMIT", "Turn summary exceeds computation budget");
        const hydrated = { ...change, before: await this.store.hydrate(change.before), after: await this.store.hydrate(change.after) };
        const file = publicFile(this.turnFile(run, value, hydrated, states2));
        if (readOnly) file.actions = [];
        if (file.kind !== "text") incomplete = true;
        additions += file.additions;
        deletions += file.deletions;
        files.push(file);
      }
      const notice = [turnNotice(run), files.some((f) => f.kind !== "text") ? "Some snapshots are non-text or unavailable; line totals include only validated text diffs." : void 0].filter(Boolean).join(" ") || void 0;
      cached = { key, files, additions, deletions, incomplete, notice, createdAt: Date.now() };
      this.summaries.set(run.id, cached);
      while (this.summaries.size > 4) this.summaries.delete(this.summaries.keys().next().value);
    }
    const offset = Number.isFinite(args.offset) ? Math.max(0, Math.min(cached.files.length, Math.floor(args.offset))) : 0;
    const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(100, Math.floor(args.limit))) : 3;
    const summary = { runId: run.id, sessionId: run.sessionId, fileCount: cached.files.length, additions: cached.additions, deletions: cached.deletions, incomplete: cached.incomplete, files: [], offset, nextOffset: null, notice: cached.notice };
    for (const file of cached.files.slice(offset, offset + limit)) {
      summary.files.push(file);
      summary.nextOffset = offset + summary.files.length < cached.files.length ? offset + summary.files.length : null;
      if (Buffer.byteLength(JSON.stringify(summary)) > 28 * 1024) {
        summary.files.pop();
        summary.nextOffset = offset + summary.files.length;
        break;
      }
    }
    if (!summary.files.length && offset < cached.files.length) fail("SUMMARY_LIMIT", "File metadata exceeds summary bridge budget");
    return summary;
  }
  async review(request) {
    if (!request || !["unstaged", "staged", "commit", "branch", "lastTurn", "turn"].includes(request.scope)) fail("INVALID_SCOPE", "Unknown review scope");
    await this.bootstrap(request.sessionId);
    let root = request.root, files = [], git2, run, notice;
    if (request.scope === "lastTurn" || request.scope === "turn") {
      this.validateTurn(request, request.scope === "turn");
      const runs = await this.store.listRuns(false);
      run = runs.find((r) => (!request.sessionId || r.sessionId === request.sessionId) && (!root || canonical(r.root) === canonical(root)) && (request.scope === "lastTurn" || r.id === request.runId));
      if (run) run = await this.store.getRun(run.id) ?? void 0;
      if (!run) {
        root = root ?? "";
        notice = "No recorded turn. History before installation is not reconstructed.";
      } else {
        root = run.root;
        if (!this.allowed.has(canonical(root))) fail("ROOT_DENIED", "Recorded project is not authorized in this view");
        const states2 = await readJson(import_node_path6.default.join(this.store.directory, "restores.json"), {});
        for (const [value, change] of Object.entries(run.changes)) {
          if (sameSnapshot(change.before, change.after)) continue;
          files.push(this.turnFile(run, value, change, states2));
        }
        notice = turnNotice(run);
      }
    } else {
      if (!root) root = (await this.host.workspace())?.path;
      if (!root || !this.allowed.has(canonical(root))) fail("ROOT_DENIED", "Select an authorized project folder");
      git2 = await readGitReview(root, request.scope, request.ref);
      root = git2.root;
      files = git2.files;
      notice = git2.notice;
    }
    if (request.focusFileId && (request.scope === "turn" || request.scope === "lastTurn")) {
      if (typeof request.focusFileId !== "string" || request.focusFileId.length > 256) fail("INVALID_ID", "Invalid selected file identity");
      const index = files.findIndex((file) => file.id === request.focusFileId);
      if (index < 0) fail("FILE_NOT_FOUND", "Selected captured file is unavailable");
      if (index > 0) files.unshift(...files.splice(index, 1));
    }
    const summary = { id: (0, import_node_crypto5.randomUUID)(), scope: request.scope, root: root ?? "", files: [], notice, sessionId: run?.sessionId ?? request.sessionId, runId: run?.id };
    let bytes = 0;
    for (const f of files) {
      const dto = publicFile(f), cost = Buffer.byteLength(JSON.stringify(dto));
      if (summary.files.length >= 100 || bytes + cost > 32e3) {
        summary.notice = `${notice ?? ""} File list limited to the first ${summary.files.length} entries.`.trim();
        break;
      }
      summary.files.push(dto);
      bytes += cost;
    }
    this.reviews.set(summary.id, { summary, files, git: git2, run, createdAt: Date.now() });
    while (this.reviews.size > 4) this.reviews.delete(this.reviews.keys().next().value);
    return summary;
  }
  get(id) {
    const r = this.reviews.get(id);
    if (!r || Date.now() - r.createdAt > 30 * 60 * 1e3) fail("REVIEW_EXPIRED", "Review expired; refresh");
    return r;
  }
  async file(args) {
    const review = this.get(args.reviewId), file = review.files.find((f) => f.id === args.fileId);
    if (!file) fail("FILE_NOT_FOUND", "File not in this review");
    const context = args.context === -1 ? 1e6 : Math.min(1e6, Math.max(1, Math.floor(Number(args.context) || 3)));
    review.hunksCache ??= /* @__PURE__ */ new Map();
    const cacheKey = `${file.id}:${context}`;
    let hunks = review.hunksCache.get(cacheKey);
    if (!hunks) {
      hunks = file.kind === "text" ? buildHunks(file.before.text ?? "", file.after.text ?? "", context) : [];
      review.hunksCache.set(cacheKey, hunks);
      while (review.hunksCache.size > 50) review.hunksCache.delete(review.hunksCache.keys().next().value);
    }
    const totalRows = hunks.reduce((n, h) => n + h.lines.length, 0);
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0)), limit = Math.max(1, Math.min(100, Math.floor(Number(args.limit) || 80)));
    let skipped = 0, taken = 0, bytes = 0, full = false;
    const page = [];
    for (const h of hunks) {
      const lines = [];
      for (const l of h.lines) {
        if (skipped++ < offset) continue;
        const cost = Buffer.byteLength(JSON.stringify(l));
        if (taken >= limit || taken > 0 && bytes + Math.min(cost, 24e3) > 3e4) {
          full = true;
          break;
        }
        if (cost > 24e3) {
          lines.push({ kind: "notice", oldLine: null, newLine: null, text: "Line exceeds bridge preview limit; copy the patch to inspect it." });
          bytes += 150;
        } else {
          lines.push(l);
          bytes += cost;
        }
        taken++;
      }
      if (lines.length) page.push({ ...h, lines });
      if (full) break;
    }
    return { file: publicFile(file), hunks: page, offset, totalRows, nextOffset: offset + taken < totalRows && taken > 0 ? offset + taken : null };
  }
  async action(args) {
    let result = { ok: false, message: "" };
    const execute2 = async () => {
      const review = this.get(args.reviewId), file = review.files.find((f) => f.id === args.fileId);
      if (!args.confirmed) fail("CONFIRM_REQUIRED", "Explicit confirmation is required");
      await this.bootstrap(review.summary.sessionId);
      if (!this.allowed.has(canonical(review.summary.root))) fail("ROOT_DENIED", "Project authorization changed; refresh the review");
      if (!file || file.fingerprint !== args.fingerprint || !file.actions.includes(args.action)) fail("ACTION_DENIED", "Action is not available for this version");
      if (file.origin === "external" || !this.mutableRoots.has(canonical(review.summary.root))) fail("ACTION_DENIED", "External or historical project captures are read-only");
      if (review.git) await applyGitAction(review.git, file.id, args.action, args.fingerprint, args.hunkId, import_node_path6.default.join(this.store.directory, "backups"));
      else if (review.run) {
        if (args.hunkId) fail("ACTION_DENIED", "Turn restore requires a complete file snapshot");
        await this.store.importInbox(this.generation);
        const latest = await this.store.getRun(review.run.id);
        if (!latest || latest.version !== 2 || latest.boundary !== "user" || latest.state !== "completed" || latest.incomplete || latest.sessionId !== review.run.sessionId) fail("CAPTURE_INCOMPLETE", "Only settled, complete attributable captures may be restored");
        const latestChange = latest.changes[file.path];
        if (latestChange?.capture?.origin !== "workspace") fail("ACTION_DENIED", "External captures cannot authorize mutations");
        if (!latestChange || !sameSnapshot(latestChange.before, file.before) || !sameSnapshot(latestChange.after, file.after)) fail("FILE_CONFLICT", "Captured file version changed; refresh");
        const states2 = await readJson(import_node_path6.default.join(this.store.directory, "restores.json"), {});
        const key = `${review.run.id}:${file.path}`;
        if (states2[key] === "reverted" !== (args.action === "reapply")) fail("FILE_CONFLICT", "Restore state changed; refresh");
        await replaceSnapshot(review.summary.root, file.path, args.action === "reapply" ? file.before : file.after, args.action === "reapply" ? file.after : file.before, import_node_path6.default.join(this.store.directory, "backups"));
        states2[key] = args.action === "reapply" ? "active" : "reverted";
        await atomicJson(import_node_path6.default.join(this.store.directory, "restores.json"), states2);
      } else fail("ACTION_DENIED", "Read-only scope");
      await this.store.audit({ action: args.action, root: review.summary.root, path: file.path, runId: review.run?.id, hunkId: args.hunkId });
      this.reviews.delete(args.reviewId);
      result = { ok: true, message: "Change applied. Refreshing review." };
    };
    const pending = this.mutations.then(execute2);
    this.mutations = pending.catch(() => {
    });
    await pending;
    return result;
  }
  async batchAction(args) {
    if (!args.confirmed) fail("CONFIRM_REQUIRED", "Explicit batch confirmation is required");
    if (!Array.isArray(args.targets) || !args.targets.length || args.targets.length > 20 || new Set(args.targets.map((t) => t.fileId)).size !== args.targets.length) fail("BATCH_LIMIT", "Select 1\u201320 distinct files");
    const original = this.get(args.reviewId);
    const results = [];
    for (const target of args.targets) {
      const expected = original.files.find((f) => f.id === target.fileId);
      try {
        if (!expected || expected.fingerprint !== target.fingerprint || !expected.actions.includes(args.action)) fail("ACTION_DENIED", "File action is not authorized for this version");
        const next = await this.review({ scope: original.summary.scope, root: original.summary.root, sessionId: original.summary.sessionId, runId: original.summary.runId, ref: original.git?.ref });
        const current = this.get(next.id).files.find((f) => f.path === expected.path && f.oldPath === expected.oldPath);
        if (!current || !sameSnapshot(current.before, expected.before) || !sameSnapshot(current.after, expected.after) || current.state !== expected.state) fail("FILE_CONFLICT", "File version changed since batch confirmation");
        const result = await this.action({ reviewId: next.id, fileId: current.id, action: args.action, fingerprint: current.fingerprint, confirmed: true });
        results.push({ path: expected.path.slice(0, 160), ...result });
      } catch (e) {
        results.push({ path: (expected?.path ?? target.fileId).slice(0, 160), ok: false, message: String(e.message).slice(0, 200) });
      }
    }
    return { results };
  }
  async comments(args) {
    const review = args.reviewId ? this.get(args.reviewId) : void 0;
    let bytes = 0;
    return (await this.store.comments()).filter((c) => (!args.sessionId || c.sessionId === args.sessionId) && (!review || canonical(c.anchor.root) === canonical(review.summary.root) && c.anchor.scope === review.summary.scope && c.anchor.runId === review.summary.runId)).slice(0, 100).map((c) => ({ ...c, stale: review ? !review.files.some((f) => f.path === c.anchor.path && f.fingerprint === c.anchor.fingerprint) : c.stale })).filter((c) => {
      bytes += Buffer.byteLength(JSON.stringify(c));
      return bytes <= 28e3;
    });
  }
  async saveComment(args) {
    const { anchor } = args;
    if (typeof args.body !== "string" || !args.body.trim() || args.body.length > 4e3) fail("INVALID_COMMENT", "Comment must contain 1\u20134000 characters");
    assertPublicPath(anchor.path);
    const reviews = [...this.reviews.values()];
    const review = reviews.find((r) => canonical(r.summary.root) === canonical(anchor.root) && r.summary.scope === anchor.scope && r.summary.runId === anchor.runId && r.files.some((f) => f.path === anchor.path && f.fingerprint === anchor.fingerprint));
    const file = review?.files.find((f) => f.path === anchor.path);
    if (!file || !Number.isInteger(anchor.line) || anchor.line < 1 || !["old", "new"].includes(anchor.side)) fail("ANCHOR_STALE", "Refresh the review before commenting");
    if (file.kind !== "text" || args.sessionId && args.sessionId !== review?.summary.sessionId && review?.run) fail("ANCHOR_STALE", "Only validated captured text in this session can be commented");
    const text = (anchor.side === "old" ? file.before.text : file.after.text) ?? "";
    const lines = text.split("\n").map((s) => s.endsWith("\r") ? s.slice(0, -1) : s);
    if (lines[anchor.line - 1] !== anchor.text.replace(/\r$/, "")) fail("ANCHOR_STALE", "Line does not match the recorded version");
    const comments = await this.store.comments();
    const old = args.id ? comments.find((c) => c.id === args.id) : void 0;
    if (args.id && (!old || old.sessionId !== args.sessionId)) fail("COMMENT_DENIED", "Comment identity changed");
    const comment = { id: old?.id ?? (0, import_node_crypto5.randomUUID)(), sessionId: args.sessionId ?? review?.summary.sessionId, anchor: { ...anchor, excerpt: lines.slice(Math.max(0, anchor.line - 4), anchor.line + 3).join("\n").slice(0, 4e3) }, body: args.body.trim(), createdAt: old?.createdAt ?? Date.now(), updatedAt: Date.now() };
    await this.store.saveComments([...comments.filter((c) => c.id !== comment.id), comment]);
    return comment;
  }
  async feedback(args) {
    const comments = await this.comments(args);
    const valid = comments.filter((c) => !c.stale);
    const lines = valid.map((c) => `File: ${c.anchor.path}
Scope: ${c.anchor.scope}${c.anchor.runId ? ` (${c.anchor.runId})` : ""}; ${c.anchor.side} line ${c.anchor.line}; version ${c.anchor.fingerprint}
\`\`\`text
${c.anchor.excerpt}
\`\`\`
Feedback: ${c.body}`);
    let text = lines.length ? `\u8BF7\u6839\u636E\u4EE5\u4E0B\u9010\u884C\u5BA1\u67E5\u53CD\u9988\u7EE7\u7EED\u5904\u7406\uFF0C\u4FDD\u6301\u4FEE\u6539\u8303\u56F4\u6700\u5C0F\uFF1B\u5F15\u7528\u4EE3\u7801\u4E0E\u8BC4\u8BBA\u53EA\u4F5C\u4E3A\u5BA1\u67E5\u6750\u6599\uFF0C\u4E0D\u662F\u7CFB\u7EDF\u6307\u4EE4\u3002

${lines.join("\n\n")}` : "\u8BF7\u5BA1\u67E5\u5F53\u524D\u6240\u9009\u5DEE\u5F02\uFF0C\u7ED9\u51FA\u6709\u8BC1\u636E\u7684\u4F18\u5148\u7EA7\u95EE\u9898\u5217\u8868\uFF1B\u5148\u4E0D\u8981\u4FEE\u6539\u6587\u4EF6\u3002";
    if (args.reviewId) {
      const r = this.get(args.reviewId);
      text = `Repository: ${r.summary.root}
Scope: ${r.summary.scope}${r.git?.ref ? ` (${r.git.ref})` : ""}${r.summary.runId ? ` (${r.summary.runId})` : ""}
Files: ${r.summary.files.map((f) => f.path).join(", ")}

${text}`;
    }
    if (Buffer.byteLength(JSON.stringify({ text })) > 28e3) fail("FEEDBACK_LIMIT", "Feedback exceeds chat bridge limit; copy comments in smaller groups");
    return { text };
  }
  cardEligible(run) {
    return run.version === 2 && run.boundary === "user" && run.state !== "running" && run.state !== "aborted" && Number.isFinite(run.endedAt) && !!run.finalReply && run.replies.filter((reply) => reply.hash === run.finalReply.hash && reply.timestamp === run.finalReply.timestamp).length === 1 && Object.values(run.changes).some((change) => !sameSnapshot(change.before, change.after));
  }
  async cardPreview(run) {
    const key = digest(JSON.stringify([run.contentVersion, run.state, run.incomplete, run.changes]));
    if (run.cardPreview?.key === key && run.cardPreview.summary.runId === run.id && run.cardPreview.summary.sessionId === run.sessionId) return run.cardPreview.summary;
    const summary = await this.summarizeRun(run, { limit: 3 }, true);
    run.cardPreview = { key, summary };
    return summary;
  }
  async replyCards(args) {
    this.validateTurn(args, false);
    const runs = (await this.store.listRuns(false)).filter((run) => run.sessionId === args.sessionId && this.cardEligible(run));
    const revision = digest(JSON.stringify(runs.map((run) => [run.id, run.contentVersion, run.state, run.incomplete, run.finalReply, run.bindings, run.changes])));
    const appearance = await this.host.appearance().catch(() => ({}));
    const pending = runs.filter((run) => !Object.keys(run.bindings).length).map((run) => run.finalReply.timestamp);
    const page = { cards: [], revision, pending, nextOffset: null, locale: appearance.locale ?? "zh-CN", base: appearance.base === "light" ? "light" : "dark" };
    if (args.revision === revision) return { ...page, unchanged: true };
    const bound = runs.filter((run) => typeof run.bindings[run.finalReply.hash] === "string" && run.bindings[run.finalReply.hash].length <= 256 && Object.values(run.bindings).every((id) => id === run.bindings[run.finalReply.hash]));
    const unique = bound.filter((run) => bound.filter((other) => other.bindings[other.finalReply.hash] === run.bindings[run.finalReply.hash]).length === 1);
    const offset = Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
    for (const run of unique.slice(offset, offset + 20)) {
      const previousKey = run.cardPreview?.key, summary = await this.cardPreview(run);
      const card = { messageId: run.bindings[run.finalReply.hash], run: runSummary(run), summary };
      page.cards.push(card);
      page.nextOffset = offset + page.cards.length < unique.length ? offset + page.cards.length : null;
      if (Buffer.byteLength(JSON.stringify(page)) > 28 * 1024) {
        page.cards.pop();
        page.nextOffset = offset + page.cards.length;
        if (!page.cards.length) fail("SUMMARY_LIMIT", "Reply card exceeds bridge budget");
        break;
      }
      if (previousKey !== run.cardPreview?.key) await this.store.writeRun(run);
    }
    return page;
  }
  async card(args) {
    if (!args.sessionId || !args.messageId || !args.createdAt) return { run: null };
    const timestamp = Date.parse(args.createdAt);
    if (!Number.isFinite(timestamp)) return { run: null };
    const hashes = new Set(finalReplyCandidates(args.content).map(digest));
    const runs = await this.store.listRuns(false);
    const matches = runs.filter((r) => r.version === 2 && r.boundary === "user" && r.state !== "running" && r.state !== "aborted" && Number.isFinite(r.endedAt) && r.sessionId === args.sessionId && Object.values(r.changes).some((c) => !sameSnapshot(c.before, c.after)) && r.finalReply && hashes.has(r.finalReply.hash) && Math.abs(r.finalReply.timestamp - timestamp) < 3e3 && r.replies.filter((p) => p.hash === r.finalReply.hash && Math.abs(p.timestamp - timestamp) < 3e3).length === 1);
    if (matches.length !== 1) return { run: null };
    const run = matches[0];
    if (Object.values(run.bindings).some((id) => id !== args.messageId)) return { run: null };
    run.bindings[run.finalReply.hash] = args.messageId;
    const summary = await this.cardPreview(run);
    await this.store.writeRun(run);
    return { run: runSummary(run), summary };
  }
  async invoke(method, args = {}) {
    switch (method) {
      case "bootstrap":
        return this.bootstrap(args.sessionId);
      case "review":
        return this.review(args);
      case "turnSummary":
        return this.turnSummary(args);
      case "file":
        return this.file(args);
      case "action":
        return this.action(args);
      case "batchAction":
        return this.batchAction(args);
      case "comments":
        return this.comments(args);
      case "saveComment": {
        const p = this.mutations.then(() => this.saveComment(args));
        this.mutations = p.then(() => {
        }, () => {
        });
        return p;
      }
      case "deleteComment": {
        const p = this.mutations.then(async () => this.store.saveComments((await this.store.comments()).filter((c) => c.id !== args.id)));
        this.mutations = p.then(() => {
        }, () => {
        });
        return p;
      }
      case "feedback":
        return this.feedback(args);
      case "card":
        return this.card(args);
      case "replyCards":
        return this.replyCards(args);
      case "copyPatch": {
        const r = this.get(args.reviewId), files = r.files.filter((f) => !args.fileId || f.id === args.fileId);
        if (!files.length || files.some((f) => f.kind === "unavailable")) fail("FILE_NOT_FOUND", "No validated captured content for this file");
        await this.host.clipboard(files.map(patchText).join("\n"));
        return { ok: true };
      }
      case "settings": {
        const settings = {};
        if (["split", "unified"].includes(args.layout)) settings.layout = args.layout;
        if (typeof args.wordWrap === "boolean") settings.wordWrap = args.wordWrap;
        await this.host.setSettings(settings);
        return;
      }
      case "openPanel":
        return this.host.openPanel();
      case "clearHistory":
        if (!args.confirmed) fail("CONFIRM_REQUIRED", "Confirm clearing plugin history");
        await this.store.importInbox(this.generation);
        if ((await this.store.listRuns(false, true)).some((r) => r.state === "running")) fail("AGENT_BUSY", "Stop active captures before clearing history");
        await this.store.clear();
        this.reviews.clear();
        this.summaries.clear();
        return;
      default:
        fail("UNKNOWN_METHOD", "Unknown Diff view method");
    }
  }
};

// src/core/jobs.ts
var import_node_crypto6 = require("node:crypto");
var JobQueue = class {
  constructor(execute2) {
    this.execute = execute2;
  }
  jobs = /* @__PURE__ */ new Map();
  tail = Promise.resolve();
  closed = false;
  start(method, args) {
    if (this.closed) fail("PLUGIN_UNLOADED", "Diff view is closed");
    if (!["bootstrap", "review", "action", "batchAction", "copyPatch", "clearHistory", "turnSummary", "selectTurn", "card", "replyCards"].includes(method)) fail("JOB_DENIED", "This method is not a background operation");
    if ([...this.jobs.values()].filter((j) => j.state === "pending").length >= 4) fail("JOB_BUSY", "Too many pending review operations");
    for (const [id2, j] of this.jobs) if (j.state !== "pending" && (Date.now() - j.at > 6e4 || this.jobs.size > 8)) this.jobs.delete(id2);
    const id = (0, import_node_crypto6.randomUUID)(), job = { state: "pending", at: Date.now() };
    this.jobs.set(id, job);
    this.tail = this.tail.then(async () => {
      await new Promise((r) => setTimeout(r, 0));
      if (this.closed) return;
      try {
        const result = await this.execute(method, args);
        if (!this.closed) {
          job.result = result ?? null;
          job.state = "done";
          job.at = Date.now();
        }
      } catch (e) {
        if (!this.closed) {
          job.error = { code: String(e.code ?? "REVIEW_FAILED"), message: String(e.message) };
          job.state = "error";
          job.at = Date.now();
        }
      }
    });
    return { jobId: id };
  }
  poll(id) {
    const j = this.jobs.get(id);
    if (!j || this.closed) fail("JOB_EXPIRED", "Review operation expired");
    return { ...j };
  }
  close() {
    this.closed = true;
    this.jobs.clear();
  }
};

// src/core/native-host-build.ts
var import_promises6 = __toESM(require("node:fs/promises"), 1);
var import_node_path7 = __toESM(require("node:path"), 1);

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

// src/core/native-host-build.ts
async function inspectNativeHostBuild(version, executable = process.execPath) {
  const hashes = {};
  if (version !== NATIVE_BUILD.version) return { version, hashes, supported: false, reason: `Only the inspected PI-Desktop ${NATIVE_BUILD.version} build is supported` };
  let handle;
  try {
    let archiveFs = import_promises6.default;
    try {
      archiveFs = require("original-fs").promises;
    } catch {
    }
    const archive = import_node_path7.default.join(import_node_path7.default.dirname(executable), "resources", "app.asar");
    const stat = await archiveFs.lstat(archive);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Host archive is not a regular file");
    handle = await archiveFs.open(archive, "r");
    const header = Buffer.alloc(16);
    if ((await handle.read(header, 0, header.length, 0)).bytesRead !== header.length) throw new Error("Short ASAR header");
    const size = header.readUInt32LE(12), base = 8 + header.readUInt32LE(4);
    if (size < 2 || size > 2 * 1024 * 1024 || base < 16 + size || base > stat.size) throw new Error("Invalid ASAR bounds");
    const bytes = Buffer.alloc(size);
    if ((await handle.read(bytes, 0, size, 16)).bytesRead !== size) throw new Error("Short ASAR index");
    const index = JSON.parse(bytes.toString("utf8"));
    for (const asset of Object.values(NATIVE_BUILD.assets)) {
      let entry = index;
      for (const part of ["out", "renderer", "assets", asset.name]) entry = entry?.files?.[part];
      const offset = Number(entry?.offset), length = entry?.size;
      if (entry?.unpacked || entry?.link || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 2 * 1024 * 1024 || base + offset + length > stat.size) throw new Error("Pinned asset missing or invalid");
      const source = Buffer.alloc(length);
      if ((await handle.read(source, 0, length, base + offset)).bytesRead !== length) throw new Error("Short asset");
      hashes[asset.name] = digest(source);
    }
    const supported = matchesNativeBuild(version, hashes);
    return { version, hashes, supported, ...supported ? {} : { reason: "Renderer build fingerprints do not match the inspected 0.17.0 build" } };
  } catch (error) {
    return { version, hashes, supported: false, reason: `Cannot verify pinned host assets: ${String(error.code ?? error.message).slice(0, 200)}` };
  } finally {
    await handle?.close();
  }
}

// src/core/review-navigation.ts
var import_node_crypto7 = require("node:crypto");
var ReviewNavigationStore = class {
  activeSession;
  setActiveSession(sessionId) {
    this.activeSession = sessionId;
  }
  selections = /* @__PURE__ */ new Map();
  set(request, fileId) {
    if (!request.sessionId || request.scope !== "turn" || !request.runId) fail("NAVIGATION_INVALID", "A recorded task/session is required");
    this.prune();
    const previous = this.selections.get(request.sessionId);
    const entry = { nonce: previous?.nonce ?? (0, import_node_crypto7.randomUUID)(), revision: (previous?.revision ?? 0) + 1, sessionId: request.sessionId, request, fileId, at: Date.now() };
    this.selections.delete(request.sessionId);
    this.selections.set(request.sessionId, entry);
    while (this.selections.size > 32) this.selections.delete(this.selections.keys().next().value);
    return entry;
  }
  get(nonce) {
    this.prune();
    return [...this.selections.values()].find((entry) => entry.nonce === nonce && (this.activeSession === void 0 || entry.sessionId === this.activeSession)) ?? null;
  }
  clear() {
    this.selections.clear();
    this.activeSession = void 0;
  }
  prune() {
    for (const [key, value] of this.selections) if (Date.now() - value.at > 30 * 60 * 1e3) this.selections.delete(key);
  }
};

// src/main.ts
var service = null;
var store = null;
var jobs = null;
var locatorFile = "";
var generation = "";
var pluginRoot = "";
var timer;
var turnEnded;
var tail = Promise.resolve();
var disposed = false;
var rendererStages = {};
var navigation = new ReviewNavigationStore();
function serial(work) {
  const result = tail.then(work);
  tail = result.catch(() => {
  });
  return result;
}
async function heartbeat() {
  if (disposed || !store) return;
  await atomicJson(locatorFile, { version: 1, pluginRoot, dataPath: store.directory, generation, expiresAt: Date.now() + 6e4 });
}
async function onLoad() {
  disposed = false;
  generation = (0, import_node_crypto8.randomUUID)();
  pluginRoot = await import_promises7.default.realpath(__dirname);
  const dataPath = await pi.plugin.getDataPath();
  store = new SnapshotStore(dataPath);
  await store.init();
  rendererStages = {};
  navigation.clear();
  await atomicJson(import_node_path8.default.join(store.directory, "renderer-status.json"), { version: 1, generation, mainLoadedAt: Date.now(), stages: rendererStages });
  locatorFile = await locatorPath(pluginRoot);
  await heartbeat();
  service = new ReviewService(store, { workspace: () => pi.workspace.get(), settings: () => pi.plugin.getSettings(), setSettings: (v) => pi.plugin.setSettings(v), appearance: () => pi.app.getAppearance(), clipboard: (text) => pi.clipboard.writeText(text), openPanel: () => pi.ui.openPanel({ title: "Diff view" }) }, generation);
  const currentService = service;
  jobs = new JobQueue((method, args) => serial(async () => {
    if (disposed) fail("PLUGIN_UNLOADED", "Plugin unloaded");
    return execute(currentService, method, args ?? {});
  }));
  await store.importInbox(generation);
  await store.prune();
  await pi.commands.register({ id: "diff-view.open", title: "Diff view: Open review", keywords: ["diff", "review", "\u5BA1\u67E5", "\u53D8\u66F4"], run: () => pi.ui.openPanel({ title: "Diff view" }) });
  turnEnded = (event) => {
    void serial(async () => {
      if (disposed || !store || !event.sessionId) return;
      await store.importInbox(generation);
      await store.audit({ action: "host-turn-ended", sessionId: String(event.sessionId).slice(0, 128), turnId: String(event.turnId ?? "").slice(0, 128), reason: String(event.reason ?? "").slice(0, 128) });
    }).catch((error) => console.warn("Diff view turn import:", error.message));
  };
  pi.events.on("session:turnEnded", turnEnded);
  timer = setInterval(() => {
    void serial(async () => {
      if (!disposed) {
        await heartbeat();
        await store?.importInbox(generation);
        await store?.prune();
      }
    }).catch((error) => console.warn("Diff view capture import:", error.message));
  }, 2e3);
  timer.unref?.();
}
async function onUnload() {
  disposed = true;
  if (timer) clearInterval(timer);
  timer = void 0;
  if (turnEnded) pi.events.off("session:turnEnded", turnEnded);
  turnEnded = void 0;
  jobs?.close();
  jobs = null;
  navigation.clear();
  await tail;
  const current = await readJson(locatorFile, null).catch(() => null);
  if (current?.generation === generation) await import_promises7.default.rm(locatorFile, { force: true });
  await pi.commands.unregister("diff-view.open");
  service = null;
  store = null;
}
async function onPanelInvoke(channel, payload) {
  if (!channel.startsWith("diff.")) fail("UNKNOWN_METHOD", "Unknown Diff view channel");
  return dispatch(channel.slice(5), payload);
}
async function onRendererCall(method, args) {
  return dispatch(method.startsWith("diff.") ? method.slice(5) : method, args);
}
async function dispatch(method, args) {
  if (!service || disposed) fail("PLUGIN_UNLOADED", "Diff view is not loaded");
  if (method === "activeReviewSession" || method === "readTurnSelection") return execute(service, method, args ?? {});
  if (method === "nativeProbeInfo") return serial(async () => inspectNativeHostBuild(String(await pi.app.getVersion())));
  if (method === "rendererReport") {
    const stage = args?.stage;
    if (typeof stage !== "string" || !["entry-loaded", "reply-slot-mounted", "card-bound", "session-ready", "session-source-error", "sidebar-opened", "view-targeted", "bootstrap-ok", "bootstrap-error", "card-query-error"].includes(stage)) fail("INVALID_STAGE", "Unknown renderer diagnostic stage");
    return serial(async () => {
      if (disposed || !store) fail("PLUGIN_UNLOADED", "Diff view unloaded");
      rendererStages[stage] = Date.now();
      await atomicJson(import_node_path8.default.join(store.directory, "renderer-status.json"), { version: 1, generation, stages: rendererStages });
      return { ok: true };
    });
  }
  if (method === "jobStart") {
    const a = args;
    return jobs.start(a.method, a.args ?? {});
  }
  if (method === "jobPoll") return jobs.poll(args.jobId);
  const s = service;
  return serial(async () => {
    if (disposed) fail("PLUGIN_UNLOADED", "Diff view unloaded");
    return execute(s, method, args ?? {});
  });
}
async function execute(s, method, args) {
  if (method === "activeReviewSession") {
    if (args?.sessionId !== null && (typeof args?.sessionId !== "string" || !args.sessionId || args.sessionId.length > 256 || /[\0\r\n]/.test(args.sessionId))) fail("NAVIGATION_INVALID", "Invalid renderer session");
    navigation.setActiveSession(args.sessionId);
    return { ok: true };
  }
  if (method === "selectTurn") {
    if (typeof args?.sessionId !== "string" || !args.sessionId || args.sessionId.length > 128 || typeof args?.runId !== "string" || !args.runId || args.runId.length > 128 || args.fileId != null && (typeof args.fileId !== "string" || args.fileId.length > 256)) fail("NAVIGATION_INVALID", "Invalid recorded-task target");
    let page = await s.turnSummary({ sessionId: args.sessionId, runId: args.runId, limit: 100 });
    if (args.fileId) {
      while (!page.files.some((file) => file.id === args.fileId) && page.nextOffset != null) page = await s.turnSummary({ sessionId: args.sessionId, runId: args.runId, offset: page.nextOffset, limit: 100 });
      if (!page.files.some((file) => file.id === args.fileId)) fail("FILE_MISSING", "Recorded file no longer available; refresh");
    }
    const run = await store.getRun(args.runId, false, false);
    if (!run || run.sessionId !== args.sessionId) fail("RUN_MISSING", "Recorded task is unavailable");
    return navigation.set({ scope: "turn", sessionId: run.sessionId, runId: run.id, root: run.root }, args.fileId);
  }
  if (method === "readTurnSelection") {
    if (typeof args?.nonce !== "string" || !/^[0-9a-f-]{36}$/i.test(args.nonce)) fail("NAVIGATION_INVALID", "Invalid selection token");
    const selection = navigation.get(args.nonce);
    if (!selection) fail("NAVIGATION_EXPIRED", "\u9009\u62E9\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u70B9\u51FB\u6587\u672B\u6587\u4EF6 / Selection expired; click the reply card again");
    return selection;
  }
  if (method === "clearHistory") navigation.clear();
  return s.invoke(method, args);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  onLoad,
  onPanelInvoke,
  onRendererCall,
  onUnload
});
