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
  const external = makeFile('external', 'D:/notes/review-summary.md', { origin: 'external', absolutePath: 'D:/notes/review-summary.md', actions: [], additions: 2, deletions: 1 });
  if (scenario === 'renderer') files.push(external);
  const turnFiles = [files[0], files[1], files[3], external];
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
  state.navigation = new Map();
  state.openLocation = path => listeners.get('view:open')?.({ path });
  const preview = (record = run) => ({ runId: record.id, sessionId: record.sessionId, fileCount: turnFiles.length, additions: turnFiles.reduce((n, file) => n + file.additions, 0), deletions: turnFiles.reduce((n, file) => n + file.deletions, 0), incomplete: false, files: turnFiles.slice(0, 3).map(file => ({ ...file, actions: [] })), offset: 0, nextOffset: 3 });
  state.replyBindings = new Map();
  const historyCount = Number(params.get('historyCards') || 0);
  if (historyCount) for (let i = 0; i < historyCount; i++) { const record = { ...run, id: `history-run-${i}` }; state.replyBindings.set(`history-${i}`, { messageId: `history-${i}`, run: record, summary: preview(record) }); }
  if (params.has('persisted')) state.replyBindings.set('reply-demo', { messageId: 'reply-demo', run, summary: preview() });
  const jobs = new Map();
  window.pluginBridge = {
    on(event, callback) { listeners.set(event, callback); return () => listeners.delete(event); },
    async invoke(method, args = {}, internal = false) {
      if (!internal) state.calls.push({ method, args, at: Date.now() });
      if (method === 'diff.activeReviewSession') { state.activeSession = args.sessionId; return { ok: true }; }
      if (method === 'app.getAppearance') return state.appearance;
      if (method === 'diff.rendererReport') return { ok: true };
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
        if (args.focusFileId) { const index = files.findIndex(file => file.id === args.focusFileId); if (index > 0) files.unshift(...files.splice(index, 1)); }
        const listed = scenario === 'renderer' && ['turn', 'lastTurn'].includes(args.scope) ? turnFiles : files;
        const mapped = args.scope === 'staged' || scenario === 'empty' ? [] : listed.map(file => ({ ...file, fingerprint: state.stale ? `${file.fingerprint}-changed` : file.fingerprint, actions: file.origin === 'external' ? [] : ['turn', 'lastTurn'].includes(args.scope) ? file.kind === 'text' ? ['revert'] : [] : ['commit', 'branch'].includes(args.scope) ? [] : file.actions }));
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
      if (method === 'diff.clearHistory') { if (!args.confirmed) throw new Error('Confirmation required'); state.runs = []; state.comments = []; state.replyBindings.clear(); return; }
      if (method === 'diff.turnSummary') { const offset = args.offset || 0, limit = args.limit || 3; return { runId: run.id, sessionId: run.sessionId, fileCount: turnFiles.length, additions: turnFiles.reduce((n, file) => n + file.additions, 0), deletions: turnFiles.reduce((n, file) => n + file.deletions, 0), incomplete: false, files: turnFiles.slice(offset, offset + limit), offset, nextOffset: offset + limit < turnFiles.length ? offset + limit : null }; }
      if (method === 'diff.selectTurn') { const previous = [...state.navigation.values()].find(item => item.sessionId === run.sessionId); const nonce = previous?.nonce || `00000000-0000-4000-8000-${String(state.navigation.size + 1).padStart(12, '0')}`; const selection = { nonce, revision: (previous?.revision || 0) + 1, sessionId: run.sessionId, request: { scope: 'turn', root, sessionId: run.sessionId, runId: args.runId || run.id }, fileId: args.fileId, at: Date.now() }; state.navigation.set(nonce, selection); return selection; }
      if (method === 'diff.readTurnSelection') { const selections = window.parent !== window ? window.parent.__demo.navigation : state.navigation; const selected = selections.get(args.nonce); if (!selected) throw new Error('Demo selection expired'); return selected; }
      if (method === 'diff.replyCards') {
        if (state.failFeed) throw new Error('Temporary feed failure');
        const all = args.sessionId === run.sessionId && state.runs.length ? [...state.replyBindings.values()] : [];
        const revision = `${state.runs.length}-${state.replyBindings.size}`, offset = args.offset || 0;
        const pending = !state.replyBindings.size && state.runs.length ? [Date.parse('2025-06-15T15:07:40.000Z') + (params.has('latestAtEnd') ? 11000 : 0)] : [];
        return { cards: args.revision === revision ? [] : all.slice(offset, offset + 20), revision, unchanged: args.revision === revision, nextOffset: args.revision !== revision && offset + 20 < all.length ? offset + 20 : null, pending, ...state.appearance };
      }
      if (method === 'diff.card') {
        if (args.messageId !== 'reply-demo') return { run: null };
        const card = { messageId: args.messageId, run, summary: preview() }; state.replyBindings.set(args.messageId, card);
        return { run, summary: card.summary };
      }
      if (method === 'diff.openPanel') return;
      throw new Error(`Unexpected mocked method: ${method}`);
    }
  };
})();
