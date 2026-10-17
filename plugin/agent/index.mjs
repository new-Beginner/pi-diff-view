var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};

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
function assertSessionScratchPath(value, sessionId, projectRoot) {
  const scratch = hostScratchRoot(value);
  if (!scratch || scratch.slice(scratch.lastIndexOf("/") + 1) === sessionId) return;
  const portable = (path7) => {
    const value2 = path7.replace(/\\/g, "/").replace(/\/$/, "");
    return /^[a-z]:\//i.test(value2) ? value2.toLowerCase() : value2;
  };
  const assigned = projectRoot && hostScratchRoot(projectRoot);
  if (projectRoot && assigned && portable(assigned) !== portable(scratch) && portable(assigned).startsWith(`${portable(scratch)}/`)) return;
  if (projectRoot && assigned === scratch && portable(projectRoot) !== portable(scratch) && (portable(value) === portable(projectRoot) || portable(value).startsWith(`${portable(projectRoot)}/`))) return;
  deny("PATH_DENIED", "Scratch evidence belongs to another session");
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
var init_public_path = __esm({
  "src/core/public-path.ts"() {
    "use strict";
  }
});

// src/core/contracts.ts
var MAX_TEXT_BYTES, MAX_CAPTURE_SEGMENTS;
var init_contracts = __esm({
  "src/core/contracts.ts"() {
    "use strict";
    MAX_TEXT_BYTES = 2 * 1024 * 1024;
    MAX_CAPTURE_SEGMENTS = 32;
  }
});

// src/core/path-policy.ts
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
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
var init_path_policy = __esm({
  "src/core/path-policy.ts"() {
    "use strict";
    init_contracts();
    init_public_path();
    init_public_path();
  }
});

// node_modules/diff/libesm/diff/base.js
var Diff;
var init_base = __esm({
  "node_modules/diff/libesm/diff/base.js"() {
    Diff = class {
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
      addToPath(path7, added, removed, oldPosInc, options) {
        const last = path7.lastComponent;
        if (last && !options.oneChangePerToken && last.added === added && last.removed === removed) {
          return {
            oldPos: path7.oldPos + oldPosInc,
            lastComponent: { count: last.count + 1, added, removed, previousComponent: last.previousComponent }
          };
        } else {
          return {
            oldPos: path7.oldPos + oldPosInc,
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
  }
});

// node_modules/diff/libesm/diff/line.js
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
var LineDiff, lineDiff;
var init_line = __esm({
  "node_modules/diff/libesm/diff/line.js"() {
    init_base();
    LineDiff = class extends Diff {
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
    lineDiff = new LineDiff();
  }
});

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
var init_create = __esm({
  "node_modules/diff/libesm/patch/create.js"() {
    init_line();
  }
});

// node_modules/diff/libesm/index.js
var init_libesm = __esm({
  "node_modules/diff/libesm/index.js"() {
    init_create();
  }
});

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
var init_diff = __esm({
  "src/core/diff.ts"() {
    "use strict";
    init_libesm();
  }
});

// src/core/capture-leases.ts
var capture_leases_exports = {};
__export(capture_leases_exports, {
  beginCaptureLease: () => beginCaptureLease,
  closeCaptureLease: () => closeCaptureLease,
  endCaptureLease: () => endCaptureLease,
  inspectCaptureLeases: () => inspectCaptureLeases,
  prepareCaptureLease: () => prepareCaptureLease,
  retireLegacyCaptureLeases: () => retireLegacyCaptureLeases,
  writeCaptureLeases: () => writeCaptureLeases
});
import fs2 from "node:fs/promises";
import path2 from "node:path";
import { randomUUID } from "node:crypto";
function validate(data) {
  if (data.version !== 1 || !Array.isArray(data.leases) || data.leases.length > 256 || new Set(data.leases.map((l) => l.id)).size !== data.leases.length) throw new Error("Invalid capture lease journal");
  for (const l of data.leases) {
    if (typeof l.id !== "string" || typeof l.root !== "string" || typeof l.ambiguous !== "boolean" || l.closed !== void 0 && typeof l.closed !== "boolean") throw new Error("Invalid capture lease");
    const p = l.prepared;
    if (!p) continue;
    if (![l.owner, l.sessionId, l.executionId].every((id3) => typeof id3 === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(id3)) || typeof l.toolCallId !== "string" || !l.toolCallId.length || l.toolCallId.length > 256 || !path2.isAbsolute(l.root) || typeof p.name !== "string" || p.name.length > 100 || p.userMessageId !== void 0 && (typeof p.userMessageId !== "string" || p.userMessageId.length > 256) || !Array.isArray(p.paths) || p.paths.length > 256) throw new Error("Invalid preparation identity");
    for (const { capture: c, before: s } of p.paths) {
      if (!c || !s || typeof c.absolutePath !== "string" || !path2.isAbsolute(c.absolutePath) || c.identity !== canonical(c.absolutePath) || c.id !== digest(c.identity).slice(0, 24)) throw new Error("Invalid preparation path");
      assertPublicPath(c.path);
      assertPublicPath(c.absolutePath);
      if (c.origin === "workspace" ? path2.isAbsolute(c.path) || !inside(l.root, c.absolutePath) || canonical(path2.resolve(l.root, c.path)) !== c.identity : c.origin !== "external" || inside(l.root, c.absolutePath) || canonical(c.path) !== c.identity) throw new Error("Invalid preparation scope");
      if (!(l.scopes ?? []).some((scope) => canonical(scope) === c.identity) || s.text !== null || typeof s.exists !== "boolean" || typeof s.hash !== "string" || !Number.isFinite(s.size) || s.size < 0 || !Number.isFinite(s.mode) || !["text", "binary", "large", "symlink", "submodule", "conflict", "unavailable"].includes(s.kind)) throw new Error("Invalid preparation endpoint");
      if (s.kind === "text" && (s.exists ? !/^[a-f0-9]{64}$/.test(s.hash) || s.size > 2 * 1024 * 1024 : s.hash !== "absent" || s.size !== 0)) throw new Error("Invalid preparation text");
    }
  }
}
async function inspectCaptureLeases(store) {
  const file = path2.join(store.directory, "capture-leases.json");
  const stat = await fs2.lstat(file).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return { fingerprint: digest("absent"), leases: [] };
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JOURNAL_BYTES) throw new Error("Unsafe lease journal");
  const text = await fs2.readFile(file, "utf8"), data = JSON.parse(text);
  validate(data);
  return { fingerprint: digest(text), leases: data.leases };
}
async function writeCaptureLeases(store, leases) {
  const data = { version: 1, leases };
  validate(data);
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_JOURNAL_BYTES) throw new Error("Capture lease journal exceeds limit");
  await atomicJson(path2.join(store.directory, "capture-leases.json"), data);
}
async function journal(store, work) {
  return store.captureLock(async () => {
    const { leases } = await inspectCaptureLeases(store);
    const result = work(leases);
    await writeCaptureLeases(store, leases);
    return result;
  });
}
async function beginCaptureLease(store, root, owner, scopes = [], lifecycle = {}) {
  return journal(store, (leases) => {
    if (leases.length >= 256) throw new Error("Capture lease limit reached; verify unresolved writers before retiring leases");
    const lease = { id: randomUUID(), root, scopes: scopes.length ? [...new Set(scopes)] : [root], owner, ambiguous: false, ...lifecycle };
    for (const other of leases) if (!other.closed && (other.scopes ?? [other.root]).some((a) => lease.scopes.some((b) => inside(a, b) || inside(b, a)))) other.ambiguous = lease.ambiguous = true;
    leases.push(lease);
    return lease.id;
  });
}
async function prepareCaptureLease(store, id3, preparation) {
  await store.captureLock(async () => {
    const { leases } = await inspectCaptureLeases(store), lease = leases.find((l) => l.id === id3);
    if (!lease || lease.prepared) throw new Error("Missing or already prepared capture lease");
    const paths = [];
    for (const entry of preparation.paths) paths.push({ capture: entry.capture, before: await store.saveBlob(entry.before) });
    lease.prepared = { ...preparation, paths };
    await writeCaptureLeases(store, leases);
  });
}
async function closeCaptureLease(store, id3) {
  return journal(store, (leases) => {
    const lease = leases.find((l) => l.id === id3);
    if (lease) lease.closed = true;
    return !lease || lease.ambiguous;
  });
}
async function endCaptureLease(store, id3) {
  return journal(store, (leases) => {
    const index = leases.findIndex((l) => l.id === id3), lease = leases[index];
    if (index >= 0) leases.splice(index, 1);
    return !lease || lease.ambiguous;
  });
}
async function retireLegacyCaptureLeases(store, root, ids, fingerprint, writersStopped) {
  if (!writersStopped || !ids.length || new Set(ids).size !== ids.length) throw new Error("Explicit confirmation of stopped legacy writers is required");
  await store.captureLock(async () => {
    const current = await inspectCaptureLeases(store);
    if (current.fingerprint !== fingerprint) throw new Error("Lease journal changed; inspect again");
    const selected = current.leases.filter((l) => ids.includes(l.id));
    if (selected.length !== ids.length || selected.some((l) => canonical(l.root) !== canonical(root) || l.sessionId || l.toolCallId || l.executionId)) throw new Error("Unverified or non-legacy lease selection");
    await atomicJson(path2.join(store.directory, "backups", `leases-${fingerprint}.json`), { version: 1, leases: current.leases });
    await writeCaptureLeases(store, current.leases.filter((l) => !ids.includes(l.id)));
  });
}
var MAX_JOURNAL_BYTES;
var init_capture_leases = __esm({
  "src/core/capture-leases.ts"() {
    "use strict";
    init_path_policy();
    init_storage();
    MAX_JOURNAL_BYTES = 1024 * 1024;
  }
});

// src/core/storage.ts
import fs3 from "node:fs/promises";
import path3 from "node:path";
import os from "node:os";
import { randomUUID as randomUUID2 } from "node:crypto";
function captureCheckpoint(change) {
  const snapshot = (value) => [value.exists, value.kind, value.hash, value.size, value.mode];
  return digest(JSON.stringify(change ? [change.capture, change.evidence, change.ambiguous, change.note, snapshot(change.before), snapshot(change.after), change.segments?.map((s) => [s.evidence, s.ambiguous, s.conflicted, snapshot(s.before), snapshot(s.after)]), change.segmentsTruncated] : null));
}
async function atomicJson(file, value) {
  await fs3.mkdir(path3.dirname(file), { recursive: true, mode: 448 });
  const temp = `${file}.${randomUUID2()}.tmp`;
  try {
    await fs3.writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 384 });
    await fs3.rename(temp, file);
  } finally {
    await fs3.rm(temp, { force: true });
  }
}
async function readJson(file, fallback) {
  try {
    const s = await fs3.stat(file);
    if (s.size > 16 * 1024 * 1024) fail("STORE_LIMIT", "Store record too large");
    return JSON.parse(await fs3.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== void 0) return fallback;
    throw error;
  }
}
async function locatorPath(pluginRoot2) {
  return path3.join(os.homedir(), ".pi-diff-view", "locators", `${digest(canonical(await fs3.realpath(pluginRoot2)))}.json`);
}
async function resolveLocator(file, pluginRoot2) {
  const locator = await readJson(file);
  if (locator.version !== 1 || typeof locator.generation !== "string" || !/^[\w-]{20,80}$/.test(locator.generation) || locator.expiresAt < Date.now() || locator.expiresAt > Date.now() + 9e4 || canonical(locator.pluginRoot) !== canonical(await fs3.realpath(pluginRoot2))) fail("BRIDGE_UNAVAILABLE", "Diff view capture bridge is missing or expired; reload the plugin");
  if (!path3.isAbsolute(locator.dataPath)) fail("BRIDGE_INVALID", "Invalid plugin storage path");
  const stat = await fs3.lstat(locator.dataPath);
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonical(await fs3.realpath(locator.dataPath)) !== canonical(locator.dataPath)) fail("BRIDGE_INVALID", "Unsafe plugin storage root");
  return locator;
}
function validId(id3) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(id3)) fail("INVALID_ID", "Invalid record identifier");
}
function validRun(run, id3) {
  if (!run || ![1, 2].includes(run.version) || run.id !== id3 || typeof run.sessionId !== "string" || !path3.isAbsolute(run.root) || !run.changes || Array.isArray(run.changes) || Object.keys(run.changes).length > 256 || !Array.isArray(run.replies) || !run.bindings) return false;
  try {
    for (const [value, change] of Object.entries(run.changes)) {
      assertPublicPath(value);
      if (change.segments !== void 0 && (!Array.isArray(change.segments) || change.segments.length > MAX_CAPTURE_SEGMENTS || change.segments.some((s) => !s || typeof s.evidence !== "string" || s.evidence.length > 1024 || !s.evidence.includes(":") || s.ambiguous !== void 0 && typeof s.ambiguous !== "boolean" || s.conflicted !== void 0 && (s.conflicted !== true || s.ambiguous !== true)))) return false;
      for (const snapshot of [change.before, change.after, ...(change.segments ?? []).flatMap((s) => [s.before, s.after])]) if (!snapshot || typeof snapshot.exists !== "boolean" || typeof snapshot.hash !== "string" || !Number.isFinite(snapshot.size) || snapshot.size < 0 || !Number.isFinite(snapshot.mode) || !["text", "binary", "large", "symlink", "submodule", "conflict", "unavailable"].includes(snapshot.kind)) return false;
      if (run.version === 1) {
        if (path3.isAbsolute(value) || !inside(run.root, path3.resolve(run.root, value))) return false;
      } else {
        const c = change.capture;
        if (!c || c.path !== value || !path3.isAbsolute(c.absolutePath) || c.identity !== canonical(c.absolutePath) || c.id !== digest(c.identity).slice(0, 24)) return false;
        if (c.origin === "workspace") {
          if (path3.isAbsolute(value) || !inside(run.root, c.absolutePath) || canonical(path3.resolve(run.root, value)) !== c.identity) return false;
        } else if (c.origin !== "external" || inside(run.root, c.absolutePath) || canonical(value) !== c.identity) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
var MAX_RUNS, MAX_HISTORY_BYTES, SnapshotStore;
var init_storage = __esm({
  "src/core/storage.ts"() {
    "use strict";
    init_path_policy();
    init_diff();
    init_contracts();
    MAX_RUNS = 200;
    MAX_HISTORY_BYTES = 128 * 1024 * 1024;
    SnapshotStore = class {
      constructor(directory) {
        this.directory = directory;
      }
      pendingRecovery = /* @__PURE__ */ new Set();
      needsRecovery(sessionId) {
        return this.pendingRecovery.has(sessionId);
      }
      acknowledgeRecovery(sessionId) {
        this.pendingRecovery.delete(sessionId);
      }
      async init() {
        for (const sub of ["blobs", "inbox", "runs", "contributions", "backups", "evidence"]) await fs3.mkdir(path3.join(this.directory, sub), { recursive: true, mode: 448 });
      }
      /** Called under captureLock after the destination has been durably written. */
      async retireRun(from, to) {
        validId(from);
        validId(to);
        if (from === to) return;
        const target = await this.getRun(to, false, false);
        const recorded = await this.getRun(from, false, false);
        const stableHostId = target?.userMessageId && `host-${digest(`${target.sessionId}\0${target.userMessageId}`).slice(0, 48)}`;
        const source = recorded ?? (from === stableHostId && target ? { ...target, id: from } : null);
        if (!source || !target || source.sessionId !== target.sessionId || source.userMessageId !== target.userMessageId) fail("REPAIR_IDENTITY", "Cannot retire unverified run identity");
        const fileAliases = await readJson(path3.join(this.directory, "file-aliases.json"), {});
        const paths = /* @__PURE__ */ new Map();
        for (const [value, change] of Object.entries(source.changes)) {
          const match = target.changes[value] ? value : Object.keys(target.changes).find((p) => target.changes[p].capture?.identity === change.capture?.identity);
          if (!match) continue;
          paths.set(value, match);
          if (change.capture?.id && target.changes[match].capture?.id) fileAliases[`${from}:${change.capture.id}`] = target.changes[match].capture.id;
        }
        await atomicJson(path3.join(this.directory, "file-aliases.json"), fileAliases);
        const comments = await this.comments();
        for (const comment of comments) if (comment.sessionId === source.sessionId && comment.anchor.runId === from && canonical(comment.anchor.root) === canonical(source.root) && paths.has(comment.anchor.path)) {
          comment.anchor = { ...comment.anchor, runId: to, root: target.root, path: paths.get(comment.anchor.path) };
          comment.stale = true;
        }
        await this.saveComments(comments);
        const aliases = await readJson(path3.join(this.directory, "run-aliases.json"), {});
        aliases[from] = to;
        await atomicJson(path3.join(this.directory, "run-aliases.json"), aliases);
        if (recorded) await atomicJson(path3.join(this.directory, "contributions", `${from}.json`), { ...recorded, userMessageId: target.userMessageId });
        for (const sub of ["runs", "inbox"]) await fs3.rm(path3.join(this.directory, sub, `${from}.json`), { force: true });
      }
      async resolveFileId(runId, fileId) {
        if (!fileId) return fileId;
        const aliases = await readJson(path3.join(this.directory, "file-aliases.json"), {});
        return aliases[`${runId}:${fileId}`] ?? fileId;
      }
      async captureLock(work) {
        const lock = path3.join(this.directory, "capture.lock");
        let handle;
        for (let attempt = 0; attempt < 80 && !handle; attempt++) {
          try {
            handle = await fs3.open(lock, "wx", 384);
            await handle.writeFile(JSON.stringify({ pid: process.pid }));
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
            const owner = await readJson(lock, null).catch(() => null);
            if (owner?.pid && owner.pid !== process.pid) {
              try {
                process.kill(owner.pid, 0);
              } catch (e) {
                if (e.code === "ESRCH") await fs3.rm(lock, { force: true });
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
          await fs3.rm(lock, { force: true });
        }
      }
      async saveBlob(snapshot) {
        if (snapshot.kind === "text" && snapshot.exists && snapshot.text !== null) {
          if (!/^[a-f0-9]{64}$/.test(snapshot.hash) || digest(snapshot.text) !== snapshot.hash) fail("SNAPSHOT_INVALID", "Snapshot content hash does not match");
          const file = path3.join(this.directory, "blobs", snapshot.hash);
          if (!await fs3.stat(file).catch(() => null)) {
            const lock = path3.join(this.directory, "quota.lock");
            let handle;
            for (let attempt = 0; attempt < 40 && !handle; attempt++) {
              try {
                handle = await fs3.open(lock, "wx", 384);
              } catch (error) {
                if (error.code !== "EEXIST") throw error;
                const s = await fs3.stat(lock).catch(() => null);
                if (s && Date.now() - s.mtimeMs > 6e4) await fs3.rm(lock, { force: true });
                else await new Promise((r) => setTimeout(r, 25));
              }
            }
            if (!handle) fail("STORE_BUSY", "Snapshot store is busy; capture marked incomplete");
            try {
              const entries = await fs3.readdir(path3.dirname(file));
              if (entries.length > 4096) fail("STORE_LIMIT", "Snapshot limit reached; clear plugin history after stopping Agents");
              let size = 0;
              for (let offset = 0; offset < entries.length; offset += 16) {
                const batch = entries.slice(offset, offset + 16);
                const sizes = await Promise.all(batch.map((entry) => fs3.stat(path3.join(path3.dirname(file), entry)).then((stat) => stat.size)));
                size += sizes.reduce((total, value) => total + value, 0);
              }
              if (size + snapshot.size > MAX_HISTORY_BYTES) fail("STORE_LIMIT", "128 MiB snapshot capacity reached; clear plugin history after stopping Agents");
              const temp = `${file}.${randomUUID2()}.tmp`;
              try {
                await fs3.writeFile(temp, snapshot.text, { flag: "wx", mode: 384 });
                await fs3.rename(temp, file);
              } finally {
                await fs3.rm(temp, { force: true });
              }
            } finally {
              await handle.close();
              await fs3.rm(lock, { force: true });
            }
          }
        }
        return { ...snapshot, text: null };
      }
      async inspect(snapshot) {
        if (!snapshot.exists || snapshot.kind !== "text") return { ...snapshot };
        if (!/^[a-f0-9]{64}$/.test(snapshot.hash)) return { ...snapshot, kind: "unavailable", text: null };
        try {
          const stat = await fs3.lstat(path3.join(this.directory, "blobs", snapshot.hash));
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
          const file = path3.join(this.directory, "blobs", snapshot.hash);
          const stat = await fs3.lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("Unsafe blob");
          const bytes = await fs3.readFile(file);
          if (digest(bytes) !== snapshot.hash) throw new Error("Corrupt blob");
          return { ...snapshot, text: bytes.toString("utf8") };
        } catch {
          return { ...snapshot, kind: "unavailable", text: null };
        }
      }
      async writeRun(run, inbox = false) {
        const save = async () => {
          const saved = /* @__PURE__ */ new Map();
          const saveSnapshot = (snapshot) => {
            let value = saved.get(snapshot);
            if (!value) {
              value = this.saveBlob(snapshot);
              saved.set(snapshot, value);
            }
            return value;
          };
          validId(run.id);
          const changes = /* @__PURE__ */ Object.create(null);
          if (Object.keys(run.changes).length > 256) fail("STORE_LIMIT", "Turn exceeds 256 captured files");
          const fileCount = Object.keys(run.changes).length;
          if (!fileCount) {
            if (run.state === "running") {
              const { prompt: _prompt, finalReply: _reply, cardPreview: _preview, ...marker } = run;
              await atomicJson(path3.join(this.directory, inbox ? "inbox" : "runs", `${run.id}.json`), { ...marker, fileCount: 0, changes: {}, replies: [], bindings: {} });
            } else {
              for (const sub of ["runs", "inbox"]) await fs3.rm(path3.join(this.directory, sub, `${run.id}.json`), { force: true });
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
            if (c.segments && c.segments.length > MAX_CAPTURE_SEGMENTS) fail("STORE_LIMIT", "Too many capture segments");
            const segments = c.segments ? await Promise.all(c.segments.map(async (s) => ({ ...s, before: await saveSnapshot(s.before), after: await saveSnapshot(s.after) }))) : void 0;
            changes[p] = { ...c, diffStats, before: await saveSnapshot(c.before), after: await saveSnapshot(c.after), ...segments ? { segments } : {} };
          }
          await atomicJson(path3.join(this.directory, inbox ? "inbox" : "runs", `${run.id}.json`), { ...run, fileCount, changes });
        };
        if (inbox) await this.captureLock(save);
        else await save();
      }
      async getRun(id3, inbox = false, hydrate = true) {
        const aliases = inbox ? void 0 : await readJson(path3.join(this.directory, "run-aliases.json"), {});
        return this.readRun(id3, inbox, hydrate, aliases);
      }
      async readRun(id3, inbox, hydrate, aliases) {
        validId(id3);
        if (!inbox) {
          const resolved = aliases ?? await readJson(path3.join(this.directory, "run-aliases.json"), {});
          const seen = /* @__PURE__ */ new Set();
          while (resolved[id3]) {
            if (seen.has(id3) || seen.size >= MAX_RUNS) fail("REPAIR_IDENTITY", "Invalid run alias chain");
            seen.add(id3);
            id3 = resolved[id3];
            validId(id3);
          }
        }
        const run = await readJson(path3.join(this.directory, inbox ? "inbox" : "runs", `${id3}.json`), null);
        if (!run || !validRun(run, id3)) return null;
        if (hydrate) {
          const loaded = /* @__PURE__ */ new Map();
          const load = (snapshot) => {
            const key = JSON.stringify([snapshot.kind, snapshot.exists, snapshot.hash, snapshot.mode]);
            let pending = loaded.get(key);
            if (!pending) {
              pending = this.hydrate(snapshot);
              loaded.set(key, pending);
            }
            return pending;
          };
          for (const [p, c] of Object.entries(run.changes)) {
            const segments = c.segments ? await Promise.all(c.segments.map(async (s) => ({ ...s, before: await load(s.before), after: await load(s.after) }))) : void 0;
            run.changes[p] = { ...c, before: await load(c.before), after: await load(c.after), ...segments ? { segments } : {} };
          }
        }
        return run;
      }
      async importInbox(generation) {
        await this.captureLock(async () => {
          const entries = (await fs3.readdir(path3.join(this.directory, "inbox"))).filter((e) => /^[\w-]+\.json$/.test(e)).slice(0, MAX_RUNS);
          for (const entry of entries) {
            const id3 = entry.slice(0, -5);
            const aliases = await readJson(path3.join(this.directory, "run-aliases.json"), {});
            if (aliases[id3]) {
              const source = await this.getRun(id3, true, false), target = await this.getRun(id3, false, false);
              if (source && target && source.sessionId === target.sessionId && canonical(source.root) === canonical(target.root)) {
                const saved = await readJson(path3.join(this.directory, "contributions", entry), null);
                if (!saved || (source.contentVersion ?? 0) > (saved.hostRecovery?.captureVersion ?? saved.contentVersion ?? 0)) {
                  await atomicJson(path3.join(this.directory, "contributions", entry), { ...source, userMessageId: target.userMessageId });
                  this.pendingRecovery.add(target.sessionId);
                }
                await fs3.rm(path3.join(this.directory, "inbox", entry), { force: true });
              }
              continue;
            }
            try {
              const run = await this.getRun(id3, true, false);
              if (!run) continue;
              const inboxWasRunning = run.state === "running";
              const current = await this.getRun(id3, false, false);
              if (current && (current.sessionId !== run.sessionId || canonical(current.root) !== canonical(run.root))) {
                await this.audit({ action: "inbox-identity-root-conflict", runId: id3, sessionId: run.sessionId });
                continue;
              }
              if (current?.execution && run.execution && current.execution.id !== run.execution.id) {
                await this.audit({ action: "inbox-execution-conflict", runId: id3, sessionId: run.sessionId });
                continue;
              }
              if (current && current.sessionId === run.sessionId && canonical(current.root) === canonical(run.root)) {
                if ((run.contentVersion ?? 0) < (current.contentVersion ?? 0) && !current.hostRecovery) continue;
                if (current.execution && run.execution?.id === current.execution.id && run.execution.revision < current.execution.revision) continue;
              }
              if (current?.execution && run.execution?.id === current.execution.id && current.boundary === "user" && current.userMessageId && !run.userMessageId) {
                run.userMessageId = current.userMessageId;
                run.boundary = "user";
              }
              if (current?.hostRecovery && (run.contentVersion ?? 0) <= current.hostRecovery.captureVersion) continue;
              if (current?.hostRecovery?.files && current.sessionId === run.sessionId && canonical(current.root) === canonical(run.root) && (!run.userMessageId || run.userMessageId === current.userMessageId)) {
                const files = /* @__PURE__ */ Object.create(null);
                for (const [value, checkpoint] of Object.entries(current.hostRecovery.files)) {
                  if (captureCheckpoint(run.changes[value]) !== checkpoint) continue;
                  if (current.changes[value]) run.changes[value] = current.changes[value];
                  else delete run.changes[value];
                  files[value] = checkpoint;
                }
                if (Object.keys(files).length) {
                  run.hostRecovery = { captureVersion: run.contentVersion ?? 0, files };
                  const order = [...Object.keys(current.changes).filter((value) => run.changes[value]), ...Object.keys(run.changes).filter((value) => !current.changes[value])];
                  run.changes = Object.fromEntries(order.map((value) => [value, run.changes[value]]));
                }
              }
              if (current && current.state !== "running" && current.sessionId === run.sessionId && canonical(current.root) === canonical(run.root)) {
                const advanced = !!current.execution && run.execution?.id === current.execution.id && run.execution.revision > current.execution.revision;
                if (!advanced) {
                  const evidenceChanged = Object.keys({ ...current.changes, ...run.changes }).some((p) => captureCheckpoint(run.changes[p]) !== captureCheckpoint(current.changes[p]));
                  const damaged = Object.values(run.changes).some((c) => c.ambiguous || c.before.kind === "unavailable" || c.after.kind === "unavailable");
                  run.state = current.state;
                  run.endedAt = current.endedAt;
                  run.execution = current.execution;
                  run.userMessageId = current.userMessageId;
                  run.replyMessageId = current.replyMessageId;
                  run.finalReply = current.finalReply;
                  run.replies = current.replies;
                  run.incomplete = current.incomplete || damaged || run.incomplete && (!current.hostRecovery || evidenceChanged);
                }
              }
              const sameReply = run.finalReply?.hash === current?.finalReply?.hash && run.finalReply?.timestamp === current?.finalReply?.timestamp;
              run.bindings = sameReply ? current?.bindings ?? {} : {};
              if (run.generation !== generation && run.state === "running") {
                run.state = "incomplete";
                run.incomplete = true;
              }
              await this.writeRun(run);
              if (!current || current.contentVersion !== run.contentVersion || current.state !== run.state || JSON.stringify(current.changes) !== JSON.stringify(run.changes)) this.pendingRecovery.add(run.sessionId);
              if (run.state !== "running" && !inboxWasRunning) await fs3.rm(path3.join(this.directory, "inbox", entry), { force: true });
            } catch {
            }
          }
        });
      }
      async captureContributions() {
        const files = (await fs3.readdir(path3.join(this.directory, "contributions"))).filter((file) => /^[\w-]+\.json$/.test(file)).slice(-MAX_RUNS * 2);
        const sources = [];
        for (const file of files) {
          const id3 = file.slice(0, -5), source = await readJson(path3.join(this.directory, "contributions", file), null);
          if (!source || !validRun(source, id3)) continue;
          const target = await this.getRun(id3, false, false);
          if (target?.id !== id3 && target?.sessionId === source.sessionId && canonical(target.root) === canonical(source.root) && target.userMessageId === source.userMessageId) sources.push(source);
        }
        return sources;
      }
      async listRuns(hydrate = true, includeUnchanged = false) {
        const files = (await fs3.readdir(path3.join(this.directory, "runs"))).filter((e) => /^[\w-]+\.json$/.test(e));
        if (!files.length) return [];
        const aliases = await readJson(path3.join(this.directory, "run-aliases.json"), {}).catch(() => null);
        if (!aliases) return [];
        const runs = [];
        const selected = files.slice(-MAX_RUNS * 2);
        for (let offset = 0; offset < selected.length; offset += 16) {
          const page = await Promise.all(selected.slice(offset, offset + 16).map(async (file) => {
            try {
              return await this.readRun(file.slice(0, -5), false, hydrate, aliases);
            } catch {
              return null;
            }
          }));
          for (const run of page) if (run && !runs.some((r) => r.id === run.id) && (includeUnchanged || Object.keys(run.changes).length > 0)) runs.push(run);
        }
        return runs.sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_RUNS);
      }
      async comments() {
        return readJson(path3.join(this.directory, "comments.json"), []);
      }
      async saveComments(comments) {
        if (comments.length > 1e3 || Buffer.byteLength(JSON.stringify(comments)) > 16 * 1024 * 1024) fail("COMMENT_LIMIT", "Comment count or byte limit reached");
        await atomicJson(path3.join(this.directory, "comments.json"), comments);
      }
      async audit(event) {
        const file = path3.join(this.directory, "actions.jsonl");
        const size = (await fs3.stat(file).catch(() => ({ size: 0 }))).size;
        if (size > 1024 * 1024) await fs3.rename(file, `${file}.previous`).catch(() => {
        });
        await fs3.appendFile(file, `${JSON.stringify({ timestamp: Date.now(), event })}
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
        for (const file of await fs3.readdir(path3.join(this.directory, "runs"))) if (/^[\w-]+\.json$/.test(file) && !keep.has(file.slice(0, -5))) await fs3.rm(path3.join(this.directory, "runs", file), { force: true });
      }
      async clear() {
        await this.captureLock(async () => {
          const { inspectCaptureLeases: inspectCaptureLeases2 } = await Promise.resolve().then(() => (init_capture_leases(), capture_leases_exports));
          if ((await inspectCaptureLeases2(this)).leases.length) fail("AGENT_BUSY", "Resolve outstanding capture leases before clearing history; verify terminal tool evidence first");
          for (const inbox of [false, true]) for (const file of await fs3.readdir(path3.join(this.directory, inbox ? "inbox" : "runs"))) {
            if (!/^[\w-]+\.json$/.test(file)) continue;
            const run = await this.getRun(file.slice(0, -5), inbox, false);
            if (run?.state === "running") fail("AGENT_BUSY", "Stop active captures before clearing history");
          }
          for (const sub of ["runs", "inbox", "contributions", "blobs", "backups", "evidence"]) {
            const dir = path3.join(this.directory, sub);
            if (!inside(this.directory, dir)) fail("STORE_ESCAPE", "Invalid store path");
            for (const file of await fs3.readdir(dir)) {
              const target = path3.join(dir, file);
              const s = await fs3.lstat(target);
              if (s.isFile() && !s.isSymbolicLink()) await fs3.unlink(target);
            }
          }
          await this.saveComments([]);
          await fs3.rm(path3.join(this.directory, "restores.json"), { force: true });
          await fs3.rm(path3.join(this.directory, "run-aliases.json"), { force: true });
          await fs3.rm(path3.join(this.directory, "file-aliases.json"), { force: true });
          this.pendingRecovery.clear();
        });
      }
    };
  }
});

// src/agent/capture.ts
init_public_path();

// src/core/delegation-lifecycle.ts
var name = (value) => String(value).split(".").pop().toLowerCase();
var id = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value);
function safeDelegation(value) {
  if (!value || !id(value.delegationId) || !["running", "completed", "failed", "aborted", "stopped"].includes(value.status) || !Number.isSafeInteger(value.startedAt) || value.startedAt <= 0) return void 0;
  return { delegationId: value.delegationId, status: value.status, startedAt: value.startedAt, ...Number.isSafeInteger(value.completedAt) && value.completedAt >= value.startedAt ? { completedAt: value.completedAt } : {} };
}
function safeTaskDetails(tool, details) {
  if (!details || typeof details !== "object") return void 0;
  if (name(tool) === "task") return safeDelegation(details);
  if (!["taskwait", "task_wait", "tasklist", "taskstop"].includes(name(tool))) return void 0;
  const output = {};
  for (const key of ["delegations", "stopped", "stopPending", "settled"]) if (Array.isArray(details[key])) output[key] = details[key].slice(0, 256).map(safeDelegation).filter(Boolean);
  return Object.keys(output).length ? output : void 0;
}

// src/agent/capture.ts
init_contracts();
init_path_policy();
init_storage();
import fs6 from "node:fs/promises";
import path6 from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID as randomUUID3 } from "node:crypto";

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

// src/core/explicit-file-tools.ts
var explicitToolName = (name2) => String(name2).split(".").pop().toLowerCase();
function isReplacementTool(name2) {
  return ["mcp_fastctx_replace", "mcp__fastctx__replace"].includes(explicitToolName(name2));
}
function isExplicitFileTool(name2) {
  return ["write", "edit"].includes(explicitToolName(name2)) || isReplacementTool(name2);
}

// src/agent/workspace-capture.ts
import fs5 from "node:fs/promises";
import path5 from "node:path";
init_path_policy();

// src/core/capture-context.ts
init_path_policy();
init_public_path();
init_storage();
import fs4 from "node:fs/promises";
import path4 from "node:path";
var CAPTURE_CONTEXT_TTL = 6e3;
var id2 = (v) => typeof v === "string" && /^[a-zA-Z0-9-]{1,256}$/.test(v);
async function readCaptureContext(directory, generation, sessionId, root, now = Date.now()) {
  try {
    const file = path4.join(directory, "capture-contexts.json"), stat = await fs4.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) return null;
    const document = JSON.parse(await fs4.readFile(file, "utf8"));
    if (document.version !== 1 || document.generation !== generation || !Array.isArray(document.contexts) || document.contexts.length > 200) return null;
    const context = document.contexts.find((v) => v?.sessionId === sessionId);
    if (!context || context.running !== true || context.statusKnown === false || !id2(context.taskId) || typeof context.root !== "string" || !path4.isAbsolute(context.root) || canonical(context.root) !== canonical(root) || !Number.isSafeInteger(context.since) || context.since <= 0 || context.since > now || !Number.isSafeInteger(context.updatedAt) || context.updatedAt > now || now - context.updatedAt > CAPTURE_CONTEXT_TTL) return null;
    return context;
  } catch {
    return null;
  }
}
async function checkScratchAncestry(value) {
  if (!hostScratchRoot(value)) return;
  const absolute = path4.resolve(value);
  let cursor = path4.parse(absolute).root;
  for (const segment of absolute.slice(cursor.length).split(path4.sep)) {
    cursor = path4.join(cursor, segment);
    const stat = await fs4.lstat(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe scratch capture ancestry");
  }
}

// src/agent/workspace-capture.ts
init_capture_leases();
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
      dir = await fs5.opendir(directory);
      for await (const entry of dir) {
        if (++entries > 4096 || Date.now() > deadline || result.paths.length >= 256) {
          result.complete = false;
          break;
        }
        const absolute = path5.join(directory, entry.name), relative = path5.relative(root, absolute);
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

// src/agent/capture.ts
init_capture_leases();
var toolName = explicitToolName;
var MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
function textContent(message) {
  if (typeof message?.content === "string") return message.content;
  return Array.isArray(message?.content) ? message.content.filter((b) => b.type === "text").map((b) => b.text).join("") : "";
}
function toolPaths(name2, input) {
  const p = input?.path ?? input?.file_path;
  if (typeof p !== "string" || !isExplicitFileTool(name2) || isReplacementTool(name2) && input?.dry_run === true) return { targets: [], hadTargets: false, truncated: false };
  const targets = /* @__PURE__ */ new Set();
  let hadTargets = false, truncated = false;
  const add = (target) => {
    hadTargets = true;
    if (!isImagePath(target)) targets.add(target);
  };
  add(p);
  if (/^edit$/i.test(name2) && typeof input.ops === "string") {
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
    const taskCalls = /* @__PURE__ */ new Map();
    const detached = /* @__PURE__ */ new Map();
    const detachPending = () => {
      for (const [id3, value] of pending) detached.set(id3, { store: value.store, lease: value.lease, sessionId: value.run.sessionId });
      pending.clear();
    };
    const retiredReplies = /* @__PURE__ */ new Set();
    const waits = /* @__PURE__ */ new Set();
    let seen = /* @__PURE__ */ new Set(), retired = /* @__PURE__ */ new Set(), warned = false, disposed = false, tail = Promise.resolve();
    let lastReply, privatePaths = [], observed = /* @__PURE__ */ new Set(), settled = false;
    let diagnosticCount = 0;
    const diagnose = async (target, stage, error, ctx, file) => {
      if (target) {
        target.incomplete = true;
        target.notice = "\u90E8\u5206\u5FEB\u7167\u91C7\u96C6\u5931\u8D25\uFF1B\u884C\u6570\u53EF\u80FD\u672A\u77E5\u3002\u8BF7\u68C0\u67E5\u5B58\u50A8\u7A7A\u95F4\u3001\u6587\u4EF6\u6743\u9650\u53CA actions.jsonl \u8BCA\u65AD\u3002";
      }
      const raw = error?.code;
      const code = typeof raw === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(raw) ? raw : "CAPTURE_FAILED";
      if (diagnosticCount++ < 16) await store?.audit({ action: `capture-${stage}`, code, runId: target?.id, ...file ? { pathId: digest(file).slice(0, 24) } : {} }).catch(() => {
      });
      if (!warned && ctx && code !== "PATH_DENIED") {
        warned = true;
        ctx.ui?.notify(`Diff view: \u5FEB\u7167\u91C7\u96C6\u964D\u7EA7 (${code})\uFF1B\u8BF7\u68C0\u67E5\u6587\u4EF6\u6743\u9650\u3001\u5B58\u50A8\u7A7A\u95F4\u53CA actions.jsonl\u3002`, "warning");
      }
    };
    const serial = (fn, ctx) => {
      tail = tail.then(fn).catch(async (error) => {
        lastReply = void 0;
        if (run) {
          run.incomplete = true;
          delete run.finalReply;
          await persist(run).catch(() => {
          });
        }
        await diagnose(run, "persist", error, ctx);
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
        privatePaths = [.../* @__PURE__ */ new Set([...privatePaths, await fs6.realpath(options.pluginRoot), locator.dataPath, options.locator ?? await locatorPath(options.pluginRoot)])];
        if (!target.notice?.includes("Capture locator refreshed")) target.notice = `${target.notice ?? ""} Capture locator refreshed during the current user task.`.trim();
      }
      return locator;
    };
    const persist = async (target) => {
      await check(target);
      if (target.mainState) {
        const children = target.delegations ?? [];
        target.state = target.mainState === "running" || children.some((child) => child.status === "running") ? "running" : target.mainState === "aborted" || children.some((child) => ["aborted", "stopped"].includes(child.status)) ? "aborted" : target.mainState === "incomplete" || children.some((child) => child.status === "failed") ? "incomplete" : target.mainState;
        if (target.state === "running") delete target.endedAt;
        else target.endedAt ??= Date.now();
      }
      target.fileCount = Object.values(target.changes).filter((c) => !c.ambiguous && !sameSnapshot(c.before, c.after)).length;
      target.contentVersion = (target.contentVersion ?? 0) + 1;
      await store.writeRun(target, true);
      for (const change of Object.values(target.changes)) for (const segment of change.segments ?? []) {
        segment.before = { ...segment.before, text: null };
        segment.after = { ...segment.after, text: null };
      }
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
      for (const reply of run?.replies ?? []) retiredReplies.add(`${reply.timestamp}:${reply.hash}`);
      while (retiredReplies.size > 200) retiredReplies.delete(retiredReplies.keys().next().value);
      if (run?.execution?.state === "running") {
        run.mainState = "incomplete";
        run.state = "incomplete";
        run.incomplete = true;
        run.execution = { ...run.execution, revision: run.execution.revision + 1, state: "settled" };
        delete run.finalReply;
        run.endedAt = Date.now();
        await persist(run);
      }
      store = new SnapshotStore(locator.dataPath);
      await store.init();
      privatePaths = [await fs6.realpath(options.pluginRoot), locator.dataPath, options.locator ?? await locatorPath(options.pluginRoot)];
      await checkScratchAncestry(ctx.cwd);
      const root = await fs6.realpath(ctx.cwd);
      assertSessionScratchPath(root, ctx.sessionManager.getSessionId(), root);
      const identity = await readCaptureContext(locator.dataPath, locator.generation, ctx.sessionManager.getSessionId(), root);
      run = { version: 2, contentVersion: 0, boundary: uncertain && !identity ? "uncertain" : "user", id: randomUUID3(), generation: locator.generation, sessionId: ctx.sessionManager.getSessionId(), root, startedAt: Date.now(), state: "running", fileCount: 0, incomplete: uncertain, changes: /* @__PURE__ */ Object.create(null), replies: [], bindings: {} };
      run.execution = { id: randomUUID3(), revision: 1, state: "running" };
      run.mainState = "running";
      const userId = event?.userMessageId ?? (event?.message?.role === "user" ? event.message.id : void 0) ?? identity?.taskId;
      if (typeof userId === "string" && userId.length > 0 && userId.length <= 256) run.userMessageId = userId;
      if (uncertain && identity) run.notice = "\u8FD0\u884C\u8EAB\u4EFD\u5DF2\u7531\u540C\u4F1A\u8BDD\u3001\u540C\u9879\u76EE\u7684\u5BBF\u4E3B\u5143\u6570\u636E\u6838\u9A8C\uFF1B\u4EC5\u8BB0\u5F55\u91C7\u96C6\u5F00\u59CB\u540E\u7684\u6709\u754C\u53D8\u66F4\u3002";
      for (const id3 of seen) retired.add(id3);
      while (retired.size > 4096) retired.delete(retired.keys().next().value);
      detachPending();
      waits.clear();
      seen.clear();
      observed.clear();
      warned = false;
      diagnosticCount = 0;
      lastReply = void 0;
      settled = false;
      await persist(run);
    };
    pi.on("before_agent_start", (event, ctx) => serial(() => begin(ctx, false, event), ctx));
    pi.on("agent_start", (_event, ctx) => serial(async () => {
      if (disposed || settled || !run || run.execution?.state === "running" || run.mainState === "aborted" || run.sessionId !== ctx.sessionManager.getSessionId() || run.root !== await fs6.realpath(ctx.cwd)) return;
      await check(run);
      run.state = "running";
      delete run.endedAt;
      delete run.finalReply;
      delete run.cardPreview;
      run.mainState = "running";
      if (run.execution) run.execution = { ...run.execution, revision: run.execution.revision + 1, state: "running" };
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
      const name2 = toolName(event.toolName), targetSet = toolPaths(name2, event.input ?? event.args), targets = targetSet.targets;
      if (isReplacementTool(name2) && targets.length) {
        try {
          if (!(await fs6.lstat(path6.resolve(run.root, targets[0]))).isFile()) return;
        } catch {
          return;
        }
      }
      if (name2 === "task") {
        if ((run.delegations?.length ?? 0) >= 256) {
          run.incomplete = true;
          await persist(run);
          return;
        }
        (run.delegations ??= []).push({ callId: event.toolCallId, owner: run.userMessageId ?? run.id, status: "running" });
        taskCalls.set(event.toolCallId, run);
        for (const [id3, target] of taskCalls) if (taskCalls.size > 4096 && target.delegations?.every((child) => child.status !== "running")) taskCalls.delete(id3);
        await persist(run);
        return;
      }
      if (["bash", "shell", "task", "taskwait", "task_wait"].includes(name2)) return;
      const workspace = false;
      if (name2 === "taskwait" || name2 === "task_wait") {
        waits.add(event.toolCallId);
        return;
      }
      if (targetSet.hadTargets && targets.length === 0 && !targetSet.truncated) return;
      if (!targets.length && !workspace) {
        if (["write", "edit"].includes(name2)) {
          run.incomplete = true;
          await persist(run);
        }
        return;
      }
      const leaseStore = store, lease = await beginCaptureLease(leaseStore, run.root, run.id, targets.slice(0, 256).map((p) => path6.resolve(run.root, p)), { sessionId: run.sessionId, toolCallId: event.toolCallId, executionId: run.execution?.id });
      const captured = { run, paths: [], store: leaseStore, lease, name: name2, workspace, complete: true, task: name2 === "task" };
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
            assertSessionScratchPath(path6.resolve(run.root, target), run.sessionId, run.root);
            const capture = await resolveCapturePath(run.root, target, privatePaths, name2 === "write" || index > 0);
            if (!observed.has(capture.identity) && observed.size >= 256) throw new Error("Turn exceeds 256 explicitly captured files");
            observed.add(capture.identity);
            const before = bounded(await readCapturedSnapshot(run.root, capture, privatePaths), captured.paths.map((e) => e.before));
            if (before.kind !== "text") await diagnose(run, "before", { code: "SNAPSHOT_UNAVAILABLE" }, ctx, capture.identity);
            captured.paths.push({ capture, before });
          } catch (error) {
            await diagnose(run, "before", error, ctx, target);
          }
        }
      }
      try {
        await prepareCaptureLease(leaseStore, lease, { name: name2, userMessageId: run.userMessageId, paths: captured.paths });
      } catch (error) {
        await diagnose(run, "prepare", error, ctx);
      }
      await persist(run);
    }, ctx));
    const finish = async (id3, captured, isError = false, sample = false) => {
      const target = captured.run;
      if (captured.finished) {
        await persist(target);
        if (!captured.retainPreparation) await endCaptureLease(captured.store, captured.lease);
        pending.delete(id3);
        return;
      }
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
        } catch (error) {
          await diagnose(target, "after", error);
        }
      }
      const overlap = sample ? true : await closeCaptureLease(captured.store, captured.lease) || captured.store.directory !== store.directory;
      if (isError) target.incomplete = true;
      for (const { entry, after: rawAfter, uncertain } of pairs) {
        if (sameSnapshot(entry.before, rawAfter)) continue;
        const priorKey = Object.keys(target.changes).find((p) => target.changes[p].capture?.identity === entry.capture.identity);
        const prior = priorKey ? target.changes[priorKey] : void 0;
        if (!prior && Object.keys(target.changes).length >= 256) {
          target.incomplete = true;
          continue;
        }
        const intervalAmbiguous = !!(overlap || uncertain || captured.task || isError);
        const ambiguous = !!(intervalAmbiguous || prior?.ambiguous || prior && !sameSnapshot(prior.after, entry.before));
        const rawSegmentAfter = bounded(rawAfter, captured.paths.map((e) => e.before));
        const segment = { before: entry.before, after: rawSegmentAfter, evidence: `${captured.name}:${id3}`, ...intervalAmbiguous ? { ambiguous: true } : {} };
        const segments = [...prior?.segments ?? [], segment];
        const segmentsTruncated = !!prior?.segmentsTruncated || segments.length > MAX_CAPTURE_SEGMENTS;
        if (segmentsTruncated) target.incomplete = true;
        let before = prior?.before ?? entry.before, after = rawSegmentAfter;
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
          evidence: [...prior?.evidence ?? [], `${captured.name}:${id3}`].slice(-32),
          segments: segments.slice(-MAX_CAPTURE_SEGMENTS),
          ...segmentsTruncated ? { segmentsTruncated: true } : {},
          ...captured.workspace && !ambiguous ? { note: "Observed workspace endpoints during a tool interval, not authoritative process-level authorship evidence." } : {},
          ...ambiguous ? { ambiguous: true, note: "Overlapping, discontinuous or delegated capture interval: file ownership is uncertain; diff and line counts unavailable." } : {}
        };
      }
      if (sample) {
        captured.paths = [];
        for (const pair of pairs.slice(0, 256)) captured.paths.push({ capture: pair.entry.capture, before: bounded(pair.after) });
      }
      if (!sample) {
        captured.finished = true;
        captured.retainPreparation = pairs.length < captured.paths.length;
      }
      await persist(target);
      if (!sample) {
        if (!captured.retainPreparation) await endCaptureLease(captured.store, captured.lease);
        pending.delete(id3);
      }
    };
    const updateDelegations = async (event, ctx) => {
      const details = event.details ?? event.message?.toolResult?.details;
      const name2 = toolName(event.toolName ?? event.message?.toolName);
      const changed = /* @__PURE__ */ new Set();
      const target = taskCalls.get(event.toolCallId ?? event.message?.toolCallId);
      if (name2 === "task" && target?.sessionId === ctx.sessionManager.getSessionId()) {
        const child = target.delegations?.find((child2) => child2.callId === (event.toolCallId ?? event.message?.toolCallId));
        const sample = safeDelegation(details);
        if (child && child.status === "running" && (event.isError || sample) && (!sample || !child.startedAt || child.startedAt === sample.startedAt)) {
          Object.assign(child, event.isError ? { status: "failed" } : sample);
          changed.add(target);
        }
      }
      const samples = name2 === "task" ? [] : Object.values(safeTaskDetails(name2, details) ?? {}).flat();
      for (const sample of samples) for (const target2 of new Set(taskCalls.values())) {
        if (target2.sessionId !== ctx.sessionManager.getSessionId()) continue;
        const child = target2.delegations?.find((child2) => child2.delegationId === sample.delegationId && child2.startedAt === sample.startedAt);
        if (child?.status === "running") {
          Object.assign(child, sample);
          changed.add(target2);
        }
      }
      for (const target2 of changed) {
        if (target2.execution) target2.execution = { ...target2.execution, revision: target2.execution.revision + 1 };
        await persist(target2);
      }
    };
    pi.on("tool_result", (event, ctx) => serial(async () => {
      await updateDelegations(event, ctx);
      const old = detached.get(event.toolCallId);
      if (old && old.sessionId === ctx.sessionManager.getSessionId()) {
        await closeCaptureLease(old.store, old.lease);
        detached.delete(event.toolCallId);
        return;
      }
      if (disposed || !run || run.sessionId !== ctx.sessionManager.getSessionId()) return;
      const captured = pending.get(event.toolCallId);
      if (!captured) {
        if (waits.delete(event.toolCallId) || ["taskwait", "task_wait"].includes(toolName(event.toolName))) {
          for (const [id3, task] of pending) if (task.task) await finish(id3, task, !!event.isError, true);
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
      await updateDelegations(event, ctx);
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
      if (!run || run.execution?.state !== "running" || run.sessionId !== ctx.sessionManager.getSessionId()) return;
      if (event.parentToolCallId) return;
      const ending = Array.isArray(event.messages) ? [...event.messages].reverse().find((m) => m.role === "assistant") : void 0;
      if (ending && retiredReplies.has(`${ending.timestamp}:${digest(textContent(ending).trim())}`)) return;
      await check(run);
      for (const [id3, captured] of pending) if (captured.task) await finish(id3, captured, false, true);
      if (pending.size) {
        run.incomplete = true;
        detachPending();
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
      if (run.execution) run.execution = { ...run.execution, revision: run.execution.revision + 1, state: "settled" };
      run.mainState = aborted ? "aborted" : run.incomplete ? "incomplete" : "completed";
      run.state = run.mainState;
      run.endedAt = Date.now();
      await persist(run);
    }, ctx));
    pi.on("agent_settled", (_event, ctx) => serial(async () => {
      if (run?.sessionId === ctx.sessionManager.getSessionId() && run.execution?.state === "settled") settled = true;
    }, ctx));
    pi.on("session_shutdown", (_event, ctx) => serial(async () => {
      if (run?.execution?.state === "running") {
        run.incomplete = true;
        run.mainState = "aborted";
        run.state = "aborted";
        run.execution = { ...run.execution, revision: run.execution.revision + 1, state: "settled" };
        delete run.finalReply;
        run.endedAt = Date.now();
        await persist(run).catch(() => {
        });
      }
      disposed = true;
      detachPending();
      seen.clear();
      observed.clear();
      run = null;
    }, ctx));
  };
}
var pluginRoot = path6.resolve(path6.dirname(fileURLToPath(import.meta.url)), "..");
var capture_default = createCaptureExtension({ pluginRoot });
export {
  createCaptureExtension,
  capture_default as default
};
