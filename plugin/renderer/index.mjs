var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
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

// node_modules/highlight.js/lib/core.js
var require_core = __commonJS({
  "node_modules/highlight.js/lib/core.js"(exports, module) {
    function deepFreeze(obj) {
      if (obj instanceof Map) {
        obj.clear = obj.delete = obj.set = function() {
          throw new Error("map is read-only");
        };
      } else if (obj instanceof Set) {
        obj.add = obj.clear = obj.delete = function() {
          throw new Error("set is read-only");
        };
      }
      Object.freeze(obj);
      Object.getOwnPropertyNames(obj).forEach((name) => {
        const prop = obj[name];
        const type = typeof prop;
        if ((type === "object" || type === "function") && !Object.isFrozen(prop)) {
          deepFreeze(prop);
        }
      });
      return obj;
    }
    var Response = class {
      /**
       * @param {CompiledMode} mode
       */
      constructor(mode) {
        if (mode.data === void 0) mode.data = {};
        this.data = mode.data;
        this.isMatchIgnored = false;
      }
      ignoreMatch() {
        this.isMatchIgnored = true;
      }
    };
    function escapeHTML(value) {
      return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
    }
    function inherit$1(original, ...objects) {
      const result = /* @__PURE__ */ Object.create(null);
      for (const key in original) {
        result[key] = original[key];
      }
      objects.forEach(function(obj) {
        for (const key in obj) {
          result[key] = obj[key];
        }
      });
      return (
        /** @type {T} */
        result
      );
    }
    var SPAN_CLOSE = "</span>";
    var emitsWrappingTags = (node) => {
      return !!node.scope;
    };
    var scopeToCSSClass = (name, { prefix }) => {
      if (name.startsWith("language:")) {
        return name.replace("language:", "language-");
      }
      if (name.includes(".")) {
        const pieces = name.split(".");
        return [
          `${prefix}${pieces.shift()}`,
          ...pieces.map((x, i) => `${x}${"_".repeat(i + 1)}`)
        ].join(" ");
      }
      return `${prefix}${name}`;
    };
    var HTMLRenderer = class {
      /**
       * Creates a new HTMLRenderer
       *
       * @param {Tree} parseTree - the parse tree (must support `walk` API)
       * @param {{classPrefix: string}} options
       */
      constructor(parseTree, options) {
        this.buffer = "";
        this.classPrefix = options.classPrefix;
        parseTree.walk(this);
      }
      /**
       * Adds texts to the output stream
       *
       * @param {string} text */
      addText(text) {
        this.buffer += escapeHTML(text);
      }
      /**
       * Adds a node open to the output stream (if needed)
       *
       * @param {Node} node */
      openNode(node) {
        if (!emitsWrappingTags(node)) return;
        const className = scopeToCSSClass(
          node.scope,
          { prefix: this.classPrefix }
        );
        this.span(className);
      }
      /**
       * Adds a node close to the output stream (if needed)
       *
       * @param {Node} node */
      closeNode(node) {
        if (!emitsWrappingTags(node)) return;
        this.buffer += SPAN_CLOSE;
      }
      /**
       * returns the accumulated buffer
      */
      value() {
        return this.buffer;
      }
      // helpers
      /**
       * Builds a span element
       *
       * @param {string} className */
      span(className) {
        this.buffer += `<span class="${className}">`;
      }
    };
    var newNode = (opts = {}) => {
      const result = { children: [] };
      Object.assign(result, opts);
      return result;
    };
    var TokenTree = class _TokenTree {
      constructor() {
        this.rootNode = newNode();
        this.stack = [this.rootNode];
      }
      get top() {
        return this.stack[this.stack.length - 1];
      }
      get root() {
        return this.rootNode;
      }
      /** @param {Node} node */
      add(node) {
        this.top.children.push(node);
      }
      /** @param {string} scope */
      openNode(scope) {
        const node = newNode({ scope });
        this.add(node);
        this.stack.push(node);
      }
      closeNode() {
        if (this.stack.length > 1) {
          return this.stack.pop();
        }
        return void 0;
      }
      closeAllNodes() {
        while (this.closeNode()) ;
      }
      toJSON() {
        return JSON.stringify(this.rootNode, null, 4);
      }
      /**
       * @typedef { import("./html_renderer").Renderer } Renderer
       * @param {Renderer} builder
       */
      walk(builder) {
        return this.constructor._walk(builder, this.rootNode);
      }
      /**
       * @param {Renderer} builder
       * @param {Node} node
       */
      static _walk(builder, node) {
        if (typeof node === "string") {
          builder.addText(node);
        } else if (node.children) {
          builder.openNode(node);
          node.children.forEach((child) => this._walk(builder, child));
          builder.closeNode(node);
        }
        return builder;
      }
      /**
       * @param {Node} node
       */
      static _collapse(node) {
        if (typeof node === "string") return;
        if (!node.children) return;
        if (node.children.every((el) => typeof el === "string")) {
          node.children = [node.children.join("")];
        } else {
          node.children.forEach((child) => {
            _TokenTree._collapse(child);
          });
        }
      }
    };
    var TokenTreeEmitter = class extends TokenTree {
      /**
       * @param {*} options
       */
      constructor(options) {
        super();
        this.options = options;
      }
      /**
       * @param {string} text
       */
      addText(text) {
        if (text === "") {
          return;
        }
        this.add(text);
      }
      /** @param {string} scope */
      startScope(scope) {
        this.openNode(scope);
      }
      endScope() {
        this.closeNode();
      }
      /**
       * @param {Emitter & {root: DataNode}} emitter
       * @param {string} name
       */
      __addSublanguage(emitter, name) {
        const node = emitter.root;
        if (name) node.scope = `language:${name}`;
        this.add(node);
      }
      toHTML() {
        const renderer = new HTMLRenderer(this, this.options);
        return renderer.value();
      }
      finalize() {
        this.closeAllNodes();
        return true;
      }
    };
    function source(re) {
      if (!re) return null;
      if (typeof re === "string") return re;
      return re.source;
    }
    function lookahead(re) {
      return concat("(?=", re, ")");
    }
    function anyNumberOfTimes(re) {
      return concat("(?:", re, ")*");
    }
    function optional(re) {
      return concat("(?:", re, ")?");
    }
    function concat(...args) {
      const joined = args.map((x) => source(x)).join("");
      return joined;
    }
    function stripOptionsFromArgs(args) {
      const opts = args[args.length - 1];
      if (typeof opts === "object" && opts.constructor === Object) {
        args.splice(args.length - 1, 1);
        return opts;
      } else {
        return {};
      }
    }
    function either(...args) {
      const opts = stripOptionsFromArgs(args);
      const joined = "(" + (opts.capture ? "" : "?:") + args.map((x) => source(x)).join("|") + ")";
      return joined;
    }
    function countMatchGroups(re) {
      return new RegExp(re.toString() + "|").exec("").length - 1;
    }
    function startsWith(re, lexeme) {
      const match = re && re.exec(lexeme);
      return match && match.index === 0;
    }
    var BACKREF_RE = /\[(?:[^\\\]]|\\.)*\]|\(\??|\\([1-9][0-9]*)|\\./;
    function _rewriteBackreferences(regexps, { joinWith }) {
      let numCaptures = 0;
      return regexps.map((regex) => {
        numCaptures += 1;
        const offset = numCaptures;
        let re = source(regex);
        let out = "";
        while (re.length > 0) {
          const match = BACKREF_RE.exec(re);
          if (!match) {
            out += re;
            break;
          }
          out += re.substring(0, match.index);
          re = re.substring(match.index + match[0].length);
          if (match[0][0] === "\\" && match[1]) {
            out += "\\" + String(Number(match[1]) + offset);
          } else {
            out += match[0];
            if (match[0] === "(") {
              numCaptures++;
            }
          }
        }
        return out;
      }).map((re) => `(${re})`).join(joinWith);
    }
    var MATCH_NOTHING_RE = /\b\B/;
    var IDENT_RE3 = "[a-zA-Z]\\w*";
    var UNDERSCORE_IDENT_RE = "[a-zA-Z_]\\w*";
    var NUMBER_RE = "\\b\\d+(\\.\\d+)?";
    var C_NUMBER_RE = "(-?)(\\b0[xX][a-fA-F0-9]+|(\\b\\d+(\\.\\d*)?|\\.\\d+)([eE][-+]?\\d+)?)";
    var BINARY_NUMBER_RE = "\\b(0b[01]+)";
    var RE_STARTERS_RE = "!|!=|!==|%|%=|&|&&|&=|\\*|\\*=|\\+|\\+=|,|-|-=|/=|/|:|;|<<|<<=|<=|<|===|==|=|>>>=|>>=|>=|>>>|>>|>|\\?|\\[|\\{|\\(|\\^|\\^=|\\||\\|=|\\|\\||~";
    var SHEBANG = (opts = {}) => {
      const beginShebang = /^#![ ]*\//;
      if (opts.binary) {
        opts.begin = concat(
          beginShebang,
          /.*\b/,
          opts.binary,
          /\b.*/
        );
      }
      return inherit$1({
        scope: "meta",
        begin: beginShebang,
        end: /$/,
        relevance: 0,
        /** @type {ModeCallback} */
        "on:begin": (m, resp) => {
          if (m.index !== 0) resp.ignoreMatch();
        }
      }, opts);
    };
    var BACKSLASH_ESCAPE = {
      begin: "\\\\[\\s\\S]",
      relevance: 0
    };
    var APOS_STRING_MODE = {
      scope: "string",
      begin: "'",
      end: "'",
      illegal: "\\n",
      contains: [BACKSLASH_ESCAPE]
    };
    var QUOTE_STRING_MODE = {
      scope: "string",
      begin: '"',
      end: '"',
      illegal: "\\n",
      contains: [BACKSLASH_ESCAPE]
    };
    var PHRASAL_WORDS_MODE = {
      begin: /\b(a|an|the|are|I'm|isn't|don't|doesn't|won't|but|just|should|pretty|simply|enough|gonna|going|wtf|so|such|will|you|your|they|like|more)\b/
    };
    var COMMENT = function(begin, end, modeOptions = {}) {
      const mode = inherit$1(
        {
          scope: "comment",
          begin,
          end,
          contains: []
        },
        modeOptions
      );
      mode.contains.push({
        scope: "doctag",
        // hack to avoid the space from being included. the space is necessary to
        // match here to prevent the plain text rule below from gobbling up doctags
        begin: "[ ]*(?=(TODO|FIXME|NOTE|BUG|OPTIMIZE|HACK|XXX):)",
        end: /(TODO|FIXME|NOTE|BUG|OPTIMIZE|HACK|XXX):/,
        excludeBegin: true,
        relevance: 0
      });
      const ENGLISH_WORD = either(
        // list of common 1 and 2 letter words in English
        "I",
        "a",
        "is",
        "so",
        "us",
        "to",
        "at",
        "if",
        "in",
        "it",
        "on",
        // note: this is not an exhaustive list of contractions, just popular ones
        /[A-Za-z]+['](d|ve|re|ll|t|s|n)/,
        // contractions - can't we'd they're let's, etc
        /[A-Za-z]+[-][a-z]+/,
        // `no-way`, etc.
        /[A-Za-z][a-z]{2,}/
        // allow capitalized words at beginning of sentences
      );
      mode.contains.push(
        {
          // TODO: how to include ", (, ) without breaking grammars that use these for
          // comment delimiters?
          // begin: /[ ]+([()"]?([A-Za-z'-]{3,}|is|a|I|so|us|[tT][oO]|at|if|in|it|on)[.]?[()":]?([.][ ]|[ ]|\))){3}/
          // ---
          // this tries to find sequences of 3 english words in a row (without any
          // "programming" type syntax) this gives us a strong signal that we've
          // TRULY found a comment - vs perhaps scanning with the wrong language.
          // It's possible to find something that LOOKS like the start of the
          // comment - but then if there is no readable text - good chance it is a
          // false match and not a comment.
          //
          // for a visual example please see:
          // https://github.com/highlightjs/highlight.js/issues/2827
          begin: concat(
            /[ ]+/,
            // necessary to prevent us gobbling up doctags like /* @author Bob Mcgill */
            "(",
            ENGLISH_WORD,
            /[.]?[:]?([.][ ]|[ ])/,
            "){3}"
          )
          // look for 3 words in a row
        }
      );
      return mode;
    };
    var C_LINE_COMMENT_MODE = COMMENT("//", "$");
    var C_BLOCK_COMMENT_MODE = COMMENT("/\\*", "\\*/");
    var HASH_COMMENT_MODE = COMMENT("#", "$");
    var NUMBER_MODE = {
      scope: "number",
      begin: NUMBER_RE,
      relevance: 0
    };
    var C_NUMBER_MODE = {
      scope: "number",
      begin: C_NUMBER_RE,
      relevance: 0
    };
    var BINARY_NUMBER_MODE = {
      scope: "number",
      begin: BINARY_NUMBER_RE,
      relevance: 0
    };
    var REGEXP_MODE = {
      scope: "regexp",
      begin: /\/(?=[^/\n]*\/)/,
      end: /\/[gimuy]*/,
      contains: [
        BACKSLASH_ESCAPE,
        {
          begin: /\[/,
          end: /\]/,
          relevance: 0,
          contains: [BACKSLASH_ESCAPE]
        }
      ]
    };
    var TITLE_MODE = {
      scope: "title",
      begin: IDENT_RE3,
      relevance: 0
    };
    var UNDERSCORE_TITLE_MODE = {
      scope: "title",
      begin: UNDERSCORE_IDENT_RE,
      relevance: 0
    };
    var METHOD_GUARD = {
      // excludes method names from keyword processing
      begin: "\\.\\s*" + UNDERSCORE_IDENT_RE,
      relevance: 0
    };
    var END_SAME_AS_BEGIN = function(mode) {
      return Object.assign(
        mode,
        {
          /** @type {ModeCallback} */
          "on:begin": (m, resp) => {
            resp.data._beginMatch = m[1];
          },
          /** @type {ModeCallback} */
          "on:end": (m, resp) => {
            if (resp.data._beginMatch !== m[1]) resp.ignoreMatch();
          }
        }
      );
    };
    var MODES2 = /* @__PURE__ */ Object.freeze({
      __proto__: null,
      APOS_STRING_MODE,
      BACKSLASH_ESCAPE,
      BINARY_NUMBER_MODE,
      BINARY_NUMBER_RE,
      COMMENT,
      C_BLOCK_COMMENT_MODE,
      C_LINE_COMMENT_MODE,
      C_NUMBER_MODE,
      C_NUMBER_RE,
      END_SAME_AS_BEGIN,
      HASH_COMMENT_MODE,
      IDENT_RE: IDENT_RE3,
      MATCH_NOTHING_RE,
      METHOD_GUARD,
      NUMBER_MODE,
      NUMBER_RE,
      PHRASAL_WORDS_MODE,
      QUOTE_STRING_MODE,
      REGEXP_MODE,
      RE_STARTERS_RE,
      SHEBANG,
      TITLE_MODE,
      UNDERSCORE_IDENT_RE,
      UNDERSCORE_TITLE_MODE
    });
    function skipIfHasPrecedingDot(match, response) {
      const before = match.input[match.index - 1];
      if (before === ".") {
        response.ignoreMatch();
      }
    }
    function scopeClassName(mode, _parent) {
      if (mode.className !== void 0) {
        mode.scope = mode.className;
        delete mode.className;
      }
    }
    function beginKeywords(mode, parent) {
      if (!parent) return;
      if (!mode.beginKeywords) return;
      mode.begin = "\\b(" + mode.beginKeywords.split(" ").join("|") + ")(?!\\.)(?=\\b|\\s)";
      mode.__beforeBegin = skipIfHasPrecedingDot;
      mode.keywords = mode.keywords || mode.beginKeywords;
      delete mode.beginKeywords;
      if (mode.relevance === void 0) mode.relevance = 0;
    }
    function compileIllegal(mode, _parent) {
      if (!Array.isArray(mode.illegal)) return;
      mode.illegal = either(...mode.illegal);
    }
    function compileMatch(mode, _parent) {
      if (!mode.match) return;
      if (mode.begin || mode.end) throw new Error("begin & end are not supported with match");
      mode.begin = mode.match;
      delete mode.match;
    }
    function compileRelevance(mode, _parent) {
      if (mode.relevance === void 0) mode.relevance = 1;
    }
    var beforeMatchExt = (mode, parent) => {
      if (!mode.beforeMatch) return;
      if (mode.starts) throw new Error("beforeMatch cannot be used with starts");
      const originalMode = Object.assign({}, mode);
      Object.keys(mode).forEach((key) => {
        delete mode[key];
      });
      mode.keywords = originalMode.keywords;
      mode.begin = concat(originalMode.beforeMatch, lookahead(originalMode.begin));
      mode.starts = {
        relevance: 0,
        contains: [
          Object.assign(originalMode, { endsParent: true })
        ]
      };
      mode.relevance = 0;
      delete originalMode.beforeMatch;
    };
    var COMMON_KEYWORDS = [
      "of",
      "and",
      "for",
      "in",
      "not",
      "or",
      "if",
      "then",
      "parent",
      // common variable name
      "list",
      // common variable name
      "value"
      // common variable name
    ];
    var DEFAULT_KEYWORD_SCOPE = "keyword";
    function compileKeywords(rawKeywords, caseInsensitive, scopeName = DEFAULT_KEYWORD_SCOPE) {
      const compiledKeywords = /* @__PURE__ */ Object.create(null);
      if (typeof rawKeywords === "string") {
        compileList(scopeName, rawKeywords.split(" "));
      } else if (Array.isArray(rawKeywords)) {
        compileList(scopeName, rawKeywords);
      } else {
        Object.keys(rawKeywords).forEach(function(scopeName2) {
          Object.assign(
            compiledKeywords,
            compileKeywords(rawKeywords[scopeName2], caseInsensitive, scopeName2)
          );
        });
      }
      return compiledKeywords;
      function compileList(scopeName2, keywordList) {
        if (caseInsensitive) {
          keywordList = keywordList.map((x) => x.toLowerCase());
        }
        keywordList.forEach(function(keyword) {
          const pair = keyword.split("|");
          compiledKeywords[pair[0]] = [scopeName2, scoreForKeyword(pair[0], pair[1])];
        });
      }
    }
    function scoreForKeyword(keyword, providedScore) {
      if (providedScore) {
        return Number(providedScore);
      }
      return commonKeyword(keyword) ? 0 : 1;
    }
    function commonKeyword(keyword) {
      return COMMON_KEYWORDS.includes(keyword.toLowerCase());
    }
    var seenDeprecations = {};
    var error = (message) => {
      console.error(message);
    };
    var warn = (message, ...args) => {
      console.log(`WARN: ${message}`, ...args);
    };
    var deprecated = (version2, message) => {
      if (seenDeprecations[`${version2}/${message}`]) return;
      console.log(`Deprecated as of ${version2}. ${message}`);
      seenDeprecations[`${version2}/${message}`] = true;
    };
    var MultiClassError = new Error();
    function remapScopeNames(mode, regexes, { key }) {
      let offset = 0;
      const scopeNames = mode[key];
      const emit = {};
      const positions = {};
      for (let i = 1; i <= regexes.length; i++) {
        positions[i + offset] = scopeNames[i];
        emit[i + offset] = true;
        offset += countMatchGroups(regexes[i - 1]);
      }
      mode[key] = positions;
      mode[key]._emit = emit;
      mode[key]._multi = true;
    }
    function beginMultiClass(mode) {
      if (!Array.isArray(mode.begin)) return;
      if (mode.skip || mode.excludeBegin || mode.returnBegin) {
        error("skip, excludeBegin, returnBegin not compatible with beginScope: {}");
        throw MultiClassError;
      }
      if (typeof mode.beginScope !== "object" || mode.beginScope === null) {
        error("beginScope must be object");
        throw MultiClassError;
      }
      remapScopeNames(mode, mode.begin, { key: "beginScope" });
      mode.begin = _rewriteBackreferences(mode.begin, { joinWith: "" });
    }
    function endMultiClass(mode) {
      if (!Array.isArray(mode.end)) return;
      if (mode.skip || mode.excludeEnd || mode.returnEnd) {
        error("skip, excludeEnd, returnEnd not compatible with endScope: {}");
        throw MultiClassError;
      }
      if (typeof mode.endScope !== "object" || mode.endScope === null) {
        error("endScope must be object");
        throw MultiClassError;
      }
      remapScopeNames(mode, mode.end, { key: "endScope" });
      mode.end = _rewriteBackreferences(mode.end, { joinWith: "" });
    }
    function scopeSugar(mode) {
      if (mode.scope && typeof mode.scope === "object" && mode.scope !== null) {
        mode.beginScope = mode.scope;
        delete mode.scope;
      }
    }
    function MultiClass(mode) {
      scopeSugar(mode);
      if (typeof mode.beginScope === "string") {
        mode.beginScope = { _wrap: mode.beginScope };
      }
      if (typeof mode.endScope === "string") {
        mode.endScope = { _wrap: mode.endScope };
      }
      beginMultiClass(mode);
      endMultiClass(mode);
    }
    function compileLanguage(language2) {
      function langRe(value, global) {
        return new RegExp(
          source(value),
          "m" + (language2.case_insensitive ? "i" : "") + (language2.unicodeRegex ? "u" : "") + (global ? "g" : "")
        );
      }
      class MultiRegex {
        constructor() {
          this.matchIndexes = {};
          this.regexes = [];
          this.matchAt = 1;
          this.position = 0;
        }
        // @ts-ignore
        addRule(re, opts) {
          opts.position = this.position++;
          this.matchIndexes[this.matchAt] = opts;
          this.regexes.push([opts, re]);
          this.matchAt += countMatchGroups(re) + 1;
        }
        compile() {
          if (this.regexes.length === 0) {
            this.exec = () => null;
          }
          const terminators = this.regexes.map((el) => el[1]);
          this.matcherRe = langRe(_rewriteBackreferences(terminators, { joinWith: "|" }), true);
          this.lastIndex = 0;
        }
        /** @param {string} s */
        exec(s) {
          this.matcherRe.lastIndex = this.lastIndex;
          const match = this.matcherRe.exec(s);
          if (!match) {
            return null;
          }
          const i = match.findIndex((el, i2) => i2 > 0 && el !== void 0);
          const matchData = this.matchIndexes[i];
          match.splice(0, i);
          return Object.assign(match, matchData);
        }
      }
      class ResumableMultiRegex {
        constructor() {
          this.rules = [];
          this.multiRegexes = [];
          this.count = 0;
          this.lastIndex = 0;
          this.regexIndex = 0;
        }
        // @ts-ignore
        getMatcher(index) {
          if (this.multiRegexes[index]) return this.multiRegexes[index];
          const matcher = new MultiRegex();
          this.rules.slice(index).forEach(([re, opts]) => matcher.addRule(re, opts));
          matcher.compile();
          this.multiRegexes[index] = matcher;
          return matcher;
        }
        resumingScanAtSamePosition() {
          return this.regexIndex !== 0;
        }
        considerAll() {
          this.regexIndex = 0;
        }
        // @ts-ignore
        addRule(re, opts) {
          this.rules.push([re, opts]);
          if (opts.type === "begin") this.count++;
        }
        /** @param {string} s */
        exec(s) {
          const m = this.getMatcher(this.regexIndex);
          m.lastIndex = this.lastIndex;
          let result = m.exec(s);
          if (this.resumingScanAtSamePosition()) {
            if (result && result.index === this.lastIndex) ;
            else {
              const m2 = this.getMatcher(0);
              m2.lastIndex = this.lastIndex + 1;
              result = m2.exec(s);
            }
          }
          if (result) {
            this.regexIndex += result.position + 1;
            if (this.regexIndex === this.count) {
              this.considerAll();
            }
          }
          return result;
        }
      }
      function buildModeRegex(mode) {
        const mm = new ResumableMultiRegex();
        mode.contains.forEach((term) => mm.addRule(term.begin, { rule: term, type: "begin" }));
        if (mode.terminatorEnd) {
          mm.addRule(mode.terminatorEnd, { type: "end" });
        }
        if (mode.illegal) {
          mm.addRule(mode.illegal, { type: "illegal" });
        }
        return mm;
      }
      function compileMode(mode, parent) {
        const cmode = (
          /** @type CompiledMode */
          mode
        );
        if (mode.isCompiled) return cmode;
        [
          scopeClassName,
          // do this early so compiler extensions generally don't have to worry about
          // the distinction between match/begin
          compileMatch,
          MultiClass,
          beforeMatchExt
        ].forEach((ext) => ext(mode, parent));
        language2.compilerExtensions.forEach((ext) => ext(mode, parent));
        mode.__beforeBegin = null;
        [
          beginKeywords,
          // do this later so compiler extensions that come earlier have access to the
          // raw array if they wanted to perhaps manipulate it, etc.
          compileIllegal,
          // default to 1 relevance if not specified
          compileRelevance
        ].forEach((ext) => ext(mode, parent));
        mode.isCompiled = true;
        let keywordPattern = null;
        if (typeof mode.keywords === "object" && mode.keywords.$pattern) {
          mode.keywords = Object.assign({}, mode.keywords);
          keywordPattern = mode.keywords.$pattern;
          delete mode.keywords.$pattern;
        }
        keywordPattern = keywordPattern || /\w+/;
        if (mode.keywords) {
          mode.keywords = compileKeywords(mode.keywords, language2.case_insensitive);
        }
        cmode.keywordPatternRe = langRe(keywordPattern, true);
        if (parent) {
          if (!mode.begin) mode.begin = /\B|\b/;
          cmode.beginRe = langRe(cmode.begin);
          if (!mode.end && !mode.endsWithParent) mode.end = /\B|\b/;
          if (mode.end) cmode.endRe = langRe(cmode.end);
          cmode.terminatorEnd = source(cmode.end) || "";
          if (mode.endsWithParent && parent.terminatorEnd) {
            cmode.terminatorEnd += (mode.end ? "|" : "") + parent.terminatorEnd;
          }
        }
        if (mode.illegal) cmode.illegalRe = langRe(
          /** @type {RegExp | string} */
          mode.illegal
        );
        if (!mode.contains) mode.contains = [];
        mode.contains = [].concat(...mode.contains.map(function(c) {
          return expandOrCloneMode(c === "self" ? mode : c);
        }));
        mode.contains.forEach(function(c) {
          compileMode(
            /** @type Mode */
            c,
            cmode
          );
        });
        if (mode.starts) {
          compileMode(mode.starts, parent);
        }
        cmode.matcher = buildModeRegex(cmode);
        return cmode;
      }
      if (!language2.compilerExtensions) language2.compilerExtensions = [];
      if (language2.contains && language2.contains.includes("self")) {
        throw new Error("ERR: contains `self` is not supported at the top-level of a language.  See documentation.");
      }
      language2.classNameAliases = inherit$1(language2.classNameAliases || {});
      return compileMode(
        /** @type Mode */
        language2
      );
    }
    function dependencyOnParent(mode) {
      if (!mode) return false;
      return mode.endsWithParent || dependencyOnParent(mode.starts);
    }
    function expandOrCloneMode(mode) {
      if (mode.variants && !mode.cachedVariants) {
        mode.cachedVariants = mode.variants.map(function(variant) {
          return inherit$1(mode, { variants: null }, variant);
        });
      }
      if (mode.cachedVariants) {
        return mode.cachedVariants;
      }
      if (dependencyOnParent(mode)) {
        return inherit$1(mode, { starts: mode.starts ? inherit$1(mode.starts) : null });
      }
      if (Object.isFrozen(mode)) {
        return inherit$1(mode);
      }
      return mode;
    }
    var version = "11.11.1";
    var HTMLInjectionError = class extends Error {
      constructor(reason, html) {
        super(reason);
        this.name = "HTMLInjectionError";
        this.html = html;
      }
    };
    var escape = escapeHTML;
    var inherit = inherit$1;
    var NO_MATCH = Symbol("nomatch");
    var MAX_KEYWORD_HITS = 7;
    var HLJS = function(hljs) {
      const languages = /* @__PURE__ */ Object.create(null);
      const aliases = /* @__PURE__ */ Object.create(null);
      const plugins = [];
      let SAFE_MODE = true;
      const LANGUAGE_NOT_FOUND = "Could not find the language '{}', did you forget to load/include a language module?";
      const PLAINTEXT_LANGUAGE = { disableAutodetect: true, name: "Plain text", contains: [] };
      let options = {
        ignoreUnescapedHTML: false,
        throwUnescapedHTML: false,
        noHighlightRe: /^(no-?highlight)$/i,
        languageDetectRe: /\blang(?:uage)?-([\w-]+)\b/i,
        classPrefix: "hljs-",
        cssSelector: "pre code",
        languages: null,
        // beta configuration options, subject to change, welcome to discuss
        // https://github.com/highlightjs/highlight.js/issues/1086
        __emitter: TokenTreeEmitter
      };
      function shouldNotHighlight(languageName) {
        return options.noHighlightRe.test(languageName);
      }
      function blockLanguage(block) {
        let classes = block.className + " ";
        classes += block.parentNode ? block.parentNode.className : "";
        const match = options.languageDetectRe.exec(classes);
        if (match) {
          const language2 = getLanguage(match[1]);
          if (!language2) {
            warn(LANGUAGE_NOT_FOUND.replace("{}", match[1]));
            warn("Falling back to no-highlight mode for this block.", block);
          }
          return language2 ? match[1] : "no-highlight";
        }
        return classes.split(/\s+/).find((_class) => shouldNotHighlight(_class) || getLanguage(_class));
      }
      function highlight2(codeOrLanguageName, optionsOrCode, ignoreIllegals) {
        let code = "";
        let languageName = "";
        if (typeof optionsOrCode === "object") {
          code = codeOrLanguageName;
          ignoreIllegals = optionsOrCode.ignoreIllegals;
          languageName = optionsOrCode.language;
        } else {
          deprecated("10.7.0", "highlight(lang, code, ...args) has been deprecated.");
          deprecated("10.7.0", "Please use highlight(code, options) instead.\nhttps://github.com/highlightjs/highlight.js/issues/2277");
          languageName = codeOrLanguageName;
          code = optionsOrCode;
        }
        if (ignoreIllegals === void 0) {
          ignoreIllegals = true;
        }
        const context = {
          code,
          language: languageName
        };
        fire("before:highlight", context);
        const result = context.result ? context.result : _highlight(context.language, context.code, ignoreIllegals);
        result.code = context.code;
        fire("after:highlight", result);
        return result;
      }
      function _highlight(languageName, codeToHighlight, ignoreIllegals, continuation) {
        const keywordHits = /* @__PURE__ */ Object.create(null);
        function keywordData(mode, matchText) {
          return mode.keywords[matchText];
        }
        function processKeywords() {
          if (!top.keywords) {
            emitter.addText(modeBuffer);
            return;
          }
          let lastIndex = 0;
          top.keywordPatternRe.lastIndex = 0;
          let match = top.keywordPatternRe.exec(modeBuffer);
          let buf = "";
          while (match) {
            buf += modeBuffer.substring(lastIndex, match.index);
            const word = language2.case_insensitive ? match[0].toLowerCase() : match[0];
            const data = keywordData(top, word);
            if (data) {
              const [kind, keywordRelevance] = data;
              emitter.addText(buf);
              buf = "";
              keywordHits[word] = (keywordHits[word] || 0) + 1;
              if (keywordHits[word] <= MAX_KEYWORD_HITS) relevance += keywordRelevance;
              if (kind.startsWith("_")) {
                buf += match[0];
              } else {
                const cssClass = language2.classNameAliases[kind] || kind;
                emitKeyword(match[0], cssClass);
              }
            } else {
              buf += match[0];
            }
            lastIndex = top.keywordPatternRe.lastIndex;
            match = top.keywordPatternRe.exec(modeBuffer);
          }
          buf += modeBuffer.substring(lastIndex);
          emitter.addText(buf);
        }
        function processSubLanguage() {
          if (modeBuffer === "") return;
          let result2 = null;
          if (typeof top.subLanguage === "string") {
            if (!languages[top.subLanguage]) {
              emitter.addText(modeBuffer);
              return;
            }
            result2 = _highlight(top.subLanguage, modeBuffer, true, continuations[top.subLanguage]);
            continuations[top.subLanguage] = /** @type {CompiledMode} */
            result2._top;
          } else {
            result2 = highlightAuto(modeBuffer, top.subLanguage.length ? top.subLanguage : null);
          }
          if (top.relevance > 0) {
            relevance += result2.relevance;
          }
          emitter.__addSublanguage(result2._emitter, result2.language);
        }
        function processBuffer() {
          if (top.subLanguage != null) {
            processSubLanguage();
          } else {
            processKeywords();
          }
          modeBuffer = "";
        }
        function emitKeyword(keyword, scope) {
          if (keyword === "") return;
          emitter.startScope(scope);
          emitter.addText(keyword);
          emitter.endScope();
        }
        function emitMultiClass(scope, match) {
          let i = 1;
          const max = match.length - 1;
          while (i <= max) {
            if (!scope._emit[i]) {
              i++;
              continue;
            }
            const klass = language2.classNameAliases[scope[i]] || scope[i];
            const text = match[i];
            if (klass) {
              emitKeyword(text, klass);
            } else {
              modeBuffer = text;
              processKeywords();
              modeBuffer = "";
            }
            i++;
          }
        }
        function startNewMode(mode, match) {
          if (mode.scope && typeof mode.scope === "string") {
            emitter.openNode(language2.classNameAliases[mode.scope] || mode.scope);
          }
          if (mode.beginScope) {
            if (mode.beginScope._wrap) {
              emitKeyword(modeBuffer, language2.classNameAliases[mode.beginScope._wrap] || mode.beginScope._wrap);
              modeBuffer = "";
            } else if (mode.beginScope._multi) {
              emitMultiClass(mode.beginScope, match);
              modeBuffer = "";
            }
          }
          top = Object.create(mode, { parent: { value: top } });
          return top;
        }
        function endOfMode(mode, match, matchPlusRemainder) {
          let matched = startsWith(mode.endRe, matchPlusRemainder);
          if (matched) {
            if (mode["on:end"]) {
              const resp = new Response(mode);
              mode["on:end"](match, resp);
              if (resp.isMatchIgnored) matched = false;
            }
            if (matched) {
              while (mode.endsParent && mode.parent) {
                mode = mode.parent;
              }
              return mode;
            }
          }
          if (mode.endsWithParent) {
            return endOfMode(mode.parent, match, matchPlusRemainder);
          }
        }
        function doIgnore(lexeme) {
          if (top.matcher.regexIndex === 0) {
            modeBuffer += lexeme[0];
            return 1;
          } else {
            resumeScanAtSamePosition = true;
            return 0;
          }
        }
        function doBeginMatch(match) {
          const lexeme = match[0];
          const newMode = match.rule;
          const resp = new Response(newMode);
          const beforeCallbacks = [newMode.__beforeBegin, newMode["on:begin"]];
          for (const cb of beforeCallbacks) {
            if (!cb) continue;
            cb(match, resp);
            if (resp.isMatchIgnored) return doIgnore(lexeme);
          }
          if (newMode.skip) {
            modeBuffer += lexeme;
          } else {
            if (newMode.excludeBegin) {
              modeBuffer += lexeme;
            }
            processBuffer();
            if (!newMode.returnBegin && !newMode.excludeBegin) {
              modeBuffer = lexeme;
            }
          }
          startNewMode(newMode, match);
          return newMode.returnBegin ? 0 : lexeme.length;
        }
        function doEndMatch(match) {
          const lexeme = match[0];
          const matchPlusRemainder = codeToHighlight.substring(match.index);
          const endMode = endOfMode(top, match, matchPlusRemainder);
          if (!endMode) {
            return NO_MATCH;
          }
          const origin = top;
          if (top.endScope && top.endScope._wrap) {
            processBuffer();
            emitKeyword(lexeme, top.endScope._wrap);
          } else if (top.endScope && top.endScope._multi) {
            processBuffer();
            emitMultiClass(top.endScope, match);
          } else if (origin.skip) {
            modeBuffer += lexeme;
          } else {
            if (!(origin.returnEnd || origin.excludeEnd)) {
              modeBuffer += lexeme;
            }
            processBuffer();
            if (origin.excludeEnd) {
              modeBuffer = lexeme;
            }
          }
          do {
            if (top.scope) {
              emitter.closeNode();
            }
            if (!top.skip && !top.subLanguage) {
              relevance += top.relevance;
            }
            top = top.parent;
          } while (top !== endMode.parent);
          if (endMode.starts) {
            startNewMode(endMode.starts, match);
          }
          return origin.returnEnd ? 0 : lexeme.length;
        }
        function processContinuations() {
          const list = [];
          for (let current = top; current !== language2; current = current.parent) {
            if (current.scope) {
              list.unshift(current.scope);
            }
          }
          list.forEach((item) => emitter.openNode(item));
        }
        let lastMatch = {};
        function processLexeme(textBeforeMatch, match) {
          const lexeme = match && match[0];
          modeBuffer += textBeforeMatch;
          if (lexeme == null) {
            processBuffer();
            return 0;
          }
          if (lastMatch.type === "begin" && match.type === "end" && lastMatch.index === match.index && lexeme === "") {
            modeBuffer += codeToHighlight.slice(match.index, match.index + 1);
            if (!SAFE_MODE) {
              const err = new Error(`0 width match regex (${languageName})`);
              err.languageName = languageName;
              err.badRule = lastMatch.rule;
              throw err;
            }
            return 1;
          }
          lastMatch = match;
          if (match.type === "begin") {
            return doBeginMatch(match);
          } else if (match.type === "illegal" && !ignoreIllegals) {
            const err = new Error('Illegal lexeme "' + lexeme + '" for mode "' + (top.scope || "<unnamed>") + '"');
            err.mode = top;
            throw err;
          } else if (match.type === "end") {
            const processed = doEndMatch(match);
            if (processed !== NO_MATCH) {
              return processed;
            }
          }
          if (match.type === "illegal" && lexeme === "") {
            modeBuffer += "\n";
            return 1;
          }
          if (iterations > 1e5 && iterations > match.index * 3) {
            const err = new Error("potential infinite loop, way more iterations than matches");
            throw err;
          }
          modeBuffer += lexeme;
          return lexeme.length;
        }
        const language2 = getLanguage(languageName);
        if (!language2) {
          error(LANGUAGE_NOT_FOUND.replace("{}", languageName));
          throw new Error('Unknown language: "' + languageName + '"');
        }
        const md = compileLanguage(language2);
        let result = "";
        let top = continuation || md;
        const continuations = {};
        const emitter = new options.__emitter(options);
        processContinuations();
        let modeBuffer = "";
        let relevance = 0;
        let index = 0;
        let iterations = 0;
        let resumeScanAtSamePosition = false;
        try {
          if (!language2.__emitTokens) {
            top.matcher.considerAll();
            for (; ; ) {
              iterations++;
              if (resumeScanAtSamePosition) {
                resumeScanAtSamePosition = false;
              } else {
                top.matcher.considerAll();
              }
              top.matcher.lastIndex = index;
              const match = top.matcher.exec(codeToHighlight);
              if (!match) break;
              const beforeMatch = codeToHighlight.substring(index, match.index);
              const processedCount = processLexeme(beforeMatch, match);
              index = match.index + processedCount;
            }
            processLexeme(codeToHighlight.substring(index));
          } else {
            language2.__emitTokens(codeToHighlight, emitter);
          }
          emitter.finalize();
          result = emitter.toHTML();
          return {
            language: languageName,
            value: result,
            relevance,
            illegal: false,
            _emitter: emitter,
            _top: top
          };
        } catch (err) {
          if (err.message && err.message.includes("Illegal")) {
            return {
              language: languageName,
              value: escape(codeToHighlight),
              illegal: true,
              relevance: 0,
              _illegalBy: {
                message: err.message,
                index,
                context: codeToHighlight.slice(index - 100, index + 100),
                mode: err.mode,
                resultSoFar: result
              },
              _emitter: emitter
            };
          } else if (SAFE_MODE) {
            return {
              language: languageName,
              value: escape(codeToHighlight),
              illegal: false,
              relevance: 0,
              errorRaised: err,
              _emitter: emitter,
              _top: top
            };
          } else {
            throw err;
          }
        }
      }
      function justTextHighlightResult(code) {
        const result = {
          value: escape(code),
          illegal: false,
          relevance: 0,
          _top: PLAINTEXT_LANGUAGE,
          _emitter: new options.__emitter(options)
        };
        result._emitter.addText(code);
        return result;
      }
      function highlightAuto(code, languageSubset) {
        languageSubset = languageSubset || options.languages || Object.keys(languages);
        const plaintext = justTextHighlightResult(code);
        const results = languageSubset.filter(getLanguage).filter(autoDetection).map(
          (name) => _highlight(name, code, false)
        );
        results.unshift(plaintext);
        const sorted = results.sort((a, b) => {
          if (a.relevance !== b.relevance) return b.relevance - a.relevance;
          if (a.language && b.language) {
            if (getLanguage(a.language).supersetOf === b.language) {
              return 1;
            } else if (getLanguage(b.language).supersetOf === a.language) {
              return -1;
            }
          }
          return 0;
        });
        const [best, secondBest] = sorted;
        const result = best;
        result.secondBest = secondBest;
        return result;
      }
      function updateClassName(element, currentLang, resultLang) {
        const language2 = currentLang && aliases[currentLang] || resultLang;
        element.classList.add("hljs");
        element.classList.add(`language-${language2}`);
      }
      function highlightElement(element) {
        let node = null;
        const language2 = blockLanguage(element);
        if (shouldNotHighlight(language2)) return;
        fire(
          "before:highlightElement",
          { el: element, language: language2 }
        );
        if (element.dataset.highlighted) {
          console.log("Element previously highlighted. To highlight again, first unset `dataset.highlighted`.", element);
          return;
        }
        if (element.children.length > 0) {
          if (!options.ignoreUnescapedHTML) {
            console.warn("One of your code blocks includes unescaped HTML. This is a potentially serious security risk.");
            console.warn("https://github.com/highlightjs/highlight.js/wiki/security");
            console.warn("The element with unescaped HTML:");
            console.warn(element);
          }
          if (options.throwUnescapedHTML) {
            const err = new HTMLInjectionError(
              "One of your code blocks includes unescaped HTML.",
              element.innerHTML
            );
            throw err;
          }
        }
        node = element;
        const text = node.textContent;
        const result = language2 ? highlight2(text, { language: language2, ignoreIllegals: true }) : highlightAuto(text);
        element.innerHTML = result.value;
        element.dataset.highlighted = "yes";
        updateClassName(element, language2, result.language);
        element.result = {
          language: result.language,
          // TODO: remove with version 11.0
          re: result.relevance,
          relevance: result.relevance
        };
        if (result.secondBest) {
          element.secondBest = {
            language: result.secondBest.language,
            relevance: result.secondBest.relevance
          };
        }
        fire("after:highlightElement", { el: element, result, text });
      }
      function configure(userOptions) {
        options = inherit(options, userOptions);
      }
      const initHighlighting = () => {
        highlightAll();
        deprecated("10.6.0", "initHighlighting() deprecated.  Use highlightAll() now.");
      };
      function initHighlightingOnLoad() {
        highlightAll();
        deprecated("10.6.0", "initHighlightingOnLoad() deprecated.  Use highlightAll() now.");
      }
      let wantsHighlight = false;
      function highlightAll() {
        function boot() {
          highlightAll();
        }
        if (document.readyState === "loading") {
          if (!wantsHighlight) {
            window.addEventListener("DOMContentLoaded", boot, false);
          }
          wantsHighlight = true;
          return;
        }
        const blocks = document.querySelectorAll(options.cssSelector);
        blocks.forEach(highlightElement);
      }
      function registerLanguage(languageName, languageDefinition) {
        let lang = null;
        try {
          lang = languageDefinition(hljs);
        } catch (error$1) {
          error("Language definition for '{}' could not be registered.".replace("{}", languageName));
          if (!SAFE_MODE) {
            throw error$1;
          } else {
            error(error$1);
          }
          lang = PLAINTEXT_LANGUAGE;
        }
        if (!lang.name) lang.name = languageName;
        languages[languageName] = lang;
        lang.rawDefinition = languageDefinition.bind(null, hljs);
        if (lang.aliases) {
          registerAliases(lang.aliases, { languageName });
        }
      }
      function unregisterLanguage(languageName) {
        delete languages[languageName];
        for (const alias of Object.keys(aliases)) {
          if (aliases[alias] === languageName) {
            delete aliases[alias];
          }
        }
      }
      function listLanguages() {
        return Object.keys(languages);
      }
      function getLanguage(name) {
        name = (name || "").toLowerCase();
        return languages[name] || languages[aliases[name]];
      }
      function registerAliases(aliasList, { languageName }) {
        if (typeof aliasList === "string") {
          aliasList = [aliasList];
        }
        aliasList.forEach((alias) => {
          aliases[alias.toLowerCase()] = languageName;
        });
      }
      function autoDetection(name) {
        const lang = getLanguage(name);
        return lang && !lang.disableAutodetect;
      }
      function upgradePluginAPI(plugin) {
        if (plugin["before:highlightBlock"] && !plugin["before:highlightElement"]) {
          plugin["before:highlightElement"] = (data) => {
            plugin["before:highlightBlock"](
              Object.assign({ block: data.el }, data)
            );
          };
        }
        if (plugin["after:highlightBlock"] && !plugin["after:highlightElement"]) {
          plugin["after:highlightElement"] = (data) => {
            plugin["after:highlightBlock"](
              Object.assign({ block: data.el }, data)
            );
          };
        }
      }
      function addPlugin(plugin) {
        upgradePluginAPI(plugin);
        plugins.push(plugin);
      }
      function removePlugin(plugin) {
        const index = plugins.indexOf(plugin);
        if (index !== -1) {
          plugins.splice(index, 1);
        }
      }
      function fire(event, args) {
        const cb = event;
        plugins.forEach(function(plugin) {
          if (plugin[cb]) {
            plugin[cb](args);
          }
        });
      }
      function deprecateHighlightBlock(el) {
        deprecated("10.7.0", "highlightBlock will be removed entirely in v12.0");
        deprecated("10.7.0", "Please use highlightElement now.");
        return highlightElement(el);
      }
      Object.assign(hljs, {
        highlight: highlight2,
        highlightAuto,
        highlightAll,
        highlightElement,
        // TODO: Remove with v12 API
        highlightBlock: deprecateHighlightBlock,
        configure,
        initHighlighting,
        initHighlightingOnLoad,
        registerLanguage,
        unregisterLanguage,
        listLanguages,
        getLanguage,
        registerAliases,
        autoDetection,
        inherit,
        addPlugin,
        removePlugin
      });
      hljs.debugMode = function() {
        SAFE_MODE = false;
      };
      hljs.safeMode = function() {
        SAFE_MODE = true;
      };
      hljs.versionString = version;
      hljs.regex = {
        concat,
        lookahead,
        either,
        optional,
        anyNumberOfTimes
      };
      for (const key in MODES2) {
        if (typeof MODES2[key] === "object") {
          deepFreeze(MODES2[key]);
        }
      }
      Object.assign(hljs, MODES2);
      return hljs;
    };
    var highlight = HLJS({});
    highlight.newInstance = () => HLJS({});
    module.exports = highlight;
    highlight.HighlightJS = highlight;
    highlight.default = highlight;
  }
});

// src/renderer/index.tsx
import { useEffect as useEffect2, useRef as useRef2, useState as useState2 } from "react";
import { createRoot as createRoot2 } from "react-dom/client";

// src/view/ReviewApp.tsx
import { useCallback, useEffect, useMemo as useMemo2, useRef, useState } from "react";

// src/view/DiffRows.tsx
import { useMemo } from "react";

// node_modules/highlight.js/es/core.js
var import_core = __toESM(require_core(), 1);
var core_default = import_core.default;

// node_modules/highlight.js/es/languages/javascript.js
var IDENT_RE = "[A-Za-z$_][0-9A-Za-z$_]*";
var KEYWORDS = [
  "as",
  // for exports
  "in",
  "of",
  "if",
  "for",
  "while",
  "finally",
  "var",
  "new",
  "function",
  "do",
  "return",
  "void",
  "else",
  "break",
  "catch",
  "instanceof",
  "with",
  "throw",
  "case",
  "default",
  "try",
  "switch",
  "continue",
  "typeof",
  "delete",
  "let",
  "yield",
  "const",
  "class",
  // JS handles these with a special rule
  // "get",
  // "set",
  "debugger",
  "async",
  "await",
  "static",
  "import",
  "from",
  "export",
  "extends",
  // It's reached stage 3, which is "recommended for implementation":
  "using"
];
var LITERALS = [
  "true",
  "false",
  "null",
  "undefined",
  "NaN",
  "Infinity"
];
var TYPES = [
  // Fundamental objects
  "Object",
  "Function",
  "Boolean",
  "Symbol",
  // numbers and dates
  "Math",
  "Date",
  "Number",
  "BigInt",
  // text
  "String",
  "RegExp",
  // Indexed collections
  "Array",
  "Float32Array",
  "Float64Array",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Int32Array",
  "Uint16Array",
  "Uint32Array",
  "BigInt64Array",
  "BigUint64Array",
  // Keyed collections
  "Set",
  "Map",
  "WeakSet",
  "WeakMap",
  // Structured data
  "ArrayBuffer",
  "SharedArrayBuffer",
  "Atomics",
  "DataView",
  "JSON",
  // Control abstraction objects
  "Promise",
  "Generator",
  "GeneratorFunction",
  "AsyncFunction",
  // Reflection
  "Reflect",
  "Proxy",
  // Internationalization
  "Intl",
  // WebAssembly
  "WebAssembly"
];
var ERROR_TYPES = [
  "Error",
  "EvalError",
  "InternalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError"
];
var BUILT_IN_GLOBALS = [
  "setInterval",
  "setTimeout",
  "clearInterval",
  "clearTimeout",
  "require",
  "exports",
  "eval",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "unescape"
];
var BUILT_IN_VARIABLES = [
  "arguments",
  "this",
  "super",
  "console",
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "module",
  "global"
  // Node.js
];
var BUILT_INS = [].concat(
  BUILT_IN_GLOBALS,
  TYPES,
  ERROR_TYPES
);
function javascript(hljs) {
  const regex = hljs.regex;
  const hasClosingTag = (match, { after }) => {
    const tag = "</" + match[0].slice(1);
    const pos = match.input.indexOf(tag, after);
    return pos !== -1;
  };
  const IDENT_RE$1 = IDENT_RE;
  const FRAGMENT = {
    begin: "<>",
    end: "</>"
  };
  const XML_SELF_CLOSING = /<[A-Za-z0-9\\._:-]+\s*\/>/;
  const XML_TAG = {
    begin: /<[A-Za-z0-9\\._:-]+/,
    end: /\/[A-Za-z0-9\\._:-]+>|\/>/,
    /**
     * @param {RegExpMatchArray} match
     * @param {CallbackResponse} response
     */
    isTrulyOpeningTag: (match, response) => {
      const afterMatchIndex = match[0].length + match.index;
      const nextChar = match.input[afterMatchIndex];
      if (
        // HTML should not include another raw `<` inside a tag
        // nested type?
        // `<Array<Array<number>>`, etc.
        nextChar === "<" || // the , gives away that this is not HTML
        // `<T, A extends keyof T, V>`
        nextChar === ","
      ) {
        response.ignoreMatch();
        return;
      }
      if (nextChar === ">") {
        if (!hasClosingTag(match, { after: afterMatchIndex })) {
          response.ignoreMatch();
        }
      }
      let m;
      const afterMatch = match.input.substring(afterMatchIndex);
      if (m = afterMatch.match(/^\s*=/)) {
        response.ignoreMatch();
        return;
      }
      if (m = afterMatch.match(/^\s+extends\s+/)) {
        if (m.index === 0) {
          response.ignoreMatch();
          return;
        }
      }
    }
  };
  const KEYWORDS$1 = {
    $pattern: IDENT_RE,
    keyword: KEYWORDS,
    literal: LITERALS,
    built_in: BUILT_INS,
    "variable.language": BUILT_IN_VARIABLES
  };
  const decimalDigits = "[0-9](_?[0-9])*";
  const frac = `\\.(${decimalDigits})`;
  const decimalInteger = `0|[1-9](_?[0-9])*|0[0-7]*[89][0-9]*`;
  const NUMBER = {
    className: "number",
    variants: [
      // DecimalLiteral
      { begin: `(\\b(${decimalInteger})((${frac})|\\.)?|(${frac}))[eE][+-]?(${decimalDigits})\\b` },
      { begin: `\\b(${decimalInteger})\\b((${frac})\\b|\\.)?|(${frac})\\b` },
      // DecimalBigIntegerLiteral
      { begin: `\\b(0|[1-9](_?[0-9])*)n\\b` },
      // NonDecimalIntegerLiteral
      { begin: "\\b0[xX][0-9a-fA-F](_?[0-9a-fA-F])*n?\\b" },
      { begin: "\\b0[bB][0-1](_?[0-1])*n?\\b" },
      { begin: "\\b0[oO][0-7](_?[0-7])*n?\\b" },
      // LegacyOctalIntegerLiteral (does not include underscore separators)
      // https://tc39.es/ecma262/#sec-additional-syntax-numeric-literals
      { begin: "\\b0[0-7]+n?\\b" }
    ],
    relevance: 0
  };
  const SUBST = {
    className: "subst",
    begin: "\\$\\{",
    end: "\\}",
    keywords: KEYWORDS$1,
    contains: []
    // defined later
  };
  const HTML_TEMPLATE = {
    begin: ".?html`",
    end: "",
    starts: {
      end: "`",
      returnEnd: false,
      contains: [
        hljs.BACKSLASH_ESCAPE,
        SUBST
      ],
      subLanguage: "xml"
    }
  };
  const CSS_TEMPLATE = {
    begin: ".?css`",
    end: "",
    starts: {
      end: "`",
      returnEnd: false,
      contains: [
        hljs.BACKSLASH_ESCAPE,
        SUBST
      ],
      subLanguage: "css"
    }
  };
  const GRAPHQL_TEMPLATE = {
    begin: ".?gql`",
    end: "",
    starts: {
      end: "`",
      returnEnd: false,
      contains: [
        hljs.BACKSLASH_ESCAPE,
        SUBST
      ],
      subLanguage: "graphql"
    }
  };
  const TEMPLATE_STRING = {
    className: "string",
    begin: "`",
    end: "`",
    contains: [
      hljs.BACKSLASH_ESCAPE,
      SUBST
    ]
  };
  const JSDOC_COMMENT = hljs.COMMENT(
    /\/\*\*(?!\/)/,
    "\\*/",
    {
      relevance: 0,
      contains: [
        {
          begin: "(?=@[A-Za-z]+)",
          relevance: 0,
          contains: [
            {
              className: "doctag",
              begin: "@[A-Za-z]+"
            },
            {
              className: "type",
              begin: "\\{",
              end: "\\}",
              excludeEnd: true,
              excludeBegin: true,
              relevance: 0
            },
            {
              className: "variable",
              begin: IDENT_RE$1 + "(?=\\s*(-)|$)",
              endsParent: true,
              relevance: 0
            },
            // eat spaces (not newlines) so we can find
            // types or variables
            {
              begin: /(?=[^\n])\s/,
              relevance: 0
            }
          ]
        }
      ]
    }
  );
  const COMMENT = {
    className: "comment",
    variants: [
      JSDOC_COMMENT,
      hljs.C_BLOCK_COMMENT_MODE,
      hljs.C_LINE_COMMENT_MODE
    ]
  };
  const SUBST_INTERNALS = [
    hljs.APOS_STRING_MODE,
    hljs.QUOTE_STRING_MODE,
    HTML_TEMPLATE,
    CSS_TEMPLATE,
    GRAPHQL_TEMPLATE,
    TEMPLATE_STRING,
    // Skip numbers when they are part of a variable name
    { match: /\$\d+/ },
    NUMBER
    // This is intentional:
    // See https://github.com/highlightjs/highlight.js/issues/3288
    // hljs.REGEXP_MODE
  ];
  SUBST.contains = SUBST_INTERNALS.concat({
    // we need to pair up {} inside our subst to prevent
    // it from ending too early by matching another }
    begin: /\{/,
    end: /\}/,
    keywords: KEYWORDS$1,
    contains: [
      "self"
    ].concat(SUBST_INTERNALS)
  });
  const SUBST_AND_COMMENTS = [].concat(COMMENT, SUBST.contains);
  const PARAMS_CONTAINS = SUBST_AND_COMMENTS.concat([
    // eat recursive parens in sub expressions
    {
      begin: /(\s*)\(/,
      end: /\)/,
      keywords: KEYWORDS$1,
      contains: ["self"].concat(SUBST_AND_COMMENTS)
    }
  ]);
  const PARAMS = {
    className: "params",
    // convert this to negative lookbehind in v12
    begin: /(\s*)\(/,
    // to match the parms with
    end: /\)/,
    excludeBegin: true,
    excludeEnd: true,
    keywords: KEYWORDS$1,
    contains: PARAMS_CONTAINS
  };
  const CLASS_OR_EXTENDS = {
    variants: [
      // class Car extends vehicle
      {
        match: [
          /class/,
          /\s+/,
          IDENT_RE$1,
          /\s+/,
          /extends/,
          /\s+/,
          regex.concat(IDENT_RE$1, "(", regex.concat(/\./, IDENT_RE$1), ")*")
        ],
        scope: {
          1: "keyword",
          3: "title.class",
          5: "keyword",
          7: "title.class.inherited"
        }
      },
      // class Car
      {
        match: [
          /class/,
          /\s+/,
          IDENT_RE$1
        ],
        scope: {
          1: "keyword",
          3: "title.class"
        }
      }
    ]
  };
  const CLASS_REFERENCE = {
    relevance: 0,
    match: regex.either(
      // Hard coded exceptions
      /\bJSON/,
      // Float32Array, OutT
      /\b[A-Z][a-z]+([A-Z][a-z]*|\d)*/,
      // CSSFactory, CSSFactoryT
      /\b[A-Z]{2,}([A-Z][a-z]+|\d)+([A-Z][a-z]*)*/,
      // FPs, FPsT
      /\b[A-Z]{2,}[a-z]+([A-Z][a-z]+|\d)*([A-Z][a-z]*)*/
      // P
      // single letters are not highlighted
      // BLAH
      // this will be flagged as a UPPER_CASE_CONSTANT instead
    ),
    className: "title.class",
    keywords: {
      _: [
        // se we still get relevance credit for JS library classes
        ...TYPES,
        ...ERROR_TYPES
      ]
    }
  };
  const USE_STRICT = {
    label: "use_strict",
    className: "meta",
    relevance: 10,
    begin: /^\s*['"]use (strict|asm)['"]/
  };
  const FUNCTION_DEFINITION = {
    variants: [
      {
        match: [
          /function/,
          /\s+/,
          IDENT_RE$1,
          /(?=\s*\()/
        ]
      },
      // anonymous function
      {
        match: [
          /function/,
          /\s*(?=\()/
        ]
      }
    ],
    className: {
      1: "keyword",
      3: "title.function"
    },
    label: "func.def",
    contains: [PARAMS],
    illegal: /%/
  };
  const UPPER_CASE_CONSTANT = {
    relevance: 0,
    match: /\b[A-Z][A-Z_0-9]+\b/,
    className: "variable.constant"
  };
  function noneOf(list) {
    return regex.concat("(?!", list.join("|"), ")");
  }
  const FUNCTION_CALL = {
    match: regex.concat(
      /\b/,
      noneOf([
        ...BUILT_IN_GLOBALS,
        "super",
        "import"
      ].map((x) => `${x}\\s*\\(`)),
      IDENT_RE$1,
      regex.lookahead(/\s*\(/)
    ),
    className: "title.function",
    relevance: 0
  };
  const PROPERTY_ACCESS = {
    begin: regex.concat(/\./, regex.lookahead(
      regex.concat(IDENT_RE$1, /(?![0-9A-Za-z$_(])/)
    )),
    end: IDENT_RE$1,
    excludeBegin: true,
    keywords: "prototype",
    className: "property",
    relevance: 0
  };
  const GETTER_OR_SETTER = {
    match: [
      /get|set/,
      /\s+/,
      IDENT_RE$1,
      /(?=\()/
    ],
    className: {
      1: "keyword",
      3: "title.function"
    },
    contains: [
      {
        // eat to avoid empty params
        begin: /\(\)/
      },
      PARAMS
    ]
  };
  const FUNC_LEAD_IN_RE = "(\\([^()]*(\\([^()]*(\\([^()]*\\)[^()]*)*\\)[^()]*)*\\)|" + hljs.UNDERSCORE_IDENT_RE + ")\\s*=>";
  const FUNCTION_VARIABLE = {
    match: [
      /const|var|let/,
      /\s+/,
      IDENT_RE$1,
      /\s*/,
      /=\s*/,
      /(async\s*)?/,
      // async is optional
      regex.lookahead(FUNC_LEAD_IN_RE)
    ],
    keywords: "async",
    className: {
      1: "keyword",
      3: "title.function"
    },
    contains: [
      PARAMS
    ]
  };
  return {
    name: "JavaScript",
    aliases: ["js", "jsx", "mjs", "cjs"],
    keywords: KEYWORDS$1,
    // this will be extended by TypeScript
    exports: { PARAMS_CONTAINS, CLASS_REFERENCE },
    illegal: /#(?![$_A-z])/,
    contains: [
      hljs.SHEBANG({
        label: "shebang",
        binary: "node",
        relevance: 5
      }),
      USE_STRICT,
      hljs.APOS_STRING_MODE,
      hljs.QUOTE_STRING_MODE,
      HTML_TEMPLATE,
      CSS_TEMPLATE,
      GRAPHQL_TEMPLATE,
      TEMPLATE_STRING,
      COMMENT,
      // Skip numbers when they are part of a variable name
      { match: /\$\d+/ },
      NUMBER,
      CLASS_REFERENCE,
      {
        scope: "attr",
        match: IDENT_RE$1 + regex.lookahead(":"),
        relevance: 0
      },
      FUNCTION_VARIABLE,
      {
        // "value" container
        begin: "(" + hljs.RE_STARTERS_RE + "|\\b(case|return|throw)\\b)\\s*",
        keywords: "return throw case",
        relevance: 0,
        contains: [
          COMMENT,
          hljs.REGEXP_MODE,
          {
            className: "function",
            // we have to count the parens to make sure we actually have the
            // correct bounding ( ) before the =>.  There could be any number of
            // sub-expressions inside also surrounded by parens.
            begin: FUNC_LEAD_IN_RE,
            returnBegin: true,
            end: "\\s*=>",
            contains: [
              {
                className: "params",
                variants: [
                  {
                    begin: hljs.UNDERSCORE_IDENT_RE,
                    relevance: 0
                  },
                  {
                    className: null,
                    begin: /\(\s*\)/,
                    skip: true
                  },
                  {
                    begin: /(\s*)\(/,
                    end: /\)/,
                    excludeBegin: true,
                    excludeEnd: true,
                    keywords: KEYWORDS$1,
                    contains: PARAMS_CONTAINS
                  }
                ]
              }
            ]
          },
          {
            // could be a comma delimited list of params to a function call
            begin: /,/,
            relevance: 0
          },
          {
            match: /\s+/,
            relevance: 0
          },
          {
            // JSX
            variants: [
              { begin: FRAGMENT.begin, end: FRAGMENT.end },
              { match: XML_SELF_CLOSING },
              {
                begin: XML_TAG.begin,
                // we carefully check the opening tag to see if it truly
                // is a tag and not a false positive
                "on:begin": XML_TAG.isTrulyOpeningTag,
                end: XML_TAG.end
              }
            ],
            subLanguage: "xml",
            contains: [
              {
                begin: XML_TAG.begin,
                end: XML_TAG.end,
                skip: true,
                contains: ["self"]
              }
            ]
          }
        ]
      },
      FUNCTION_DEFINITION,
      {
        // prevent this from getting swallowed up by function
        // since they appear "function like"
        beginKeywords: "while if switch catch for"
      },
      {
        // we have to count the parens to make sure we actually have the correct
        // bounding ( ).  There could be any number of sub-expressions inside
        // also surrounded by parens.
        begin: "\\b(?!function)" + hljs.UNDERSCORE_IDENT_RE + "\\([^()]*(\\([^()]*(\\([^()]*\\)[^()]*)*\\)[^()]*)*\\)\\s*\\{",
        // end parens
        returnBegin: true,
        label: "func.def",
        contains: [
          PARAMS,
          hljs.inherit(hljs.TITLE_MODE, { begin: IDENT_RE$1, className: "title.function" })
        ]
      },
      // catch ... so it won't trigger the property rule below
      {
        match: /\.\.\./,
        relevance: 0
      },
      PROPERTY_ACCESS,
      // hack: prevents detection of keywords in some circumstances
      // .keyword()
      // $keyword = x
      {
        match: "\\$" + IDENT_RE$1,
        relevance: 0
      },
      {
        match: [/\bconstructor(?=\s*\()/],
        className: { 1: "title.function" },
        contains: [PARAMS]
      },
      FUNCTION_CALL,
      UPPER_CASE_CONSTANT,
      CLASS_OR_EXTENDS,
      GETTER_OR_SETTER,
      {
        match: /\$[(.]/
        // relevance booster for a pattern common to JS libs: `$(something)` and `$.something`
      }
    ]
  };
}

// node_modules/highlight.js/es/languages/typescript.js
var IDENT_RE2 = "[A-Za-z$_][0-9A-Za-z$_]*";
var KEYWORDS2 = [
  "as",
  // for exports
  "in",
  "of",
  "if",
  "for",
  "while",
  "finally",
  "var",
  "new",
  "function",
  "do",
  "return",
  "void",
  "else",
  "break",
  "catch",
  "instanceof",
  "with",
  "throw",
  "case",
  "default",
  "try",
  "switch",
  "continue",
  "typeof",
  "delete",
  "let",
  "yield",
  "const",
  "class",
  // JS handles these with a special rule
  // "get",
  // "set",
  "debugger",
  "async",
  "await",
  "static",
  "import",
  "from",
  "export",
  "extends",
  // It's reached stage 3, which is "recommended for implementation":
  "using"
];
var LITERALS2 = [
  "true",
  "false",
  "null",
  "undefined",
  "NaN",
  "Infinity"
];
var TYPES2 = [
  // Fundamental objects
  "Object",
  "Function",
  "Boolean",
  "Symbol",
  // numbers and dates
  "Math",
  "Date",
  "Number",
  "BigInt",
  // text
  "String",
  "RegExp",
  // Indexed collections
  "Array",
  "Float32Array",
  "Float64Array",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Int32Array",
  "Uint16Array",
  "Uint32Array",
  "BigInt64Array",
  "BigUint64Array",
  // Keyed collections
  "Set",
  "Map",
  "WeakSet",
  "WeakMap",
  // Structured data
  "ArrayBuffer",
  "SharedArrayBuffer",
  "Atomics",
  "DataView",
  "JSON",
  // Control abstraction objects
  "Promise",
  "Generator",
  "GeneratorFunction",
  "AsyncFunction",
  // Reflection
  "Reflect",
  "Proxy",
  // Internationalization
  "Intl",
  // WebAssembly
  "WebAssembly"
];
var ERROR_TYPES2 = [
  "Error",
  "EvalError",
  "InternalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError"
];
var BUILT_IN_GLOBALS2 = [
  "setInterval",
  "setTimeout",
  "clearInterval",
  "clearTimeout",
  "require",
  "exports",
  "eval",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "unescape"
];
var BUILT_IN_VARIABLES2 = [
  "arguments",
  "this",
  "super",
  "console",
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "module",
  "global"
  // Node.js
];
var BUILT_INS2 = [].concat(
  BUILT_IN_GLOBALS2,
  TYPES2,
  ERROR_TYPES2
);
function javascript2(hljs) {
  const regex = hljs.regex;
  const hasClosingTag = (match, { after }) => {
    const tag = "</" + match[0].slice(1);
    const pos = match.input.indexOf(tag, after);
    return pos !== -1;
  };
  const IDENT_RE$1 = IDENT_RE2;
  const FRAGMENT = {
    begin: "<>",
    end: "</>"
  };
  const XML_SELF_CLOSING = /<[A-Za-z0-9\\._:-]+\s*\/>/;
  const XML_TAG = {
    begin: /<[A-Za-z0-9\\._:-]+/,
    end: /\/[A-Za-z0-9\\._:-]+>|\/>/,
    /**
     * @param {RegExpMatchArray} match
     * @param {CallbackResponse} response
     */
    isTrulyOpeningTag: (match, response) => {
      const afterMatchIndex = match[0].length + match.index;
      const nextChar = match.input[afterMatchIndex];
      if (
        // HTML should not include another raw `<` inside a tag
        // nested type?
        // `<Array<Array<number>>`, etc.
        nextChar === "<" || // the , gives away that this is not HTML
        // `<T, A extends keyof T, V>`
        nextChar === ","
      ) {
        response.ignoreMatch();
        return;
      }
      if (nextChar === ">") {
        if (!hasClosingTag(match, { after: afterMatchIndex })) {
          response.ignoreMatch();
        }
      }
      let m;
      const afterMatch = match.input.substring(afterMatchIndex);
      if (m = afterMatch.match(/^\s*=/)) {
        response.ignoreMatch();
        return;
      }
      if (m = afterMatch.match(/^\s+extends\s+/)) {
        if (m.index === 0) {
          response.ignoreMatch();
          return;
        }
      }
    }
  };
  const KEYWORDS$1 = {
    $pattern: IDENT_RE2,
    keyword: KEYWORDS2,
    literal: LITERALS2,
    built_in: BUILT_INS2,
    "variable.language": BUILT_IN_VARIABLES2
  };
  const decimalDigits = "[0-9](_?[0-9])*";
  const frac = `\\.(${decimalDigits})`;
  const decimalInteger = `0|[1-9](_?[0-9])*|0[0-7]*[89][0-9]*`;
  const NUMBER = {
    className: "number",
    variants: [
      // DecimalLiteral
      { begin: `(\\b(${decimalInteger})((${frac})|\\.)?|(${frac}))[eE][+-]?(${decimalDigits})\\b` },
      { begin: `\\b(${decimalInteger})\\b((${frac})\\b|\\.)?|(${frac})\\b` },
      // DecimalBigIntegerLiteral
      { begin: `\\b(0|[1-9](_?[0-9])*)n\\b` },
      // NonDecimalIntegerLiteral
      { begin: "\\b0[xX][0-9a-fA-F](_?[0-9a-fA-F])*n?\\b" },
      { begin: "\\b0[bB][0-1](_?[0-1])*n?\\b" },
      { begin: "\\b0[oO][0-7](_?[0-7])*n?\\b" },
      // LegacyOctalIntegerLiteral (does not include underscore separators)
      // https://tc39.es/ecma262/#sec-additional-syntax-numeric-literals
      { begin: "\\b0[0-7]+n?\\b" }
    ],
    relevance: 0
  };
  const SUBST = {
    className: "subst",
    begin: "\\$\\{",
    end: "\\}",
    keywords: KEYWORDS$1,
    contains: []
    // defined later
  };
  const HTML_TEMPLATE = {
    begin: ".?html`",
    end: "",
    starts: {
      end: "`",
      returnEnd: false,
      contains: [
        hljs.BACKSLASH_ESCAPE,
        SUBST
      ],
      subLanguage: "xml"
    }
  };
  const CSS_TEMPLATE = {
    begin: ".?css`",
    end: "",
    starts: {
      end: "`",
      returnEnd: false,
      contains: [
        hljs.BACKSLASH_ESCAPE,
        SUBST
      ],
      subLanguage: "css"
    }
  };
  const GRAPHQL_TEMPLATE = {
    begin: ".?gql`",
    end: "",
    starts: {
      end: "`",
      returnEnd: false,
      contains: [
        hljs.BACKSLASH_ESCAPE,
        SUBST
      ],
      subLanguage: "graphql"
    }
  };
  const TEMPLATE_STRING = {
    className: "string",
    begin: "`",
    end: "`",
    contains: [
      hljs.BACKSLASH_ESCAPE,
      SUBST
    ]
  };
  const JSDOC_COMMENT = hljs.COMMENT(
    /\/\*\*(?!\/)/,
    "\\*/",
    {
      relevance: 0,
      contains: [
        {
          begin: "(?=@[A-Za-z]+)",
          relevance: 0,
          contains: [
            {
              className: "doctag",
              begin: "@[A-Za-z]+"
            },
            {
              className: "type",
              begin: "\\{",
              end: "\\}",
              excludeEnd: true,
              excludeBegin: true,
              relevance: 0
            },
            {
              className: "variable",
              begin: IDENT_RE$1 + "(?=\\s*(-)|$)",
              endsParent: true,
              relevance: 0
            },
            // eat spaces (not newlines) so we can find
            // types or variables
            {
              begin: /(?=[^\n])\s/,
              relevance: 0
            }
          ]
        }
      ]
    }
  );
  const COMMENT = {
    className: "comment",
    variants: [
      JSDOC_COMMENT,
      hljs.C_BLOCK_COMMENT_MODE,
      hljs.C_LINE_COMMENT_MODE
    ]
  };
  const SUBST_INTERNALS = [
    hljs.APOS_STRING_MODE,
    hljs.QUOTE_STRING_MODE,
    HTML_TEMPLATE,
    CSS_TEMPLATE,
    GRAPHQL_TEMPLATE,
    TEMPLATE_STRING,
    // Skip numbers when they are part of a variable name
    { match: /\$\d+/ },
    NUMBER
    // This is intentional:
    // See https://github.com/highlightjs/highlight.js/issues/3288
    // hljs.REGEXP_MODE
  ];
  SUBST.contains = SUBST_INTERNALS.concat({
    // we need to pair up {} inside our subst to prevent
    // it from ending too early by matching another }
    begin: /\{/,
    end: /\}/,
    keywords: KEYWORDS$1,
    contains: [
      "self"
    ].concat(SUBST_INTERNALS)
  });
  const SUBST_AND_COMMENTS = [].concat(COMMENT, SUBST.contains);
  const PARAMS_CONTAINS = SUBST_AND_COMMENTS.concat([
    // eat recursive parens in sub expressions
    {
      begin: /(\s*)\(/,
      end: /\)/,
      keywords: KEYWORDS$1,
      contains: ["self"].concat(SUBST_AND_COMMENTS)
    }
  ]);
  const PARAMS = {
    className: "params",
    // convert this to negative lookbehind in v12
    begin: /(\s*)\(/,
    // to match the parms with
    end: /\)/,
    excludeBegin: true,
    excludeEnd: true,
    keywords: KEYWORDS$1,
    contains: PARAMS_CONTAINS
  };
  const CLASS_OR_EXTENDS = {
    variants: [
      // class Car extends vehicle
      {
        match: [
          /class/,
          /\s+/,
          IDENT_RE$1,
          /\s+/,
          /extends/,
          /\s+/,
          regex.concat(IDENT_RE$1, "(", regex.concat(/\./, IDENT_RE$1), ")*")
        ],
        scope: {
          1: "keyword",
          3: "title.class",
          5: "keyword",
          7: "title.class.inherited"
        }
      },
      // class Car
      {
        match: [
          /class/,
          /\s+/,
          IDENT_RE$1
        ],
        scope: {
          1: "keyword",
          3: "title.class"
        }
      }
    ]
  };
  const CLASS_REFERENCE = {
    relevance: 0,
    match: regex.either(
      // Hard coded exceptions
      /\bJSON/,
      // Float32Array, OutT
      /\b[A-Z][a-z]+([A-Z][a-z]*|\d)*/,
      // CSSFactory, CSSFactoryT
      /\b[A-Z]{2,}([A-Z][a-z]+|\d)+([A-Z][a-z]*)*/,
      // FPs, FPsT
      /\b[A-Z]{2,}[a-z]+([A-Z][a-z]+|\d)*([A-Z][a-z]*)*/
      // P
      // single letters are not highlighted
      // BLAH
      // this will be flagged as a UPPER_CASE_CONSTANT instead
    ),
    className: "title.class",
    keywords: {
      _: [
        // se we still get relevance credit for JS library classes
        ...TYPES2,
        ...ERROR_TYPES2
      ]
    }
  };
  const USE_STRICT = {
    label: "use_strict",
    className: "meta",
    relevance: 10,
    begin: /^\s*['"]use (strict|asm)['"]/
  };
  const FUNCTION_DEFINITION = {
    variants: [
      {
        match: [
          /function/,
          /\s+/,
          IDENT_RE$1,
          /(?=\s*\()/
        ]
      },
      // anonymous function
      {
        match: [
          /function/,
          /\s*(?=\()/
        ]
      }
    ],
    className: {
      1: "keyword",
      3: "title.function"
    },
    label: "func.def",
    contains: [PARAMS],
    illegal: /%/
  };
  const UPPER_CASE_CONSTANT = {
    relevance: 0,
    match: /\b[A-Z][A-Z_0-9]+\b/,
    className: "variable.constant"
  };
  function noneOf(list) {
    return regex.concat("(?!", list.join("|"), ")");
  }
  const FUNCTION_CALL = {
    match: regex.concat(
      /\b/,
      noneOf([
        ...BUILT_IN_GLOBALS2,
        "super",
        "import"
      ].map((x) => `${x}\\s*\\(`)),
      IDENT_RE$1,
      regex.lookahead(/\s*\(/)
    ),
    className: "title.function",
    relevance: 0
  };
  const PROPERTY_ACCESS = {
    begin: regex.concat(/\./, regex.lookahead(
      regex.concat(IDENT_RE$1, /(?![0-9A-Za-z$_(])/)
    )),
    end: IDENT_RE$1,
    excludeBegin: true,
    keywords: "prototype",
    className: "property",
    relevance: 0
  };
  const GETTER_OR_SETTER = {
    match: [
      /get|set/,
      /\s+/,
      IDENT_RE$1,
      /(?=\()/
    ],
    className: {
      1: "keyword",
      3: "title.function"
    },
    contains: [
      {
        // eat to avoid empty params
        begin: /\(\)/
      },
      PARAMS
    ]
  };
  const FUNC_LEAD_IN_RE = "(\\([^()]*(\\([^()]*(\\([^()]*\\)[^()]*)*\\)[^()]*)*\\)|" + hljs.UNDERSCORE_IDENT_RE + ")\\s*=>";
  const FUNCTION_VARIABLE = {
    match: [
      /const|var|let/,
      /\s+/,
      IDENT_RE$1,
      /\s*/,
      /=\s*/,
      /(async\s*)?/,
      // async is optional
      regex.lookahead(FUNC_LEAD_IN_RE)
    ],
    keywords: "async",
    className: {
      1: "keyword",
      3: "title.function"
    },
    contains: [
      PARAMS
    ]
  };
  return {
    name: "JavaScript",
    aliases: ["js", "jsx", "mjs", "cjs"],
    keywords: KEYWORDS$1,
    // this will be extended by TypeScript
    exports: { PARAMS_CONTAINS, CLASS_REFERENCE },
    illegal: /#(?![$_A-z])/,
    contains: [
      hljs.SHEBANG({
        label: "shebang",
        binary: "node",
        relevance: 5
      }),
      USE_STRICT,
      hljs.APOS_STRING_MODE,
      hljs.QUOTE_STRING_MODE,
      HTML_TEMPLATE,
      CSS_TEMPLATE,
      GRAPHQL_TEMPLATE,
      TEMPLATE_STRING,
      COMMENT,
      // Skip numbers when they are part of a variable name
      { match: /\$\d+/ },
      NUMBER,
      CLASS_REFERENCE,
      {
        scope: "attr",
        match: IDENT_RE$1 + regex.lookahead(":"),
        relevance: 0
      },
      FUNCTION_VARIABLE,
      {
        // "value" container
        begin: "(" + hljs.RE_STARTERS_RE + "|\\b(case|return|throw)\\b)\\s*",
        keywords: "return throw case",
        relevance: 0,
        contains: [
          COMMENT,
          hljs.REGEXP_MODE,
          {
            className: "function",
            // we have to count the parens to make sure we actually have the
            // correct bounding ( ) before the =>.  There could be any number of
            // sub-expressions inside also surrounded by parens.
            begin: FUNC_LEAD_IN_RE,
            returnBegin: true,
            end: "\\s*=>",
            contains: [
              {
                className: "params",
                variants: [
                  {
                    begin: hljs.UNDERSCORE_IDENT_RE,
                    relevance: 0
                  },
                  {
                    className: null,
                    begin: /\(\s*\)/,
                    skip: true
                  },
                  {
                    begin: /(\s*)\(/,
                    end: /\)/,
                    excludeBegin: true,
                    excludeEnd: true,
                    keywords: KEYWORDS$1,
                    contains: PARAMS_CONTAINS
                  }
                ]
              }
            ]
          },
          {
            // could be a comma delimited list of params to a function call
            begin: /,/,
            relevance: 0
          },
          {
            match: /\s+/,
            relevance: 0
          },
          {
            // JSX
            variants: [
              { begin: FRAGMENT.begin, end: FRAGMENT.end },
              { match: XML_SELF_CLOSING },
              {
                begin: XML_TAG.begin,
                // we carefully check the opening tag to see if it truly
                // is a tag and not a false positive
                "on:begin": XML_TAG.isTrulyOpeningTag,
                end: XML_TAG.end
              }
            ],
            subLanguage: "xml",
            contains: [
              {
                begin: XML_TAG.begin,
                end: XML_TAG.end,
                skip: true,
                contains: ["self"]
              }
            ]
          }
        ]
      },
      FUNCTION_DEFINITION,
      {
        // prevent this from getting swallowed up by function
        // since they appear "function like"
        beginKeywords: "while if switch catch for"
      },
      {
        // we have to count the parens to make sure we actually have the correct
        // bounding ( ).  There could be any number of sub-expressions inside
        // also surrounded by parens.
        begin: "\\b(?!function)" + hljs.UNDERSCORE_IDENT_RE + "\\([^()]*(\\([^()]*(\\([^()]*\\)[^()]*)*\\)[^()]*)*\\)\\s*\\{",
        // end parens
        returnBegin: true,
        label: "func.def",
        contains: [
          PARAMS,
          hljs.inherit(hljs.TITLE_MODE, { begin: IDENT_RE$1, className: "title.function" })
        ]
      },
      // catch ... so it won't trigger the property rule below
      {
        match: /\.\.\./,
        relevance: 0
      },
      PROPERTY_ACCESS,
      // hack: prevents detection of keywords in some circumstances
      // .keyword()
      // $keyword = x
      {
        match: "\\$" + IDENT_RE$1,
        relevance: 0
      },
      {
        match: [/\bconstructor(?=\s*\()/],
        className: { 1: "title.function" },
        contains: [PARAMS]
      },
      FUNCTION_CALL,
      UPPER_CASE_CONSTANT,
      CLASS_OR_EXTENDS,
      GETTER_OR_SETTER,
      {
        match: /\$[(.]/
        // relevance booster for a pattern common to JS libs: `$(something)` and `$.something`
      }
    ]
  };
}
function typescript(hljs) {
  const regex = hljs.regex;
  const tsLanguage = javascript2(hljs);
  const IDENT_RE$1 = IDENT_RE2;
  const TYPES3 = [
    "any",
    "void",
    "number",
    "boolean",
    "string",
    "object",
    "never",
    "symbol",
    "bigint",
    "unknown"
  ];
  const NAMESPACE = {
    begin: [
      /namespace/,
      /\s+/,
      hljs.IDENT_RE
    ],
    beginScope: {
      1: "keyword",
      3: "title.class"
    }
  };
  const INTERFACE = {
    beginKeywords: "interface",
    end: /\{/,
    excludeEnd: true,
    keywords: {
      keyword: "interface extends",
      built_in: TYPES3
    },
    contains: [tsLanguage.exports.CLASS_REFERENCE]
  };
  const USE_STRICT = {
    className: "meta",
    relevance: 10,
    begin: /^\s*['"]use strict['"]/
  };
  const TS_SPECIFIC_KEYWORDS = [
    "type",
    // "namespace",
    "interface",
    "public",
    "private",
    "protected",
    "implements",
    "declare",
    "abstract",
    "readonly",
    "enum",
    "override",
    "satisfies"
  ];
  const KEYWORDS$1 = {
    $pattern: IDENT_RE2,
    keyword: KEYWORDS2.concat(TS_SPECIFIC_KEYWORDS),
    literal: LITERALS2,
    built_in: BUILT_INS2.concat(TYPES3),
    "variable.language": BUILT_IN_VARIABLES2
  };
  const DECORATOR = {
    className: "meta",
    begin: "@" + IDENT_RE$1
  };
  const swapMode = (mode, label, replacement) => {
    const indx = mode.contains.findIndex((m) => m.label === label);
    if (indx === -1) {
      throw new Error("can not find mode to replace");
    }
    mode.contains.splice(indx, 1, replacement);
  };
  Object.assign(tsLanguage.keywords, KEYWORDS$1);
  tsLanguage.exports.PARAMS_CONTAINS.push(DECORATOR);
  const ATTRIBUTE_HIGHLIGHT = tsLanguage.contains.find((c) => c.scope === "attr");
  const OPTIONAL_KEY_OR_ARGUMENT = Object.assign(
    {},
    ATTRIBUTE_HIGHLIGHT,
    { match: regex.concat(IDENT_RE$1, regex.lookahead(/\s*\?:/)) }
  );
  tsLanguage.exports.PARAMS_CONTAINS.push([
    tsLanguage.exports.CLASS_REFERENCE,
    // class reference for highlighting the params types
    ATTRIBUTE_HIGHLIGHT,
    // highlight the params key
    OPTIONAL_KEY_OR_ARGUMENT
    // Added for optional property assignment highlighting
  ]);
  tsLanguage.contains = tsLanguage.contains.concat([
    DECORATOR,
    NAMESPACE,
    INTERFACE,
    OPTIONAL_KEY_OR_ARGUMENT
    // Added for optional property assignment highlighting
  ]);
  swapMode(tsLanguage, "shebang", hljs.SHEBANG());
  swapMode(tsLanguage, "use_strict", USE_STRICT);
  const functionDeclaration = tsLanguage.contains.find((m) => m.label === "func.def");
  functionDeclaration.relevance = 0;
  Object.assign(tsLanguage, {
    name: "TypeScript",
    aliases: [
      "ts",
      "tsx",
      "mts",
      "cts"
    ]
  });
  return tsLanguage;
}

// node_modules/highlight.js/es/languages/python.js
function python(hljs) {
  const regex = hljs.regex;
  const IDENT_RE3 = /[\p{XID_Start}_]\p{XID_Continue}*/u;
  const RESERVED_WORDS = [
    "and",
    "as",
    "assert",
    "async",
    "await",
    "break",
    "case",
    "class",
    "continue",
    "def",
    "del",
    "elif",
    "else",
    "except",
    "finally",
    "for",
    "from",
    "global",
    "if",
    "import",
    "in",
    "is",
    "lambda",
    "match",
    "nonlocal|10",
    "not",
    "or",
    "pass",
    "raise",
    "return",
    "try",
    "while",
    "with",
    "yield"
  ];
  const BUILT_INS3 = [
    "__import__",
    "abs",
    "all",
    "any",
    "ascii",
    "bin",
    "bool",
    "breakpoint",
    "bytearray",
    "bytes",
    "callable",
    "chr",
    "classmethod",
    "compile",
    "complex",
    "delattr",
    "dict",
    "dir",
    "divmod",
    "enumerate",
    "eval",
    "exec",
    "filter",
    "float",
    "format",
    "frozenset",
    "getattr",
    "globals",
    "hasattr",
    "hash",
    "help",
    "hex",
    "id",
    "input",
    "int",
    "isinstance",
    "issubclass",
    "iter",
    "len",
    "list",
    "locals",
    "map",
    "max",
    "memoryview",
    "min",
    "next",
    "object",
    "oct",
    "open",
    "ord",
    "pow",
    "print",
    "property",
    "range",
    "repr",
    "reversed",
    "round",
    "set",
    "setattr",
    "slice",
    "sorted",
    "staticmethod",
    "str",
    "sum",
    "super",
    "tuple",
    "type",
    "vars",
    "zip"
  ];
  const LITERALS3 = [
    "__debug__",
    "Ellipsis",
    "False",
    "None",
    "NotImplemented",
    "True"
  ];
  const TYPES3 = [
    "Any",
    "Callable",
    "Coroutine",
    "Dict",
    "List",
    "Literal",
    "Generic",
    "Optional",
    "Sequence",
    "Set",
    "Tuple",
    "Type",
    "Union"
  ];
  const KEYWORDS3 = {
    $pattern: /[A-Za-z]\w+|__\w+__/,
    keyword: RESERVED_WORDS,
    built_in: BUILT_INS3,
    literal: LITERALS3,
    type: TYPES3
  };
  const PROMPT = {
    className: "meta",
    begin: /^(>>>|\.\.\.) /
  };
  const SUBST = {
    className: "subst",
    begin: /\{/,
    end: /\}/,
    keywords: KEYWORDS3,
    illegal: /#/
  };
  const LITERAL_BRACKET = {
    begin: /\{\{/,
    relevance: 0
  };
  const STRING = {
    className: "string",
    contains: [hljs.BACKSLASH_ESCAPE],
    variants: [
      {
        begin: /([uU]|[bB]|[rR]|[bB][rR]|[rR][bB])?'''/,
        end: /'''/,
        contains: [
          hljs.BACKSLASH_ESCAPE,
          PROMPT
        ],
        relevance: 10
      },
      {
        begin: /([uU]|[bB]|[rR]|[bB][rR]|[rR][bB])?"""/,
        end: /"""/,
        contains: [
          hljs.BACKSLASH_ESCAPE,
          PROMPT
        ],
        relevance: 10
      },
      {
        begin: /([fF][rR]|[rR][fF]|[fF])'''/,
        end: /'''/,
        contains: [
          hljs.BACKSLASH_ESCAPE,
          PROMPT,
          LITERAL_BRACKET,
          SUBST
        ]
      },
      {
        begin: /([fF][rR]|[rR][fF]|[fF])"""/,
        end: /"""/,
        contains: [
          hljs.BACKSLASH_ESCAPE,
          PROMPT,
          LITERAL_BRACKET,
          SUBST
        ]
      },
      {
        begin: /([uU]|[rR])'/,
        end: /'/,
        relevance: 10
      },
      {
        begin: /([uU]|[rR])"/,
        end: /"/,
        relevance: 10
      },
      {
        begin: /([bB]|[bB][rR]|[rR][bB])'/,
        end: /'/
      },
      {
        begin: /([bB]|[bB][rR]|[rR][bB])"/,
        end: /"/
      },
      {
        begin: /([fF][rR]|[rR][fF]|[fF])'/,
        end: /'/,
        contains: [
          hljs.BACKSLASH_ESCAPE,
          LITERAL_BRACKET,
          SUBST
        ]
      },
      {
        begin: /([fF][rR]|[rR][fF]|[fF])"/,
        end: /"/,
        contains: [
          hljs.BACKSLASH_ESCAPE,
          LITERAL_BRACKET,
          SUBST
        ]
      },
      hljs.APOS_STRING_MODE,
      hljs.QUOTE_STRING_MODE
    ]
  };
  const digitpart = "[0-9](_?[0-9])*";
  const pointfloat = `(\\b(${digitpart}))?\\.(${digitpart})|\\b(${digitpart})\\.`;
  const lookahead = `\\b|${RESERVED_WORDS.join("|")}`;
  const NUMBER = {
    className: "number",
    relevance: 0,
    variants: [
      // exponentfloat, pointfloat
      // https://docs.python.org/3.9/reference/lexical_analysis.html#floating-point-literals
      // optionally imaginary
      // https://docs.python.org/3.9/reference/lexical_analysis.html#imaginary-literals
      // Note: no leading \b because floats can start with a decimal point
      // and we don't want to mishandle e.g. `fn(.5)`,
      // no trailing \b for pointfloat because it can end with a decimal point
      // and we don't want to mishandle e.g. `0..hex()`; this should be safe
      // because both MUST contain a decimal point and so cannot be confused with
      // the interior part of an identifier
      {
        begin: `(\\b(${digitpart})|(${pointfloat}))[eE][+-]?(${digitpart})[jJ]?(?=${lookahead})`
      },
      {
        begin: `(${pointfloat})[jJ]?`
      },
      // decinteger, bininteger, octinteger, hexinteger
      // https://docs.python.org/3.9/reference/lexical_analysis.html#integer-literals
      // optionally "long" in Python 2
      // https://docs.python.org/2.7/reference/lexical_analysis.html#integer-and-long-integer-literals
      // decinteger is optionally imaginary
      // https://docs.python.org/3.9/reference/lexical_analysis.html#imaginary-literals
      {
        begin: `\\b([1-9](_?[0-9])*|0+(_?0)*)[lLjJ]?(?=${lookahead})`
      },
      {
        begin: `\\b0[bB](_?[01])+[lL]?(?=${lookahead})`
      },
      {
        begin: `\\b0[oO](_?[0-7])+[lL]?(?=${lookahead})`
      },
      {
        begin: `\\b0[xX](_?[0-9a-fA-F])+[lL]?(?=${lookahead})`
      },
      // imagnumber (digitpart-based)
      // https://docs.python.org/3.9/reference/lexical_analysis.html#imaginary-literals
      {
        begin: `\\b(${digitpart})[jJ](?=${lookahead})`
      }
    ]
  };
  const COMMENT_TYPE = {
    className: "comment",
    begin: regex.lookahead(/# type:/),
    end: /$/,
    keywords: KEYWORDS3,
    contains: [
      {
        // prevent keywords from coloring `type`
        begin: /# type:/
      },
      // comment within a datatype comment includes no keywords
      {
        begin: /#/,
        end: /\b\B/,
        endsWithParent: true
      }
    ]
  };
  const PARAMS = {
    className: "params",
    variants: [
      // Exclude params in functions without params
      {
        className: "",
        begin: /\(\s*\)/,
        skip: true
      },
      {
        begin: /\(/,
        end: /\)/,
        excludeBegin: true,
        excludeEnd: true,
        keywords: KEYWORDS3,
        contains: [
          "self",
          PROMPT,
          NUMBER,
          STRING,
          hljs.HASH_COMMENT_MODE
        ]
      }
    ]
  };
  SUBST.contains = [
    STRING,
    NUMBER,
    PROMPT
  ];
  return {
    name: "Python",
    aliases: [
      "py",
      "gyp",
      "ipython"
    ],
    unicodeRegex: true,
    keywords: KEYWORDS3,
    illegal: /(<\/|\?)|=>/,
    contains: [
      PROMPT,
      NUMBER,
      {
        // very common convention
        scope: "variable.language",
        match: /\bself\b/
      },
      {
        // eat "if" prior to string so that it won't accidentally be
        // labeled as an f-string
        beginKeywords: "if",
        relevance: 0
      },
      { match: /\bor\b/, scope: "keyword" },
      STRING,
      COMMENT_TYPE,
      hljs.HASH_COMMENT_MODE,
      {
        match: [
          /\bdef/,
          /\s+/,
          IDENT_RE3
        ],
        scope: {
          1: "keyword",
          3: "title.function"
        },
        contains: [PARAMS]
      },
      {
        variants: [
          {
            match: [
              /\bclass/,
              /\s+/,
              IDENT_RE3,
              /\s*/,
              /\(\s*/,
              IDENT_RE3,
              /\s*\)/
            ]
          },
          {
            match: [
              /\bclass/,
              /\s+/,
              IDENT_RE3
            ]
          }
        ],
        scope: {
          1: "keyword",
          3: "title.class",
          6: "title.class.inherited"
        }
      },
      {
        className: "meta",
        begin: /^[\t ]*@/,
        end: /(?=#)|$/,
        contains: [
          NUMBER,
          PARAMS,
          STRING
        ]
      }
    ]
  };
}

// node_modules/highlight.js/es/languages/json.js
function json(hljs) {
  const ATTRIBUTE = {
    className: "attr",
    begin: /"(\\.|[^\\"\r\n])*"(?=\s*:)/,
    relevance: 1.01
  };
  const PUNCTUATION = {
    match: /[{}[\],:]/,
    className: "punctuation",
    relevance: 0
  };
  const LITERALS3 = [
    "true",
    "false",
    "null"
  ];
  const LITERALS_MODE = {
    scope: "literal",
    beginKeywords: LITERALS3.join(" ")
  };
  return {
    name: "JSON",
    aliases: ["jsonc"],
    keywords: {
      literal: LITERALS3
    },
    contains: [
      ATTRIBUTE,
      PUNCTUATION,
      hljs.QUOTE_STRING_MODE,
      LITERALS_MODE,
      hljs.C_NUMBER_MODE,
      hljs.C_LINE_COMMENT_MODE,
      hljs.C_BLOCK_COMMENT_MODE
    ],
    illegal: "\\S"
  };
}

// node_modules/highlight.js/es/languages/css.js
var MODES = (hljs) => {
  return {
    IMPORTANT: {
      scope: "meta",
      begin: "!important"
    },
    BLOCK_COMMENT: hljs.C_BLOCK_COMMENT_MODE,
    HEXCOLOR: {
      scope: "number",
      begin: /#(([0-9a-fA-F]{3,4})|(([0-9a-fA-F]{2}){3,4}))\b/
    },
    FUNCTION_DISPATCH: {
      className: "built_in",
      begin: /[\w-]+(?=\()/
    },
    ATTRIBUTE_SELECTOR_MODE: {
      scope: "selector-attr",
      begin: /\[/,
      end: /\]/,
      illegal: "$",
      contains: [
        hljs.APOS_STRING_MODE,
        hljs.QUOTE_STRING_MODE
      ]
    },
    CSS_NUMBER_MODE: {
      scope: "number",
      begin: hljs.NUMBER_RE + "(%|em|ex|ch|rem|vw|vh|vmin|vmax|cm|mm|in|pt|pc|px|deg|grad|rad|turn|s|ms|Hz|kHz|dpi|dpcm|dppx)?",
      relevance: 0
    },
    CSS_VARIABLE: {
      className: "attr",
      begin: /--[A-Za-z_][A-Za-z0-9_-]*/
    }
  };
};
var HTML_TAGS = [
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "audio",
  "b",
  "blockquote",
  "body",
  "button",
  "canvas",
  "caption",
  "cite",
  "code",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "html",
  "i",
  "iframe",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "legend",
  "li",
  "main",
  "mark",
  "menu",
  "nav",
  "object",
  "ol",
  "optgroup",
  "option",
  "p",
  "picture",
  "q",
  "quote",
  "samp",
  "section",
  "select",
  "source",
  "span",
  "strong",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "ul",
  "var",
  "video"
];
var SVG_TAGS = [
  "defs",
  "g",
  "marker",
  "mask",
  "pattern",
  "svg",
  "switch",
  "symbol",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feFlood",
  "feGaussianBlur",
  "feImage",
  "feMerge",
  "feMorphology",
  "feOffset",
  "feSpecularLighting",
  "feTile",
  "feTurbulence",
  "linearGradient",
  "radialGradient",
  "stop",
  "circle",
  "ellipse",
  "image",
  "line",
  "path",
  "polygon",
  "polyline",
  "rect",
  "text",
  "use",
  "textPath",
  "tspan",
  "foreignObject",
  "clipPath"
];
var TAGS = [
  ...HTML_TAGS,
  ...SVG_TAGS
];
var MEDIA_FEATURES = [
  "any-hover",
  "any-pointer",
  "aspect-ratio",
  "color",
  "color-gamut",
  "color-index",
  "device-aspect-ratio",
  "device-height",
  "device-width",
  "display-mode",
  "forced-colors",
  "grid",
  "height",
  "hover",
  "inverted-colors",
  "monochrome",
  "orientation",
  "overflow-block",
  "overflow-inline",
  "pointer",
  "prefers-color-scheme",
  "prefers-contrast",
  "prefers-reduced-motion",
  "prefers-reduced-transparency",
  "resolution",
  "scan",
  "scripting",
  "update",
  "width",
  // TODO: find a better solution?
  "min-width",
  "max-width",
  "min-height",
  "max-height"
].sort().reverse();
var PSEUDO_CLASSES = [
  "active",
  "any-link",
  "blank",
  "checked",
  "current",
  "default",
  "defined",
  "dir",
  // dir()
  "disabled",
  "drop",
  "empty",
  "enabled",
  "first",
  "first-child",
  "first-of-type",
  "fullscreen",
  "future",
  "focus",
  "focus-visible",
  "focus-within",
  "has",
  // has()
  "host",
  // host or host()
  "host-context",
  // host-context()
  "hover",
  "indeterminate",
  "in-range",
  "invalid",
  "is",
  // is()
  "lang",
  // lang()
  "last-child",
  "last-of-type",
  "left",
  "link",
  "local-link",
  "not",
  // not()
  "nth-child",
  // nth-child()
  "nth-col",
  // nth-col()
  "nth-last-child",
  // nth-last-child()
  "nth-last-col",
  // nth-last-col()
  "nth-last-of-type",
  //nth-last-of-type()
  "nth-of-type",
  //nth-of-type()
  "only-child",
  "only-of-type",
  "optional",
  "out-of-range",
  "past",
  "placeholder-shown",
  "read-only",
  "read-write",
  "required",
  "right",
  "root",
  "scope",
  "target",
  "target-within",
  "user-invalid",
  "valid",
  "visited",
  "where"
  // where()
].sort().reverse();
var PSEUDO_ELEMENTS = [
  "after",
  "backdrop",
  "before",
  "cue",
  "cue-region",
  "first-letter",
  "first-line",
  "grammar-error",
  "marker",
  "part",
  "placeholder",
  "selection",
  "slotted",
  "spelling-error"
].sort().reverse();
var ATTRIBUTES = [
  "accent-color",
  "align-content",
  "align-items",
  "align-self",
  "alignment-baseline",
  "all",
  "anchor-name",
  "animation",
  "animation-composition",
  "animation-delay",
  "animation-direction",
  "animation-duration",
  "animation-fill-mode",
  "animation-iteration-count",
  "animation-name",
  "animation-play-state",
  "animation-range",
  "animation-range-end",
  "animation-range-start",
  "animation-timeline",
  "animation-timing-function",
  "appearance",
  "aspect-ratio",
  "backdrop-filter",
  "backface-visibility",
  "background",
  "background-attachment",
  "background-blend-mode",
  "background-clip",
  "background-color",
  "background-image",
  "background-origin",
  "background-position",
  "background-position-x",
  "background-position-y",
  "background-repeat",
  "background-size",
  "baseline-shift",
  "block-size",
  "border",
  "border-block",
  "border-block-color",
  "border-block-end",
  "border-block-end-color",
  "border-block-end-style",
  "border-block-end-width",
  "border-block-start",
  "border-block-start-color",
  "border-block-start-style",
  "border-block-start-width",
  "border-block-style",
  "border-block-width",
  "border-bottom",
  "border-bottom-color",
  "border-bottom-left-radius",
  "border-bottom-right-radius",
  "border-bottom-style",
  "border-bottom-width",
  "border-collapse",
  "border-color",
  "border-end-end-radius",
  "border-end-start-radius",
  "border-image",
  "border-image-outset",
  "border-image-repeat",
  "border-image-slice",
  "border-image-source",
  "border-image-width",
  "border-inline",
  "border-inline-color",
  "border-inline-end",
  "border-inline-end-color",
  "border-inline-end-style",
  "border-inline-end-width",
  "border-inline-start",
  "border-inline-start-color",
  "border-inline-start-style",
  "border-inline-start-width",
  "border-inline-style",
  "border-inline-width",
  "border-left",
  "border-left-color",
  "border-left-style",
  "border-left-width",
  "border-radius",
  "border-right",
  "border-right-color",
  "border-right-style",
  "border-right-width",
  "border-spacing",
  "border-start-end-radius",
  "border-start-start-radius",
  "border-style",
  "border-top",
  "border-top-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-top-style",
  "border-top-width",
  "border-width",
  "bottom",
  "box-align",
  "box-decoration-break",
  "box-direction",
  "box-flex",
  "box-flex-group",
  "box-lines",
  "box-ordinal-group",
  "box-orient",
  "box-pack",
  "box-shadow",
  "box-sizing",
  "break-after",
  "break-before",
  "break-inside",
  "caption-side",
  "caret-color",
  "clear",
  "clip",
  "clip-path",
  "clip-rule",
  "color",
  "color-interpolation",
  "color-interpolation-filters",
  "color-profile",
  "color-rendering",
  "color-scheme",
  "column-count",
  "column-fill",
  "column-gap",
  "column-rule",
  "column-rule-color",
  "column-rule-style",
  "column-rule-width",
  "column-span",
  "column-width",
  "columns",
  "contain",
  "contain-intrinsic-block-size",
  "contain-intrinsic-height",
  "contain-intrinsic-inline-size",
  "contain-intrinsic-size",
  "contain-intrinsic-width",
  "container",
  "container-name",
  "container-type",
  "content",
  "content-visibility",
  "counter-increment",
  "counter-reset",
  "counter-set",
  "cue",
  "cue-after",
  "cue-before",
  "cursor",
  "cx",
  "cy",
  "direction",
  "display",
  "dominant-baseline",
  "empty-cells",
  "enable-background",
  "field-sizing",
  "fill",
  "fill-opacity",
  "fill-rule",
  "filter",
  "flex",
  "flex-basis",
  "flex-direction",
  "flex-flow",
  "flex-grow",
  "flex-shrink",
  "flex-wrap",
  "float",
  "flood-color",
  "flood-opacity",
  "flow",
  "font",
  "font-display",
  "font-family",
  "font-feature-settings",
  "font-kerning",
  "font-language-override",
  "font-optical-sizing",
  "font-palette",
  "font-size",
  "font-size-adjust",
  "font-smooth",
  "font-smoothing",
  "font-stretch",
  "font-style",
  "font-synthesis",
  "font-synthesis-position",
  "font-synthesis-small-caps",
  "font-synthesis-style",
  "font-synthesis-weight",
  "font-variant",
  "font-variant-alternates",
  "font-variant-caps",
  "font-variant-east-asian",
  "font-variant-emoji",
  "font-variant-ligatures",
  "font-variant-numeric",
  "font-variant-position",
  "font-variation-settings",
  "font-weight",
  "forced-color-adjust",
  "gap",
  "glyph-orientation-horizontal",
  "glyph-orientation-vertical",
  "grid",
  "grid-area",
  "grid-auto-columns",
  "grid-auto-flow",
  "grid-auto-rows",
  "grid-column",
  "grid-column-end",
  "grid-column-start",
  "grid-gap",
  "grid-row",
  "grid-row-end",
  "grid-row-start",
  "grid-template",
  "grid-template-areas",
  "grid-template-columns",
  "grid-template-rows",
  "hanging-punctuation",
  "height",
  "hyphenate-character",
  "hyphenate-limit-chars",
  "hyphens",
  "icon",
  "image-orientation",
  "image-rendering",
  "image-resolution",
  "ime-mode",
  "initial-letter",
  "initial-letter-align",
  "inline-size",
  "inset",
  "inset-area",
  "inset-block",
  "inset-block-end",
  "inset-block-start",
  "inset-inline",
  "inset-inline-end",
  "inset-inline-start",
  "isolation",
  "justify-content",
  "justify-items",
  "justify-self",
  "kerning",
  "left",
  "letter-spacing",
  "lighting-color",
  "line-break",
  "line-height",
  "line-height-step",
  "list-style",
  "list-style-image",
  "list-style-position",
  "list-style-type",
  "margin",
  "margin-block",
  "margin-block-end",
  "margin-block-start",
  "margin-bottom",
  "margin-inline",
  "margin-inline-end",
  "margin-inline-start",
  "margin-left",
  "margin-right",
  "margin-top",
  "margin-trim",
  "marker",
  "marker-end",
  "marker-mid",
  "marker-start",
  "marks",
  "mask",
  "mask-border",
  "mask-border-mode",
  "mask-border-outset",
  "mask-border-repeat",
  "mask-border-slice",
  "mask-border-source",
  "mask-border-width",
  "mask-clip",
  "mask-composite",
  "mask-image",
  "mask-mode",
  "mask-origin",
  "mask-position",
  "mask-repeat",
  "mask-size",
  "mask-type",
  "masonry-auto-flow",
  "math-depth",
  "math-shift",
  "math-style",
  "max-block-size",
  "max-height",
  "max-inline-size",
  "max-width",
  "min-block-size",
  "min-height",
  "min-inline-size",
  "min-width",
  "mix-blend-mode",
  "nav-down",
  "nav-index",
  "nav-left",
  "nav-right",
  "nav-up",
  "none",
  "normal",
  "object-fit",
  "object-position",
  "offset",
  "offset-anchor",
  "offset-distance",
  "offset-path",
  "offset-position",
  "offset-rotate",
  "opacity",
  "order",
  "orphans",
  "outline",
  "outline-color",
  "outline-offset",
  "outline-style",
  "outline-width",
  "overflow",
  "overflow-anchor",
  "overflow-block",
  "overflow-clip-margin",
  "overflow-inline",
  "overflow-wrap",
  "overflow-x",
  "overflow-y",
  "overlay",
  "overscroll-behavior",
  "overscroll-behavior-block",
  "overscroll-behavior-inline",
  "overscroll-behavior-x",
  "overscroll-behavior-y",
  "padding",
  "padding-block",
  "padding-block-end",
  "padding-block-start",
  "padding-bottom",
  "padding-inline",
  "padding-inline-end",
  "padding-inline-start",
  "padding-left",
  "padding-right",
  "padding-top",
  "page",
  "page-break-after",
  "page-break-before",
  "page-break-inside",
  "paint-order",
  "pause",
  "pause-after",
  "pause-before",
  "perspective",
  "perspective-origin",
  "place-content",
  "place-items",
  "place-self",
  "pointer-events",
  "position",
  "position-anchor",
  "position-visibility",
  "print-color-adjust",
  "quotes",
  "r",
  "resize",
  "rest",
  "rest-after",
  "rest-before",
  "right",
  "rotate",
  "row-gap",
  "ruby-align",
  "ruby-position",
  "scale",
  "scroll-behavior",
  "scroll-margin",
  "scroll-margin-block",
  "scroll-margin-block-end",
  "scroll-margin-block-start",
  "scroll-margin-bottom",
  "scroll-margin-inline",
  "scroll-margin-inline-end",
  "scroll-margin-inline-start",
  "scroll-margin-left",
  "scroll-margin-right",
  "scroll-margin-top",
  "scroll-padding",
  "scroll-padding-block",
  "scroll-padding-block-end",
  "scroll-padding-block-start",
  "scroll-padding-bottom",
  "scroll-padding-inline",
  "scroll-padding-inline-end",
  "scroll-padding-inline-start",
  "scroll-padding-left",
  "scroll-padding-right",
  "scroll-padding-top",
  "scroll-snap-align",
  "scroll-snap-stop",
  "scroll-snap-type",
  "scroll-timeline",
  "scroll-timeline-axis",
  "scroll-timeline-name",
  "scrollbar-color",
  "scrollbar-gutter",
  "scrollbar-width",
  "shape-image-threshold",
  "shape-margin",
  "shape-outside",
  "shape-rendering",
  "speak",
  "speak-as",
  "src",
  // @font-face
  "stop-color",
  "stop-opacity",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "tab-size",
  "table-layout",
  "text-align",
  "text-align-all",
  "text-align-last",
  "text-anchor",
  "text-combine-upright",
  "text-decoration",
  "text-decoration-color",
  "text-decoration-line",
  "text-decoration-skip",
  "text-decoration-skip-ink",
  "text-decoration-style",
  "text-decoration-thickness",
  "text-emphasis",
  "text-emphasis-color",
  "text-emphasis-position",
  "text-emphasis-style",
  "text-indent",
  "text-justify",
  "text-orientation",
  "text-overflow",
  "text-rendering",
  "text-shadow",
  "text-size-adjust",
  "text-transform",
  "text-underline-offset",
  "text-underline-position",
  "text-wrap",
  "text-wrap-mode",
  "text-wrap-style",
  "timeline-scope",
  "top",
  "touch-action",
  "transform",
  "transform-box",
  "transform-origin",
  "transform-style",
  "transition",
  "transition-behavior",
  "transition-delay",
  "transition-duration",
  "transition-property",
  "transition-timing-function",
  "translate",
  "unicode-bidi",
  "user-modify",
  "user-select",
  "vector-effect",
  "vertical-align",
  "view-timeline",
  "view-timeline-axis",
  "view-timeline-inset",
  "view-timeline-name",
  "view-transition-name",
  "visibility",
  "voice-balance",
  "voice-duration",
  "voice-family",
  "voice-pitch",
  "voice-range",
  "voice-rate",
  "voice-stress",
  "voice-volume",
  "white-space",
  "white-space-collapse",
  "widows",
  "width",
  "will-change",
  "word-break",
  "word-spacing",
  "word-wrap",
  "writing-mode",
  "x",
  "y",
  "z-index",
  "zoom"
].sort().reverse();
function css(hljs) {
  const regex = hljs.regex;
  const modes = MODES(hljs);
  const VENDOR_PREFIX = { begin: /-(webkit|moz|ms|o)-(?=[a-z])/ };
  const AT_MODIFIERS = "and or not only";
  const AT_PROPERTY_RE = /@-?\w[\w]*(-\w+)*/;
  const IDENT_RE3 = "[a-zA-Z-][a-zA-Z0-9_-]*";
  const STRINGS = [
    hljs.APOS_STRING_MODE,
    hljs.QUOTE_STRING_MODE
  ];
  return {
    name: "CSS",
    case_insensitive: true,
    illegal: /[=|'\$]/,
    keywords: { keyframePosition: "from to" },
    classNameAliases: {
      // for visual continuity with `tag {}` and because we
      // don't have a great class for this?
      keyframePosition: "selector-tag"
    },
    contains: [
      modes.BLOCK_COMMENT,
      VENDOR_PREFIX,
      // to recognize keyframe 40% etc which are outside the scope of our
      // attribute value mode
      modes.CSS_NUMBER_MODE,
      {
        className: "selector-id",
        begin: /#[A-Za-z0-9_-]+/,
        relevance: 0
      },
      {
        className: "selector-class",
        begin: "\\." + IDENT_RE3,
        relevance: 0
      },
      modes.ATTRIBUTE_SELECTOR_MODE,
      {
        className: "selector-pseudo",
        variants: [
          { begin: ":(" + PSEUDO_CLASSES.join("|") + ")" },
          { begin: ":(:)?(" + PSEUDO_ELEMENTS.join("|") + ")" }
        ]
      },
      // we may actually need this (12/2020)
      // { // pseudo-selector params
      //   begin: /\(/,
      //   end: /\)/,
      //   contains: [ hljs.CSS_NUMBER_MODE ]
      // },
      modes.CSS_VARIABLE,
      {
        className: "attribute",
        begin: "\\b(" + ATTRIBUTES.join("|") + ")\\b"
      },
      // attribute values
      {
        begin: /:/,
        end: /[;}{]/,
        contains: [
          modes.BLOCK_COMMENT,
          modes.HEXCOLOR,
          modes.IMPORTANT,
          modes.CSS_NUMBER_MODE,
          ...STRINGS,
          // needed to highlight these as strings and to avoid issues with
          // illegal characters that might be inside urls that would tigger the
          // languages illegal stack
          {
            begin: /(url|data-uri)\(/,
            end: /\)/,
            relevance: 0,
            // from keywords
            keywords: { built_in: "url data-uri" },
            contains: [
              ...STRINGS,
              {
                className: "string",
                // any character other than `)` as in `url()` will be the start
                // of a string, which ends with `)` (from the parent mode)
                begin: /[^)]/,
                endsWithParent: true,
                excludeEnd: true
              }
            ]
          },
          modes.FUNCTION_DISPATCH
        ]
      },
      {
        begin: regex.lookahead(/@/),
        end: "[{;]",
        relevance: 0,
        illegal: /:/,
        // break on Less variables @var: ...
        contains: [
          {
            className: "keyword",
            begin: AT_PROPERTY_RE
          },
          {
            begin: /\s/,
            endsWithParent: true,
            excludeEnd: true,
            relevance: 0,
            keywords: {
              $pattern: /[a-z-]+/,
              keyword: AT_MODIFIERS,
              attribute: MEDIA_FEATURES.join(" ")
            },
            contains: [
              {
                begin: /[a-z-]+(?=:)/,
                className: "attribute"
              },
              ...STRINGS,
              modes.CSS_NUMBER_MODE
            ]
          }
        ]
      },
      {
        className: "selector-tag",
        begin: "\\b(" + TAGS.join("|") + ")\\b"
      }
    ]
  };
}

// node_modules/highlight.js/es/languages/xml.js
function xml(hljs) {
  const regex = hljs.regex;
  const TAG_NAME_RE = regex.concat(/[\p{L}_]/u, regex.optional(/[\p{L}0-9_.-]*:/u), /[\p{L}0-9_.-]*/u);
  const XML_IDENT_RE = /[\p{L}0-9._:-]+/u;
  const XML_ENTITIES = {
    className: "symbol",
    begin: /&[a-z]+;|&#[0-9]+;|&#x[a-f0-9]+;/
  };
  const XML_META_KEYWORDS = {
    begin: /\s/,
    contains: [
      {
        className: "keyword",
        begin: /#?[a-z_][a-z1-9_-]+/,
        illegal: /\n/
      }
    ]
  };
  const XML_META_PAR_KEYWORDS = hljs.inherit(XML_META_KEYWORDS, {
    begin: /\(/,
    end: /\)/
  });
  const APOS_META_STRING_MODE = hljs.inherit(hljs.APOS_STRING_MODE, { className: "string" });
  const QUOTE_META_STRING_MODE = hljs.inherit(hljs.QUOTE_STRING_MODE, { className: "string" });
  const TAG_INTERNALS = {
    endsWithParent: true,
    illegal: /</,
    relevance: 0,
    contains: [
      {
        className: "attr",
        begin: XML_IDENT_RE,
        relevance: 0
      },
      {
        begin: /=\s*/,
        relevance: 0,
        contains: [
          {
            className: "string",
            endsParent: true,
            variants: [
              {
                begin: /"/,
                end: /"/,
                contains: [XML_ENTITIES]
              },
              {
                begin: /'/,
                end: /'/,
                contains: [XML_ENTITIES]
              },
              { begin: /[^\s"'=<>`]+/ }
            ]
          }
        ]
      }
    ]
  };
  return {
    name: "HTML, XML",
    aliases: [
      "html",
      "xhtml",
      "rss",
      "atom",
      "xjb",
      "xsd",
      "xsl",
      "plist",
      "wsf",
      "svg"
    ],
    case_insensitive: true,
    unicodeRegex: true,
    contains: [
      {
        className: "meta",
        begin: /<![a-z]/,
        end: />/,
        relevance: 10,
        contains: [
          XML_META_KEYWORDS,
          QUOTE_META_STRING_MODE,
          APOS_META_STRING_MODE,
          XML_META_PAR_KEYWORDS,
          {
            begin: /\[/,
            end: /\]/,
            contains: [
              {
                className: "meta",
                begin: /<![a-z]/,
                end: />/,
                contains: [
                  XML_META_KEYWORDS,
                  XML_META_PAR_KEYWORDS,
                  QUOTE_META_STRING_MODE,
                  APOS_META_STRING_MODE
                ]
              }
            ]
          }
        ]
      },
      hljs.COMMENT(
        /<!--/,
        /-->/,
        { relevance: 10 }
      ),
      {
        begin: /<!\[CDATA\[/,
        end: /\]\]>/,
        relevance: 10
      },
      XML_ENTITIES,
      // xml processing instructions
      {
        className: "meta",
        end: /\?>/,
        variants: [
          {
            begin: /<\?xml/,
            relevance: 10,
            contains: [
              QUOTE_META_STRING_MODE
            ]
          },
          {
            begin: /<\?[a-z][a-z0-9]+/
          }
        ]
      },
      {
        className: "tag",
        /*
        The lookahead pattern (?=...) ensures that 'begin' only matches
        '<style' as a single word, followed by a whitespace or an
        ending bracket.
        */
        begin: /<style(?=\s|>)/,
        end: />/,
        keywords: { name: "style" },
        contains: [TAG_INTERNALS],
        starts: {
          end: /<\/style>/,
          returnEnd: true,
          subLanguage: [
            "css",
            "xml"
          ]
        }
      },
      {
        className: "tag",
        // See the comment in the <style tag about the lookahead pattern
        begin: /<script(?=\s|>)/,
        end: />/,
        keywords: { name: "script" },
        contains: [TAG_INTERNALS],
        starts: {
          end: /<\/script>/,
          returnEnd: true,
          subLanguage: [
            "javascript",
            "handlebars",
            "xml"
          ]
        }
      },
      // we need this for now for jSX
      {
        className: "tag",
        begin: /<>|<\/>/
      },
      // open tag
      {
        className: "tag",
        begin: regex.concat(
          /</,
          regex.lookahead(regex.concat(
            TAG_NAME_RE,
            // <tag/>
            // <tag>
            // <tag ...
            regex.either(/\/>/, />/, /\s/)
          ))
        ),
        end: /\/?>/,
        contains: [
          {
            className: "name",
            begin: TAG_NAME_RE,
            relevance: 0,
            starts: TAG_INTERNALS
          }
        ]
      },
      // close tag
      {
        className: "tag",
        begin: regex.concat(
          /<\//,
          regex.lookahead(regex.concat(
            TAG_NAME_RE,
            />/
          ))
        ),
        contains: [
          {
            className: "name",
            begin: TAG_NAME_RE,
            relevance: 0
          },
          {
            begin: />/,
            relevance: 0,
            endsParent: true
          }
        ]
      }
    ]
  };
}

// node_modules/highlight.js/es/languages/bash.js
function bash(hljs) {
  const regex = hljs.regex;
  const VAR = {};
  const BRACED_VAR = {
    begin: /\$\{/,
    end: /\}/,
    contains: [
      "self",
      {
        begin: /:-/,
        contains: [VAR]
      }
      // default values
    ]
  };
  Object.assign(VAR, {
    className: "variable",
    variants: [
      { begin: regex.concat(
        /\$[\w\d#@][\w\d_]*/,
        // negative look-ahead tries to avoid matching patterns that are not
        // Perl at all like $ident$, @ident@, etc.
        `(?![\\w\\d])(?![$])`
      ) },
      BRACED_VAR
    ]
  });
  const SUBST = {
    className: "subst",
    begin: /\$\(/,
    end: /\)/,
    contains: [hljs.BACKSLASH_ESCAPE]
  };
  const COMMENT = hljs.inherit(
    hljs.COMMENT(),
    {
      match: [
        /(^|\s)/,
        /#.*$/
      ],
      scope: {
        2: "comment"
      }
    }
  );
  const HERE_DOC = {
    begin: /<<-?\s*(?=\w+)/,
    starts: { contains: [
      hljs.END_SAME_AS_BEGIN({
        begin: /(\w+)/,
        end: /(\w+)/,
        className: "string"
      })
    ] }
  };
  const QUOTE_STRING = {
    className: "string",
    begin: /"/,
    end: /"/,
    contains: [
      hljs.BACKSLASH_ESCAPE,
      VAR,
      SUBST
    ]
  };
  SUBST.contains.push(QUOTE_STRING);
  const ESCAPED_QUOTE = {
    match: /\\"/
  };
  const APOS_STRING = {
    className: "string",
    begin: /'/,
    end: /'/
  };
  const ESCAPED_APOS = {
    match: /\\'/
  };
  const ARITHMETIC = {
    begin: /\$?\(\(/,
    end: /\)\)/,
    contains: [
      {
        begin: /\d+#[0-9a-f]+/,
        className: "number"
      },
      hljs.NUMBER_MODE,
      VAR
    ]
  };
  const SH_LIKE_SHELLS = [
    "fish",
    "bash",
    "zsh",
    "sh",
    "csh",
    "ksh",
    "tcsh",
    "dash",
    "scsh"
  ];
  const KNOWN_SHEBANG = hljs.SHEBANG({
    binary: `(${SH_LIKE_SHELLS.join("|")})`,
    relevance: 10
  });
  const FUNCTION = {
    className: "function",
    begin: /\w[\w\d_]*\s*\(\s*\)\s*\{/,
    returnBegin: true,
    contains: [hljs.inherit(hljs.TITLE_MODE, { begin: /\w[\w\d_]*/ })],
    relevance: 0
  };
  const KEYWORDS3 = [
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "time",
    "for",
    "while",
    "until",
    "in",
    "do",
    "done",
    "case",
    "esac",
    "coproc",
    "function",
    "select"
  ];
  const LITERALS3 = [
    "true",
    "false"
  ];
  const PATH_MODE = { match: /(\/[a-z._-]+)+/ };
  const SHELL_BUILT_INS = [
    "break",
    "cd",
    "continue",
    "eval",
    "exec",
    "exit",
    "export",
    "getopts",
    "hash",
    "pwd",
    "readonly",
    "return",
    "shift",
    "test",
    "times",
    "trap",
    "umask",
    "unset"
  ];
  const BASH_BUILT_INS = [
    "alias",
    "bind",
    "builtin",
    "caller",
    "command",
    "declare",
    "echo",
    "enable",
    "help",
    "let",
    "local",
    "logout",
    "mapfile",
    "printf",
    "read",
    "readarray",
    "source",
    "sudo",
    "type",
    "typeset",
    "ulimit",
    "unalias"
  ];
  const ZSH_BUILT_INS = [
    "autoload",
    "bg",
    "bindkey",
    "bye",
    "cap",
    "chdir",
    "clone",
    "comparguments",
    "compcall",
    "compctl",
    "compdescribe",
    "compfiles",
    "compgroups",
    "compquote",
    "comptags",
    "comptry",
    "compvalues",
    "dirs",
    "disable",
    "disown",
    "echotc",
    "echoti",
    "emulate",
    "fc",
    "fg",
    "float",
    "functions",
    "getcap",
    "getln",
    "history",
    "integer",
    "jobs",
    "kill",
    "limit",
    "log",
    "noglob",
    "popd",
    "print",
    "pushd",
    "pushln",
    "rehash",
    "sched",
    "setcap",
    "setopt",
    "stat",
    "suspend",
    "ttyctl",
    "unfunction",
    "unhash",
    "unlimit",
    "unsetopt",
    "vared",
    "wait",
    "whence",
    "where",
    "which",
    "zcompile",
    "zformat",
    "zftp",
    "zle",
    "zmodload",
    "zparseopts",
    "zprof",
    "zpty",
    "zregexparse",
    "zsocket",
    "zstyle",
    "ztcp"
  ];
  const GNU_CORE_UTILS = [
    "chcon",
    "chgrp",
    "chown",
    "chmod",
    "cp",
    "dd",
    "df",
    "dir",
    "dircolors",
    "ln",
    "ls",
    "mkdir",
    "mkfifo",
    "mknod",
    "mktemp",
    "mv",
    "realpath",
    "rm",
    "rmdir",
    "shred",
    "sync",
    "touch",
    "truncate",
    "vdir",
    "b2sum",
    "base32",
    "base64",
    "cat",
    "cksum",
    "comm",
    "csplit",
    "cut",
    "expand",
    "fmt",
    "fold",
    "head",
    "join",
    "md5sum",
    "nl",
    "numfmt",
    "od",
    "paste",
    "ptx",
    "pr",
    "sha1sum",
    "sha224sum",
    "sha256sum",
    "sha384sum",
    "sha512sum",
    "shuf",
    "sort",
    "split",
    "sum",
    "tac",
    "tail",
    "tr",
    "tsort",
    "unexpand",
    "uniq",
    "wc",
    "arch",
    "basename",
    "chroot",
    "date",
    "dirname",
    "du",
    "echo",
    "env",
    "expr",
    "factor",
    // "false", // keyword literal already
    "groups",
    "hostid",
    "id",
    "link",
    "logname",
    "nice",
    "nohup",
    "nproc",
    "pathchk",
    "pinky",
    "printenv",
    "printf",
    "pwd",
    "readlink",
    "runcon",
    "seq",
    "sleep",
    "stat",
    "stdbuf",
    "stty",
    "tee",
    "test",
    "timeout",
    // "true", // keyword literal already
    "tty",
    "uname",
    "unlink",
    "uptime",
    "users",
    "who",
    "whoami",
    "yes"
  ];
  return {
    name: "Bash",
    aliases: [
      "sh",
      "zsh"
    ],
    keywords: {
      $pattern: /\b[a-z][a-z0-9._-]+\b/,
      keyword: KEYWORDS3,
      literal: LITERALS3,
      built_in: [
        ...SHELL_BUILT_INS,
        ...BASH_BUILT_INS,
        // Shell modifiers
        "set",
        "shopt",
        ...ZSH_BUILT_INS,
        ...GNU_CORE_UTILS
      ]
    },
    contains: [
      KNOWN_SHEBANG,
      // to catch known shells and boost relevancy
      hljs.SHEBANG(),
      // to catch unknown shells but still highlight the shebang
      FUNCTION,
      ARITHMETIC,
      COMMENT,
      HERE_DOC,
      PATH_MODE,
      QUOTE_STRING,
      ESCAPED_QUOTE,
      APOS_STRING,
      ESCAPED_APOS,
      VAR
    ]
  };
}

// node_modules/highlight.js/es/languages/markdown.js
function markdown(hljs) {
  const regex = hljs.regex;
  const INLINE_HTML = {
    begin: /<\/?[A-Za-z_]/,
    end: ">",
    subLanguage: "xml",
    relevance: 0
  };
  const HORIZONTAL_RULE = {
    begin: "^[-\\*]{3,}",
    end: "$"
  };
  const CODE = {
    className: "code",
    variants: [
      // TODO: fix to allow these to work with sublanguage also
      { begin: "(`{3,})[^`](.|\\n)*?\\1`*[ ]*" },
      { begin: "(~{3,})[^~](.|\\n)*?\\1~*[ ]*" },
      // needed to allow markdown as a sublanguage to work
      {
        begin: "```",
        end: "```+[ ]*$"
      },
      {
        begin: "~~~",
        end: "~~~+[ ]*$"
      },
      { begin: "`.+?`" },
      {
        begin: "(?=^( {4}|\\t))",
        // use contains to gobble up multiple lines to allow the block to be whatever size
        // but only have a single open/close tag vs one per line
        contains: [
          {
            begin: "^( {4}|\\t)",
            end: "(\\n)$"
          }
        ],
        relevance: 0
      }
    ]
  };
  const LIST = {
    className: "bullet",
    begin: "^[ 	]*([*+-]|(\\d+\\.))(?=\\s+)",
    end: "\\s+",
    excludeEnd: true
  };
  const LINK_REFERENCE = {
    begin: /^\[[^\n]+\]:/,
    returnBegin: true,
    contains: [
      {
        className: "symbol",
        begin: /\[/,
        end: /\]/,
        excludeBegin: true,
        excludeEnd: true
      },
      {
        className: "link",
        begin: /:\s*/,
        end: /$/,
        excludeBegin: true
      }
    ]
  };
  const URL_SCHEME = /[A-Za-z][A-Za-z0-9+.-]*/;
  const LINK = {
    variants: [
      // too much like nested array access in so many languages
      // to have any real relevance
      {
        begin: /\[.+?\]\[.*?\]/,
        relevance: 0
      },
      // popular internet URLs
      {
        begin: /\[.+?\]\(((data|javascript|mailto):|(?:http|ftp)s?:\/\/).*?\)/,
        relevance: 2
      },
      {
        begin: regex.concat(/\[.+?\]\(/, URL_SCHEME, /:\/\/.*?\)/),
        relevance: 2
      },
      // relative urls
      {
        begin: /\[.+?\]\([./?&#].*?\)/,
        relevance: 1
      },
      // whatever else, lower relevance (might not be a link at all)
      {
        begin: /\[.*?\]\(.*?\)/,
        relevance: 0
      }
    ],
    returnBegin: true,
    contains: [
      {
        // empty strings for alt or link text
        match: /\[(?=\])/
      },
      {
        className: "string",
        relevance: 0,
        begin: "\\[",
        end: "\\]",
        excludeBegin: true,
        returnEnd: true
      },
      {
        className: "link",
        relevance: 0,
        begin: "\\]\\(",
        end: "\\)",
        excludeBegin: true,
        excludeEnd: true
      },
      {
        className: "symbol",
        relevance: 0,
        begin: "\\]\\[",
        end: "\\]",
        excludeBegin: true,
        excludeEnd: true
      }
    ]
  };
  const BOLD = {
    className: "strong",
    contains: [],
    // defined later
    variants: [
      {
        begin: /_{2}(?!\s)/,
        end: /_{2}/
      },
      {
        begin: /\*{2}(?!\s)/,
        end: /\*{2}/
      }
    ]
  };
  const ITALIC = {
    className: "emphasis",
    contains: [],
    // defined later
    variants: [
      {
        begin: /\*(?![*\s])/,
        end: /\*/
      },
      {
        begin: /_(?![_\s])/,
        end: /_/,
        relevance: 0
      }
    ]
  };
  const BOLD_WITHOUT_ITALIC = hljs.inherit(BOLD, { contains: [] });
  const ITALIC_WITHOUT_BOLD = hljs.inherit(ITALIC, { contains: [] });
  BOLD.contains.push(ITALIC_WITHOUT_BOLD);
  ITALIC.contains.push(BOLD_WITHOUT_ITALIC);
  let CONTAINABLE = [
    INLINE_HTML,
    LINK
  ];
  [
    BOLD,
    ITALIC,
    BOLD_WITHOUT_ITALIC,
    ITALIC_WITHOUT_BOLD
  ].forEach((m) => {
    m.contains = m.contains.concat(CONTAINABLE);
  });
  CONTAINABLE = CONTAINABLE.concat(BOLD, ITALIC);
  const HEADER = {
    className: "section",
    variants: [
      {
        begin: "^#{1,6}",
        end: "$",
        contains: CONTAINABLE
      },
      {
        begin: "(?=^.+?\\n[=-]{2,}$)",
        contains: [
          { begin: "^[=-]*$" },
          {
            begin: "^",
            end: "\\n",
            contains: CONTAINABLE
          }
        ]
      }
    ]
  };
  const BLOCKQUOTE = {
    className: "quote",
    begin: "^>\\s+",
    contains: CONTAINABLE,
    end: "$"
  };
  const ENTITY = {
    //https://spec.commonmark.org/0.31.2/#entity-references
    scope: "literal",
    match: /&([a-zA-Z0-9]+|#[0-9]{1,7}|#[Xx][0-9a-fA-F]{1,6});/
  };
  return {
    name: "Markdown",
    aliases: [
      "md",
      "mkdown",
      "mkd"
    ],
    contains: [
      HEADER,
      INLINE_HTML,
      LIST,
      BOLD,
      ITALIC,
      BLOCKQUOTE,
      CODE,
      HORIZONTAL_RULE,
      LINK,
      LINK_REFERENCE,
      ENTITY
    ]
  };
}

// node_modules/highlight.js/es/languages/yaml.js
function yaml(hljs) {
  const LITERALS3 = "true false yes no null";
  const URI_CHARACTERS = "[\\w#;/?:@&=+$,.~*'()[\\]]+";
  const KEY = {
    className: "attr",
    variants: [
      // added brackets support and special char support
      { begin: /[\w*@][\w*@ :()\./-]*:(?=[ \t]|$)/ },
      {
        // double quoted keys - with brackets and special char support
        begin: /"[\w*@][\w*@ :()\./-]*":(?=[ \t]|$)/
      },
      {
        // single quoted keys - with brackets and special char support
        begin: /'[\w*@][\w*@ :()\./-]*':(?=[ \t]|$)/
      }
    ]
  };
  const TEMPLATE_VARIABLES = {
    className: "template-variable",
    variants: [
      {
        // jinja templates Ansible
        begin: /\{\{/,
        end: /\}\}/
      },
      {
        // Ruby i18n
        begin: /%\{/,
        end: /\}/
      }
    ]
  };
  const SINGLE_QUOTE_STRING = {
    className: "string",
    relevance: 0,
    begin: /'/,
    end: /'/,
    contains: [
      {
        match: /''/,
        scope: "char.escape",
        relevance: 0
      }
    ]
  };
  const STRING = {
    className: "string",
    relevance: 0,
    variants: [
      {
        begin: /"/,
        end: /"/
      },
      { begin: /\S+/ }
    ],
    contains: [
      hljs.BACKSLASH_ESCAPE,
      TEMPLATE_VARIABLES
    ]
  };
  const CONTAINER_STRING = hljs.inherit(STRING, { variants: [
    {
      begin: /'/,
      end: /'/,
      contains: [
        {
          begin: /''/,
          relevance: 0
        }
      ]
    },
    {
      begin: /"/,
      end: /"/
    },
    { begin: /[^\s,{}[\]]+/ }
  ] });
  const DATE_RE = "[0-9]{4}(-[0-9][0-9]){0,2}";
  const TIME_RE = "([Tt \\t][0-9][0-9]?(:[0-9][0-9]){2})?";
  const FRACTION_RE = "(\\.[0-9]*)?";
  const ZONE_RE = "([ \\t])*(Z|[-+][0-9][0-9]?(:[0-9][0-9])?)?";
  const TIMESTAMP = {
    className: "number",
    begin: "\\b" + DATE_RE + TIME_RE + FRACTION_RE + ZONE_RE + "\\b"
  };
  const VALUE_CONTAINER = {
    end: ",",
    endsWithParent: true,
    excludeEnd: true,
    keywords: LITERALS3,
    relevance: 0
  };
  const OBJECT = {
    begin: /\{/,
    end: /\}/,
    contains: [VALUE_CONTAINER],
    illegal: "\\n",
    relevance: 0
  };
  const ARRAY = {
    begin: "\\[",
    end: "\\]",
    contains: [VALUE_CONTAINER],
    illegal: "\\n",
    relevance: 0
  };
  const MODES2 = [
    KEY,
    {
      className: "meta",
      begin: "^---\\s*$",
      relevance: 10
    },
    {
      // multi line string
      // Blocks start with a | or > followed by a newline
      //
      // Indentation of subsequent lines must be the same to
      // be considered part of the block
      className: "string",
      begin: "[\\|>]([1-9]?[+-])?[ ]*\\n( +)[^ ][^\\n]*\\n(\\2[^\\n]+\\n?)*"
    },
    {
      // Ruby/Rails erb
      begin: "<%[%=-]?",
      end: "[%-]?%>",
      subLanguage: "ruby",
      excludeBegin: true,
      excludeEnd: true,
      relevance: 0
    },
    {
      // named tags
      className: "type",
      begin: "!\\w+!" + URI_CHARACTERS
    },
    // https://yaml.org/spec/1.2/spec.html#id2784064
    {
      // verbatim tags
      className: "type",
      begin: "!<" + URI_CHARACTERS + ">"
    },
    {
      // primary tags
      className: "type",
      begin: "!" + URI_CHARACTERS
    },
    {
      // secondary tags
      className: "type",
      begin: "!!" + URI_CHARACTERS
    },
    {
      // fragment id &ref
      className: "meta",
      begin: "&" + hljs.UNDERSCORE_IDENT_RE + "$"
    },
    {
      // fragment reference *ref
      className: "meta",
      begin: "\\*" + hljs.UNDERSCORE_IDENT_RE + "$"
    },
    {
      // array listing
      className: "bullet",
      // TODO: remove |$ hack when we have proper look-ahead support
      begin: "-(?=[ ]|$)",
      relevance: 0
    },
    hljs.HASH_COMMENT_MODE,
    {
      beginKeywords: LITERALS3,
      keywords: { literal: LITERALS3 }
    },
    TIMESTAMP,
    // numbers are any valid C-style number that
    // sit isolated from other words
    {
      className: "number",
      begin: hljs.C_NUMBER_RE + "\\b",
      relevance: 0
    },
    OBJECT,
    ARRAY,
    SINGLE_QUOTE_STRING,
    STRING
  ];
  const VALUE_MODES = [...MODES2];
  VALUE_MODES.pop();
  VALUE_MODES.push(CONTAINER_STRING);
  VALUE_CONTAINER.contains = VALUE_MODES;
  return {
    name: "YAML",
    case_insensitive: true,
    aliases: ["yml"],
    contains: MODES2
  };
}

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
  addToPath(path, added, removed, oldPosInc, options) {
    const last = path.lastComponent;
    if (last && !options.oneChangePerToken && last.added === added && last.removed === removed) {
      return {
        oldPos: path.oldPos + oldPosInc,
        lastComponent: { count: last.count + 1, added, removed, previousComponent: last.previousComponent }
      };
    } else {
      return {
        oldPos: path.oldPos + oldPosInc,
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

// node_modules/diff/libesm/util/string.js
function longestCommonPrefix(str1, str2) {
  let i;
  for (i = 0; i < str1.length && i < str2.length; i++) {
    if (str1[i] != str2[i]) {
      return str1.slice(0, i);
    }
  }
  return str1.slice(0, i);
}
function longestCommonSuffix(str1, str2) {
  let i;
  if (!str1 || !str2 || str1[str1.length - 1] != str2[str2.length - 1]) {
    return "";
  }
  for (i = 0; i < str1.length && i < str2.length; i++) {
    if (str1[str1.length - (i + 1)] != str2[str2.length - (i + 1)]) {
      return str1.slice(-i);
    }
  }
  return str1.slice(-i);
}
function replacePrefix(string, oldPrefix, newPrefix) {
  if (string.slice(0, oldPrefix.length) != oldPrefix) {
    throw Error(`string ${JSON.stringify(string)} doesn't start with prefix ${JSON.stringify(oldPrefix)}; this is a bug`);
  }
  return newPrefix + string.slice(oldPrefix.length);
}
function replaceSuffix(string, oldSuffix, newSuffix) {
  if (!oldSuffix) {
    return string + newSuffix;
  }
  if (string.slice(-oldSuffix.length) != oldSuffix) {
    throw Error(`string ${JSON.stringify(string)} doesn't end with suffix ${JSON.stringify(oldSuffix)}; this is a bug`);
  }
  return string.slice(0, -oldSuffix.length) + newSuffix;
}
function removePrefix(string, oldPrefix) {
  return replacePrefix(string, oldPrefix, "");
}
function removeSuffix(string, oldSuffix) {
  return replaceSuffix(string, oldSuffix, "");
}
function maximumOverlap(string1, string2) {
  return string2.slice(0, overlapCount(string1, string2));
}
function overlapCount(a, b) {
  let startA = 0;
  if (a.length > b.length) {
    startA = a.length - b.length;
  }
  let endB = b.length;
  if (a.length < b.length) {
    endB = a.length;
  }
  const map = Array(endB);
  let k = 0;
  map[0] = 0;
  for (let j = 1; j < endB; j++) {
    if (b[j] == b[k]) {
      map[j] = map[k];
    } else {
      map[j] = k;
    }
    while (k > 0 && b[j] != b[k]) {
      k = map[k];
    }
    if (b[j] == b[k]) {
      k++;
    }
  }
  k = 0;
  for (let i = startA; i < a.length; i++) {
    while (k > 0 && a[i] != b[k]) {
      k = map[k];
    }
    if (a[i] == b[k]) {
      k++;
    }
  }
  return k;
}
function trailingWs(string) {
  let i;
  for (i = string.length - 1; i >= 0; i--) {
    if (!string[i].match(/\s/)) {
      break;
    }
  }
  return string.substring(i + 1);
}
function leadingWs(string) {
  const match = string.match(/^\s*/);
  return match ? match[0] : "";
}

// node_modules/diff/libesm/diff/word.js
var extendedWordChars = "a-zA-Z0-9_\\u{C0}-\\u{FF}\\u{D8}-\\u{F6}\\u{F8}-\\u{2C6}\\u{2C8}-\\u{2D7}\\u{2DE}-\\u{2FF}\\u{1E00}-\\u{1EFF}";
var tokenizeIncludingWhitespace = new RegExp(`[${extendedWordChars}]+|\\s+|[^${extendedWordChars}]`, "ug");
var WordDiff = class extends Diff {
  equals(left, right, options) {
    if (options.ignoreCase) {
      left = left.toLowerCase();
      right = right.toLowerCase();
    }
    return left.trim() === right.trim();
  }
  tokenize(value, options = {}) {
    let parts;
    if (options.intlSegmenter) {
      const segmenter = options.intlSegmenter;
      if (segmenter.resolvedOptions().granularity != "word") {
        throw new Error('The segmenter passed must have a granularity of "word"');
      }
      parts = Array.from(segmenter.segment(value), (segment) => segment.segment);
    } else {
      parts = value.match(tokenizeIncludingWhitespace) || [];
    }
    const tokens = [];
    let prevPart = null;
    parts.forEach((part) => {
      if (/\s/.test(part)) {
        if (prevPart == null) {
          tokens.push(part);
        } else {
          tokens.push(tokens.pop() + part);
        }
      } else if (prevPart != null && /\s/.test(prevPart)) {
        if (tokens[tokens.length - 1] == prevPart) {
          tokens.push(tokens.pop() + part);
        } else {
          tokens.push(prevPart + part);
        }
      } else {
        tokens.push(part);
      }
      prevPart = part;
    });
    return tokens;
  }
  join(tokens) {
    return tokens.map((token, i) => {
      if (i == 0) {
        return token;
      } else {
        return token.replace(/^\s+/, "");
      }
    }).join("");
  }
  postProcess(changes, options) {
    if (!changes || options.oneChangePerToken) {
      return changes;
    }
    let lastKeep = null;
    let insertion = null;
    let deletion = null;
    changes.forEach((change) => {
      if (change.added) {
        insertion = change;
      } else if (change.removed) {
        deletion = change;
      } else {
        if (insertion || deletion) {
          dedupeWhitespaceInChangeObjects(lastKeep, deletion, insertion, change);
        }
        lastKeep = change;
        insertion = null;
        deletion = null;
      }
    });
    if (insertion || deletion) {
      dedupeWhitespaceInChangeObjects(lastKeep, deletion, insertion, null);
    }
    return changes;
  }
};
var wordDiff = new WordDiff();
function dedupeWhitespaceInChangeObjects(startKeep, deletion, insertion, endKeep) {
  if (deletion && insertion) {
    const oldWsPrefix = leadingWs(deletion.value);
    const oldWsSuffix = trailingWs(deletion.value);
    const newWsPrefix = leadingWs(insertion.value);
    const newWsSuffix = trailingWs(insertion.value);
    if (startKeep) {
      const commonWsPrefix = longestCommonPrefix(oldWsPrefix, newWsPrefix);
      startKeep.value = replaceSuffix(startKeep.value, newWsPrefix, commonWsPrefix);
      deletion.value = removePrefix(deletion.value, commonWsPrefix);
      insertion.value = removePrefix(insertion.value, commonWsPrefix);
    }
    if (endKeep) {
      const commonWsSuffix = longestCommonSuffix(oldWsSuffix, newWsSuffix);
      endKeep.value = replacePrefix(endKeep.value, newWsSuffix, commonWsSuffix);
      deletion.value = removeSuffix(deletion.value, commonWsSuffix);
      insertion.value = removeSuffix(insertion.value, commonWsSuffix);
    }
  } else if (insertion) {
    if (startKeep) {
      const ws = leadingWs(insertion.value);
      insertion.value = insertion.value.substring(ws.length);
    }
    if (endKeep) {
      const ws = leadingWs(endKeep.value);
      endKeep.value = endKeep.value.substring(ws.length);
    }
  } else if (startKeep && endKeep) {
    const newWsFull = leadingWs(endKeep.value), delWsStart = leadingWs(deletion.value), delWsEnd = trailingWs(deletion.value);
    const newWsStart = longestCommonPrefix(newWsFull, delWsStart);
    deletion.value = removePrefix(deletion.value, newWsStart);
    const newWsEnd = longestCommonSuffix(removePrefix(newWsFull, newWsStart), delWsEnd);
    deletion.value = removeSuffix(deletion.value, newWsEnd);
    endKeep.value = replacePrefix(endKeep.value, newWsFull, newWsEnd);
    startKeep.value = replaceSuffix(startKeep.value, newWsFull, newWsFull.slice(0, newWsFull.length - newWsEnd.length));
  } else if (endKeep) {
    const endKeepWsPrefix = leadingWs(endKeep.value);
    const deletionWsSuffix = trailingWs(deletion.value);
    const overlap = maximumOverlap(deletionWsSuffix, endKeepWsPrefix);
    deletion.value = removeSuffix(deletion.value, overlap);
  } else if (startKeep) {
    const startKeepWsSuffix = trailingWs(startKeep.value);
    const deletionWsPrefix = leadingWs(deletion.value);
    const overlap = maximumOverlap(startKeepWsSuffix, deletionWsPrefix);
    deletion.value = removePrefix(deletion.value, overlap);
  }
}
var WordsWithSpaceDiff = class extends Diff {
  tokenize(value) {
    const regex = new RegExp(`(\\r?\\n)|[${extendedWordChars}]+|[^\\S\\n\\r]+|[^${extendedWordChars}]`, "ug");
    return value.match(regex) || [];
  }
};
var wordsWithSpaceDiff = new WordsWithSpaceDiff();
function diffWordsWithSpace(oldStr, newStr, options) {
  return wordsWithSpaceDiff.diff(oldStr, newStr, options);
}

// src/view/DiffRows.tsx
import { jsx, jsxs } from "react/jsx-runtime";
for (const [name, language2] of Object.entries({ javascript, typescript, python, json, css, xml, bash, markdown, yaml })) core_default.registerLanguage(name, language2);
function ranges(before, after) {
  if (before.length + after.length > 4e3) return [[], []];
  const changes = diffWordsWithSpace(before, after, { timeout: 15 });
  if (!changes) return [[], []];
  let old = 0, next = 0;
  const a = [], b = [];
  for (const c of changes) {
    if (!c.added) {
      if (c.removed) a.push([old, old + c.value.length]);
      old += c.value.length;
    }
    if (!c.removed) {
      if (c.added) b.push([next, next + c.value.length]);
      next += c.value.length;
    }
  }
  return [a, b];
}
function alignLines(lines) {
  const result = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (line.kind === "context" || line.kind === "notice") {
      result.push({ left: line, right: line });
      i++;
      continue;
    }
    const removed = [], added = [];
    while (lines[i]?.kind === "del") removed.push(lines[i++]);
    while (lines[i]?.kind === "add") added.push(lines[i++]);
    for (let j = 0; j < Math.max(removed.length, added.length); j++) {
      const left = removed[j], right = added[j];
      const [oldRanges, newRanges] = left && right ? ranges(left.text, right.text) : [[], []];
      result.push({ left, right, oldRanges, newRanges });
    }
  }
  return result;
}
function language(path) {
  const ext = path.split(".").pop()?.toLowerCase();
  return { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", py: "python", json: "json", css: "css", html: "xml", svg: "xml", xml: "xml", sh: "bash", md: "markdown", yml: "yaml", yaml: "yaml" }[ext ?? ""];
}
function Code({ text, path, changes = [] }) {
  const nodes = useMemo(() => {
    const lang = language(path);
    const template = document.createElement("template");
    if (lang && text.length <= 8e3) template.innerHTML = core_default.highlight(text, { language: lang, ignoreIllegals: true }).value;
    else template.content.append(document.createTextNode(text));
    let offset = 0, key = 0;
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const value = node.textContent ?? "", start = offset;
        offset += value.length;
        const cuts = /* @__PURE__ */ new Set([0, value.length]);
        for (const [a, b] of changes) {
          if (a > start && a < offset) cuts.add(a - start);
          if (b > start && b < offset) cuts.add(b - start);
        }
        const points = [...cuts].sort((a, b) => a - b);
        return points.slice(0, -1).map((a, i) => {
          const segment = value.slice(a, points[i + 1]);
          return changes.some(([lo, hi]) => start + a >= lo && start + a < hi) ? /* @__PURE__ */ jsx("mark", { className: "dv-word", children: segment }, key++) : segment;
        });
      }
      const el = node;
      return /* @__PURE__ */ jsx("span", { className: el.getAttribute("class") ?? void 0, children: Array.from(node.childNodes).map(walk) }, key++);
    }
    return Array.from(template.content.childNodes).map(walk);
  }, [text, path, changes]);
  return /* @__PURE__ */ jsx("code", { className: "dv-code", children: nodes.length ? nodes : " " });
}
function DiffRows({ lines, path, layout, onLine, t, disabled }) {
  const pairs = useMemo(() => alignLines(lines), [lines]);
  const button = (line, side) => {
    const number = side === "old" ? line?.oldLine : line?.newLine;
    return number == null ? /* @__PURE__ */ jsx("span", { className: "dv-number" }) : /* @__PURE__ */ jsx("button", { className: "dv-number", disabled, "aria-label": `${t.addComment}: ${t[side]} ${number}`, onClick: () => onLine(line, side), children: number });
  };
  const cell = (line, side, changes2) => /* @__PURE__ */ jsxs("div", { className: `dv-side dv-${line?.kind ?? "blank"}`, children: [
    button(line, side),
    /* @__PURE__ */ jsx("span", { className: "dv-sign", "aria-hidden": "true", children: line?.kind === "add" ? "+" : line?.kind === "del" ? "\u2212" : " " }),
    line ? /* @__PURE__ */ jsx(Code, { text: line.text, path, changes: changes2 }) : /* @__PURE__ */ jsx("span", { className: "dv-code" })
  ] });
  if (layout === "split") return /* @__PURE__ */ jsxs("div", { className: "dv-rows dv-split", role: "group", "aria-label": `${t.old} / ${t.new}`, style: { "--dv-code-width": `${Math.max(240, ...lines.map((line) => [...line.text].reduce((width, char) => width + (char === "	" ? 4 : char.charCodeAt(0) > 255 ? 2 : 1), 0) * 8 + 72))}px` }, children: [
    /* @__PURE__ */ jsxs("div", { className: "dv-side-labels", children: [
      /* @__PURE__ */ jsx("span", { children: t.old }),
      /* @__PURE__ */ jsx("span", { children: t.new })
    ] }),
    pairs.map((pair, index) => pair.left?.kind === "notice" ? /* @__PURE__ */ jsx("div", { className: "dv-notice-line", children: pair.left.text }, index) : /* @__PURE__ */ jsxs("div", { className: "dv-pair", children: [
      cell(pair.left, "old", pair.oldRanges),
      cell(pair.right, "new", pair.newRanges)
    ] }, index))
  ] });
  const changes = /* @__PURE__ */ new Map();
  for (const pair of pairs) {
    if (pair.left) changes.set(pair.left, pair.oldRanges ?? []);
    if (pair.right) changes.set(pair.right, pair.newRanges ?? []);
  }
  return /* @__PURE__ */ jsx("div", { className: "dv-rows dv-unified", children: lines.map((line, index) => line.kind === "notice" ? /* @__PURE__ */ jsx("div", { className: "dv-notice-line", children: line.text }, index) : /* @__PURE__ */ jsxs("div", { className: `dv-row dv-${line.kind}`, children: [
    button(line, "old"),
    button(line, "new"),
    /* @__PURE__ */ jsx("span", { className: "dv-sign", "aria-hidden": "true", children: line.kind === "add" ? "+" : line.kind === "del" ? "\u2212" : " " }),
    /* @__PURE__ */ jsx(Code, { text: line.text, path, changes: changes.get(line) })
  ] }, index)) });
}

// src/view/i18n.ts
var en = {
  batch: "Visible files (max 20)",
  batchHint: "Each file is checked independently. Conflicts are reported per file; this is not an atomic transaction.",
  title: "Review changes",
  repository: "Repository",
  scope: "Scope",
  unstaged: "Working tree",
  staged: "Staged",
  commit: "Commit",
  branch: "Branch",
  lastTurn: "Last turn",
  turn: "Recorded turn",
  ref: "Reference",
  run: "Turn",
  refresh: "Refresh",
  close: "Close",
  search: "Search file paths",
  files: "Files",
  noFiles: "No changes in this scope.",
  noMatches: "No matching paths. Clear the search to see all files.",
  noRoots: "No repository or recorded turn is available. Open a project in PI-Desktop, then refresh.",
  chooseFile: "Select a file to review.",
  loading: "Loading\u2026",
  retry: "Retry",
  unified: "Unified",
  split: "Split",
  wrap: "Wrap lines",
  context: "Context",
  full: "Full file",
  copy: "Copy diff",
  copied: "Diff copied",
  previous: "Previous page",
  next: "Next page",
  previousHunk: "Previous hunk",
  nextHunk: "Next hunk",
  page: "Rows",
  of: "of",
  comments: "Comments",
  addComment: "Add comment",
  edit: "Edit",
  delete: "Delete",
  save: "Save comment",
  cancel: "Cancel",
  commentBody: "Comment",
  old: "Old",
  new: "New",
  stale: "Stale anchor \xB7 file content has changed",
  noComments: "No comments yet. Select a line number to add one.",
  commentSaved: "Comment saved",
  commentDeleted: "Comment deleted",
  feedback: "Review feedback",
  insert: "Insert feedback into draft",
  feedbackHint: "Inserts prepared feedback into the current draft. Nothing is sent.",
  feedbackNoSession: "Open a review from a session reply to insert feedback into its draft.",
  feedbackEmpty: "Save a comment to prepare feedback.",
  stage: "Stage",
  unstage: "Unstage",
  revert: "Revert",
  reapply: "Reapply",
  confirm: "Confirm operation",
  confirmHint: "This modifies local files or the Git index. Verify the exact target before continuing.",
  target: "Target",
  wholeFile: "Entire file",
  hunk: "Hunk",
  expandedHint: "Hunk operations are available only with 3 context lines; expanded context can merge hunk IDs.",
  actionOk: "Operation completed",
  actionConflict: "Operation refused. Refresh to inspect the current file before trying again.",
  history: "Recorded history",
  clearHistory: "Clear recorded history",
  clearHint: "Delete all local recorded-turn snapshots and saved review comments. Git changes are not affected.",
  cleared: "Recorded history cleared",
  theme: "Theme",
  light: "Light",
  dark: "Dark",
  language: "Language",
  settings: "Display settings",
  unavailable: "Historical content is missing or was not recorded. No diff can be reconstructed.",
  binary: "Binary file. A text diff is not available.",
  large: "File exceeds the text diff limit.",
  symlink: "Symbolic link. Text hunk operations are not available.",
  submodule: "Submodule change. Text hunks are not available.",
  conflict: "Unresolved merge conflict. Resolve it before applying operations.",
  mode: "File mode changed; no text hunks.",
  noHunks: "No text hunks in this file.",
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  reverted: "Reverted",
  incomplete: "Incomplete capture",
  running: "Running",
  completed: "Completed",
  aborted: "Aborted",
  notice: "Notice",
  collapsed: "Expand hunk",
  expanded: "Collapse hunk",
  summary: "Comment summary",
  deleteHint: "Delete this saved comment?",
  keyboard: "Alt+\u2191 / Alt+\u2193: move between visible hunks",
  busy: "An operation is in progress",
  error: "Request failed",
  demo: "Demo data \xB7 mocked backend",
  emptyRef: "Enter a commit or branch reference.",
  continuation: "Page may continue a hunk from another page.",
  noBridge: "PI-Desktop bridge is unavailable. Open this plugin inside PI-Desktop.",
  feedbackCopy: "Select and copy feedback",
  deletedExcerpt: "Anchored excerpt",
  clearSearch: "Clear search",
  commentsFailed: "Comments could not be loaded",
  feedbackFailed: "Feedback could not be prepared",
  action: "Operation",
  loadMore: "Continue on next page",
  commentLimit: "Comments must contain 1\u20134,000 characters.",
  commentDisabled: "Notice rows cannot be commented on.",
  applyRef: "Review reference"
};
var zh = {
  batch: "\u53EF\u89C1\u6587\u4EF6\uFF08\u6700\u591A 20 \u4E2A\uFF09",
  batchHint: "\u9010\u6587\u4EF6\u72EC\u7ACB\u590D\u6838\uFF1B\u6BCF\u4E2A\u51B2\u7A81\u5355\u72EC\u62A5\u544A\uFF0C\u4E0D\u662F\u8DE8\u6587\u4EF6\u539F\u5B50\u4E8B\u52A1\u3002",
  title: "\u5BA1\u9605\u66F4\u6539",
  repository: "\u4ED3\u5E93",
  scope: "\u8303\u56F4",
  unstaged: "\u5DE5\u4F5C\u533A",
  staged: "\u6682\u5B58\u533A",
  commit: "\u63D0\u4EA4",
  branch: "\u5206\u652F",
  lastTurn: "\u6700\u8FD1\u8F6E\u6B21",
  turn: "\u5DF2\u8BB0\u5F55\u8F6E\u6B21",
  ref: "\u5F15\u7528",
  run: "\u8F6E\u6B21",
  refresh: "\u5237\u65B0",
  close: "\u5173\u95ED",
  search: "\u641C\u7D22\u6587\u4EF6\u8DEF\u5F84",
  files: "\u6587\u4EF6",
  noFiles: "\u6B64\u8303\u56F4\u6CA1\u6709\u66F4\u6539\u3002",
  noMatches: "\u6CA1\u6709\u5339\u914D\u7684\u8DEF\u5F84\u3002\u6E05\u7A7A\u641C\u7D22\u4EE5\u67E5\u770B\u5168\u90E8\u6587\u4EF6\u3002",
  noRoots: "\u6CA1\u6709\u53EF\u7528\u4ED3\u5E93\u6216\u5DF2\u8BB0\u5F55\u8F6E\u6B21\u3002\u5728 PI-Desktop \u4E2D\u6253\u5F00\u9879\u76EE\u540E\u5237\u65B0\u3002",
  chooseFile: "\u9009\u62E9\u4E00\u4E2A\u6587\u4EF6\u5F00\u59CB\u5BA1\u9605\u3002",
  loading: "\u52A0\u8F7D\u4E2D\u2026",
  retry: "\u91CD\u8BD5",
  unified: "\u7EDF\u4E00",
  split: "\u5E76\u6392",
  wrap: "\u81EA\u52A8\u6362\u884C",
  context: "\u4E0A\u4E0B\u6587",
  full: "\u5B8C\u6574\u6587\u4EF6",
  copy: "\u590D\u5236\u5DEE\u5F02",
  copied: "\u5DEE\u5F02\u5DF2\u590D\u5236",
  previous: "\u4E0A\u4E00\u9875",
  next: "\u4E0B\u4E00\u9875",
  previousHunk: "\u4E0A\u4E00\u5DEE\u5F02\u5757",
  nextHunk: "\u4E0B\u4E00\u5DEE\u5F02\u5757",
  page: "\u884C",
  of: "/",
  comments: "\u8BC4\u8BBA",
  addComment: "\u6DFB\u52A0\u8BC4\u8BBA",
  edit: "\u7F16\u8F91",
  delete: "\u5220\u9664",
  save: "\u4FDD\u5B58\u8BC4\u8BBA",
  cancel: "\u53D6\u6D88",
  commentBody: "\u8BC4\u8BBA\u5185\u5BB9",
  old: "\u65E7",
  new: "\u65B0",
  stale: "\u951A\u70B9\u5DF2\u8FC7\u671F \xB7 \u6587\u4EF6\u5185\u5BB9\u5DF2\u66F4\u6539",
  noComments: "\u6682\u65E0\u8BC4\u8BBA\u3002\u70B9\u51FB\u884C\u53F7\u6DFB\u52A0\u8BC4\u8BBA\u3002",
  commentSaved: "\u8BC4\u8BBA\u5DF2\u4FDD\u5B58",
  commentDeleted: "\u8BC4\u8BBA\u5DF2\u5220\u9664",
  feedback: "\u5BA1\u9605\u53CD\u9988",
  insert: "\u5C06\u53CD\u9988\u63D2\u5165\u8349\u7A3F",
  feedbackHint: "\u5C06\u9884\u5148\u51C6\u5907\u7684\u53CD\u9988\u63D2\u5165\u5F53\u524D\u8349\u7A3F\uFF0C\u4E0D\u4F1A\u53D1\u9001\u6D88\u606F\u3002",
  feedbackNoSession: "\u4ECE\u4F1A\u8BDD\u56DE\u590D\u6253\u5F00\u5BA1\u9605\uFF0C\u624D\u80FD\u5C06\u53CD\u9988\u63D2\u5165\u8BE5\u4F1A\u8BDD\u8349\u7A3F\u3002",
  feedbackEmpty: "\u4FDD\u5B58\u8BC4\u8BBA\u4EE5\u51C6\u5907\u53CD\u9988\u3002",
  stage: "\u6682\u5B58",
  unstage: "\u53D6\u6D88\u6682\u5B58",
  revert: "\u64A4\u9500",
  reapply: "\u91CD\u65B0\u5E94\u7528",
  confirm: "\u786E\u8BA4\u64CD\u4F5C",
  confirmHint: "\u6B64\u64CD\u4F5C\u4F1A\u4FEE\u6539\u672C\u5730\u6587\u4EF6\u6216 Git \u7D22\u5F15\u3002\u8BF7\u6838\u5BF9\u5177\u4F53\u76EE\u6807\u540E\u7EE7\u7EED\u3002",
  target: "\u76EE\u6807",
  wholeFile: "\u6574\u4E2A\u6587\u4EF6",
  hunk: "\u5DEE\u5F02\u5757",
  expandedHint: "\u4EC5\u5728\u4E0A\u4E0B\u6587\u4E3A 3 \u884C\u65F6\u63D0\u4F9B\u5DEE\u5F02\u5757\u64CD\u4F5C\uFF1B\u6269\u5C55\u4E0A\u4E0B\u6587\u53EF\u80FD\u5408\u5E76\u5DEE\u5F02\u5757\u6807\u8BC6\u3002",
  actionOk: "\u64CD\u4F5C\u5DF2\u5B8C\u6210",
  actionConflict: "\u64CD\u4F5C\u88AB\u62D2\u7EDD\u3002\u8BF7\u5237\u65B0\u5E76\u6838\u5BF9\u5F53\u524D\u6587\u4EF6\u540E\u91CD\u8BD5\u3002",
  history: "\u8BB0\u5F55\u5386\u53F2",
  clearHistory: "\u6E05\u7A7A\u8BB0\u5F55\u5386\u53F2",
  clearHint: "\u5220\u9664\u6240\u6709\u672C\u5730\u8F6E\u6B21\u5FEB\u7167\u53CA\u5DF2\u4FDD\u5B58\u7684\u5BA1\u9605\u8BC4\u8BBA\u3002\u4E0D\u5F71\u54CD Git \u66F4\u6539\u3002",
  cleared: "\u8BB0\u5F55\u5386\u53F2\u5DF2\u6E05\u7A7A",
  theme: "\u4E3B\u9898",
  light: "\u6D45\u8272",
  dark: "\u6DF1\u8272",
  language: "\u8BED\u8A00",
  settings: "\u663E\u793A\u8BBE\u7F6E",
  unavailable: "\u5386\u53F2\u5185\u5BB9\u7F3A\u5931\u6216\u672A\u8BB0\u5F55\uFF0C\u65E0\u6CD5\u91CD\u5EFA\u5DEE\u5F02\u3002",
  binary: "\u4E8C\u8FDB\u5236\u6587\u4EF6\uFF0C\u65E0\u6CD5\u663E\u793A\u6587\u672C\u5DEE\u5F02\u3002",
  large: "\u6587\u4EF6\u8D85\u51FA\u6587\u672C\u5DEE\u5F02\u9650\u5236\u3002",
  symlink: "\u7B26\u53F7\u94FE\u63A5\uFF0C\u4E0D\u63D0\u4F9B\u6587\u672C\u5DEE\u5F02\u5757\u64CD\u4F5C\u3002",
  submodule: "\u5B50\u6A21\u5757\u66F4\u6539\uFF0C\u4E0D\u63D0\u4F9B\u6587\u672C\u5DEE\u5F02\u5757\u3002",
  conflict: "\u5B58\u5728\u672A\u89E3\u51B3\u7684\u5408\u5E76\u51B2\u7A81\uFF0C\u8BF7\u5148\u89E3\u51B3\u518D\u6267\u884C\u64CD\u4F5C\u3002",
  mode: "\u6587\u4EF6\u6A21\u5F0F\u53D1\u751F\u66F4\u6539\uFF0C\u65E0\u6587\u672C\u5DEE\u5F02\u5757\u3002",
  noHunks: "\u6B64\u6587\u4EF6\u6CA1\u6709\u6587\u672C\u5DEE\u5F02\u5757\u3002",
  added: "\u65B0\u589E",
  modified: "\u4FEE\u6539",
  deleted: "\u5220\u9664",
  renamed: "\u91CD\u547D\u540D",
  reverted: "\u5DF2\u64A4\u9500",
  incomplete: "\u8BB0\u5F55\u4E0D\u5B8C\u6574",
  running: "\u8FD0\u884C\u4E2D",
  completed: "\u5DF2\u5B8C\u6210",
  aborted: "\u5DF2\u4E2D\u6B62",
  notice: "\u63D0\u793A",
  collapsed: "\u5C55\u5F00\u5DEE\u5F02\u5757",
  expanded: "\u6298\u53E0\u5DEE\u5F02\u5757",
  summary: "\u8BC4\u8BBA\u6C47\u603B",
  deleteHint: "\u5220\u9664\u6B64\u6761\u5DF2\u4FDD\u5B58\u8BC4\u8BBA\uFF1F",
  keyboard: "Alt+\u2191 / Alt+\u2193\uFF1A\u8DF3\u8F6C\u5230\u5F53\u524D\u9875\u5DEE\u5F02\u5757",
  busy: "\u6B63\u5728\u6267\u884C\u64CD\u4F5C",
  error: "\u8BF7\u6C42\u5931\u8D25",
  demo: "\u6F14\u793A\u6570\u636E \xB7 \u6A21\u62DF\u540E\u7AEF",
  emptyRef: "\u8BF7\u8F93\u5165\u63D0\u4EA4\u6216\u5206\u652F\u5F15\u7528\u3002",
  continuation: "\u672C\u9875\u53EF\u80FD\u5EF6\u7EED\u5176\u4ED6\u9875\u7684\u5DEE\u5F02\u5757\u3002",
  noBridge: "PI-Desktop \u6865\u63A5\u4E0D\u53EF\u7528\uFF0C\u8BF7\u5728 PI-Desktop \u4E2D\u6253\u5F00\u6B64\u63D2\u4EF6\u3002",
  feedbackCopy: "\u9009\u62E9\u5E76\u590D\u5236\u53CD\u9988",
  deletedExcerpt: "\u951A\u70B9\u6458\u5F55",
  clearSearch: "\u6E05\u7A7A\u641C\u7D22",
  commentsFailed: "\u65E0\u6CD5\u52A0\u8F7D\u8BC4\u8BBA",
  feedbackFailed: "\u65E0\u6CD5\u51C6\u5907\u53CD\u9988",
  action: "\u64CD\u4F5C",
  loadMore: "\u4E0B\u4E00\u9875\u7EE7\u7EED",
  commentLimit: "\u8BC4\u8BBA\u957F\u5EA6\u987B\u4E3A 1\u20134,000 \u4E2A\u5B57\u7B26\u3002",
  commentDisabled: "\u63D0\u793A\u884C\u65E0\u6CD5\u6DFB\u52A0\u8BC4\u8BBA\u3002",
  applyRef: "\u5BA1\u9605\u5F15\u7528"
};
function messages(locale) {
  return locale.toLowerCase().startsWith("zh") ? zh : en;
}
function kindLabel(kind, locale) {
  const labels = { binary: ["Binary", "\u4E8C\u8FDB\u5236"], large: ["Oversized", "\u8D85\u5927\u6587\u4EF6"], symlink: ["Symlink", "\u7B26\u53F7\u94FE\u63A5"], submodule: ["Submodule", "\u5B50\u6A21\u5757"], conflict: ["Conflict", "\u51B2\u7A81"], unavailable: ["Unrecorded", "\u672A\u8BB0\u5F55"] };
  return labels[kind]?.[locale.startsWith("zh") ? 1 : 0] ?? kind;
}

// src/view/transport.ts
var realm = globalThis;
var queue = realm.__piDiffQueue ??= { tail: Promise.resolve(), last: 0 };
var background = /* @__PURE__ */ new Set(["bootstrap", "review", "action", "batchAction", "copyPatch", "clearHistory"]);
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

// src/view/ReviewApp.tsx
import { Fragment, jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
var errorText = (error) => error instanceof Error ? error.message : String(error);
function Modal({ title, children, onClose, busy }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return /* @__PURE__ */ jsxs2("dialog", { className: "dv-dialog", ref, "aria-label": title, onCancel: (event) => {
    event.preventDefault();
    if (!busy) onClose();
  }, children: [
    /* @__PURE__ */ jsx2("h2", { children: title }),
    children
  ] });
}
function ReviewApp({ transport: source, initialRequest = {}, onClose, locale: hostLocale, base: hostBase }) {
  const transport = useMemo2(() => ensureBounded(source), [source]);
  const [boot, setBoot] = useState(null);
  const [bootError, setBootError] = useState("");
  const [bootTick, setBootTick] = useState(0);
  const [locale, setLocale] = useState(hostLocale ?? "zh-CN");
  const [base, setBase] = useState(hostBase ?? "light");
  const t = messages(locale);
  const [layout, setLayout] = useState("unified");
  const [wrap, setWrap] = useState(true);
  const [request, setRequest] = useState({ scope: initialRequest.scope ?? (initialRequest.sessionId ? "lastTurn" : "unstaged"), ...initialRequest });
  const [refDraft, setRefDraft] = useState(initialRequest.ref ?? "");
  const [review, setReview] = useState(null);
  const [reviewError, setReviewError] = useState("");
  const [loadingReview, setLoadingReview] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [context, setContext] = useState(3);
  const [offset, setOffset] = useState(0);
  const [pageStack, setPageStack] = useState([]);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState("");
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailTick, setDetailTick] = useState(0);
  const [collapsed, setCollapsed] = useState(/* @__PURE__ */ new Set());
  const [comments, setComments] = useState([]);
  const [commentsError, setCommentsError] = useState("");
  const [loadingComments, setLoadingComments] = useState(false);
  const [commentsTick, setCommentsTick] = useState(0);
  const [feedback, setFeedback] = useState("");
  const [feedbackError, setFeedbackError] = useState("");
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [confirmation, setConfirmation] = useState(null);
  const [editor, setEditor] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [batchResults, setBatchResults] = useState([]);
  const live = useRef(true);
  const scopeKey = `${request.scope}|${request.root}|${request.ref}|${request.sessionId}|${request.runId}`;
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const diffPane = useRef(null);
  const sessionId = review?.sessionId ?? request.sessionId;
  const canInsert = Boolean(transport.insertText && sessionId && sessionId === initialRequest.sessionId);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (hostLocale) setLocale(hostLocale);
  }, [hostLocale]);
  useEffect(() => {
    if (hostBase) setBase(hostBase);
  }, [hostBase]);
  useEffect(() => {
    let active = true;
    setBootError("");
    transport.invoke("bootstrap", { sessionId: initialRequest.sessionId }).then((data) => {
      if (!active) return;
      setBoot(data);
      setLayout(data.settings.layout);
      setWrap(data.settings.wordWrap);
      if (!hostLocale) setLocale(data.locale);
      if (!hostBase) setBase(data.base);
      setRequest((previous) => {
        if (previous.root) return previous;
        const run = data.runs.find((item) => item.id === previous.runId) ?? data.runs.find((item) => item.sessionId === previous.sessionId) ?? data.runs[0];
        const root = previous.scope === "turn" || previous.scope === "lastTurn" ? run?.root : data.repositories[0]?.root;
        return { ...previous, root, ...(previous.scope === "turn" || previous.scope === "lastTurn") && run ? { sessionId: previous.sessionId ?? run.sessionId, runId: previous.scope === "turn" ? previous.runId ?? run.id : void 0 } : {} };
      });
    }).catch((err) => {
      if (active) setBootError(errorText(err));
    });
    return () => {
      active = false;
    };
  }, [transport, bootTick]);
  useEffect(() => {
    if (!boot) return;
    let active = true;
    setLoadingReview(false);
    setReview(null);
    setDetail(null);
    setReviewError("");
    setComments([]);
    setFeedback("");
    setEditor(null);
    setConfirmation(null);
    setOffset(0);
    setPageStack([]);
    setCollapsed(/* @__PURE__ */ new Set());
    if (!request.root && !request.sessionId && !request.runId) return;
    if ((request.scope === "commit" || request.scope === "branch") && !request.ref?.trim()) {
      setReviewError(t.emptyRef);
      return;
    }
    setLoadingReview(true);
    transport.invoke("review", request).then((data) => {
      if (!active) return;
      setReview(data);
      setSelected((previous) => data.files.some((file) => file.id === previous) ? previous : data.files[0]?.id ?? "");
    }).catch((err) => {
      if (active) setReviewError(errorText(err));
    }).finally(() => {
      if (active) setLoadingReview(false);
    });
    return () => {
      active = false;
    };
  }, [transport, boot, scopeKey, refreshTick]);
  useEffect(() => {
    setLoadingDetail(false);
    setDetail(null);
    setDetailError("");
    if (!review || !selected) return;
    let active = true;
    setLoadingDetail(true);
    transport.invoke("file", { reviewId: review.id, fileId: selected, offset, limit: 80, context }).then((data) => {
      if (active) setDetail(data);
    }).catch((err) => {
      if (active) setDetailError(errorText(err));
    }).finally(() => {
      if (active) setLoadingDetail(false);
    });
    return () => {
      active = false;
    };
  }, [transport, review, selected, offset, context, detailTick]);
  useEffect(() => {
    setLoadingComments(false);
    setFeedbackLoading(false);
    setCommentsError("");
    setFeedback("");
    setFeedbackError("");
    if (!review) return;
    let active = true;
    setLoadingComments(true);
    transport.invoke("comments", { reviewId: review.id, sessionId }).then((data) => {
      if (active) setComments(data);
    }).catch((err) => {
      if (active) setCommentsError(errorText(err));
    }).finally(() => {
      if (active) setLoadingComments(false);
    });
    setFeedbackLoading(true);
    transport.invoke("feedback", { reviewId: review.id, sessionId }).then((data) => {
      if (active) setFeedback(data.text);
    }).catch((err) => {
      if (active) setFeedbackError(errorText(err));
    }).finally(() => {
      if (active) setFeedbackLoading(false);
    });
    return () => {
      active = false;
    };
  }, [transport, review, sessionId, commentsTick]);
  const resetPage = () => {
    setOffset(0);
    setPageStack([]);
    setCollapsed(/* @__PURE__ */ new Set());
  };
  const currentFile = detail?.file ?? review?.files.find((file) => file.id === selected);
  const visibleFiles = review?.files.filter((file) => `${file.path} ${file.oldPath ?? ""}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  const sessionRuns = boot?.runs.filter((run) => !initialRequest.sessionId || run.sessionId === initialRequest.sessionId) ?? [];
  const roots = [.../* @__PURE__ */ new Set([...boot?.repositories.map((repo) => repo.root) ?? [], ...boot?.runs.map((run) => run.root) ?? [], ...request.root ? [request.root] : []])];
  const perform = async (job) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await job();
    } catch (err) {
      if (live.current) setError(errorText(err));
    } finally {
      if (live.current) setBusy(false);
    }
  };
  const saveSettings = (next) => {
    if (next.layout) setLayout(next.layout);
    if (next.wordWrap != null) setWrap(next.wordWrap);
    transport.invoke("settings", next).catch((err) => {
      if (live.current) setError(errorText(err));
    });
  };
  const openComment = (line, side, hunk) => {
    if (!currentFile || !review) return;
    const lineNumber = side === "old" ? line.oldLine : line.newLine;
    if (lineNumber == null) return;
    const sideLines = hunk.lines.filter((item) => side === "old" ? item.oldLine != null : item.newLine != null);
    const index = sideLines.indexOf(line);
    setError("");
    setEditor({ body: "", anchor: { path: currentFile.path, fingerprint: currentFile.fingerprint, scope: review.scope, root: review.root, side, line: lineNumber, text: line.text, excerpt: sideLines.slice(Math.max(0, index - 2), index + 3).map((item) => item.text).join("\n").slice(0, 3e3), runId: review.runId } });
  };
  const navigateHunk = useCallback((direction) => {
    const buttons = Array.from(diffPane.current?.querySelectorAll("[data-hunk-nav]") ?? []);
    if (!buttons.length) return;
    const focused = buttons.findIndex((button) => button === document.activeElement || button.closest(".dv-hunk")?.contains(document.activeElement));
    const next = focused < 0 ? direction > 0 ? 0 : buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, focused + direction));
    buttons[next].focus();
    buttons[next].scrollIntoView({ block: "nearest" });
  }, []);
  const confirmOperation = () => perform(async () => {
    const target = confirmation;
    if (!target) return;
    const key = scopeRef.current;
    if (target.kind === "action") {
      const args = { reviewId: target.review.id, fileId: target.file.id, action: target.action, hunkId: target.hunk?.id, fingerprint: target.file.fingerprint, confirmed: true };
      const result = await transport.invoke("action", args);
      if (!live.current) return;
      setConfirmation(null);
      if (!result.ok) {
        setError(`${t.actionConflict} ${result.message}`);
        return;
      }
      setStatus(result.message || t.actionOk);
      if (scopeRef.current === key) setRefreshTick((value) => value + 1);
    } else if (target.kind === "batch") {
      const result = await transport.invoke("batchAction", { reviewId: target.review.id, action: target.action, targets: target.files.map((file) => ({ fileId: file.id, fingerprint: file.fingerprint })), confirmed: true });
      if (!live.current) return;
      setConfirmation(null);
      setBatchResults(result.results);
      if (scopeRef.current === key) setRefreshTick((value) => value + 1);
    } else if (target.kind === "history") {
      await transport.invoke("clearHistory", { confirmed: true });
      if (!live.current) return;
      setConfirmation(null);
      setStatus(t.cleared);
      setBootTick((value) => value + 1);
      setComments([]);
    } else {
      await transport.invoke("deleteComment", { id: target.comment.id });
      if (!live.current) return;
      setConfirmation(null);
      setStatus(t.commentDeleted);
      setCommentsTick((value) => value + 1);
    }
  });
  const copyPatch = () => perform(async () => {
    if (!review) return;
    await transport.invoke("copyPatch", { reviewId: review.id, fileId: currentFile?.id });
    if (live.current) setStatus(t.copied);
  });
  const actionButtons = (file, hunk) => file.actions.map((action) => /* @__PURE__ */ jsx2("button", { disabled: busy || loadingReview || loadingDetail, onClick: () => {
    setError("");
    if (review) setConfirmation({ kind: "action", action, file, hunk, review });
  }, children: t[action] }, action));
  const runLabel = (id) => {
    const run = boot?.runs.find((item) => item.id === id);
    return run ? `${new Date(run.startedAt).toLocaleString(locale)} \xB7 ${run.prompt?.slice(0, 60) ?? run.id} \xB7 ${t[run.state]}${run.incomplete ? ` \xB7 ${t.incomplete}` : ""}` : id;
  };
  return /* @__PURE__ */ jsxs2("section", { className: "dv-app", "data-base": base, lang: locale, "aria-label": t.title, onKeyDown: (event) => {
    if (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp") && !editor && !confirmation) {
      event.preventDefault();
      navigateHunk(event.key === "ArrowDown" ? 1 : -1);
    }
  }, children: [
    /* @__PURE__ */ jsxs2("header", { className: "dv-top", children: [
      /* @__PURE__ */ jsxs2("div", { className: "dv-heading", children: [
        /* @__PURE__ */ jsx2("h1", { children: t.title }),
        review && /* @__PURE__ */ jsxs2("span", { className: "dv-counts", children: [
          /* @__PURE__ */ jsxs2("span", { className: "dv-added", children: [
            "+",
            review.files.reduce((sum, file) => sum + file.additions, 0)
          ] }),
          /* @__PURE__ */ jsxs2("span", { className: "dv-deleted", children: [
            "\u2212",
            review.files.reduce((sum, file) => sum + file.deletions, 0)
          ] })
        ] }),
        /* @__PURE__ */ jsxs2("div", { className: "dv-toolbar", children: [
          /* @__PURE__ */ jsxs2("label", { children: [
            t.language,
            /* @__PURE__ */ jsxs2("select", { "aria-label": t.language, value: locale.startsWith("zh") ? "zh-CN" : "en", onChange: (event) => setLocale(event.target.value), children: [
              /* @__PURE__ */ jsx2("option", { value: "zh-CN", children: "\u4E2D\u6587" }),
              /* @__PURE__ */ jsx2("option", { value: "en", children: "English" })
            ] })
          ] }),
          /* @__PURE__ */ jsxs2("label", { children: [
            t.theme,
            /* @__PURE__ */ jsxs2("select", { "aria-label": t.theme, value: base, onChange: (event) => setBase(event.target.value), children: [
              /* @__PURE__ */ jsx2("option", { value: "light", children: t.light }),
              /* @__PURE__ */ jsx2("option", { value: "dark", children: t.dark })
            ] })
          ] }),
          onClose && /* @__PURE__ */ jsx2("button", { onClick: onClose, disabled: busy, children: t.close })
        ] })
      ] }),
      /* @__PURE__ */ jsxs2("div", { className: "dv-toolbar dv-repo-toolbar", children: [
        /* @__PURE__ */ jsxs2("label", { className: "dv-repository", children: [
          t.repository,
          /* @__PURE__ */ jsxs2("select", { "aria-label": t.repository, value: request.root ?? "", disabled: !boot || busy, onChange: (event) => {
            setRequest((value) => ({ ...value, root: event.target.value, runId: void 0, sessionId: initialRequest.sessionId }));
            setQuery("");
          }, children: [
            /* @__PURE__ */ jsx2("option", { value: "", disabled: true, children: "\u2014" }),
            roots.map((root) => /* @__PURE__ */ jsxs2("option", { value: root, children: [
              boot?.repositories.find((repo) => repo.root === root)?.name ?? root,
              " \u2014 ",
              root
            ] }, root))
          ] })
        ] }),
        /* @__PURE__ */ jsxs2("label", { children: [
          t.scope,
          /* @__PURE__ */ jsx2("select", { "aria-label": t.scope, value: request.scope, disabled: !boot || busy, onChange: (event) => {
            const scope = event.target.value;
            const run = sessionRuns.find((item) => item.root === request.root) ?? sessionRuns[0];
            setRequest((value) => ({ root: value.root, scope, sessionId: initialRequest.sessionId, ...scope === "turn" || scope === "lastTurn" ? { root: run?.root ?? value.root, sessionId: initialRequest.sessionId ?? run?.sessionId, runId: scope === "turn" ? run?.id : void 0 } : {}, ref: scope === "commit" || scope === "branch" ? refDraft : void 0 }));
          }, children: ["unstaged", "staged", "commit", "branch", "lastTurn", "turn"].map((scope) => /* @__PURE__ */ jsx2("option", { value: scope, children: t[scope] }, scope)) })
        ] }),
        request.scope === "turn" && /* @__PURE__ */ jsxs2("label", { className: "dv-run", children: [
          t.run,
          /* @__PURE__ */ jsxs2("select", { "aria-label": t.run, disabled: busy, value: request.runId ?? "", onChange: (event) => {
            const run = boot?.runs.find((item) => item.id === event.target.value);
            if (run) setRequest((value) => ({ ...value, root: run.root, runId: run.id, sessionId: run.sessionId }));
          }, children: [
            /* @__PURE__ */ jsx2("option", { value: "", disabled: true, children: "\u2014" }),
            sessionRuns.map((run) => /* @__PURE__ */ jsx2("option", { value: run.id, children: runLabel(run.id) }, run.id))
          ] })
        ] }),
        (request.scope === "commit" || request.scope === "branch") && /* @__PURE__ */ jsxs2("form", { className: "dv-toolbar", onSubmit: (event) => {
          event.preventDefault();
          setRequest((value) => ({ ...value, ref: refDraft.trim() }));
        }, children: [
          /* @__PURE__ */ jsxs2("label", { children: [
            t.ref,
            /* @__PURE__ */ jsx2("input", { "aria-label": t.ref, value: refDraft, onChange: (event) => setRefDraft(event.target.value), maxLength: 250 })
          ] }),
          /* @__PURE__ */ jsx2("button", { disabled: busy || !refDraft.trim(), children: t.applyRef })
        ] }),
        /* @__PURE__ */ jsx2("button", { disabled: busy || loadingReview, onClick: () => setBootTick((value) => value + 1), children: t.refresh }),
        /* @__PURE__ */ jsx2("button", { disabled: !boot?.runs.length || busy, onClick: () => {
          setError("");
          setConfirmation({ kind: "history" });
        }, children: t.clearHistory })
      ] }),
      review?.notice && /* @__PURE__ */ jsx2("p", { className: "dv-notice", children: review.notice }),
      request.runId && boot?.runs.find((run) => run.id === request.runId)?.incomplete && /* @__PURE__ */ jsx2("p", { className: "dv-notice", children: t.incomplete })
    ] }),
    (error || status) && /* @__PURE__ */ jsx2("div", { className: `dv-message ${error ? "dv-error" : ""}`, role: error ? "alert" : "status", children: error || status }),
    batchResults.length > 0 && /* @__PURE__ */ jsxs2("details", { className: "dv-message", open: true, children: [
      /* @__PURE__ */ jsx2("summary", { children: t.batch }),
      /* @__PURE__ */ jsx2("pre", { style: { whiteSpace: "pre-wrap" }, children: batchResults.map((result) => `${result.ok ? "\u2713" : "\u2717"} ${result.path}: ${result.message}`).join("\n") })
    ] }),
    bootError ? /* @__PURE__ */ jsxs2("div", { className: "dv-empty dv-error", role: "alert", children: [
      bootError,
      /* @__PURE__ */ jsx2("button", { onClick: () => setBootTick((value) => value + 1), children: t.retry })
    ] }) : !boot ? /* @__PURE__ */ jsx2("div", { className: "dv-empty", role: "status", children: t.loading }) : /* @__PURE__ */ jsxs2("div", { className: "dv-workspace", children: [
      /* @__PURE__ */ jsxs2("aside", { className: "dv-files", "aria-label": t.files, children: [
        /* @__PURE__ */ jsxs2("div", { className: "dv-file-search", children: [
          /* @__PURE__ */ jsxs2("strong", { children: [
            t.files,
            " ",
            /* @__PURE__ */ jsx2("span", { className: "dv-muted", children: review?.files.length ?? 0 })
          ] }),
          /* @__PURE__ */ jsx2("input", { type: "search", "aria-label": t.search, placeholder: t.search, value: query, onChange: (event) => setQuery(event.target.value) })
        ] }),
        /* @__PURE__ */ jsx2("div", { className: "dv-toolbar", "aria-label": t.batch, children: ["stage", "unstage", "revert", "reapply"].map((action) => {
          const files = visibleFiles.filter((file) => file.actions.includes(action)).slice(0, 20);
          return files.length > 1 && /* @__PURE__ */ jsxs2("button", { disabled: busy || loadingReview, onClick: () => {
            if (review) {
              setError("");
              setBatchResults([]);
              setConfirmation({ kind: "batch", action, files, review });
            }
          }, children: [
            t[action],
            " \xB7 ",
            files.length
          ] }, action);
        }) }),
        /* @__PURE__ */ jsx2("nav", { className: "dv-file-list", "aria-label": t.files, children: visibleFiles.map((file) => /* @__PURE__ */ jsxs2("button", { className: "dv-file", "aria-current": file.id === selected ? "true" : void 0, disabled: busy, onClick: () => {
          resetPage();
          setSelected(file.id);
          setEditor(null);
        }, title: `${file.oldPath ? `${file.oldPath} \u2192 ` : ""}${file.path}`, children: [
          /* @__PURE__ */ jsx2("span", { className: "dv-file-name", children: file.path.split("/").pop() }),
          /* @__PURE__ */ jsxs2("span", { className: "dv-counts", children: [
            /* @__PURE__ */ jsxs2("span", { className: "dv-added", children: [
              "+",
              file.additions
            ] }),
            /* @__PURE__ */ jsxs2("span", { className: "dv-deleted", children: [
              "\u2212",
              file.deletions
            ] })
          ] }),
          /* @__PURE__ */ jsxs2("span", { className: "dv-file-path", children: [
            file.path,
            file.oldPath && /* @__PURE__ */ jsxs2(Fragment, { children: [
              /* @__PURE__ */ jsx2("br", {}),
              "\u2190 ",
              file.oldPath
            ] })
          ] }),
          /* @__PURE__ */ jsxs2("span", { className: "dv-file-status", children: [
            t[file.status],
            file.kind !== "text" ? ` \xB7 ${kindLabel(file.kind, locale)}` : "",
            file.state === "reverted" ? ` \xB7 ${t.reverted}` : ""
          ] })
        ] }, file.id)) }),
        !visibleFiles.length && !loadingReview && /* @__PURE__ */ jsxs2("p", { className: "dv-rail-empty", children: [
          query ? t.noMatches : t.noFiles,
          query && /* @__PURE__ */ jsx2("button", { onClick: () => setQuery(""), children: t.clearSearch })
        ] })
      ] }),
      /* @__PURE__ */ jsx2("main", { className: "dv-review", "aria-busy": loadingReview || loadingDetail, children: loadingReview ? /* @__PURE__ */ jsx2("div", { className: "dv-empty", role: "status", children: t.loading }) : reviewError ? /* @__PURE__ */ jsxs2("div", { className: "dv-empty dv-error", role: "alert", children: [
        reviewError,
        /* @__PURE__ */ jsx2("button", { onClick: () => setRefreshTick((value) => value + 1), children: t.retry })
      ] }) : !review ? /* @__PURE__ */ jsx2("div", { className: "dv-empty", children: t.noRoots }) : !currentFile ? /* @__PURE__ */ jsx2("div", { className: "dv-empty", children: review.files.length ? t.chooseFile : t.noFiles }) : /* @__PURE__ */ jsxs2(Fragment, { children: [
        /* @__PURE__ */ jsxs2("div", { className: "dv-file-heading", children: [
          /* @__PURE__ */ jsxs2("div", { children: [
            /* @__PURE__ */ jsx2("h2", { children: currentFile.path }),
            currentFile.oldPath && /* @__PURE__ */ jsxs2("p", { className: "dv-muted", children: [
              "\u2190 ",
              currentFile.oldPath
            ] }),
            /* @__PURE__ */ jsxs2("span", { className: "dv-added", children: [
              "+",
              currentFile.additions
            ] }),
            " ",
            /* @__PURE__ */ jsxs2("span", { className: "dv-deleted", children: [
              "\u2212",
              currentFile.deletions
            ] }),
            " ",
            /* @__PURE__ */ jsx2("span", { className: "dv-muted", children: t[currentFile.status] })
          ] }),
          /* @__PURE__ */ jsxs2("div", { className: "dv-toolbar", children: [
            actionButtons(currentFile),
            /* @__PURE__ */ jsx2("button", { disabled: busy, onClick: copyPatch, children: t.copy })
          ] })
        ] }),
        /* @__PURE__ */ jsxs2("div", { className: "dv-display-toolbar dv-toolbar", "aria-label": t.settings, children: [
          /* @__PURE__ */ jsxs2("div", { className: "dv-segment", role: "group", "aria-label": t.settings, children: [
            /* @__PURE__ */ jsx2("button", { "aria-pressed": layout === "unified", onClick: () => saveSettings({ layout: "unified" }), children: t.unified }),
            /* @__PURE__ */ jsx2("button", { "aria-pressed": layout === "split", onClick: () => saveSettings({ layout: "split" }), children: t.split })
          ] }),
          /* @__PURE__ */ jsxs2("label", { className: "dv-check", children: [
            /* @__PURE__ */ jsx2("input", { type: "checkbox", checked: wrap, onChange: (event) => saveSettings({ wordWrap: event.target.checked }) }),
            t.wrap
          ] }),
          /* @__PURE__ */ jsxs2("label", { children: [
            t.context,
            /* @__PURE__ */ jsxs2("select", { "aria-label": t.context, value: context, disabled: busy, onChange: (event) => {
              resetPage();
              setContext(Number(event.target.value));
            }, children: [
              /* @__PURE__ */ jsx2("option", { value: 3, children: "3" }),
              /* @__PURE__ */ jsx2("option", { value: 20, children: "20" }),
              /* @__PURE__ */ jsx2("option", { value: -1, children: t.full })
            ] })
          ] }),
          /* @__PURE__ */ jsx2("button", { onClick: () => navigateHunk(-1), disabled: !detail?.hunks.length, title: t.keyboard, children: t.previousHunk }),
          /* @__PURE__ */ jsx2("button", { onClick: () => navigateHunk(1), disabled: !detail?.hunks.length, title: t.keyboard, children: t.nextHunk })
        ] }),
        context !== 3 && /* @__PURE__ */ jsx2("p", { className: "dv-notice", children: t.expandedHint }),
        currentFile.note && /* @__PURE__ */ jsx2("p", { className: "dv-notice", children: currentFile.note }),
        /* @__PURE__ */ jsx2("div", { className: `dv-diff-pane ${wrap ? "dv-wrap" : "dv-nowrap"}`, ref: diffPane, tabIndex: 0, "aria-label": `${currentFile.path} ${t.title}`, children: loadingDetail ? /* @__PURE__ */ jsx2("div", { className: "dv-empty", role: "status", children: t.loading }) : detailError ? /* @__PURE__ */ jsxs2("div", { className: "dv-empty dv-error", role: "alert", children: [
          detailError,
          /* @__PURE__ */ jsx2("button", { onClick: () => setDetailTick((value) => value + 1), children: t.retry })
        ] }) : currentFile.kind !== "text" ? /* @__PURE__ */ jsx2("div", { className: "dv-empty", children: t[currentFile.kind] }) : detail && !detail.hunks.length ? /* @__PURE__ */ jsx2("div", { className: "dv-empty", children: currentFile.status === "mode" ? t.mode : t.noHunks }) : detail?.hunks.map((hunk, index) => /* @__PURE__ */ jsxs2("section", { className: "dv-hunk", style: { "--dv-stagger": `${Math.min(index, 4) * 20}ms` }, children: [
          /* @__PURE__ */ jsxs2("div", { className: "dv-hunk-heading", children: [
            /* @__PURE__ */ jsxs2("button", { "data-hunk-nav": true, "aria-expanded": !collapsed.has(hunk.id), onClick: () => setCollapsed((value) => {
              const next = new Set(value);
              next.has(hunk.id) ? next.delete(hunk.id) : next.add(hunk.id);
              return next;
            }), "aria-label": `${collapsed.has(hunk.id) ? t.collapsed : t.expanded} ${hunk.header}`, children: [
              /* @__PURE__ */ jsx2("span", { "aria-hidden": "true", children: collapsed.has(hunk.id) ? "\u25B8" : "\u25BE" }),
              " ",
              /* @__PURE__ */ jsx2("code", { children: hunk.header })
            ] }),
            /* @__PURE__ */ jsx2("div", { className: "dv-toolbar", children: context === 3 && !currentFile.oldPath && review.scope !== "turn" && review.scope !== "lastTurn" && actionButtons(currentFile, hunk) })
          ] }),
          !collapsed.has(hunk.id) && /* @__PURE__ */ jsx2(DiffRows, { path: currentFile.path, lines: hunk.lines, layout, t, disabled: busy, onLine: (line, side) => openComment(line, side, hunk) })
        ] }, `${context}:${offset}:${hunk.id}`)) }),
        detail && detail.totalRows > 0 && /* @__PURE__ */ jsxs2("footer", { className: "dv-pagination", children: [
          /* @__PURE__ */ jsxs2("span", { children: [
            t.page,
            " ",
            detail.offset + 1,
            "\u2013",
            detail.offset + detail.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0),
            " ",
            t.of,
            " ",
            detail.totalRows
          ] }),
          /* @__PURE__ */ jsxs2("div", { className: "dv-toolbar", children: [
            /* @__PURE__ */ jsx2("button", { disabled: !pageStack.length || busy || loadingDetail, onClick: () => {
              const pages = [...pageStack];
              setOffset(pages.pop() ?? 0);
              setPageStack(pages);
              diffPane.current?.scrollTo(0, 0);
            }, children: t.previous }),
            /* @__PURE__ */ jsx2("button", { disabled: detail.nextOffset == null || busy || loadingDetail, onClick: () => {
              if (detail.nextOffset != null) {
                setPageStack((value) => [...value, offset]);
                setOffset(detail.nextOffset);
                diffPane.current?.scrollTo(0, 0);
              }
            }, children: t.next })
          ] }),
          detail.totalRows > 80 && /* @__PURE__ */ jsx2("small", { children: t.continuation })
        ] }),
        /* @__PURE__ */ jsxs2("details", { className: "dv-comments", open: true, children: [
          /* @__PURE__ */ jsxs2("summary", { children: [
            t.summary,
            " (",
            comments.length,
            ")"
          ] }),
          commentsError && /* @__PURE__ */ jsxs2("p", { className: "dv-error", role: "alert", children: [
            t.commentsFailed,
            ": ",
            commentsError,
            /* @__PURE__ */ jsx2("button", { onClick: () => setCommentsTick((value) => value + 1), children: t.retry })
          ] }),
          loadingComments ? /* @__PURE__ */ jsx2("p", { role: "status", children: t.loading }) : !comments.length && !commentsError && /* @__PURE__ */ jsx2("p", { className: "dv-muted", children: t.noComments }),
          /* @__PURE__ */ jsx2("div", { className: "dv-comment-list", children: comments.map((comment) => /* @__PURE__ */ jsxs2("article", { className: "dv-comment", children: [
            /* @__PURE__ */ jsxs2("header", { children: [
              /* @__PURE__ */ jsx2("strong", { children: comment.anchor.path }),
              /* @__PURE__ */ jsxs2("span", { children: [
                t[comment.anchor.side],
                ":",
                comment.anchor.line
              ] }),
              /* @__PURE__ */ jsxs2("div", { className: "dv-toolbar", children: [
                /* @__PURE__ */ jsx2("button", { disabled: busy, onClick: () => {
                  setError("");
                  setEditor({ id: comment.id, body: comment.body, anchor: comment.anchor });
                }, children: t.edit }),
                /* @__PURE__ */ jsx2("button", { disabled: busy, onClick: () => {
                  setError("");
                  setConfirmation({ kind: "comment", comment });
                }, children: t.delete })
              ] })
            ] }),
            comment.stale && /* @__PURE__ */ jsx2("p", { className: "dv-stale", children: t.stale }),
            /* @__PURE__ */ jsx2("p", { className: "dv-comment-body", children: comment.body }),
            /* @__PURE__ */ jsxs2("details", { children: [
              /* @__PURE__ */ jsx2("summary", { children: t.deletedExcerpt }),
              /* @__PURE__ */ jsx2("pre", { children: comment.anchor.excerpt })
            ] })
          ] }, comment.id)) }),
          /* @__PURE__ */ jsxs2("details", { className: "dv-feedback", children: [
            /* @__PURE__ */ jsx2("summary", { children: t.feedback }),
            feedbackLoading ? /* @__PURE__ */ jsx2("p", { role: "status", children: t.loading }) : feedbackError ? /* @__PURE__ */ jsxs2("p", { className: "dv-error", role: "alert", children: [
              t.feedbackFailed,
              ": ",
              feedbackError
            ] }) : feedback ? /* @__PURE__ */ jsx2("textarea", { readOnly: true, "aria-label": t.feedbackCopy, value: feedback, rows: 5 }) : /* @__PURE__ */ jsx2("p", { className: "dv-muted", children: t.feedbackEmpty }),
            canInsert ? /* @__PURE__ */ jsxs2(Fragment, { children: [
              /* @__PURE__ */ jsx2("button", { disabled: !feedback || feedbackLoading || busy, onClick: () => {
                if (!live.current || !feedback || !canInsert) return;
                setError("");
                transport.insertText(feedback).catch((err) => {
                  if (live.current) setError(errorText(err));
                });
              }, children: t.insert }),
              /* @__PURE__ */ jsx2("p", { className: "dv-muted", children: t.feedbackHint })
            ] }) : /* @__PURE__ */ jsx2("p", { className: "dv-muted", children: t.feedbackNoSession })
          ] })
        ] })
      ] }) })
    ] }),
    editor && /* @__PURE__ */ jsx2(Modal, { title: editor.id ? t.edit : t.addComment, busy, onClose: () => setEditor(null), children: /* @__PURE__ */ jsxs2("form", { onSubmit: (event) => {
      event.preventDefault();
      const draft = editor;
      const key = scopeRef.current;
      void perform(async () => {
        if (!draft.body.trim() || draft.body.length > 4e3) throw new Error(t.commentLimit);
        await transport.invoke("saveComment", { id: draft.id, anchor: draft.anchor, body: draft.body.trim(), sessionId });
        if (!live.current || scopeRef.current !== key) return;
        setEditor(null);
        setStatus(t.commentSaved);
        setCommentsTick((value) => value + 1);
      });
    }, children: [
      /* @__PURE__ */ jsxs2("p", { className: "dv-anchor", children: [
        editor.anchor.path,
        " \xB7 ",
        t[editor.anchor.side],
        ":",
        editor.anchor.line
      ] }),
      /* @__PURE__ */ jsx2("pre", { children: editor.anchor.excerpt }),
      /* @__PURE__ */ jsxs2("label", { className: "dv-editor-label", children: [
        t.commentBody,
        /* @__PURE__ */ jsx2("textarea", { "aria-label": t.commentBody, autoFocus: true, value: editor.body, maxLength: 4e3, rows: 5, onChange: (event) => setEditor((value) => value && { ...value, body: event.target.value }) })
      ] }),
      error && /* @__PURE__ */ jsx2("p", { className: "dv-error", role: "alert", children: error }),
      /* @__PURE__ */ jsxs2("div", { className: "dv-dialog-actions", children: [
        /* @__PURE__ */ jsx2("button", { type: "button", disabled: busy, onClick: () => setEditor(null), children: t.cancel }),
        /* @__PURE__ */ jsx2("button", { className: "dv-primary", disabled: busy || !editor.body.trim(), children: busy ? t.loading : t.save })
      ] })
    ] }) }),
    confirmation && /* @__PURE__ */ jsxs2(Modal, { title: confirmation.kind === "action" || confirmation.kind === "batch" ? `${t.confirm}: ${t[confirmation.action]}` : confirmation.kind === "history" ? t.clearHistory : t.delete, busy, onClose: () => setConfirmation(null), children: [
      /* @__PURE__ */ jsx2("p", { children: confirmation.kind === "batch" ? t.batchHint : confirmation.kind === "action" ? t.confirmHint : confirmation.kind === "history" ? t.clearHint : t.deleteHint }),
      confirmation.kind === "batch" && /* @__PURE__ */ jsxs2(Fragment, { children: [
        /* @__PURE__ */ jsxs2("p", { children: [
          confirmation.review.root,
          " \xB7 ",
          t[confirmation.review.scope]
        ] }),
        /* @__PURE__ */ jsx2("pre", { style: { whiteSpace: "pre-wrap" }, children: confirmation.files.map((file) => file.path).join("\n") })
      ] }),
      confirmation.kind === "action" ? /* @__PURE__ */ jsxs2("dl", { className: "dv-target", children: [
        /* @__PURE__ */ jsx2("dt", { children: t.repository }),
        /* @__PURE__ */ jsx2("dd", { children: confirmation.review.root }),
        /* @__PURE__ */ jsx2("dt", { children: t.scope }),
        /* @__PURE__ */ jsx2("dd", { children: t[confirmation.review.scope] }),
        /* @__PURE__ */ jsx2("dt", { children: t.target }),
        /* @__PURE__ */ jsxs2("dd", { children: [
          confirmation.file.path,
          confirmation.file.oldPath && /* @__PURE__ */ jsxs2(Fragment, { children: [
            " \u2190 ",
            confirmation.file.oldPath
          ] })
        ] }),
        /* @__PURE__ */ jsx2("dt", { children: t.action }),
        /* @__PURE__ */ jsxs2("dd", { children: [
          t[confirmation.action],
          " \xB7 ",
          confirmation.hunk ? `${t.hunk} ${confirmation.hunk.header}` : t.wholeFile
        ] })
      ] }) : confirmation.kind === "comment" ? /* @__PURE__ */ jsxs2(Fragment, { children: [
        /* @__PURE__ */ jsxs2("p", { className: "dv-anchor", children: [
          confirmation.comment.anchor.path,
          " \xB7 ",
          t[confirmation.comment.anchor.side],
          ":",
          confirmation.comment.anchor.line
        ] }),
        /* @__PURE__ */ jsx2("p", { children: confirmation.comment.body })
      ] }) : confirmation.kind === "history" ? /* @__PURE__ */ jsxs2("p", { children: [
        t.history,
        ": ",
        boot?.runs.length ?? 0
      ] }) : null,
      error && /* @__PURE__ */ jsx2("p", { className: "dv-error", role: "alert", children: error }),
      /* @__PURE__ */ jsxs2("div", { className: "dv-dialog-actions", children: [
        /* @__PURE__ */ jsx2("button", { disabled: busy, onClick: () => setConfirmation(null), autoFocus: true, children: t.cancel }),
        /* @__PURE__ */ jsx2("button", { className: "dv-primary", disabled: busy, onClick: confirmOperation, children: busy ? t.loading : t.confirm })
      ] })
    ] })
  ] });
}
var ReviewApp_default = ReviewApp;

// src/renderer/styles.ts
var styles_default = String.raw`
.dv-app{--dv-bg:#fff;--dv-surface:#f6f7f8;--dv-ink:#20252b;--dv-muted:#616b77;--dv-border:#dce1e6;--dv-focus:#2469ce;--dv-hover:#edf0f3;--dv-selected:#e8eef7;--dv-green:#18723b;--dv-red:#b02c35;--dv-add-bg:#ecf8ee;--dv-del-bg:#fff0f1;--dv-add-word:#c1e9cc;--dv-del-word:#ffd0d5;color-scheme:light;color:var(--dv-ink);background:var(--dv-bg);font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;height:100%;display:flex;flex-direction:column;text-align:left}
.dv-app[data-base=dark]{--dv-bg:#181b20;--dv-surface:#20242b;--dv-ink:#e5e9ef;--dv-muted:#a0aab8;--dv-border:#363d47;--dv-focus:#8cb9ff;--dv-hover:#2b323c;--dv-selected:#2c394d;--dv-green:#8bddab;--dv-red:#ffa0a8;--dv-add-bg:#20382b;--dv-del-bg:#40282c;--dv-add-word:#315e41;--dv-del-word:#703a43;color-scheme:dark}
.dv-app *,.dv-app *::before,.dv-app *::after{box-sizing:border-box}.dv-app h1,.dv-app h2,.dv-app p{margin:0}.dv-app h1{font-size:16px;line-height:24px;font-weight:600}.dv-app h2{font-size:14px;font-weight:600;overflow-wrap:anywhere}
.dv-app button,.dv-app input,.dv-app select,.dv-app textarea{font:inherit;color:inherit;border:1px solid var(--dv-border);background:var(--dv-bg);border-radius:4px;min-height:28px}.dv-app button{padding:3px 8px;cursor:pointer}.dv-app button:hover:not(:disabled){background:var(--dv-hover)}.dv-app button:active:not(:disabled){background:var(--dv-selected)}.dv-app button:disabled,.dv-app input:disabled,.dv-app select:disabled{opacity:.5;cursor:not-allowed}.dv-app input:not([type=checkbox]),.dv-app select{padding:3px 8px;min-width:0;max-width:100%}.dv-app textarea{display:block;padding:8px;width:100%;resize:vertical}
.dv-app :is(button,input,select,textarea,summary,[tabindex]):focus-visible{outline:2px solid var(--dv-focus);outline-offset:-2px}.dv-app label{display:inline-flex;align-items:center;gap:8px;min-width:0}.dv-app summary{cursor:pointer;padding:4px 0}.dv-app pre{font:12px/20px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;padding:8px;background:var(--dv-surface)}.dv-app code{font:12px/20px ui-monospace,SFMono-Regular,Consolas,'Liberation Mono',monospace;tab-size:4}
.dv-top{border-bottom:1px solid var(--dv-border);padding:12px 16px}.dv-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:12px}.dv-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0}.dv-repository{flex:1 1 260px}.dv-repository select{flex:1;width:100%}.dv-run{flex:1 1 260px}.dv-run select{width:100%}.dv-message{padding:8px 16px;border-bottom:1px solid var(--dv-border);background:var(--dv-surface);overflow-wrap:anywhere}.dv-error,.dv-stale{color:var(--dv-red)}.dv-notice{padding:8px 12px;color:var(--dv-muted);background:var(--dv-surface);overflow-wrap:anywhere}.dv-top .dv-notice{margin:8px -4px -4px}
.dv-workspace{display:grid;grid-template-columns:248px minmax(0,1fr);flex:1;min-height:0}.dv-files{display:flex;flex-direction:column;min-height:0;min-width:0;border-right:1px solid var(--dv-border);background:var(--dv-surface)}.dv-file-search{display:grid;gap:8px;padding:12px;border-bottom:1px solid var(--dv-border)}.dv-file-list{overflow-y:auto;min-height:0}.dv-app .dv-file{width:100%;border:0;border-bottom:1px solid var(--dv-border);border-radius:0;display:grid;grid-template-columns:minmax(0,1fr) auto;text-align:left;padding:8px 12px;gap:4px 8px;background:transparent}.dv-app .dv-file[aria-current=true]{background:var(--dv-selected);box-shadow:inset 3px 0 var(--dv-focus)}.dv-file-name{font-weight:600;overflow-wrap:anywhere}.dv-counts{display:flex;gap:8px}.dv-file-path,.dv-file-status{grid-column:1/-1;font-size:12px;color:var(--dv-muted);overflow-wrap:anywhere}.dv-file-status{font-size:11px}.dv-added{color:var(--dv-green)}.dv-deleted{color:var(--dv-red)}.dv-muted{color:var(--dv-muted)}.dv-review{overflow:auto;min-width:0;min-height:0}.dv-rail-empty{padding:12px;color:var(--dv-muted);display:grid;gap:8px}.dv-empty{padding:32px 16px;display:flex;flex-wrap:wrap;align-items:center;gap:12px;color:var(--dv-muted)}.dv-empty.dv-error{color:var(--dv-red)}
.dv-file-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--dv-border)}.dv-file-heading>div:first-child{min-width:0;flex:1 1 240px}.dv-display-toolbar{padding:8px 16px;border-bottom:1px solid var(--dv-border)}.dv-segment{display:inline-flex}.dv-segment button:first-child{border-radius:4px 0 0 4px}.dv-segment button:last-child{border-radius:0 4px 4px 0;margin-left:-1px}.dv-app button[aria-pressed=true]{background:var(--dv-selected);border-color:var(--dv-focus);z-index:1}.dv-app .dv-check input{min-height:0;accent-color:var(--dv-focus)}
.dv-diff-pane{min-width:0;overflow-x:auto}.dv-hunk{border-bottom:1px solid var(--dv-border);animation:dv-reveal 140ms cubic-bezier(.2,.9,.3,1) var(--dv-stagger,0ms) both}.dv-hunk-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;background:var(--dv-surface);border-bottom:1px solid var(--dv-border);padding:4px 8px;gap:4px 8px}.dv-hunk-heading>button{border:0;text-align:left;background:transparent;overflow-wrap:anywhere}.dv-hunk-heading code{white-space:normal}.dv-rows{width:100%}.dv-row{display:grid;grid-template-columns:44px 44px 20px minmax(0,1fr);min-height:22px}.dv-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.dv-side{display:grid;grid-template-columns:44px 20px minmax(0,1fr);min-height:22px;min-width:0}.dv-side:first-child{border-right:1px solid var(--dv-border)}.dv-side-labels{display:grid;grid-template-columns:1fr 1fr;color:var(--dv-muted);background:var(--dv-surface)}.dv-side-labels span{padding:4px 12px}.dv-side-labels span:first-child{border-right:1px solid var(--dv-border)}.dv-app .dv-number{font:11px/22px ui-monospace,Consolas,monospace;color:var(--dv-muted);padding:0 6px;text-align:right;border:0;border-radius:0;min-height:22px;background:transparent;user-select:none}.dv-app button.dv-number:hover{color:var(--dv-focus);background:var(--dv-selected)}.dv-sign{text-align:center;font:12px/22px ui-monospace,Consolas,monospace;user-select:none}.dv-code{display:block;padding:1px 8px 1px 0;min-width:0}.dv-wrap .dv-code{white-space:pre-wrap;overflow-wrap:anywhere}.dv-nowrap .dv-unified{width:max-content;min-width:100%}.dv-nowrap .dv-unified .dv-row{grid-template-columns:44px 44px 20px minmax(max-content,1fr)}.dv-nowrap .dv-split{min-width:calc(var(--dv-code-width,480px)*2)}.dv-nowrap .dv-code{white-space:pre}.dv-add{background:var(--dv-add-bg)}.dv-del{background:var(--dv-del-bg)}.dv-add .dv-sign{color:var(--dv-green)}.dv-del .dv-sign{color:var(--dv-red)}.dv-blank{background:var(--dv-surface)}.dv-word{color:inherit;border-radius:2px;padding:0}.dv-add .dv-word{background:var(--dv-add-word)}.dv-del .dv-word{background:var(--dv-del-word)}.dv-notice-line{padding:4px 12px;color:var(--dv-muted);font-style:italic;overflow-wrap:anywhere}
.dv-pagination{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:8px 16px;border-bottom:1px solid var(--dv-border);gap:8px;color:var(--dv-muted)}.dv-pagination small{flex-basis:100%}.dv-comments{padding:8px 16px 16px}.dv-comments>summary{font-weight:600}.dv-comment-list{max-height:320px;overflow-y:auto}.dv-comment{border-bottom:1px solid var(--dv-border);padding:8px 0}.dv-comment header{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.dv-comment header strong{overflow-wrap:anywhere;min-width:0}.dv-comment header>.dv-toolbar{margin-left:auto}.dv-comment-body{white-space:pre-wrap;overflow-wrap:anywhere;padding:8px 0}.dv-feedback{margin-top:12px}.dv-feedback p{margin:8px 0}.dv-feedback button{margin-top:8px}
.dv-app .dv-dialog{color:var(--dv-ink);background:var(--dv-bg);border:1px solid var(--dv-border);border-radius:8px;width:min(540px,calc(100vw - 32px));max-height:calc(100dvh - 32px);padding:20px}.dv-dialog::backdrop{background:rgb(0 0 0 / .4)}.dv-dialog h2{font-size:16px;margin-bottom:12px}.dv-dialog p{margin:8px 0;overflow-wrap:anywhere}.dv-dialog pre{max-height:160px;overflow-y:auto}.dv-dialog-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:16px}.dv-app .dv-primary{background:var(--dv-ink);color:var(--dv-bg);border-color:var(--dv-ink)}.dv-app .dv-primary:hover:not(:disabled){background:var(--dv-muted)}.dv-target{display:grid;grid-template-columns:80px minmax(0,1fr);padding:12px 0;margin:0;gap:8px}.dv-target dt{color:var(--dv-muted)}.dv-target dd{margin:0;overflow-wrap:anywhere}.dv-app .dv-editor-label{display:grid;gap:8px}.dv-anchor{font-weight:600;overflow-wrap:anywhere}
.dv-code .hljs-keyword,.dv-code .hljs-selector-tag{color:#8951aa}.dv-code .hljs-string,.dv-code .hljs-attr{color:#176d59}.dv-code .hljs-number,.dv-code .hljs-literal{color:#925423}.dv-code .hljs-title,.dv-code .hljs-built_in{color:#286ca6}.dv-code .hljs-comment{color:#687481}.dv-app[data-base=dark] .hljs-keyword,.dv-app[data-base=dark] .hljs-selector-tag{color:#cda5ea}.dv-app[data-base=dark] .hljs-string,.dv-app[data-base=dark] .hljs-attr{color:#9bd5be}.dv-app[data-base=dark] .hljs-number,.dv-app[data-base=dark] .hljs-literal{color:#ecc49a}.dv-app[data-base=dark] .hljs-title,.dv-app[data-base=dark] .hljs-built_in{color:#9dcaff}.dv-app[data-base=dark] .hljs-comment{color:#a3afbd}
@keyframes dv-reveal{from{opacity:.5;transform:translateY(3px)}to{opacity:1;transform:translateY(0)}}@media(max-width:720px){.dv-workspace{grid-template-columns:minmax(0,1fr);grid-template-rows:160px minmax(0,1fr)}.dv-files{border-right:0;border-bottom:1px solid var(--dv-border)}.dv-file-search{display:flex;align-items:center;padding:8px 12px}.dv-file-search input{flex:1;width:100%}.dv-file-list{display:flex;align-items:stretch;overflow:auto}.dv-app .dv-file{width:220px;flex:0 0 220px;border-right:1px solid var(--dv-border)}.dv-top{padding:8px 12px}.dv-heading{margin-bottom:8px}.dv-repo-toolbar>label{flex:1 1 100%}.dv-repo-toolbar>label select{flex:1}.dv-heading .dv-toolbar label{font-size:12px}.dv-row{grid-template-columns:34px 34px 16px minmax(0,1fr)}.dv-side{grid-template-columns:34px 16px minmax(0,1fr)}.dv-wrap .dv-code{font-size:11px}}@media(prefers-reduced-motion:reduce){.dv-hunk{animation:none}}
`;

// src/renderer/native-review-adapter.ts
import React3 from "react";
import { createRoot } from "react-dom/client";

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
async function loadPinnedModules() {
  const scripts = Array.from(document.querySelectorAll('script[type="module"][src]')).map((script) => script.src);
  const urls = pinnedModuleUrls(document.location.href, scripts);
  const main = await import(
    /* @vite-ignore */
    urls.main
  );
  const transcript = await import(
    /* @vite-ignore */
    urls.transcript
  );
  return { store: main.R, parse: main.bp, records: main.au, tab: main.V, component: transcript.R, hostReact: main.r };
}
function nativeDisplayDto(presentation) {
  if (!presentation.id || !presentation.path || presentation.path.length > 4096 || presentation.hunks.length > 20 || presentation.hunks.reduce((n, h) => n + h.lines.length, 0) > 100 || !Number.isSafeInteger(presentation.additions) || presentation.additions < 0 || !Number.isSafeInteger(presentation.deletions) || presentation.deletions < 0) denied("NATIVE_DISPLAY_LIMIT", "Invalid or oversized native presentation");
  const dto = {
    id: `diff-view-display:${presentation.id}`,
    role: "tool",
    toolName: "Write",
    toolStatus: "success",
    // root is a rendering discriminator required by the internal component, NOT an authorization claim.
    toolResult: { details: { root: "workspace", pluginPresentation: { owner: "local.diff-view", origin: presentation.origin, demo: presentation.demo === true }, review: { version: 1, snapshotId: `diff-view-display:${presentation.id}`, messageId: `diff-view-display:${presentation.id}`, path: presentation.path, operation: "write", status: "modified", state: "active", additions: presentation.additions, deletions: presentation.deletions, hunks: presentation.hunks, reversible: false } } }
  };
  if (new TextEncoder().encode(JSON.stringify(dto)).length > 3e4) denied("NATIVE_DISPLAY_LIMIT", "Native display exceeds 30 KiB");
  return dto;
}
function createNativeReviewAdapter(options) {
  class NativeDisplayBoundary extends React3.Component {
    state = { failed: false };
    static getDerivedStateFromError() {
      return { failed: true };
    }
    componentDidCatch(error) {
      this.props.onError(error);
    }
    render() {
      return this.state.failed ? React3.createElement("p", { role: "alert" }, "Native component failed") : this.props.children;
    }
  }
  let closed = false, modules, pending;
  let mount;
  const unmount = () => {
    const current = mount;
    mount = void 0;
    if (current) {
      current.stop();
      current.root.unmount();
      current.element.remove();
    }
  };
  let probing = false;
  const alive = () => {
    if (closed) denied("NATIVE_UNLOADED", "Native adapter unloaded");
  };
  const inspect = async () => {
    alive();
    if (modules) return modules;
    if (!pending) pending = (async () => {
      const info = await options.info();
      alive();
      if (!info.supported || !matchesNativeBuild(info.version, info.hashes)) denied("NATIVE_BUILD", info.reason ?? "Host version/build is not supported");
      const result = await (options.load ?? loadPinnedModules)();
      alive();
      if (typeof result.store?.getState !== "function" || typeof result.store?.subscribe !== "function" || typeof result.parse !== "function" || typeof result.records !== "function" || typeof result.tab !== "function" || !result.component || result.hostReact?.createElement !== React3.createElement || result.hostReact?.useState !== React3.useState) denied("NATIVE_CONTRACT", "Native exports or React identity changed");
      const state = result.store.getState();
      if (typeof state.openWorkPanelTabForSession !== "function" || !Array.isArray(state.messages) || result.tab("review").kind !== "review" || result.tab("review").id !== "review") denied("NATIVE_CONTRACT", "Native work-panel contract changed");
      modules = result;
      return result;
    })();
    return pending;
  };
  const guard = (sessionId, native) => {
    alive();
    const state = native.store.getState();
    if (!sessionId || state.activeSessionId !== sessionId || state.selectingSessionId) denied("NATIVE_SESSION", "Session changed; no old-session review was opened");
    return state;
  };
  const isReview = (sessionId, native) => {
    const s = native.store.getState();
    return !closed && s.activeSessionId === sessionId && !s.selectingSessionId && s.workPanelOpen && s.activeWorkPanelTabId === "review";
  };
  const pane = () => document.querySelector('#work-panel-surface-review.work-panel-tabpane[role="tabpanel"]');
  const wait = async (sessionId, native, predicate) => {
    const end = Date.now() + 2e3;
    while (Date.now() < end) {
      guard(sessionId, native);
      if (!isReview(sessionId, native)) denied("NATIVE_CLOSED", "Review tab was closed or changed");
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    denied("NATIVE_SURFACE", "Expected native review surface was not rendered");
  };
  const locate = (native, reference, sessionId) => {
    const state = guard(sessionId, native);
    const records = native.records(state.messages), index = records.findIndex((record) => record.change.snapshotId === reference.snapshotId && record.change.messageId === reference.messageId && record.change.path === reference.path);
    if (index < 0 || records.filter((record) => record.change.snapshotId === reference.snapshotId).length !== 1) denied("NATIVE_RECORD", "Native snapshot is missing or ambiguous; nothing was guessed");
    const headers = pane()?.querySelectorAll(".review-scroll > section.review-change-card > button.review-change-card-header");
    const header = headers?.[index];
    if (!header || header.querySelector(".review-change-card-path")?.getAttribute("title") !== reference.path) denied("NATIVE_ANCHOR", "Native snapshot/DOM order no longer matches this build");
    if (header.getAttribute("aria-expanded") === "false") header.click();
    header.scrollIntoView({ block: "nearest" });
    return header;
  };
  const show = async (native, sessionId, presentation) => {
    guard(sessionId, native);
    unmount();
    const surface = pane();
    if (!surface || !isReview(sessionId, native)) denied("NATIVE_SURFACE", "Native review tab is not visible");
    const scroll = surface.querySelector(".review-scroll");
    if (!scroll) denied("NATIVE_SURFACE", "Pinned native review list is missing");
    const message = nativeDisplayDto(presentation), parsed = native.parse(message);
    if (!parsed || parsed.snapshotId !== `diff-view-display:${presentation.id}` || parsed.path !== presentation.path) denied("NATIVE_CONTRACT", "Native parser rejected isolated display DTO");
    const element = document.createElement("section");
    element.dataset.diffViewNativeSupplement = presentation.id;
    element.style.cssText = "padding:12px;border-top:1px solid color-mix(in srgb,currentColor 14%,transparent);max-height:320px;overflow:auto;min-height:64px";
    scroll.append(element);
    const root = createRoot(element);
    let stopped = false;
    let renderError;
    const unsubscribe = native.store.subscribe(() => {
      if (!isReview(sessionId, native)) unmount();
    });
    const observer = new MutationObserver(() => {
      if (!element.isConnected || !isReview(sessionId, native)) unmount();
    });
    observer.observe(surface.parentElement ?? surface, { childList: true, subtree: true });
    const stop = () => {
      if (!stopped) {
        stopped = true;
        unsubscribe();
        observer.disconnect();
      }
    };
    mount = { element, root, stop };
    root.render(React3.createElement(
      React3.Fragment,
      null,
      React3.createElement("p", null, presentation.demo ? "\u5DE5\u4F5C\u533A\u5916\u6587\u4EF6\u6F14\u793A / External-file demo \u2014 \u4EC5\u9A8C\u8BC1\u539F\u751F\u7EC4\u4EF6\uFF0C\u4E0D\u662F\u804A\u5929\u8BB0\u5F55\u6216\u771F\u5B9E\u91C7\u96C6 / not a transcript record or capture" : `\u63D2\u4EF6\u8BB0\u5F55 / Plugin capture \u2014 ${presentation.origin === "external" ? "\u5DE5\u4F5C\u533A\u5916 / outside workspace" : "workspace"}`),
      React3.createElement(NativeDisplayBoundary, { onError: (error) => {
        renderError = error;
      }, children: React3.createElement(native.component, { message, compact: true }) }),
      React3.createElement("button", { type: "button", onClick: unmount }, "\u79FB\u9664\u6F14\u793A / Remove display")
    ));
    try {
      await wait(sessionId, native, () => {
        if (renderError) denied("NATIVE_RENDER", `Native component failed: ${renderError.message.slice(0, 200)}`);
        return !!element.querySelector("button.review-change-card-header");
      });
      const header = element.querySelector("button.review-change-card-header");
      if (header.getAttribute("aria-expanded") === "false") header.click();
      await wait(sessionId, native, () => {
        if (renderError) denied("NATIVE_RENDER", `Native component failed: ${renderError.message.slice(0, 200)}`);
        return !!element.querySelector(".review-change-diff");
      });
      element.scrollIntoView({ block: "nearest" });
      await wait(sessionId, native, () => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
      });
      if (element.querySelector(".review-change-rollback")) denied("NATIVE_READONLY", "Display unexpectedly exposed a rollback action");
      return element;
    } catch (error) {
      unmount();
      throw error;
    }
  };
  return {
    inspect,
    async probe(sessionId, workspacePath, presentation) {
      alive();
      if (probing) denied("NATIVE_BUSY", "A native preflight is already running");
      probing = true;
      try {
        const native = await inspect(), state = guard(sessionId, native);
        const candidates = native.records(state.messages).filter((record) => record.change.path === workspacePath);
        if (state.isRunning) denied("NATIVE_RUNNING", "Wait until the Agent finishes before running the native preflight");
        if (candidates.length !== 1) denied("NATIVE_RECORD", "Exactly one current native record for the preflight file is required");
        native.store.getState().openWorkPanelTabForSession(sessionId, native.tab("review"));
        await wait(sessionId, native, () => !!pane()?.querySelector(".review-scroll > section.review-change-card"));
        const header = locate(native, candidates[0].change, sessionId);
        await wait(sessionId, native, () => header.getAttribute("aria-expanded") === "true" && !!header.parentElement?.querySelector(".review-change-card-body"));
        const element = await show(native, sessionId, presentation);
        guard(sessionId, native);
        return { opened: true, located: true, externalRendered: !!element.querySelector(".review-change-diff"), readonly: !element.querySelector(".review-change-rollback"), sessionGuard: true };
      } finally {
        probing = false;
      }
    },
    close() {
      closed = true;
      unmount();
      modules = void 0;
    }
  };
}

// src/renderer/index.tsx
import { Fragment as Fragment2, jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
var hub = null;
var realm2 = globalThis;
var disposers = [];
var layers = /* @__PURE__ */ new Set();
var css2 = `${styles_default}
.dv-reply{display:flex;align-items:center;flex-wrap:wrap;gap:8px;border-top:1px solid color-mix(in srgb,currentColor 16%,transparent);padding:8px 0;font:12px/1.45 system-ui}.dv-reply button,.dv-composer{font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 24%,transparent);border-radius:4px;padding:4px 8px;cursor:pointer}.dv-reply button:hover,.dv-composer:hover{background:color-mix(in srgb,currentColor 8%,transparent)}.dv-reply button:focus-visible,.dv-composer:focus-visible{outline:2px solid #8cb9ff;outline-offset:2px}.dv-composer:disabled{opacity:.5;cursor:not-allowed}.dv-layer{position:fixed;inset:0;padding:24px;background:rgb(0 0 0 / .4);display:grid;place-items:stretch;z-index:1}.dv-layer-inner{min-width:0;min-height:0;border:1px solid #616b77;border-radius:8px;box-shadow:0 8px 32px rgb(0 0 0 / .2)}.dv-layer .dv-app{height:100%;min-height:0;border-radius:8px}.dv-layer-error{color:#b02c35;padding:8px;font:12px system-ui}@media(max-width:720px){.dv-layer{padding:8px}}`;
function same(current) {
  return Boolean(current && current === hub && !current.disposed);
}
async function poll(current) {
  if (!same(current)) return;
  try {
    const data = await current.transport.invoke("bootstrap");
    if (!same(current)) return;
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
  } catch {
  } finally {
    if (same(current)) current.timer = setTimeout(() => void poll(current), 6e3);
  }
}
function useBootstrap(current) {
  const [boot, setBoot] = useState2(current?.bootstrap ?? null);
  useEffect2(() => {
    if (!same(current)) return;
    setBoot(current.bootstrap);
    current.listeners.add(setBoot);
    return () => {
      current.listeners.delete(setBoot);
    };
  }, [current]);
  return boot;
}
function openReview(current, run) {
  if (!same(current)) return;
  const sessionId = run?.sessionId ?? current.activeSession;
  const layer = current.host.ui.openLayer();
  let mounted = true;
  let root = null;
  const previous = document.activeElement;
  const close = () => {
    if (!mounted) return;
    mounted = false;
    root?.unmount();
    layer.close();
    layers.delete(close);
    previous?.focus();
  };
  const transport = { invoke: current.transport.invoke, ...sessionId ? { insertText(text) {
    if (!mounted || !same(current) || current.activeSession !== sessionId) return Promise.reject(new Error("Composer session changed / \u7F16\u8F91\u5668\u4F1A\u8BDD\u5DF2\u5207\u6362\u3002"));
    return current.host.dispatch("composer.insertText", { text });
  } } : {} };
  function Layer() {
    const boot = useBootstrap(current);
    const shell = useRef2(null);
    useEffect2(() => {
      shell.current?.querySelector("button,select")?.focus();
    }, []);
    return /* @__PURE__ */ jsx3("div", { className: "dv-layer", ref: shell, role: "dialog", "aria-modal": "true", "aria-label": messages(boot?.locale ?? "zh-CN").title, onKeyDown: (event) => {
      if (event.defaultPrevented || event.target.closest("dialog")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
      if (event.key === "Tab") {
        const controls = Array.from(shell.current?.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]') ?? []).filter((el) => el.getClientRects().length > 0);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    }, children: /* @__PURE__ */ jsx3("div", { className: "dv-layer-inner", children: /* @__PURE__ */ jsx3(ReviewApp_default, { transport, initialRequest: run ? { scope: "turn", root: run.root, sessionId, runId: run.id } : { scope: "unstaged", sessionId }, locale: boot?.locale, base: boot?.base, onClose: close }) }) });
  }
  layers.add(close);
  root = createRoot2(layer.element);
  root.render(/* @__PURE__ */ jsx3(Layer, {}));
}
function EntryExtra(props) {
  const current = hub;
  const boot = useBootstrap(current);
  const t = messages(boot?.locale ?? "zh-CN");
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
  if (!run || !same(current)) return null;
  return /* @__PURE__ */ jsxs3("div", { className: "dv-reply", children: [
    /* @__PURE__ */ jsxs3("span", { children: [
      t.files,
      ": ",
      run.fileCount
    ] }),
    /* @__PURE__ */ jsxs3("span", { children: [
      t[run.state],
      run.incomplete ? ` \xB7 ${t.incomplete}` : ""
    ] }),
    /* @__PURE__ */ jsx3("button", { onClick: () => openReview(current, run), children: t.title })
  ] });
}
function ComposerControl() {
  const current = hub;
  const boot = useBootstrap(current);
  const [error, setError] = useState2("");
  const [busy, setBusy] = useState2(false);
  const mounted = useRef2(true);
  const [probeStatus, setProbeStatus] = useState2("");
  useEffect2(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const t = messages(boot?.locale ?? "zh-CN");
  return /* @__PURE__ */ jsxs3(Fragment2, { children: [
    /* @__PURE__ */ jsx3("button", { className: "dv-composer", disabled: busy || !same(current), title: t.title, onClick: () => {
      if (!same(current)) return;
      setBusy(true);
      setError("");
      try {
        openReview(current);
      } catch (err) {
        if (mounted.current) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mounted.current) setBusy(false);
      }
    }, children: busy ? t.loading : t.title }),
    boot?.settings.nativePreflight && /* @__PURE__ */ jsx3("button", { className: "dv-composer", disabled: busy || !same(current) || !current.activeSession, onClick: () => {
      if (!same(current) || !current.native || !current.activeSession) return;
      const sessionId = current.activeSession;
      setBusy(true);
      setProbeStatus("\u9A8C\u8BC1\u4E2D / Checking native integration\u2026");
      current.native.probe(sessionId, "docs/native-preflight-fixture.txt", { id: "preflight-demo", path: "[\u5916\u90E8\u6587\u4EF6\u6F14\u793A / render-only] native-preflight-external.txt", origin: "external", demo: true, additions: 1, deletions: 1, hunks: [{ header: "@@ -1,1 +1,1 @@", lines: [{ type: "del", text: "native preflight before" }, { type: "add", text: "native preflight after" }] }] }).then((result) => {
        if (mounted.current && same(current) && current.activeSession === sessionId) setProbeStatus(`\u539F\u751F\u9884\u68C0 / Native preflight: ${JSON.stringify(result)}\u3002\u8BF7\u4EBA\u5DE5\u6838\u5BF9\u4FA7\u680F\uFF1B\u6F14\u793A\u4E0D\u662F\u5B9E\u9645\u91C7\u96C6\u3002`);
      }).catch((err) => {
        if (mounted.current && same(current)) setProbeStatus(`\u539F\u751F\u9884\u68C0\u672A\u901A\u8FC7 / Failed: ${String(err?.code ?? "NATIVE_IMPORT")} ${err instanceof Error ? err.message : String(err)}`);
      }).finally(() => {
        if (mounted.current && same(current)) setBusy(false);
      });
    }, children: "\u539F\u751F\u5BA1\u9605\u9884\u68C0 / Native preflight" }),
    probeStatus && /* @__PURE__ */ jsx3("span", { className: "dv-layer-error", role: "status", style: { whiteSpace: "pre-wrap" }, children: probeStatus }),
    error && /* @__PURE__ */ jsx3("span", { className: "dv-layer-error", role: "alert", children: error })
  ] });
}
function onLoad(pi) {
  realm2.__piDiffRenderer?.dispose();
  onUnload();
  const transport = ensureBounded({ invoke(method, args) {
    if (!same(current)) return Promise.reject(new Error("Renderer unloaded / \u6E32\u67D3\u6269\u5C55\u5DF2\u5378\u8F7D\u3002"));
    return pi.dispatch("plugin.call", { method, args });
  } });
  const current = { host: pi, transport, disposed: false, bootstrap: null, listeners: /* @__PURE__ */ new Set(), cards: /* @__PURE__ */ new Map(), cursor: 0 };
  hub = current;
  current.native = createNativeReviewAdapter({ info: () => transport.invoke("nativeProbeInfo") });
  realm2.__piDiffRenderer = { hub: current, dispose: onUnload };
  current.unsubscribeDraft = pi.composer.subscribeDraft((draft) => {
    if (!same(current)) return;
    const previous = current.activeSession;
    current.activeSession = draft?.sessionId;
    if (previous && previous !== current.activeSession) for (const dispose of [...layers]) dispose();
  });
  disposers.push(pi.ui.injectStyle(css2));
  disposers.push(pi.slots.register({ slot: "entryExtra", component: EntryExtra }));
  disposers.push(pi.slots.register({ slot: "composerControl", component: ComposerControl, positions: ["right"] }));
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
  }
  current?.native?.close();
  for (const dispose of [...layers]) dispose();
  for (const dispose of disposers.splice(0).reverse()) dispose();
  if (realm2.__piDiffRenderer?.hub === current) delete realm2.__piDiffRenderer;
  hub = null;
}
export {
  onLoad,
  onUnload
};
