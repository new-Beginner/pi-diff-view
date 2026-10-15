# Diff view for PI-Desktop

面向 **PI-Desktop 0.17.0+** 的本地变更审查插件。按会话和用户轮次展示修改证据、文末卡片与运行浮窗；独立的本地 Git 页面用于人工审查和操作仓库。

**Version: 1.4.30（本地更新版，未公开发布） · Plugin ID: `local.diff-view` · License: MIT**

1.4.30 统一全部实际入口的视觉风格：会话审查、Git 六个子页与详情/提交区、菜单、确认弹窗、加载/空/错误状态、文末卡片及运行浮窗。控件采用 8px 圆角，提示容器 12px，弹层 16px，共用细边框、灰阶悬停与主题阴影；分支和 Stash 长标题单行省略并保留完整悬停提示。文件列表仍为平面样式，保持宿主主题优先、键盘焦点和窄屏适配，不改变请求、Git 操作及确认流程，无新增依赖或权限。

1.4.29 参考轻量列表样式统一范围、设置与文件操作菜单：圆角浮层、细边框、柔和阴影、浅灰悬停与范围勾选标记。保留范围选项与操作逻辑，支持键盘导航、Esc 及外部点击关闭；删除“显示轮次”说明行，历史轮次选择与自动跟随仍保留。继续适配宿主主题和窄屏，无新增依赖或权限。

1.4.28 最小修复本地分支切换：确认后由 Git 判断是否能保留改动，覆盖冲突仍拒绝，不强制覆盖、不自动 Stash 或重试。统一历史两行列表与本地化时间，移除重复说明及文件统计旁的重复折叠按钮，保留文件名与顶部折叠入口。

1.4.27 最小修复整轮端点误配到单次 Edit 引发的假断链；按历史标签与重放结果哈希核验恢复对应起点，仍保留真正断链和并发冲突保护。仓库外文件列表显示为 `…/文件名`，悬停、复制及打开仍使用完整路径。

1.4.26 修复未知占位阻塞有效历史快照；逐次保存 Write/Edit 与 FastCtx 单文件替换的前后快照。断链时保留只读分段，不伪造净行数或开放自动撤销。不启用 Shell/Task 工作区扫描，FastCtx 目录替换与 dry-run 不采集；新采集行为需在任务结束后重载扩展。

源码：[new-Beginner/pi-diff-view](https://github.com/new-Beginner/pi-diff-view) · 安装包：[GitHub Releases](https://github.com/new-Beginner/pi-diff-view/releases/latest)。官方插件中心审核通过后公开上架：[plugins.aiuo.net](https://plugins.aiuo.net)。

当前本地修复版不提交市场。会话与页签导航仍保留内部兼容接口和动态导入；尚未解决市场的动态模块加载拦截。已公开发布安装包仍为 1.4.16。

## 安装与使用

1. 本地更新版安装 `plugin/dist/local.diff-view-1.4.31.piplug`；公开旧版可从 GitHub Releases 下载。在 PI-Desktop 插件页安装并手动批准所需权限。
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
- 文本上限为 2 MiB/文件，捕获最多 256 个路径，每文件保留最近 32 次修改快照，历史最多 200 轮，快照容量 128 MiB。会话采集支持标准 Write/Edit 和 FastCtx 单文件 replace（非 dry-run）；目录替换、Shell、Task 和未适配服务不扫描、不自动归入本轮。内容按哈希去重，历史分段只存引用，分段差异打开时计算；断链的分段可只读查看，净行数仍未知，禁止复制成合并补丁或自动撤销。独立本地 Git 不受此限制。
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
1.4.31 在明确文件工具执行前保存前态 blob/不存在证据及有界准备日志，中断后按精确调用身份与成功结果恢复；准备操作不计入变更，不读当前文件补历史。新增脱敏、限量采集诊断，结果持久化后才退役准备记录，未决租约阻止清理历史。旧缺失证据不猜测修补，未自动安装或重载。验证与开销见 [前态持久化验证](docs/verification-1.4.31.md)。

1.4.25 将文件三点菜单的“系统打开”更名为“外部打开”，功能保持不变：Windows 默认程序打开当前磁盘文件，可执行类型额外确认；文件不存在则提示，不导出历史副本、不自动重试。

1.4.26 的测试范围、性能对照和限制见 [明确文件快照验证](docs/verification-1.4.26.md)。


1.4.23 优化整个加载与交互链路：独立桥接读取不再等待前一响应，Git 长任务与历史/评论分离；仓库读取有界并发，写入继续互斥有序；分支、历史与 Stash 和状态并行加载，状态失败时操作仍不可用；摘要按批核验并合并重复快照读取，历史扫描共用单次别名读取，快照配额检查有界并行；卡片增量计量，搜索、选择、布局与差异渲染复用未变数据。保留会话隔离、哈希/路径检查、确认、限流、冲突保护、实时更新和分页。未新增权限、未自动安装或公开发布。优化范围、对照与验证见 [1.4.23 性能验证](docs/verification-1.4.23.md)。

1.4.22 移除“历史恢复”提示栏及其恢复操作引导，不再在侧栏启动时扫描历史租约生成恢复提示；保留正常的会话修改记录与历史轮次查看。运行浮窗点击后打开本会话“最近轮次”，不固定到旧轮次或旧项目；从历史模式再次点击也回到最近模式，并跟随后续有修改的轮次。浮窗仍仅在当前会话有运行任务与已验证变更时显示，任务结束或切至非运行会话立即隐藏；文末卡片继续定位对应历史轮次。未新增权限、未自动安装。

1.4.20 修正“最近轮次”的选择规则：当前轮尚无修改时显示本会话最近有可展示修改的一轮，当前轮首次产生修改后自动切换并持续更新，结束后继续保留；空轮次、缺失或过期的运行身份不会遮住已有记录。历史模式仍固定到所选轮次，不合并不同轮次或会话的证据，不使用 Git 状态补造历史。

1.4.21 保留上述选择规则，修复会话根目录暂缺时误归 scratch、旧快照覆盖已核验生命周期、迟到标准工具租约遗留，以及已验证重复记录的导航引用。跨根目录历史迁移默认关闭，只在显式授权且原生工具 ID、路径和历史哈希均核验后进行；不会使用当前磁盘或 Git 内容补造历史。缺失/过期状态显示待核验，旧式后台租约保守保留并提供诊断。更新不会热替换进行中 runner；需在任务安全结束后重新加载扩展。

最近模式默认在本会话全部项目中选择，不继承历史轮次的项目路径；用户主动设置的项目筛选独立保留，也可切回“本会话全部项目”。会话返回时立即重新查询（仍受桥接请求限额约束），旧请求失去发布资格，已有文件选择、折叠和滚动状态在未变更时继续复用。按钮名称保持“最近轮次”，下方标明实际展示轮次及状态。

本次补充空轮次回退、首次修改、结束状态、历史返回、项目筛选、A→B→A 和旧请求晚返回的回归测试。未新增权限、未自动安装，模拟桥接测试不代表原生客户端验收。

1.4.19 优化加载和恢复：悬浮窗按会话、任务身份缓存已验证统计，返回同任务时立即显示并后台更新；点击只选择目标，不重复查询统计或设置活动会话。桥接和后端为只读导航保留独立的有界通道，仍校验会话、任务、文件身份并遵守每秒 6 请求上限。文末卡片按会话和原生消息 ID 即时恢复，历史首批不再等待全部分页。侧栏保留最近 6 个会话实例，切回复用选中文件、折叠和滚动状态；非当前会话停止轮询。首次读取、插件重载或缓存淘汰仍需加载，不保证所有历史永久留在内存。

未新增权限、未自动安装。原生 API 的当前会话订阅仍未正式开放，因此保留兼容适配器，不使用计划中的 `session:activated`。自动化恢复测试不等同于原生客户端性能验收，详见 [1.4.19 验证记录](docs/verification-1.4.19.md)。

1.4.18 修复任务栏与浮窗重叠：任务栏可见时浮窗位于其上方，隐藏后回到输入框上方。会话实时捕获和历史恢复仅接纳标准 Write/Edit，未知行数不再由 Shell/Task 推断记录产生（标准工具的二进制或缺失快照仍明确显示未知）。同目标定位轮询暂时失败时保留已加载侧栏，避免卸载重建；保留实时更新、折叠和会话隔离。复制成功提示采用宿主风格的轻量胶囊，3 秒自动消失，重复复制重新计时，不挤动文件列表。

保留 1.4.17 的官方 `pi.ui.openLayer()` 样式作用域和安全暂停适配。只有旧宿主缺少接口时才使用兼容容器；接口拒绝不绕过。文末卡片、文件页签、评论与本地 Git 功能保留。未新增权限、未公开发布、未提交市场、未自动安装。

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
