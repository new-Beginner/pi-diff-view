# 审阅 UI 浏览器验收

证据分层：
- `review.spec.ts`：通用差异/Git 组件覆盖使用 `/review-component/`，直接挂载真实 `ReviewApp`，不经过生产 Panel，不改变其身份限制。测试服务器将专用入口 `review-harness.tsx` 编译到 scratch；不写入插件产物。末项导航竞态测试仍访问生产 Panel。
- `panel.spec.ts`：生产 Panel + 模拟桥接，验证无身份拒绝全局历史、两会话并行与迟到选择隔离、错误重试/返回本会话、本地 Git 往返。`mock.js` 的 selection 读取强制校验 sessionId。
- `renderer.spec.ts`、`renderer-entry.spec.ts`、`native-adapter.spec.ts`：renderer/适配器在模拟宿主中运行，不是原生宿主验收。
- `running.spec.ts`：模拟宿主 UI + 真实本地快照服务，不是原生联调。
- `git-management.spec.ts`：真实本地 Git 后端 + 独立组件，仓库仅创建在 scratch，不能据此宣称宿主插件安装或原生验收通过。

```sh
# 生产构建由主代理负责；也可用 E2E_VIEW_DIR 指向 scratch 中的 views 构建。
E2E_BROWSER='C:/Program Files/Google/Chrome/Application/chrome.exe' npm run test:e2e -- --workers=1
node scripts/serve-e2e.mjs
```

截图、失败 trace 写入 `PI_SCRATCH_DIR/playwright-results`（未设置时使用系统临时目录），不写项目截图目录。组件 harness 编译文件同样位于 scratch；生产视图默认从 `plugin/views` 读取。

入口：
- `/`：生产 Panel，无身份不展示会话历史；可独立进入本地 Git。
- `/?piViewOpen=diff-session%3Asession-demo%3FsessionId%3Dsession-demo`：带会话身份的生产 Panel。
- `/review-component/`：仅测试用的无会话通用组件，演示新增文件、重命名、特殊非文本状态、两块差异、2,000 行自动续载。
- `/review-component/?scenario=conflict`：确认操作后版本冲突，不自动重试。
- `/review-component/?scenario=file-error`：文件请求一次失败，可重试。
- `/review-component/?scenario=empty`、`no-roots`、`boot-error`、`slow`：空范围、缺少仓库、桥接错误、迟到响应。
- `/review-component/?lang=zh-CN&base=dark`：中文深色、实时语言与主题切换。

组件测试保留行号/对齐、词内差异、3/20/full 上下文、80 行分页、键盘焦点、360/760/1280px、减少动态效果、主机高度偏移、超过 2 秒后台作业、明确确认和失败不重试等实质断言。模拟剪贴板调用不能证明系统剪贴板已写入；原生 PI-Desktop 主机仍需独立验收。
