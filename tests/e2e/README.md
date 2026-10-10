# 审阅 UI 浏览器验收

这些场景使用明确标注的演示数据和模拟桥接，不验证实际 PI-Desktop 主机、Git 写入或系统剪贴板。

```sh
npm run build                    # 由主代理负责生成 plugin 文件
npm run test:e2e
node scripts/serve-e2e.mjs        # http://127.0.0.1:8787
```

若 Playwright 对应版本浏览器未安装，可设置 `E2E_BROWSER` 为现有 Chromium/Chrome/Edge 可执行文件。`E2E_VIEW_DIR` 可指向临时编译的 views 目录，避免修改插件生成物。测试截图、失败 trace 均写入 `PI_SCRATCH_DIR/playwright-results`（未设置时使用系统临时目录），不写入项目。

可交互场景：
- `/`：新增文件与重复文件名路径、两块差异、长行、2,000 行分页、重命名、特殊非文本文件。
- `/?scenario=conflict`：确认暂存/撤销后返回版本冲突，不自动重试。
- `/?scenario=stale`：评论旧/新行，编辑、删除、过期提示、准备反馈。
- `/?scenario=file-error`：文件请求一次失败，可安全重试。
- `/?scenario=empty`、`no-roots`、`boot-error`、`slow`：空范围、缺少仓库、桥接错误、迟到响应隔离。
- `/?lang=zh-CN&base=dark`：中文深色；页面控制可切换语言与主题。

`review.spec.ts` 验证可达流程、3/20/full 上下文、80 行上限、行号、对齐、键盘焦点、360/760/1280px、减少动态效果、46px 主机高度只减一次、超过 2 秒的后台作业。`renderer.spec.ts` 在测试用 SDK 替身中验证共享轮询、entryExtra 绑定、composerControl 主窗口审查层、回复图层选中轮次、手势内同步插入预加载反馈、保留草稿、会话切换丢弃图层，以及卸载后的订阅/图层/样式/定时器清理。测试替身校验实际 renderer 方法白名单及 `openLayer().close` 契约。

实际主机仍需确认外部 React/import-map 与公开的 `composer.subscribeDraft` 回调结构；回调没有明确 `sessionId` 时插入会拒绝，而不是从 DOM 推断会话。上下文 full 使用后端支持的 `-1`；轮次恢复仅提供整文件操作。跨分页的词内比较只针对当前页可见的配对行，不请求完整文件或伪造不可用历史内容。
