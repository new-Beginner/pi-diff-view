# 1.4.6：文件行图标打开 PI-Desktop 文件管理器

## 修复范围

- 文件行倒数第二个图标现在打开对应的当前磁盘文件，目标固定为 `pi.file-manager/manager`，不再选择或展开差异。
- 文件名点击、菜单“展开文件”、折叠、复制、历史差异与本地 Git 行为保留。
- 仅按后端审阅文件 ID 解析路径，不接收任意路径；拒绝缺失文件、链接、私有路径及跨会话请求。
- 打开请求仅存在内存中，经既有 renderer 刷新响应交付一次，最长等待 10 秒；不新增定时器或权限。正常交付依赖现有约 2 秒刷新周期，不承诺零延迟。
- 文件管理器必须已启用。无法打开时在审阅界面显示错误，不回退到展开差异或系统默认应用。

## 证据 → 修复 → 代码路径

| 证据 | 修复 | 路径 |
|---|---|---|
| 原图标标题为“展开文件”，点击调用本地展开函数 | 改为文件管理器请求，标题与动作一致 | `src/view/ReviewApp.tsx` |
| 宿主使用文件管理器插件页签与 `location` 路径 | 复用既有宿主适配器，检查当前会话与视图契约 | `src/renderer/plugin-review-adapter.ts` |
| 面板与 renderer 隔离，没有跨插件打开的公开面板 SDK | 复用 `replyCards` 响应交付一次性请求与回执，不改宿主 | `src/core/file-open.ts`、`src/main.ts`、`src/renderer/index.tsx` |

## 已执行验证

- `npm run typecheck`：通过。
- `npm test`：309 通过、1 跳过（Windows 上不适用的 POSIX FIFO 用例）。
- 新增/扩展路径、会话隔离、请求回执、页签适配器测试，定向复测 21 项通过。
- `E2E_BROWSER='C:/Program Files/Google/Chrome/Application/chrome.exe' npm run test:e2e`：114 项全部通过，包含打开图标不展开差异、错误显示和原有菜单/Git/侧栏更新行为。
- 无可见回复卡片的 renderer 检查：准确打开一次、回传成功、卸载清理通过。该检查使用模拟宿主，不是原生窗口验收。
- `npm run build`、`git diff --check`、`git diff --cached --exit-code`：通过。

## 部署边界

版本元数据推进至 1.4.6。未自动安装、reload 或授权；未修改宿主记录或本项目 Git 暂存内容。实际 PI-Desktop 窗口点击验收未执行，需手动 reload 本地目录插件或安装新版包后确认；浏览器回归不替代原生宿主验收。
