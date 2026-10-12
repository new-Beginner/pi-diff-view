// src/agent/capture.ts
import fs5 from "node:fs/promises";
import path5 from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID as randomUUID3 } from "node:crypto";

// src/core/path-policy.ts
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// src/core/contracts.ts
var MAX_TEXT_BYTES = 2 * 1024 * 1024;

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
function hostScratchRoot(value) {
  const portable = value.replace(/\\/g, "/");
  if (!/^(?:[a-z]:\/|\/[^/])/i.test(portable)) return void 0;
  const match = /\/(?:\.pi-desktoooop|\.pi-desktop)\/data\/scratch\/[a-zA-Z0-9-]{1,80}(?=\/|$)/gi;
  let found, root;
  while (found = match.exec(portable)) root = portable.slice(0, found.index + found[0].length);
  return root;
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
  addToPath(path6, added, removed, oldPosInc, options) {
    const last = path6.lastComponent;
    if (last && !options.oneChangePerToken && last.added === added && last.removed === removed) {
      return {
        oldPos: path6.oldPos + oldPosInc,
        lastComponent: { count: last.count + 1, added, removed, previousComponent: last.previousComponent }
      };
    } else {
      return {
        oldPos: path6.oldPos + oldPosInc,
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
function stats(before, after) {
  let additions = 0, deletions = 0;
  for (const hunk of buildHunks(before, after)) for (const line of hunk.lines) {
    if (line.kind === "add") additions++;
    if (line.kind === "del") deletions++;
  }
  return { additions, deletions };
}

// src/core/storage.ts
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
function validId(id2) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(id2)) fail("INVALID_ID", "Invalid record identifier");
}
function validRun(run, id2) {
  if (!run || ![1, 2].includes(run.version) || run.id !== id2 || typeof run.sessionId !== "string" || !path2.isAbsolute(run.root) || !run.changes || Array.isArray(run.changes) || Object.keys(run.changes).length > 256 || !Array.isArray(run.replies) || !run.bindings) return false;
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
    for (const sub of ["blobs", "inbox", "runs", "backups", "evidence"]) await fs2.mkdir(path2.join(this.directory, sub), { recursive: true, mode: 448 });
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
  async inspect(snapshot) {
    if (!snapshot.exists || snapshot.kind !== "text") return { ...snapshot };
    if (!/^[a-f0-9]{64}$/.test(snapshot.hash)) return { ...snapshot, kind: "unavailable", text: null };
    try {
      const stat = await fs2.lstat(path2.join(this.directory, "blobs", snapshot.hash));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024 || stat.size !== snapshot.size) throw new Error("Unsafe blob");
      return { ...snapshot, text: null };
    } catch {
      return { ...snapshot, kind: "unavailable", text: null };
    }
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
      const fileCount = Object.keys(run.changes).length;
      if (!fileCount) {
        if (run.state === "running") {
          const { prompt: _prompt, finalReply: _reply, cardPreview: _preview, ...marker } = run;
          await atomicJson(path2.join(this.directory, inbox ? "inbox" : "runs", `${run.id}.json`), { ...marker, fileCount: 0, changes: {}, replies: [], bindings: {} });
        } else {
          for (const sub of ["runs", "inbox"]) await fs2.rm(path2.join(this.directory, sub, `${run.id}.json`), { force: true });
        }
        return;
      }
      for (const [p, c] of Object.entries(run.changes)) {
        let diffStats = c.diffStats;
        if (diffStats?.beforeHash !== c.before.hash || diffStats?.afterHash !== c.after.hash) diffStats = void 0;
        if (!diffStats && c.before.kind === "text" && c.after.kind === "text" && (!c.before.exists || c.before.text !== null) && (!c.after.exists || c.after.text !== null)) {
          try {
            diffStats = { beforeHash: c.before.hash, afterHash: c.after.hash, ...stats(c.before.text ?? "", c.after.text ?? "") };
          } catch {
          }
        }
        changes[p] = { ...c, diffStats, before: await this.saveBlob(c.before), after: await this.saveBlob(c.after) };
      }
      await atomicJson(path2.join(this.directory, inbox ? "inbox" : "runs", `${run.id}.json`), { ...run, fileCount, changes });
    };
    if (inbox) await this.captureLock(save);
    else await save();
  }
  async getRun(id2, inbox = false, hydrate = true) {
    validId(id2);
    const run = await readJson(path2.join(this.directory, inbox ? "inbox" : "runs", `${id2}.json`), null);
    if (!run || !validRun(run, id2)) return null;
    if (hydrate) for (const [p, c] of Object.entries(run.changes)) run.changes[p] = { ...c, before: await this.hydrate(c.before), after: await this.hydrate(c.after) };
    return run;
  }
  async importInbox(generation) {
    await this.captureLock(async () => {
      const entries = (await fs2.readdir(path2.join(this.directory, "inbox"))).filter((e) => /^[\w-]+\.json$/.test(e)).slice(0, MAX_RUNS);
      for (const entry of entries) {
        const id2 = entry.slice(0, -5);
        try {
          const run = await this.getRun(id2, true, false);
          if (!run) continue;
          const current = await this.getRun(id2, false, false);
          if (current?.hostRecovery && (run.contentVersion ?? 0) <= current.hostRecovery.captureVersion) continue;
          const sameReply = run.finalReply?.hash === current?.finalReply?.hash && run.finalReply?.timestamp === current?.finalReply?.timestamp;
          run.bindings = sameReply ? current?.bindings ?? {} : {};
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
  async listRuns(hydrate = true, includeUnchanged = false) {
    const files = (await fs2.readdir(path2.join(this.directory, "runs"))).filter((e) => /^[\w-]+\.json$/.test(e));
    const runs = [];
    const selected = files.slice(-MAX_RUNS * 2);
    for (let offset = 0; offset < selected.length; offset += 16) {
      const page = await Promise.all(selected.slice(offset, offset + 16).map(async (file) => {
        try {
          return await this.getRun(file.slice(0, -5), false, hydrate);
        } catch {
          return null;
        }
      }));
      for (const run of page) if (run && (includeUnchanged || Object.keys(run.changes).length > 0)) runs.push(run);
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
    for (const file of await fs2.readdir(path2.join(this.directory, "runs"))) if (/^[\w-]+\.json$/.test(file) && !keep.has(file.slice(0, -5))) await fs2.rm(path2.join(this.directory, "runs", file), { force: true });
  }
  async clear() {
    await this.captureLock(async () => {
      for (const inbox of [false, true]) for (const file of await fs2.readdir(path2.join(this.directory, inbox ? "inbox" : "runs"))) {
        if (!/^[\w-]+\.json$/.test(file)) continue;
        const run = await this.getRun(file.slice(0, -5), inbox, false);
        if (run?.state === "running") fail("AGENT_BUSY", "Stop active captures before clearing history");
      }
      for (const sub of ["runs", "inbox", "blobs", "backups", "evidence"]) {
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

// src/agent/workspace-capture.ts
import fs4 from "node:fs/promises";
import path4 from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";

// src/core/capture-context.ts
import fs3 from "node:fs/promises";
import path3 from "node:path";
var CAPTURE_CONTEXT_TTL = 6e3;
var id = (v) => typeof v === "string" && /^[a-zA-Z0-9-]{1,256}$/.test(v);
async function readCaptureContext(directory, generation, sessionId, root, now = Date.now()) {
  try {
    const file = path3.join(directory, "capture-contexts.json"), stat = await fs3.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) return null;
    const document = JSON.parse(await fs3.readFile(file, "utf8"));
    if (document.version !== 1 || document.generation !== generation || !Array.isArray(document.contexts) || document.contexts.length > 200) return null;
    const context = document.contexts.find((v) => v?.sessionId === sessionId);
    if (!context || context.running !== true || !id(context.taskId) || typeof context.root !== "string" || !path3.isAbsolute(context.root) || canonical(context.root) !== canonical(root) || !Number.isSafeInteger(context.since) || context.since <= 0 || context.since > now || !Number.isSafeInteger(context.updatedAt) || context.updatedAt > now || now - context.updatedAt > CAPTURE_CONTEXT_TTL) return null;
    return context;
  } catch {
    return null;
  }
}
async function checkScratchAncestry(value) {
  if (!hostScratchRoot(value)) return;
  const absolute = path3.resolve(value);
  let cursor = path3.parse(absolute).root;
  for (const segment of absolute.slice(cursor.length).split(path3.sep)) {
    cursor = path3.join(cursor, segment);
    const stat = await fs3.lstat(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe scratch capture ancestry");
  }
}

// src/agent/workspace-capture.ts
var WORKSPACE_NOTICE = "Workspace capture: at most 256 files, 4096 directory entries, 16 MiB text and 3 seconds per snapshot; credentials, private paths, dependencies and symlinks excluded. Only observed endpoints are retained; transient changes and uninstrumented/background writers cannot be proven. Renames are represented as deletion/addition.";
async function snapshotWorkspace(root, privatePaths) {
  const result = { paths: [], complete: true, notice: WORKSPACE_NOTICE };
  const deadline = Date.now() + 3e3;
  let entries = 0, bytes = 0;
  const walk = async (directory) => {
    if (Date.now() > deadline || entries >= 4096 || result.paths.length >= 256) {
      result.complete = false;
      return;
    }
    let dir;
    const directories = [];
    try {
      if (directory !== root) await safeResolve(root, directory);
      if (privatePaths.some((p) => inside(p, directory))) return;
      dir = await fs4.opendir(directory);
      for await (const entry of dir) {
        if (++entries > 4096 || Date.now() > deadline || result.paths.length >= 256) {
          result.complete = false;
          break;
        }
        const absolute = path4.join(directory, entry.name), relative = path4.relative(root, absolute);
        try {
          try {
            assertPublicPath(relative);
          } catch {
            continue;
          }
          if (privatePaths.some((p) => inside(p, absolute)) || entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) directories.push(absolute);
          else if (entry.isFile() && !isImagePath(relative)) {
            const capture = await resolveCapturePath(root, relative, privatePaths);
            let before = await readCapturedSnapshot(root, capture, privatePaths);
            if (before.text !== null) {
              bytes += before.size;
              if (bytes > 16 * 1024 * 1024) {
                before = { ...before, kind: "unavailable", text: null };
                result.complete = false;
              }
            }
            result.paths.push({ capture, before });
          } else if (entry.isFile()) continue;
          else result.complete = false;
        } catch {
          result.complete = false;
        }
      }
      for (const child of directories) await walk(child);
    } catch {
      result.complete = false;
    } finally {
      await dir?.close().catch(() => {
      });
    }
  };
  try {
    assertPublicPath(root);
    await checkScratchAncestry(root);
    await walk(root);
  } catch {
    result.complete = false;
  }
  return result;
}
async function journal(store, work) {
  return store.captureLock(async () => {
    const file = path4.join(store.directory, "capture-leases.json");
    let data;
    try {
      const stat = await fs4.stat(file);
      if (stat.size > 1024 * 1024) throw new Error("Capture lease journal exceeds limit");
      data = JSON.parse(await fs4.readFile(file, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.leases) || data.leases.some((l) => typeof l.id !== "string" || typeof l.root !== "string" || typeof l.ambiguous !== "boolean")) throw new Error("Invalid capture lease journal");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      data = { version: 1, leases: [] };
    }
    const result = work(data);
    await atomicJson(file, data);
    return result;
  });
}
async function beginCaptureLease(store, root, owner, scopes = []) {
  return journal(store, (data) => {
    if (data.leases.length >= 256) throw new Error("Capture lease limit reached; unresolved/background operations require a fresh store");
    const lease = { id: randomUUID2(), root, scopes: scopes.length ? [...new Set(scopes)] : [root], owner, ambiguous: false };
    for (const other of data.leases) if ((other.scopes ?? [other.root]).some((a) => lease.scopes.some((b) => inside(a, b) || inside(b, a)))) other.ambiguous = lease.ambiguous = true;
    data.leases.push(lease);
    return lease.id;
  });
}
async function endCaptureLease(store, id2) {
  return journal(store, (data) => {
    const lease = data.leases.find((l) => l.id === id2);
    data.leases = data.leases.filter((l) => l.id !== id2);
    return !lease || lease.ambiguous;
  });
}

// src/agent/capture.ts
var toolName = (name) => String(name).split(".").pop().toLowerCase();
var MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
function textContent(message) {
  if (typeof message?.content === "string") return message.content;
  return Array.isArray(message?.content) ? message.content.filter((b) => b.type === "text").map((b) => b.text).join("") : "";
}
function toolPaths(name, input) {
  const p = input?.path ?? input?.file_path;
  if (typeof p !== "string" || !["write", "edit"].includes(name)) return { targets: [], hadTargets: false, truncated: false };
  const targets = /* @__PURE__ */ new Set();
  let hadTargets = false, truncated = false;
  const add = (target) => {
    hadTargets = true;
    if (!isImagePath(target)) targets.add(target);
  };
  add(p);
  if (/^edit$/i.test(name) && typeof input.ops === "string") {
    let scanned = 0;
    for (const line of input.ops.split("\n")) if (line.startsWith("MV ")) {
      if (++scanned > 4096) {
        truncated = true;
        break;
      }
      add(line.slice(3).trim());
      if (targets.size > 256) {
        truncated = true;
        break;
      }
    }
  }
  return { targets: [...targets], hadTargets, truncated };
}
function createCaptureExtension(options) {
  return (pi) => {
    let run = null, store = null;
    const pending = /* @__PURE__ */ new Map();
    const waits = /* @__PURE__ */ new Set();
    let seen = /* @__PURE__ */ new Set(), retired = /* @__PURE__ */ new Set(), warned = false, disposed = false, tail = Promise.resolve();
    let lastReply, privatePaths = [], observed = /* @__PURE__ */ new Set(), settled = false;
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
      if (locator.generation !== target.generation || locator.dataPath !== store?.directory) {
        store = new SnapshotStore(locator.dataPath);
        await store.init();
        target.generation = locator.generation;
        privatePaths = [.../* @__PURE__ */ new Set([...privatePaths, await fs5.realpath(options.pluginRoot), locator.dataPath, options.locator ?? await locatorPath(options.pluginRoot)])];
        if (!target.notice?.includes("Capture locator refreshed")) target.notice = `${target.notice ?? ""} Capture locator refreshed during the current user task.`.trim();
      }
      return locator;
    };
    const persist = async (target) => {
      await check(target);
      target.fileCount = Object.values(target.changes).filter((c) => !c.ambiguous && !sameSnapshot(c.before, c.after)).length;
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
    const begin = async (ctx, uncertain = false, event) => {
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
      privatePaths = [await fs5.realpath(options.pluginRoot), locator.dataPath, options.locator ?? await locatorPath(options.pluginRoot)];
      await checkScratchAncestry(ctx.cwd);
      const root = await fs5.realpath(ctx.cwd);
      const identity = await readCaptureContext(locator.dataPath, locator.generation, ctx.sessionManager.getSessionId(), root);
      run = { version: 2, contentVersion: 0, boundary: uncertain && !identity ? "uncertain" : "user", id: randomUUID3(), generation: locator.generation, sessionId: ctx.sessionManager.getSessionId(), root, startedAt: Date.now(), state: "running", fileCount: 0, incomplete: uncertain, changes: /* @__PURE__ */ Object.create(null), replies: [], bindings: {} };
      const userId = event?.userMessageId ?? (event?.message?.role === "user" ? event.message.id : void 0) ?? identity?.taskId;
      if (typeof userId === "string" && userId.length > 0 && userId.length <= 256) run.userMessageId = userId;
      if (uncertain && identity) run.notice = "\u8FD0\u884C\u8EAB\u4EFD\u5DF2\u7531\u540C\u4F1A\u8BDD\u3001\u540C\u9879\u76EE\u7684\u5BBF\u4E3B\u5143\u6570\u636E\u6838\u9A8C\uFF1B\u4EC5\u8BB0\u5F55\u91C7\u96C6\u5F00\u59CB\u540E\u7684\u6709\u754C\u53D8\u66F4\u3002";
      for (const id2 of seen) retired.add(id2);
      while (retired.size > 4096) retired.delete(retired.keys().next().value);
      pending.clear();
      waits.clear();
      seen.clear();
      observed.clear();
      warned = false;
      lastReply = void 0;
      settled = false;
      await persist(run);
    };
    pi.on("before_agent_start", (event, ctx) => serial(() => begin(ctx, false, event), ctx));
    pi.on("agent_start", (_event, ctx) => serial(async () => {
      if (disposed || settled || !run || run.state === "running" || run.state === "aborted" || run.sessionId !== ctx.sessionManager.getSessionId() || run.root !== await fs5.realpath(ctx.cwd)) return;
      await check(run);
      run.state = "running";
      delete run.endedAt;
      delete run.finalReply;
      delete run.cardPreview;
      run.bindings = {};
      lastReply = void 0;
      await persist(run);
    }, ctx));
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
      const name = toolName(event.toolName), targetSet = toolPaths(name, event.input ?? event.args), targets = targetSet.targets;
      const workspace = ["bash", "shell", "task"].includes(name);
      if (name === "taskwait" || name === "task_wait") {
        waits.add(event.toolCallId);
        return;
      }
      if (targetSet.hadTargets && targets.length === 0 && !targetSet.truncated) return;
      if (!targets.length && !workspace) {
        if (["write", "edit"].includes(name) || name.startsWith("plugin_")) {
          run.incomplete = true;
          await persist(run);
        }
        return;
      }
      const leaseStore = store, lease = await beginCaptureLease(leaseStore, run.root, run.id, targets.slice(0, 256).map((p) => path5.resolve(run.root, p)));
      const captured = { run, paths: [], store: leaseStore, lease, name, workspace, complete: true, task: name === "task" };
      pending.set(event.toolCallId, captured);
      if (workspace) {
        const snapshot = await snapshotWorkspace(run.root, privatePaths);
        captured.complete = snapshot.complete;
        for (const entry of snapshot.paths) captured.paths.push({ ...entry, before: bounded(entry.before) });
        run.notice = WORKSPACE_NOTICE + (captured.task ? " Task is sampled at TaskWait/agent_end, not at launch; child runners should load this extension. Parent endpoints are ambiguous and do not prove child completion." : " Shell coverage ends at tool_result; background writes after return are unsupported.");
        if (!snapshot.complete || captured.task) run.incomplete = true;
      } else {
        if (targetSet.truncated || targets.length > 256) run.incomplete = true;
        for (const [index, target] of targets.slice(0, 256).entries()) {
          try {
            const capture = await resolveCapturePath(run.root, target, privatePaths, name === "write" || index > 0);
            if (!observed.has(capture.identity) && observed.size >= 256) throw new Error("Turn exceeds 256 explicitly captured files");
            observed.add(capture.identity);
            const before = bounded(await readCapturedSnapshot(run.root, capture, privatePaths), captured.paths.map((e) => e.before));
            if (before.kind !== "text") run.incomplete = true;
            captured.paths.push({ capture, before });
          } catch {
            run.incomplete = true;
          }
        }
      }
      await persist(run);
    }, ctx));
    const finish = async (id2, captured, isError = false, sample = false) => {
      const target = captured.run;
      await check(target);
      const pairs = [];
      const retain = (snapshot) => bounded(snapshot, pairs.map((pair) => pair.after));
      if (captured.workspace) {
        const current = await snapshotWorkspace(target.root, privatePaths);
        if (!current.complete) target.incomplete = true;
        const remaining = new Map(current.paths.map((e) => [e.capture.identity, e]));
        for (const entry of captured.paths) {
          const live = remaining.get(entry.capture.identity);
          remaining.delete(entry.capture.identity);
          try {
            pairs.push({ entry, after: retain(live?.before ?? await readCapturedSnapshot(target.root, entry.capture, privatePaths)) });
          } catch {
            target.incomplete = true;
          }
        }
        for (const entry of remaining.values()) pairs.push({ entry: { capture: entry.capture, before: absentSnapshot() }, after: retain(entry.before), uncertain: !captured.complete });
      } else for (const entry of captured.paths) {
        try {
          pairs.push({ entry, after: retain(await readCapturedSnapshot(target.root, entry.capture, privatePaths)) });
        } catch {
          target.incomplete = true;
        }
      }
      const overlap = sample ? true : await endCaptureLease(captured.store, captured.lease) || captured.store.directory !== store.directory;
      if (!sample) pending.delete(id2);
      if (isError) target.incomplete = true;
      for (const { entry, after: rawAfter, uncertain } of pairs) {
        if (sameSnapshot(entry.before, rawAfter)) continue;
        const priorKey = Object.keys(target.changes).find((p) => target.changes[p].capture?.identity === entry.capture.identity);
        const prior = priorKey ? target.changes[priorKey] : void 0;
        if (!prior && Object.keys(target.changes).length >= 256) {
          target.incomplete = true;
          continue;
        }
        const ambiguous = !!(overlap || uncertain || captured.task || prior?.ambiguous || prior && !sameSnapshot(prior.after, entry.before));
        let before = prior?.before ?? entry.before, after = bounded(rawAfter, captured.paths.map((e) => e.before));
        if (ambiguous) {
          before = { ...before, text: null, kind: "unavailable" };
          after = { ...after, text: null, kind: "unavailable" };
          target.incomplete = true;
        }
        if (after.kind !== "text") target.incomplete = true;
        target.changes[priorKey ?? entry.capture.path] = {
          capture: prior?.capture ?? entry.capture,
          before,
          after,
          evidence: [...prior?.evidence ?? [], `${captured.name}:${id2}`].slice(-32),
          ...captured.workspace && !ambiguous ? { note: "Observed workspace endpoints during a tool interval, not authoritative process-level authorship evidence." } : {},
          ...ambiguous ? { ambiguous: true, note: "Overlapping, discontinuous or delegated capture interval: file ownership is uncertain; diff and line counts unavailable." } : {}
        };
      }
      if (sample) {
        captured.paths = [];
        for (const pair of pairs.slice(0, 256)) captured.paths.push({ capture: pair.entry.capture, before: bounded(pair.after) });
      }
      await persist(target);
    };
    pi.on("tool_result", (event, ctx) => serial(async () => {
      if (disposed || !run || run.sessionId !== ctx.sessionManager.getSessionId()) return;
      const captured = pending.get(event.toolCallId);
      if (!captured) {
        if (waits.delete(event.toolCallId) || ["taskwait", "task_wait"].includes(toolName(event.toolName))) {
          for (const [id2, task] of pending) if (task.task) await finish(id2, task, !!event.isError, true);
        }
        return;
      }
      if (captured.run !== run || run.state !== "running") return;
      lastReply = void 0;
      if (captured.task) {
        await persist(run);
        return;
      }
      await finish(event.toolCallId, captured, !!event.isError);
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
      const reply = { hash: digest(text.trim()), timestamp: message.timestamp };
      if (!run.replies.some((r) => r.hash === reply.hash && r.timestamp === reply.timestamp)) run.replies.push(reply);
      run.replies = run.replies.slice(-20);
      if (!pending.size && !["error", "aborted", "toolUse", "tool_use", "length"].includes(message.stopReason)) lastReply = reply;
      else if (["error", "aborted", "length"].includes(message.stopReason)) run.incomplete = true;
      await persist(run);
    }, ctx));
    pi.on("agent_end", (event, ctx) => serial(async () => {
      if (!run || run.state !== "running" || run.sessionId !== ctx.sessionManager.getSessionId()) return;
      await check(run);
      for (const [id2, captured] of pending) if (captured.task) await finish(id2, captured, false, true);
      if (pending.size) {
        run.incomplete = true;
        pending.clear();
        lastReply = void 0;
      }
      const messages = Array.isArray(event.messages) ? event.messages : void 0;
      if (messages) {
        const last = [...messages].reverse().find((m) => m.role === "assistant");
        if (!last || !lastReply || digest(textContent(last).trim()) !== lastReply.hash || last.timestamp !== lastReply.timestamp || Array.isArray(last.content) && last.content.some((b) => b.type === "toolCall" || b.type === "tool_use")) lastReply = void 0;
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
    pi.on("agent_settled", (_event, ctx) => serial(async () => {
      if (run?.sessionId === ctx.sessionManager.getSessionId()) settled = true;
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
var pluginRoot = path5.resolve(path5.dirname(fileURLToPath(import.meta.url)), "..");
var capture_default = createCaptureExtension({ pluginRoot });
export {
  createCaptureExtension,
  capture_default as default
};
