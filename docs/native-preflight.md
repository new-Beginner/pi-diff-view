> **此文档仅保留历史预检证据，不再是当前使用说明。** 用户已澄清目标是文末卡片打开本插件的 Diff view 侧栏。输入框按钮和默认 renderer 中的原生预检入口已删除；无需执行下列点击步骤。当前说明见 [文末卡片](task-summary.md)。

# 原生审阅接入预检（开发中，未发布 v0.2.0）

> **当前只完成先行验证代码，尚未通过真实宿主验证。** 本轮汇总卡片、工作区外采集和 v0.2.0 发布按批准计划等待这一门槛；不把模拟测试冒称为原生通过。原有 v0.1.0 安装包和 Git 检查点保留，没有覆盖安装包。

## 你需要执行的一次操作

1. 在 PI-Desktop 插件页通过**加载开发插件**选择本项目的 `plugin/`：
   `D:/32057/Files_of_Desktop/Academic/AI/Pi-plugin/diff-view/plugin`。
   安装版不会自动读取项目源码。你已在本机加载开发目录并启用开关，后续通常只需 hot reload；只保留一个启用实例，权限确认仍由你操作。
2. 在插件设置启用 **Native review preflight (experimental 0.17.0 build only)**。默认关闭。
3. 回到**本次对话**，等 Agent 完成回复后，点击输入区的 **原生审阅预检 / Native preflight** 按钮。不要在 Agent 仍运行时点；那时会明确拒绝。
4. 预检应打开宿主自带“审阅”页签，定位本轮由 Write 创建的 `docs/native-preflight-fixture.txt`，并在宿主审阅滚动列表中展示一个明确标注的**工作区外演示**。它只是原生组件接入样本，不代表已经采集真实外部文件；无撤销按钮。
5. 人工确认显示正确，再切换会话、关闭审阅页签或禁用开发插件，检查演示区域是否消失、原生记录仍在。把按钮旁的预检状态及截图发回本对话即可继续已批准计划，**不需要重新批准计划**。

若按钮没有出现，不要重复安装或制造快照。2026-10-10 已定位并修复开发产物错误导入 `react/jsx-runtime`：0.17.0 的 import map 没有它，浏览器在调用 onLoad 前就拒绝整份 renderer。现在使用经典 JSX 并覆盖 renderer 的 tsconfig，构建断言只允许宿主支持的三项模块。设置加载失败会显示原因，不再静默隐藏预检。

## 错误含义

| 代码 | 含义 | 下一步 |
|---|---|---|
| `NATIVE_BUILD` | 版本、三个模块指纹或宿主资源路径不符 | 报告信息；禁止猜测升级后的内部导出 |
| `NATIVE_ORIGIN` / `NATIVE_ENTRY` | 不是锁定的原生文档，或已加载主模块位置不符 | 不复制执行另一个主入口；报告信息 |
| `NATIVE_IMPORT` | 动态模块导入失败（可能是 CSP/协议限制） | 报告具体导入错误；不改安装包绕过 |
| `NATIVE_CONTRACT` | store、原生组件、解析器或 React 实例结构不符 | 停止接入，保留原有插件 |
| `NATIVE_RECORD` | 当前会话内预检文件的原生记录缺失或不唯一 | 在本次对话预检；勿重写文件制造重复记录 |
| `NATIVE_ANCHOR` | snapshot/message/path 与原生列表 DOM 不一致 | 拒绝定位，不按路径猜测别的版本 |
| `NATIVE_SESSION` / `NATIVE_RUNNING` / `NATIVE_CLOSED` | 会话切换、Agent 运行中或侧栏已关闭 | 待稳定后重试；旧会话不继续挂载 |
| `NATIVE_SURFACE` / `NATIVE_RENDER` / `NATIVE_READONLY` | 原生区域不可见、组件失败或出现不应有的回退按钮 | 插件区域清理；报告信息 |

`opened/located/externalRendered/readonly/sessionGuard` 为按钮运行时检测到的状态，仍需视觉核对。模拟测试得到的这些字段不是原生验收证据。

## 已检查的边界与证据

- `src/core/native-host-build.ts`：从宿主可执行文件目录下的 `resources/app.asar` 只读三个固定资源，核验内容 SHA-256；不接受前端提供的任意路径。Electron 下使用其 `original-fs` 读取归档字节，普通 Node 下使用标准 fs。
- `src/core/native-build-contract.ts`：锁定 0.17.0 **一个实际构建**；版本相同但资源内容不同也拒绝。已在 Node CLI 对本机安装资源读取并确认三个指纹一致，这只是文件级核验。
- `src/renderer/native-review-adapter.ts`：只复用原生文档已经使用的主模块 URL及同目录原生组件；不下载资源、不执行复制的宿主主入口。
- 原生 store 仅用于当前会话的匹配工具变更元数据及打开页签，不调用普通会话历史读取 API，不写 messages，不更新数据库。
- 为复用原生组件构造隔离的展示 DTO，标记 `diff-view-display:` 和来源，强制 `reversible: false`。其中原生解析器要求的 `root: workspace` 只是组件渲染判别，不表示外部路径获得工作区授权；DTO 永不注入工具返回或真实历史。
- DOM 操作仅限原生 review 页签内与明确快照匹配的 diff 展开及插件拥有区域。关闭/切会话/卸载后清理；不替换宿主已有内容，不操作权限或回退按钮。
- 主进程的 `ready` 不表示 renderer 就绪。插件私有 `renderer-status.json` 只记录固定启动阶段和时间戳，不记录聊天、草稿、路径或会话 ID。实际宿主本轮已回传入口加载、输入区挂载及 bootstrap 成功；这证明启动链路，不证明原生审阅预检通过。

### 本轮实际结果

| 检查 | 结果 | 不应混淆的边界 |
|---|---|---|
| 类型检查与开发构建 | 通过 | 已收到真实宿主热重载及输入区挂载阶段标记 |
| 真实 renderer 启动阶段 | entry-loaded、composer-mounted、bootstrap-ok | 来自当前宿主；不等于原生侧栏预检通过 |
| 后端回归 | 70 通过、1 跳过 | Windows 跳过 POSIX FIFO |
| Chromium 回归 | 28/28 通过 | 原生适配用模拟组件；新增最终 ESM＋宿主三项 import map 的启动测试 |
| 安装资源读取核验 | 三个实际模块指纹匹配 | Node CLI 文件级检查，不是原生 UI 验证 |
| 真实宿主预检 | 未执行 | 开发目录与开关已经启用；待本轮结束后点击预检按钮 |

### 自动化复跑

```bash
npm run typecheck
npm test
npm run build
E2E_BROWSER='C:/Users/32057/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe' npm run test:e2e
```

新增生产 ESM 测试 `tests/e2e/renderer-entry.spec.ts`：浏览器只提供宿主真实三项 import map，动态导入 `plugin/renderer/index.mjs`，验证按钮可见、关闭开关和设置失败提示；不再只测试把 React 一起打包的源代码替身。`tests/integration/renderer-status.test.ts` 检查固定阶段记录及拒绝任意键。其余原生适配测试仍是模拟接口/组件。

## 本轮执行状态

已完成：版本锁定、原生适配预检代码、默认关闭的用户按钮、模拟回归与开发构建。

阻碍：没有主窗口调试连接，工具不自动控制 PI-Desktop 或权限弹窗。**开发 renderer 加载与输入区挂载已通过真实阶段标记确认，但仍需你在本轮结束后点击原生预检按钮。** 原生模块导入、页签定位和组件展示尚未验证，未发布 `local.diff-view-0.2.0.piplug`，不以自建侧栏代替目标。
