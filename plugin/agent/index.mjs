// src/agent/capture.ts
import fs3 from "node:fs/promises";
import path3 from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID as randomUUID2 } from "node:crypto";

// src/core/path-policy.ts
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// src/core/contracts.ts
var MAX_TEXT_BYTES = 2 * 1024 * 1024;

// src/core/path-policy.ts
function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
function canonical(value) {
  const p = path.resolve(value);
  return process.platform === "win32" ? p.toLowerCase() : p;
}
function inside(root, target) {
  const rel = path.relative(canonical(root), canonical(target));
  return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`);
}
function assertPublicPath(value) {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\0\r\n]/.test(value)) fail("INVALID_PATH", "Invalid file path");
  const parts = value.replace(/\\/g, "/").split("/");
  for (const part of parts) {
    const s = part.toLowerCase();
    if (s === ".." || [".git", ".ssh", ".aws", ".gnupg", ".gpg", ".npmrc", ".git-credentials", ".netrc", "_netrc", ".pi-desktoooop", ".pi-desktop", "node_modules"].includes(s) || s.startsWith(".env") || /^id_(rsa|dsa|ecdsa|ed25519)/.test(s) || /\.(pem|key|p12|pfx|keystore|jks)$/.test(s)) fail("PATH_DENIED", "Credential, dependency, internal or escaping paths are not reviewable");
  }
}
async function safeResolve(root, value) {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\0\r\n]/.test(value) || value.replace(/\\/g, "/").split("/").includes("..")) fail("INVALID_PATH", "Invalid or escaping file path");
  const realRoot = await fs.realpath(root);
  const target = path.resolve(realRoot, value);
  if (!inside(realRoot, target) || canonical(target) === canonical(realRoot)) fail("PATH_ESCAPE", "File is outside the authorized project root");
  const rel = path.relative(realRoot, target);
  assertPublicPath(rel);
  let cursor = realRoot;
  for (const segment of rel.split(path.sep)) {
    cursor = path.join(cursor, segment);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) fail("SYMLINK_DENIED", "Symlinks and junctions are read-only metadata");
      if (!inside(realRoot, await fs.realpath(cursor))) fail("PATH_ESCAPE", "Resolved path escapes the project");
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
function sameSnapshot(a, b) {
  return a.exists === b.exists && a.hash === b.hash && (!a.exists || (a.mode & 511) === (b.mode & 511));
}
async function readSnapshot(root, value) {
  const target = await safeResolve(root, value);
  let handle;
  try {
    const initial = await fs.lstat(target);
    if (!initial.isFile() || initial.isSymbolicLink()) fail("NOT_FILE", "Only regular files can be captured");
    handle = await fs.open(target, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW));
    const stat = await handle.stat();
    if (!stat.isFile()) fail("NOT_FILE", "Only regular files can be captured");
    if (stat.size > MAX_TEXT_BYTES) return { exists: true, text: null, hash: `large:${stat.size}:${stat.mtimeMs}`, size: stat.size, mode: stat.mode, kind: "large" };
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
    await safeResolve(root, value);
    return snapshotFromBytes(bytes, stat.mode);
  } catch (error) {
    if (error.code === "ENOENT") return absentSnapshot();
    throw error;
  } finally {
    await handle?.close();
  }
}

// src/core/storage.ts
import fs2 from "node:fs/promises";
import path2 from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
var MAX_RUNS = 200;
var MAX_HISTORY_BYTES = 128 * 1024 * 1024;
async function atomicJson(file, value) {
  await fs2.mkdir(path2.dirname(file), { recursive: true, mode: 448 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs2.writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 384 });
    await fs2.rename(temp, file);
  } finally {
    await fs2.rm(temp, { force: true });
  }
}
async function readJson(file, fallback) {
  try {
    const s = await fs2.stat(file);
    if (s.size > 16 * 1024 * 1024) fail("STORE_LIMIT", "Store record too large");
    return JSON.parse(await fs2.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== void 0) return fallback;
    throw error;
  }
}
async function locatorPath(pluginRoot2) {
  return path2.join(os.homedir(), ".pi-diff-view", "locators", `${digest(canonical(await fs2.realpath(pluginRoot2)))}.json`);
}
async function resolveLocator(file, pluginRoot2) {
  const locator = await readJson(file);
  if (locator.version !== 1 || typeof locator.generation !== "string" || !/^[\w-]{20,80}$/.test(locator.generation) || locator.expiresAt < Date.now() || locator.expiresAt > Date.now() + 9e4 || canonical(locator.pluginRoot) !== canonical(await fs2.realpath(pluginRoot2))) fail("BRIDGE_UNAVAILABLE", "Diff view capture bridge is missing or expired; reload the plugin");
  if (!path2.isAbsolute(locator.dataPath)) fail("BRIDGE_INVALID", "Invalid plugin storage path");
  const stat = await fs2.lstat(locator.dataPath);
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical(await fs2.realpath(locator.dataPath)) !== canonical(locator.dataPath)) fail("BRIDGE_INVALID", "Unsafe plugin storage root");
  return locator;
}
function validId(id) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) fail("INVALID_ID", "Invalid record identifier");
}
var SnapshotStore = class {
  constructor(directory) {
    this.directory = directory;
  }
  async init() {
    for (const sub of ["blobs", "inbox", "runs", "backups"]) await fs2.mkdir(path2.join(this.directory, sub), { recursive: true, mode: 448 });
  }
  async captureLock(work) {
    const lock = path2.join(this.directory, "capture.lock");
    let handle;
    for (let attempt = 0; attempt < 80 && !handle; attempt++) {
      try {
        handle = await fs2.open(lock, "wx", 384);
        await handle.writeFile(JSON.stringify({ pid: process.pid }));
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const owner = await readJson(lock, null).catch(() => null);
        if (owner?.pid && owner.pid !== process.pid) {
          try {
            process.kill(owner.pid, 0);
          } catch (e) {
            if (e.code === "ESRCH") await fs2.rm(lock, { force: true });
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
      await fs2.rm(lock, { force: true });
    }
  }
  async saveBlob(snapshot) {
    if (snapshot.kind === "text" && snapshot.exists && snapshot.text !== null) {
      if (!/^[a-f0-9]{64}$/.test(snapshot.hash) || digest(snapshot.text) !== snapshot.hash) fail("SNAPSHOT_INVALID", "Snapshot content hash does not match");
      const file = path2.join(this.directory, "blobs", snapshot.hash);
      if (!await fs2.stat(file).catch(() => null)) {
        const lock = path2.join(this.directory, "quota.lock");
        let handle;
        for (let attempt = 0; attempt < 40 && !handle; attempt++) {
          try {
            handle = await fs2.open(lock, "wx", 384);
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
            const s = await fs2.stat(lock).catch(() => null);
            if (s && Date.now() - s.mtimeMs > 6e4) await fs2.rm(lock, { force: true });
            else await new Promise((r) => setTimeout(r, 25));
          }
        }
        if (!handle) fail("STORE_BUSY", "Snapshot store is busy; capture marked incomplete");
        try {
          const entries = await fs2.readdir(path2.dirname(file));
          if (entries.length > 4096) fail("STORE_LIMIT", "Snapshot limit reached; clear plugin history after stopping Agents");
          let size = 0;
          for (const entry of entries) size += (await fs2.stat(path2.join(path2.dirname(file), entry))).size;
          if (size + snapshot.size > MAX_HISTORY_BYTES) fail("STORE_LIMIT", "128 MiB snapshot capacity reached; clear plugin history after stopping Agents");
          try {
            await fs2.writeFile(file, snapshot.text, { flag: "wx", mode: 384 });
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
          }
        } finally {
          await handle.close();
          await fs2.rm(lock, { force: true });
        }
      }
    }
    return { ...snapshot, text: null };
  }
  async hydrate(snapshot) {
    if (!snapshot.exists || snapshot.kind !== "text") return { ...snapshot };
    if (!/^[a-f0-9]{64}$/.test(snapshot.hash)) return { ...snapshot, kind: "unavailable", text: null };
    try {
      const file = path2.join(this.directory, "blobs", snapshot.hash);
      const stat = await fs2.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("Unsafe blob");
      const bytes = await fs2.readFile(file);
      if (digest(bytes) !== snapshot.hash) throw new Error("Corrupt blob");
      return { ...snapshot, text: bytes.toString("utf8") };
    } catch {
      return { ...snapshot, kind: "unavailable", text: null };
    }
  }
  async writeRun(run, inbox = false) {
    const save = async () => {
      validId(run.id);
      const changes = {};
      if (Object.keys(run.changes).length > 256) fail("STORE_LIMIT", "Turn exceeds 256 captured files");
      for (const [p, c] of Object.entries(run.changes)) changes[p] = { before: await this.saveBlob(c.before), after: await this.saveBlob(c.after) };
      await atomicJson(path2.join(this.directory, inbox ? "inbox" : "runs", `${run.id}.json`), { ...run, changes });
    };
    if (inbox) await this.captureLock(save);
    else await save();
  }
  async getRun(id, inbox = false, hydrate = true) {
    validId(id);
    const run = await readJson(path2.join(this.directory, inbox ? "inbox" : "runs", `${id}.json`), null);
    if (!run || run.version !== 1 || run.id !== id || typeof run.sessionId !== "string" || !path2.isAbsolute(run.root) || !run.changes) return null;
    if (hydrate) for (const [p, c] of Object.entries(run.changes)) run.changes[p] = { before: await this.hydrate(c.before), after: await this.hydrate(c.after) };
    return run;
  }
  async importInbox(generation) {
    await this.captureLock(async () => {
      const entries = (await fs2.readdir(path2.join(this.directory, "inbox"))).filter((e) => /^[\w-]+\.json$/.test(e)).slice(0, MAX_RUNS);
      for (const entry of entries) {
        const id = entry.slice(0, -5);
        try {
          const run = await this.getRun(id, true, false);
          if (!run) continue;
          const current = await this.getRun(id, false, false);
          run.bindings = current?.bindings ?? {};
          if (run.generation !== generation && run.state === "running") {
            run.state = "incomplete";
            run.incomplete = true;
          }
          await this.writeRun(run);
          if (run.state !== "running") await fs2.rm(path2.join(this.directory, "inbox", entry), { force: true });
        } catch {
        }
      }
    });
  }
  async listRuns(hydrate = true) {
    const files = (await fs2.readdir(path2.join(this.directory, "runs"))).filter((e) => /^[\w-]+\.json$/.test(e));
    const runs = [];
    for (const file of files.slice(-MAX_RUNS * 2)) {
      try {
        const run = await this.getRun(file.slice(0, -5), false, hydrate);
        if (run) runs.push(run);
      } catch {
      }
    }
    return runs.sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_RUNS);
  }
  async comments() {
    return readJson(path2.join(this.directory, "comments.json"), []);
  }
  async saveComments(comments) {
    if (comments.length > 1e3 || Buffer.byteLength(JSON.stringify(comments)) > 16 * 1024 * 1024) fail("COMMENT_LIMIT", "Comment count or byte limit reached");
    await atomicJson(path2.join(this.directory, "comments.json"), comments);
  }
  async audit(event) {
    const file = path2.join(this.directory, "actions.jsonl");
    const size = (await fs2.stat(file).catch(() => ({ size: 0 }))).size;
    if (size > 1024 * 1024) await fs2.rename(file, `${file}.previous`).catch(() => {
    });
    await fs2.appendFile(file, `${JSON.stringify({ timestamp: Date.now(), event })}
`, { mode: 384 });
  }
  async prune() {
    const runs = await this.listRuns(false);
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
    for (const file of await fs2.readdir(path2.join(this.directory, "runs"))) if (/^[\w-]+\.json$/.test(file) && !keep.has(file.slice(0, -5))) await fs2.rm(path2.join(this.directory, "runs", file), { force: true });
  }
  async clear() {
    await this.captureLock(async () => {
      for (const inbox of [false, true]) for (const file of await fs2.readdir(path2.join(this.directory, inbox ? "inbox" : "runs"))) {
        if (!/^[\w-]+\.json$/.test(file)) continue;
        const run = await this.getRun(file.slice(0, -5), inbox, false);
        if (run?.state === "running") fail("AGENT_BUSY", "Stop active captures before clearing history");
      }
      for (const sub of ["runs", "inbox", "blobs", "backups"]) {
        const dir = path2.join(this.directory, sub);
        if (!inside(this.directory, dir)) fail("STORE_ESCAPE", "Invalid store path");
        for (const file of await fs2.readdir(dir)) {
          const target = path2.join(dir, file);
          const s = await fs2.lstat(target);
          if (s.isFile() && !s.isSymbolicLink()) await fs2.unlink(target);
        }
      }
      await this.saveComments([]);
      await fs2.rm(path2.join(this.directory, "restores.json"), { force: true });
    });
  }
};

// src/agent/capture.ts
function textContent(message) {
  if (typeof message?.content === "string") return message.content;
  return Array.isArray(message?.content) ? message.content.filter((b) => b.type === "text").map((b) => b.text).join("") : "";
}
function toolPaths(name, input) {
  const p = input?.path ?? input?.file_path;
  if (typeof p !== "string" || !["Write", "Edit", "write", "edit"].includes(name)) return [];
  const paths = [p];
  if (typeof input.ops === "string") {
    for (const line of input.ops.split("\n")) if (line.startsWith("MV ")) paths.push(line.slice(3).trim());
  }
  return [...new Set(paths)];
}
function createCaptureExtension(options) {
  return (pi) => {
    let run = null, store = null;
    let pending = /* @__PURE__ */ new Map();
    let seen = /* @__PURE__ */ new Set(), warned = false, disposed = false, tail = Promise.resolve();
    const serial = (fn, ctx) => {
      tail = tail.then(fn).catch((error) => {
        if (run) run.incomplete = true;
        if (!warned) {
          warned = true;
          ctx.ui?.notify(`Diff view: ${error.message}`, "warning");
        }
      });
      return tail;
    };
    const bridge = async () => {
      const file = options.locator ?? await locatorPath(options.pluginRoot);
      return resolveLocator(file, options.pluginRoot);
    };
    const persist = async (target) => {
      const locator = await bridge();
      if (locator.generation !== target.generation) throw new Error("Capture generation changed; reload the Agent session");
      target.fileCount = Object.keys(target.changes).length;
      await store.writeRun(target, true);
    };
    const begin = async (ctx, prompt, uncertain = false) => {
      if (disposed) return;
      const locator = await bridge();
      store = new SnapshotStore(locator.dataPath);
      await store.init();
      if (run && (run.state === "running" || uncertain)) {
        run.state = "incomplete";
        run.incomplete = true;
        run.endedAt = Date.now();
        await persist(run);
      }
      run = { version: 1, id: randomUUID2(), generation: locator.generation, sessionId: ctx.sessionManager.getSessionId(), root: await fs3.realpath(ctx.cwd), startedAt: Date.now(), state: "running", fileCount: 0, incomplete: uncertain, changes: {}, replies: [], bindings: {} };
      pending = /* @__PURE__ */ new Map();
      seen = /* @__PURE__ */ new Set();
      warned = false;
      void prompt;
      await persist(run);
    };
    pi.on("before_agent_start", (event, ctx) => serial(() => begin(ctx, event.prompt), ctx));
    pi.on("tool_call", (event, ctx) => serial(async () => {
      if (disposed || seen.has(event.toolCallId)) return;
      if (!run || run.state !== "running") await begin(ctx, void 0, run !== null);
      if (!run) return;
      const name = String(event.toolName), inputs = event.input ?? event.args;
      const targets = toolPaths(name, inputs);
      if (!targets.length) {
        if (/^(Bash|bash|Task|task)$/.test(name) || name.startsWith("plugin_")) {
          run.incomplete = true;
          await persist(run);
        }
        return;
      }
      const captures = [];
      for (const target of targets) {
        try {
          const abs = await safeResolve(run.root, target);
          const rel = path3.relative(run.root, abs).split(path3.sep).join("/");
          const before = await readSnapshot(run.root, rel);
          if (before.kind !== "text") run.incomplete = true;
          captures.push({ path: rel, before });
        } catch {
          run.incomplete = true;
        }
      }
      seen.add(event.toolCallId);
      pending.set(event.toolCallId, { run, paths: captures });
      await persist(run);
    }, ctx));
    pi.on("tool_result", (event, ctx) => serial(async () => {
      const captured = pending.get(event.toolCallId);
      if (!captured || disposed) return;
      pending.delete(event.toolCallId);
      const target = captured.run;
      for (const entry of captured.paths) {
        try {
          const after = await readSnapshot(target.root, entry.path);
          if (event.isError || after.kind !== "text") target.incomplete = true;
          if (sameSnapshot(entry.before, after)) continue;
          const key = process.platform === "win32" ? entry.path.toLowerCase() : entry.path;
          const prior = Object.keys(target.changes).find((p) => (process.platform === "win32" ? p.toLowerCase() : p) === key);
          if (prior && !sameSnapshot(target.changes[prior].after, entry.before)) target.incomplete = true;
          target.changes[prior ?? entry.path] = { before: prior ? target.changes[prior].before : entry.before, after };
        } catch {
          target.incomplete = true;
        }
      }
      await persist(target);
      return void 0;
    }, ctx));
    pi.on("message_end", (event, ctx) => serial(async () => {
      if (!run || event.message?.role !== "assistant") return;
      const message = event.message;
      if (Array.isArray(message.content) && message.content.some((b) => b.type === "toolCall")) return;
      const text = textContent(message);
      if (!text.trim()) return;
      const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();
      const hash = digest(text);
      if (!run.replies.some((r) => r.hash === hash && r.timestamp === timestamp)) run.replies.push({ hash, timestamp });
      run.replies = run.replies.slice(-20);
      await persist(run);
    }, ctx));
    pi.on("agent_end", (_event, ctx) => serial(async () => {
      if (!run) return;
      if (pending.size) {
        run.incomplete = true;
        pending.clear();
      }
      run.state = run.incomplete ? "incomplete" : "completed";
      run.endedAt = Date.now();
      await persist(run);
    }, ctx));
    pi.on("session_shutdown", (_event, ctx) => serial(async () => {
      if (run?.state === "running") {
        run.incomplete = true;
        run.state = "aborted";
        run.endedAt = Date.now();
        await persist(run).catch(() => {
        });
      }
      disposed = true;
      pending.clear();
      seen.clear();
      run = null;
    }, ctx));
    void canonical;
  };
}
var pluginRoot = path3.resolve(path3.dirname(fileURLToPath(import.meta.url)), "..");
var capture_default = createCaptureExtension({ pluginRoot });
export {
  createCaptureExtension,
  capture_default as default
};
