# Diff view for PI-Desktop

面向 **PI-Desktop 0.17.0+** 的本地变更审查插件。按会话和用户轮次展示修改证据、文末卡片与运行浮窗；独立的本地 Git 页面用于人工审查和操作仓库。

**Version: 1.4.17（本地开发，未发布） · Plugin ID: `local.diff-view` · License: MIT**

源码：[new-Beginner/pi-diff-view](https://github.com/new-Beginner/pi-diff-view) · 安装包：[GitHub Releases](https://github.com/new-Beginner/pi-diff-view/releases/latest)。官方插件中心审核通过后公开上架：[plugins.aiuo.net](https://plugins.aiuo.net)。

当前仅做本地官方接口适配，不提交市场。会话与页签导航仍保留内部兼容接口和动态导入；尚未解决市场的动态模块加载拦截。已发布安装包仍为 1.4.16。

## 安装与使用

1. 从 GitHub Releases 下载 `local.diff-view-1.4.16.piplug`，在 PI-Desktop 插件页安装并手动批准所需权限。
2. 在会话右侧添加 **差异审查 / Diff view**，查看当前或历史轮次的文件修改。
3. 点击文件查看统一或并排差异，支持上下文、搜索、逐行评论和复制反馈；不会自动发送聊天。
4. **本地 Git** 是独立入口，支持工作区、暂存区、提交、分支、历史、blame 和 stash。不提供远程 Git 操作。
5. 本地开发可安装 `plugin/` 目录，构建后在插件页手动 reload。

## 权限与安全边界

**这是受信任的非沙箱本地插件。** Agent 和 renderer 扩展在宿主进程环境中运行。恢复文件、本地 Git 写入等操作由用户明确发起，并有确认与冲突检查；Git hooks/filters 是受信任的本地代码。应自行备份重要项目。

- 所需权限：`ui.panel`、`ui.view`、`agent.extension`、`renderer.extension`、`clipboard.write`。
- 不联网、不读取剪贴板、不执行远程 Git，不自动发送消息。
- 只读取已授权会话历史和原生变更证据进行本地恢复，不改写宿主历史记录。
- 文件采集排除凭据、私有目录和链接逃逸；无法确定的归属和缺失内容明确标记，不用当前磁盘内容伪造过去。
- 快照、去正文工具证据、评论和恢复副本存于插件私有数据目录。它们不属于项目源码或公开发布内容。
- 文本上限为 2 MiB/文件，捕获最多 256 个路径，历史最多 200 轮，快照容量 128 MiB。Shell 采集有扫描预算，不保证覆盖后台延迟写入或未知外部作者。
- 清理插件历史会删除历史证据和恢复副本，不影响项目源码和 Git 提交。
- 自动化界面测试使用模拟宿主桥接，不等同于完成原生客户端界面验收。

## 本地开发与验证

需要 Node.js 22.19+ 和 Git。

```bash
npm ci --ignore-scripts
npm run typecheck
npm test -- --maxWorkers=1
npm run build
npm run test:e2e
```

界面测试需要 Playwright Chromium，或通过 `E2E_BROWSER` 指定本机浏览器。可用 `PI_SCRATCH_DIR` 指定临时测试输出目录。

构建输出在 `plugin/`。在 PI-Desktop 中使用 **PluginCheck** 校验目录，然后使用 **PluginPack** 打包。不要手工 zip，安装器只接受 store-only `.piplug`。

## 本次版本

1.4.17 的运行浮窗优先使用官方 `pi.ui.openLayer()`，继承插件样式作用域和宿主安全暂停规则。只有旧宿主缺少此接口时才使用插件自己的兼容容器；公开接口拒绝会显示错误，不通过 DOM 回退绕过。会话跟随、任务身份、文末卡片、精确侧栏定位、PI 内置文件页签和 Git 功能保留。未新增权限；未发布、未提交市场、未自动安装。

### 官方接口适配边界

依据官方 [开发文档](https://github.com/vastsa/PI-Desktop/blob/a7a98ee051b1b35eb959830eabe0cebca3e39215/docs/plugin-development.md)、[API 规范](https://github.com/vastsa/PI-Desktop/blob/a7a98ee051b1b35eb959830eabe0cebca3e39215/docs/spec/07-plugins/03-plugin-api.md)和 [Renderer SDK](https://github.com/vastsa/PI-Desktop/blob/a7a98ee051b1b35eb959830eabe0cebca3e39215/packages/plugin-sdk/src/renderer.ts)核对，替换以保持原有行为为前提。

| 功能 | 本次处理 | 不强行替换的原因 |
| --- | --- | --- |
| 文末卡片、独立审查视图、桥接 | 保留已有官方 `entryExtra`、`contributes.views`、`plugin.call` / Panel bridge | 已使用公开接口，无需重复改造 |
| 运行浮窗挂载 | 改用官方 `ui.openLayer`，缺接口时使用带样式作用域的兼容节点 | 不覆盖宿主提供的接口拒绝或安全暂停 |
| 会话跟随和精确任务身份 | 保留现有兼容适配器及会话切换保护 | `session:activated` 尚属计划；草稿 `generation` 不是会话 ID |
| 会话证据恢复 | 保留有界、去正文证据链 | `getLlmContext` 仅限插件工具执行；`session.get/listMessages` 是插件自有导入会话读取，不等价于当前原生会话 |
| 实时运行状态 | 保留即时订阅 | `desktop.invoke(agent/getStatus)` 需要宽泛的 `desktop.control`，且不等价于精确用户消息与实时切换订阅 |
| 指定侧栏和 PI 内置文件页签 | 保留原定位、复用和跨会话保护 | 公开接口未提供同等导航；`fs.openDefault/reveal` 打开的是系统应用/文件管理器 |
| 原生审查适配器 | 保留源码但不启用 | 未找到公开组件接口；该未引用模块不进入当前 renderer 构建 |

输入框位置仍只读测量；没有公开矩形接口，不改宿主输入框 DOM，也不读取或修改草稿来猜会话。动态导入仍明确保留在兼容适配器中，未隐藏或混淆；本地功能适配不代表市场审核通过。

## English summary

Diff view provides session-isolated change history, reply cards, running-change indicators and a separate local Git management interface for PI-Desktop 0.17.0+. Install the `.piplug` from GitHub Releases and explicitly approve its permissions.

This is a trusted, unsandboxed local plugin. File restoration and Git writes require deliberate user actions and confirmations. Repository hooks and filters are trusted code. The plugin does not use network access, remote Git or automatic chat sending. Captured evidence and backups remain in private local storage; uncertain attribution and missing history are reported explicitly. Automated UI checks use mocked host bridges, not native client acceptance.

See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for licensing.
