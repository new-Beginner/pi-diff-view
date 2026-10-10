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
      const resolved = await fs.realpath(cursor);
      if (!inside(realRoot, resolved)) fail("PATH_ESCAPE", "Resolved path escapes the project");
      assertPublicPath(path.relative(realRoot, resolved));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return target;
}
async function resolveCapturePath(root, value, privatePaths, allowMissing = false) {
  assertPathSyntax(root);
  assertPathSyntax(value);
  const absolute = path.resolve(root, value), origin = inside(root, absolute) ? "workspace" : "external";
  if (origin === "workspace") assertPublicPath(root);
  if (origin === "external" && !path.isAbsolute(value)) fail("PATH_ESCAPE", "External capture requires an explicit absolute path");
  if (privatePaths.some((p) => inside(p, absolute))) fail("PATH_DENIED", "Plugin-private paths cannot be captured");
  assertPublicPath(origin === "workspace" ? path.relative(root, absolute) : absolute);
  let target;
  if (origin === "workspace") target = await safeResolve(root, value);
  else {
    let cursor = path.parse(absolute).root;
    const segments = absolute.slice(cursor.length).split(path.sep);
    for (const [i, segment] of segments.entries()) {
      cursor = path.join(cursor, segment);
      try {
        const stat2 = await fs.lstat(cursor);
        if (stat2.isSymbolicLink()) fail("SYMLINK_DENIED", "Symlinks and junctions cannot be captured");
        if (i < segments.length - 1 && !stat2.isDirectory()) fail("NOT_FILE", "Capture ancestors must be directories");
      } catch (error) {
        if (error.code !== "ENOENT" || !allowMissing) throw error;
        break;
      }
    }
    target = absolute;
  }
  const stat = await fs.lstat(target).catch((error) => {
    if (error.code === "ENOENT" && allowMissing) return null;
    throw error;
  });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) fail("NOT_FILE", "Only regular files can be captured");
  target = stat ? await fs.realpath(target) : target;
  if (origin === "external") assertPublicPath(target);
  if (privatePaths.some((p) => inside(p, target))) fail("PATH_DENIED", "Plugin-private paths cannot be captured");
  if (origin === "workspace" && !inside(root, target)) fail("PATH_ESCAPE", "Capture escaped the workspace");
  if (origin === "workspace") assertPublicPath(path.relative(root, target));
  const identity = canonical(target);
  return { id: digest(identity).slice(0, 24), identity, origin, absolutePath: target, path: origin === "workspace" ? path.relative(root, target).split(path.sep).join("/") : target };
}
async function readCapturedSnapshot(root, capture, privatePaths) {
  const resolve = async () => {
    const live = await resolveCapturePath(root, capture.origin === "workspace" ? capture.path : capture.absolutePath, privatePaths, true);
    if (live.identity !== capture.identity || live.origin !== capture.origin || live.id !== capture.id) fail("PATH_ESCAPE", "Explicit capture identity changed");
    return live.absolutePath;
  };
  return readRegularSnapshot(await resolve(), resolve);
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
async function readRegularSnapshot(target, resolve) {
  let handle;
  try {
    const initial = await fs.lstat(target);
    if (!initial.isFile() || initial.isSymbolicLink()) fail("NOT_FILE", "Only regular files can be captured");
    handle = await fs.open(target, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW));
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
    const live = await fs.lstat(target);
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
function validRun(run, id) {
  if (!run || ![1, 2].includes(run.version) || run.id !== id || typeof run.sessionId !== "string" || !path2.isAbsolute(run.root) || !run.changes || Array.isArray(run.changes) || Object.keys(run.changes).length > 256 || !Array.isArray(run.replies) || !run.bindings) return false;
  try {
    for (const [value, change] of Object.entries(run.changes)) {
      assertPublicPath(value);
      for (const snapshot of [change.before, change.after]) if (!snapshot || typeof snapshot.exists !== "boolean" || typeof snapshot.hash !== "string" || !Number.isFinite(snapshot.size) || snapshot.size < 0 || !Number.isFinite(snapshot.mode) || !["text", "binary", "large", "symlink", "submodule", "conflict", "unavailable"].includes(snapshot.kind)) return false;
      if (run.version === 1) {
        if (path2.isAbsolute(value) || !inside(run.root, path2.resolve(run.root, value))) return false;
      } else {
        const c = change.capture;
        if (!c || c.path !== value || !path2.isAbsolute(c.absolutePath) || c.identity !== canonical(c.absolutePath) || c.id !== digest(c.identity).slice(0, 24)) return false;
        if (c.origin === "workspace") {
          if (path2.isAbsolute(value) || !inside(run.root, c.absolutePath) || canonical(path2.resolve(run.root, value)) !== c.identity) return false;
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
      const changes = /* @__PURE__ */ Object.create(null);
      if (Object.keys(run.changes).length > 256) fail("STORE_LIMIT", "Turn exceeds 256 captured files");
      for (const [p, c] of Object.entries(run.changes)) changes[p] = { ...c, before: await this.saveBlob(c.before), after: await this.saveBlob(c.after) };
      const fileCount = Object.values(changes).filter((c) => !sameSnapshot(c.before, c.after)).length;
      await atomicJson(path2.join(this.directory, inbox ? "inbox" : "runs", `${run.id}.json`), { ...run, fileCount, changes });
    };
    if (inbox) await this.captureLock(save);
    else await save();
  }
  async getRun(id, inbox = false, hydrate = true) {
    validId(id);
    const run = await readJson(path2.join(this.directory, inbox ? "inbox" : "runs", `${id}.json`), null);
    if (!run || !validRun(run, id)) return null;
    if (hydrate) for (const [p, c] of Object.entries(run.changes)) run.changes[p] = { ...c, before: await this.hydrate(c.before), after: await this.hydrate(c.after) };
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
var MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
function textContent(message) {
  if (typeof message?.content === "string") return message.content;
  return Array.isArray(message?.content) ? message.content.filter((b) => b.type === "text").map((b) => b.text).join("") : "";
}
function toolPaths(name, input) {
  const p = input?.path ?? input?.file_path;
  if (typeof p !== "string" || !["Write", "Edit", "write", "edit"].includes(name)) return [];
  const paths = [p];
  if (/^edit$/i.test(name) && typeof input.ops === "string") {
    for (const line of input.ops.split("\n")) if (line.startsWith("MV ")) {
      paths.push(line.slice(3).trim());
      if (paths.length > 256) break;
    }
  }
  return [...new Set(paths)];
}
function createCaptureExtension(options) {
  return (pi) => {
    let run = null, store = null;
    let pending = /* @__PURE__ */ new Map();
    let seen = /* @__PURE__ */ new Set(), retired = /* @__PURE__ */ new Set(), warned = false, disposed = false, tail = Promise.resolve();
    let lastReply, privatePaths = [], observed = /* @__PURE__ */ new Set();
    const serial = (fn, ctx) => {
      tail = tail.then(fn).catch(async (error) => {
        lastReply = void 0;
        if (run) {
          run.incomplete = true;
          delete run.finalReply;
          await persist(run).catch(() => {
          });
        }
        if (!warned) {
          warned = true;
          ctx.ui?.notify(`Diff view: ${error.message}`, "warning");
        }
      });
      return tail;
    };
    const bridge = async () => resolveLocator(options.locator ?? await locatorPath(options.pluginRoot), options.pluginRoot);
    const check = async (target) => {
      const locator = await bridge();
      if (locator.generation !== target.generation) throw new Error("Capture generation changed; reload the Agent session");
      return locator;
    };
    const persist = async (target) => {
      await check(target);
      target.fileCount = Object.values(target.changes).filter((c) => !sameSnapshot(c.before, c.after)).length;
      target.contentVersion = (target.contentVersion ?? 0) + 1;
      await store.writeRun(target, true);
    };
    const bounded = (snapshot, extra = []) => {
      const retained = /* @__PURE__ */ new Set([...Object.values(run.changes).flatMap((c) => [c.before, c.after]), ...[...pending.values()].flatMap((p) => p.paths.map((e) => e.before)), ...extra]);
      const used = [...retained].reduce((n, s) => n + (s.text === null ? 0 : s.size), 0);
      if (snapshot.text !== null && used + snapshot.size > MAX_CAPTURE_BYTES) {
        run.incomplete = true;
        return { ...snapshot, kind: "unavailable", text: null };
      }
      return snapshot;
    };
    const begin = async (ctx, uncertain = false) => {
      if (disposed) return;
      const locator = await bridge();
      if (run?.state === "running") {
        run.state = "incomplete";
        run.incomplete = true;
        delete run.finalReply;
        run.endedAt = Date.now();
        await persist(run);
      }
      store = new SnapshotStore(locator.dataPath);
      await store.init();
      privatePaths = [await fs3.realpath(options.pluginRoot), locator.dataPath, options.locator ?? await locatorPath(options.pluginRoot)];
      run = { version: 2, contentVersion: 0, boundary: uncertain ? "uncertain" : "user", id: randomUUID2(), generation: locator.generation, sessionId: ctx.sessionManager.getSessionId(), root: await fs3.realpath(ctx.cwd), startedAt: Date.now(), state: "running", fileCount: 0, incomplete: uncertain, changes: /* @__PURE__ */ Object.create(null), replies: [], bindings: {} };
      for (const id of seen) retired.add(id);
      while (retired.size > 4096) retired.delete(retired.keys().next().value);
      pending.clear();
      seen.clear();
      observed.clear();
      warned = false;
      lastReply = void 0;
      await persist(run);
    };
    pi.on("before_agent_start", (_event, ctx) => serial(() => begin(ctx), ctx));
    pi.on("tool_call", (event, ctx) => serial(async () => {
      if (disposed || typeof event.toolCallId !== "string" || seen.has(event.toolCallId)) return;
      lastReply = void 0;
      if (!run || run.state !== "running") await begin(ctx, true);
      if (!run || run.sessionId !== ctx.sessionManager.getSessionId()) return;
      if (retired.has(event.toolCallId)) {
        if (run) {
          run.incomplete = true;
          await persist(run);
        }
        return;
      }
      if (seen.size >= 4096 || pending.size >= 256 || event.toolCallId.length > 256) {
        run.incomplete = true;
        await persist(run);
        return;
      }
      await check(run);
      seen.add(event.toolCallId);
      const name = String(event.toolName), targets = toolPaths(name, event.input ?? event.args);
      if (!targets.length) {
        if (/^(Bash|bash|Task|task|Write|write|Edit|edit)$/.test(name) || name.startsWith("plugin_")) {
          run.incomplete = true;
          await persist(run);
        }
        return;
      }
      if (targets.length > 256) run.incomplete = true;
      const captures = [];
      for (const [index, target] of targets.slice(0, 256).entries()) {
        try {
          const capture = await resolveCapturePath(run.root, target, privatePaths, /^write$/i.test(name) || index > 0);
          if (!observed.has(capture.identity) && observed.size >= 256) throw new Error("Turn exceeds 256 explicitly captured files");
          observed.add(capture.identity);
          const before = bounded(await readCapturedSnapshot(run.root, capture, privatePaths), captures.map((e) => e.before));
          if (before.kind !== "text") run.incomplete = true;
          captures.push({ capture, before });
        } catch {
          run.incomplete = true;
        }
      }
      pending.set(event.toolCallId, { run, paths: captures });
      await persist(run);
    }, ctx));
    pi.on("tool_result", (event, ctx) => serial(async () => {
      const captured = pending.get(event.toolCallId);
      if (!captured || disposed) return;
      pending.delete(event.toolCallId);
      const target = captured.run;
      if (target !== run || target.state !== "running" || target.sessionId !== ctx.sessionManager.getSessionId()) return;
      await check(target);
      lastReply = void 0;
      for (const entry of captured.paths) {
        try {
          const after = bounded(await readCapturedSnapshot(target.root, entry.capture, privatePaths), captured.paths.map((e) => e.before));
          if (event.isError || after.kind !== "text") target.incomplete = true;
          const priorKey = Object.keys(target.changes).find((p) => target.changes[p].capture?.identity === entry.capture.identity);
          const prior = priorKey ? target.changes[priorKey] : void 0;
          if (prior && !sameSnapshot(prior.after, entry.before)) target.incomplete = true;
          target.changes[priorKey ?? entry.capture.path] = { capture: prior?.capture ?? entry.capture, before: prior?.before ?? entry.before, after };
        } catch {
          target.incomplete = true;
        }
      }
      await persist(target);
      return void 0;
    }, ctx));
    pi.on("message_end", (event, ctx) => serial(async () => {
      if (!run || run.state !== "running" || run.sessionId !== ctx.sessionManager.getSessionId() || event.message?.role !== "assistant") return;
      const message = event.message, text = textContent(message);
      lastReply = void 0;
      const tools = Array.isArray(message.content) && message.content.some((b) => b.type === "toolCall" || b.type === "tool_use");
      if (tools || !text.trim()) return;
      if (!Number.isFinite(message.timestamp)) {
        run.incomplete = true;
        await persist(run);
        return;
      }
      if (message.timestamp < run.startedAt || message.timestamp > Date.now() + 3e3) {
        run.incomplete = true;
        await persist(run);
        return;
      }
      const reply = { hash: digest(text), timestamp: message.timestamp };
      if (!run.replies.some((r) => r.hash === reply.hash && r.timestamp === reply.timestamp)) run.replies.push(reply);
      run.replies = run.replies.slice(-20);
      if (!pending.size && !["error", "aborted", "toolUse", "tool_use", "length"].includes(message.stopReason)) lastReply = reply;
      else if (["error", "aborted", "length"].includes(message.stopReason)) run.incomplete = true;
      await persist(run);
    }, ctx));
    pi.on("agent_end", (event, ctx) => serial(async () => {
      if (!run || run.state !== "running" || run.sessionId !== ctx.sessionManager.getSessionId()) return;
      await check(run);
      if (pending.size) {
        run.incomplete = true;
        pending.clear();
        lastReply = void 0;
      }
      for (const change of Object.values(run.changes)) if (change.capture) {
        try {
          const after = bounded(await readCapturedSnapshot(run.root, change.capture, privatePaths));
          if (!sameSnapshot(change.after, after)) run.incomplete = true;
          change.after = after;
        } catch {
          run.incomplete = true;
          change.after = { ...change.after, kind: "unavailable", text: null };
        }
      }
      const messages = Array.isArray(event.messages) ? event.messages : void 0;
      if (messages) {
        const last = [...messages].reverse().find((m) => m.role === "assistant");
        if (!last || !lastReply || digest(textContent(last)) !== lastReply.hash || last.timestamp !== lastReply.timestamp || Array.isArray(last.content) && last.content.some((b) => b.type === "toolCall" || b.type === "tool_use")) lastReply = void 0;
      }
      const aborted = event.aborted === true || event.isError === true;
      if (aborted) {
        run.incomplete = true;
        lastReply = void 0;
      }
      if (run.boundary === "user" && lastReply && !aborted) run.finalReply = lastReply;
      run.state = aborted ? "aborted" : run.incomplete ? "incomplete" : "completed";
      run.endedAt = Date.now();
      await persist(run);
    }, ctx));
    pi.on("session_shutdown", (_event, ctx) => serial(async () => {
      if (run?.state === "running") {
        run.incomplete = true;
        run.state = "aborted";
        delete run.finalReply;
        run.endedAt = Date.now();
        await persist(run).catch(() => {
        });
      }
      disposed = true;
      pending.clear();
      seen.clear();
      observed.clear();
      run = null;
    }, ctx));
  };
}
var pluginRoot = path3.resolve(path3.dirname(fileURLToPath(import.meta.url)), "..");
var capture_default = createCaptureExtension({ pluginRoot });
export {
  createCaptureExtension,
  capture_default as default
};
