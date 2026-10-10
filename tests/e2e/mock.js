// Browser-only, explicitly labelled demo data. No actual PI-Desktop backend is used.
(() => {
  const params = new URLSearchParams(location.search);
  const scenario = params.get('scenario') || 'standard';
  const listeners = new Map();
  const root = 'D:/projects/diff-view';
  const run = { id: 'run-demo', root, sessionId: 'session-demo', startedAt: 1750000000000, endedAt: 1750000060000, state: 'completed', fileCount: 4, incomplete: false, prompt: 'Add review context controls' };
  const makeFile = (id, path, extra = {}) => ({ id, path, status: 'modified', kind: 'text', additions: 3, deletions: 2, fingerprint: `version-${id}`, actions: ['stage', 'revert'], ...extra });
  const files = [
    makeFile('review', 'src/review/index.ts'),
    makeFile('created', 'src/theme/index.ts', { status: 'added', additions: 3, deletions: 0 }),
    makeFile('long', 'src/generated/long.ts', { additions: 1000, deletions: 1000 }),
    makeFile('renamed', 'src/new-name.ts', { status: 'renamed', oldPath: 'src/old-name.ts' }),
    makeFile('binary', 'assets/logo.png', { kind: 'binary', additions: 0, deletions: 0, actions: [] }),
    makeFile('missing', 'src/historical.ts', { kind: 'unavailable', actions: [], note: 'Demo: snapshot missing / 演示：快照缺失' }),
    ...['large', 'symlink', 'submodule', 'conflict'].map(kind => makeFile(kind, `special/${kind}`, { kind, actions: [] }))
  ];
  const line = (kind, text, oldLine, newLine) => ({ kind, text, oldLine, newLine });
  const hunk = (id, oldStart, newStart, lines) => ({ id, oldStart, newStart, oldLines: lines.filter(l => l.oldLine != null).length, newLines: lines.filter(l => l.newLine != null).length, header: `@@ -${oldStart},3 +${newStart},4 @@`, lines });
  const hunksFor = (fileId, context) => {
    if (fileId === 'long') {
      const lines = [];
      for (let i = 1; i <= 1000; i++) { lines.push(line('del', `const value${i} = "old";`, i, null), line('add', `const value${i} = "new";`, null, i)); }
      return [hunk('0:1:1', 1, 1, lines)];
    }
    if (fileId === 'created') return [hunk('0:0:1', 0, 1, [line('add', 'export const theme = {', null, 1), line('add', '  base: "light",', null, 2), line('add', '};', null, 3)])];
    if (files.find(f => f.id === fileId)?.kind !== 'text') return [];
    const first = hunk('0:1:1', 1, 1, [line('context', 'export function review() {', 1, 1), line('del', '  const context = 3;', 2, null), line('add', '  const context = 20;', null, 2), line('add', '  const wrap = true;', null, 3), line('context', '  return context;', 3, 4), line('context', '}', 4, 5)]);
    const second = hunk('1:60:61', 60, 61, [line('del', `const description = "${'long line '.repeat(80)}old";`, 60, null), line('add', `const description = "${'long line '.repeat(80)}new";`, null, 61), line('notice', '\\ No newline at end of file', null, null)]);
    if (context !== 3) return [hunk('0:1:1-expanded', 1, 1, [...first.lines, ...Array.from({ length: context === -1 ? 140 : 20 }, (_, i) => line('context', `// Additional context ${i + 1}`, i + 5, i + 6)), ...second.lines])];
    return [first, second];
  };
  const state = window.__demo = { calls: [], comments: [], failFile: scenario === 'file-error', conflict: scenario === 'conflict', stale: scenario === 'stale', settings: { layout: 'unified', wordWrap: true }, review: null, runs: [run], appearance: { locale: params.get('lang') || 'en', base: params.get('base') || 'light' }, changeAppearance(value) { this.appearance = value; listeners.get('appearance:changed')?.(value); } };
  const jobs = new Map();
  window.pluginBridge = {
    on(event, callback) { listeners.set(event, callback); return () => listeners.delete(event); },
    async invoke(method, args = {}, internal = false) {
      if (!internal) state.calls.push({ method, args, at: Date.now() });
      if (method === 'app.getAppearance') return state.appearance;
      if (method === 'diff.jobStart') {
        const jobId = `job-${jobs.size + 1}`, job = { state: 'pending' }; jobs.set(jobId, job);
        // Background work is intentionally not part of the short bridge round trip.
        window.pluginBridge.invoke(`diff.${args.method}`, args.args || {}, true).then(result => Object.assign(job, { state: 'done', result: result ?? null }), error => Object.assign(job, { state: 'error', error: { code: 'DEMO_ERROR', message: error.message } }));
        return { jobId };
      }
      if (method === 'diff.jobPoll') return jobs.get(args.jobId);
      if (internal) state.calls.push({ method, args, at: Date.now(), internal: true });
      await new Promise(resolve => setTimeout(resolve, scenario === 'slow' ? 800 : scenario === 'long-job' && ['diff.bootstrap', 'diff.review'].includes(method) ? 2300 : 20));
      if (method === 'diff.bootstrap') {
        if (scenario === 'boot-error') throw new Error('Demo bridge denied access');
        return { repositories: scenario === 'no-roots' ? [] : [{ root, name: 'diff-view', git: true, branch: 'main' }], runs: scenario === 'no-roots' ? [] : state.runs, locale: state.appearance.locale, base: state.appearance.base, settings: state.settings };
      }
      if (method === 'diff.review') {
        const mapped = args.scope === 'staged' || scenario === 'empty' ? [] : files.map(file => ({ ...file, fingerprint: state.stale ? `${file.fingerprint}-changed` : file.fingerprint, actions: ['turn', 'lastTurn'].includes(args.scope) ? file.kind === 'text' ? ['revert'] : [] : ['commit', 'branch'].includes(args.scope) ? [] : file.actions }));
        state.review = { id: `review-${state.calls.length}`, root, scope: args.scope, sessionId: args.sessionId, runId: args.runId, files: mapped, notice: 'Demo data · mocked backend / 演示数据 · 模拟后端' }; return state.review;
      }
      if (method === 'diff.file') {
        if (state.failFile) { state.failFile = false; throw new Error('Demo file request failed; retry is safe'); }
        const all = hunksFor(args.fileId, args.context); const totalRows = all.reduce((sum, h) => sum + h.lines.length, 0);
        const page = []; let cursor = 0, taken = 0;
        for (const h of all) { const lines = h.lines.filter(() => cursor++ >= args.offset && taken < args.limit && ++taken > 0); if (lines.length) page.push({ ...h, lines }); }
        return { file: state.review.files.find(f => f.id === args.fileId), hunks: page, offset: args.offset, totalRows, nextOffset: args.offset + taken < totalRows ? args.offset + taken : null };
      }
      if (method === 'diff.comments') return state.comments.map(comment => ({ ...comment, stale: state.stale }));
      if (method === 'diff.saveComment') { const comment = { ...args, id: args.id || `comment-${state.comments.length + 1}`, createdAt: Date.now(), updatedAt: Date.now() }; state.comments = [...state.comments.filter(c => c.id !== comment.id), comment]; return comment; }
      if (method === 'diff.deleteComment') { state.comments = state.comments.filter(c => c.id !== args.id); return; }
      if (method === 'diff.feedback') return { text: (!state.stale ? state.comments.map(c => `${c.anchor.path}:${c.anchor.side}:${c.anchor.line}\n${c.body}`).join('\n\n') : '') || '请审查当前所选差异，给出有证据的优先级问题列表；先不要修改文件。' };
      if (method === 'diff.action') { if (args.confirmed !== true) throw new Error('Confirmation required'); if (state.conflict) return { ok: false, message: 'Demo FILE_CONFLICT: version changed.' }; return { ok: true, message: 'Demo operation completed' }; }
      if (method === 'diff.batchAction') return { results: args.targets.map((target, i) => ({ path: files.find(file => file.id === target.fileId).path, ok: i !== 1, message: i === 1 ? 'Demo FILE_CONFLICT: changed file' : 'Demo operation completed' })) };
      if (method === 'diff.copyPatch') return { ok: true };
      if (method === 'diff.settings') { Object.assign(state.settings, args); return; }
      if (method === 'diff.clearHistory') { if (!args.confirmed) throw new Error('Confirmation required'); state.runs = []; state.comments = []; return; }
      if (method === 'diff.card') return { run: args.messageId === 'reply-demo' ? run : null };
      if (method === 'diff.openPanel') return;
      throw new Error(`Unexpected mocked method: ${method}`);
    }
  };
})();
