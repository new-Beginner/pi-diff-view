// Theme-only browser fixture. Every Git operation below is simulated; no filesystem or Git process.
(() => {
  const params = new URLSearchParams(location.search);
  const root = 'D:/演示项目/很长的授权工作区路径/本地差异审查/theme-demo';
  const longPath = 'src/very-long-directory-name/'.repeat(3) + '中文组件-configuration-with-a-long-name.tsx';
  const demo = window.__themeDemo = {
    longPath, root, calls: [], failNext: false, delay: 0,
    entries: [
      { path: '.env.private', index: '?', working: '?', blocked: 'Sensitive paths are excluded' },
      { path: 'credentials/secret.json', index: '?', working: '?', blocked: 'Sensitive paths are excluded' },
      { path: longPath, index: 'M', working: 'M' },
      { path: 'src/second.ts', index: ' ', working: 'M' },
      { path: 'linked/outside.ts', index: ' ', working: 'M', blocked: 'Symbolic links are not allowed' }
    ]
  };
  const bridge = window.pluginBridge, invoke = bridge.invoke.bind(bridge);
  bridge.invoke = async (method, args = {}, internal = false) => {
    if (method === 'app.getAppearance' && params.has('appearanceRace')) {
      const initial = { locale: 'zh-CN', base: 'light' };
      return new Promise(resolve => demo.resolveAppearance = () => resolve(initial));
    }
    if (method === 'diff.bootstrap' && !args.sessionId) {
      return { repositories: [{ root, name: '演示项目', git: true }, { root: root + '/other-project-with-a-long-name', name: '演示项目二', git: true }], runs: [], locale: 'zh-CN', base: window.__demo.appearance.base, settings: {} };
    }
    if (method === 'diff.review') {
      const review = await invoke(method, args, internal);
      if (review.files.length) review.files[0].path = `${args.sessionId || 'session-demo'}/${longPath}`;
      return review;
    }
    if (method !== 'diff.gitManage') return invoke(method, args, internal);
    demo.calls.push({ ...args });
    if (demo.delay) await new Promise(resolve => setTimeout(resolve, demo.delay));
    if (demo.failNext) { demo.failNext = false; throw new Error('演示错误：请求失败，请刷新后重试。'); }
    const status = () => ({ root: args.root || root, branch: '演示数据 · 模拟后端 · main', head: 'demo-head', entries: demo.entries });
    switch (args.operation) {
      case 'status': return status();
      case 'stats': return { entries: args.paths.map(path => ({ path, additions: 3, deletions: 2 })) };
      case 'branches': return { branches: [{ name: 'main', oid: 'demo-main', current: true }, { name: 'feature/' + 'long-branch-name-'.repeat(8), oid: 'demo-feature', current: false }], truncated: false };
      case 'history': return { commits: [{ oid: '0123456789abcdef', subject: '演示提交：' + '很长的提交标题与说明'.repeat(12), author: '演示用户', date: '2026-10-11' }], hasMore: false };
      case 'stashList': return { stashes: [{ ref: 'stash@{0}', oid: 'demo-stash', subject: '演示备份：' + 'stash-description-'.repeat(8) }], notice: 'Showing at most 100 stashes.' };
      case 'diff': case 'commitDiff': case 'blame': case 'stashShow': return { text: '演示数据 · 模拟后端\n--- before\n+++ after\n+' + 'long code '.repeat(100), truncated: false };
      case 'stage': demo.entries = demo.entries.map(entry => args.paths?.includes(entry.path) ? { ...entry, index: 'M', working: ' ' } : entry); break;
      case 'unstage': demo.entries = demo.entries.map(entry => args.paths?.includes(entry.path) ? { ...entry, index: ' ', working: 'M' } : entry); break;
      case 'commit': return { ok: true, oid: 'demo-commit' };
    }
    return { ok: true }; // Simulated confirmation only; never a real repository mutation.
  };
  if (params.get('mode') === 'git') {
    const observer = new MutationObserver(() => {
      const button = document.querySelector('.dv-panel-nav button:nth-child(2)');
      if (button) { observer.disconnect(); button.click(); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
