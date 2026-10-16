# 1.4.41：方案 A 公开状态与自有采集

新增 `desktop.control` 权限，需要用户批准。此版本没有自动安装、重载、推送或提交市场；原生客户端和市场准入仍需单独验收。

## 如何工作

1. Agent 扩展通过公开生命周期和明确文件工具事件，在插件数据区保存前后快照、调用 ID 和执行状态；不保存提示词或回复正文。
2. 后端发现官方桌面操作目录，只调用 `agent/getStatus` 和 `session/get`。核验返回会话身份后，通过 `hostEvidenceMessages` 去除聊天正文，保留工具/生命周期结构化证据。
3. 恢复器结合公开工具 ID、同会话/同根目录的自有快照及已保存证据，保持既有归属、冲突、哈希和只读规则。不从时间接近推断归属，不用当前文件伪造历史前像。
4. Renderer 通过 `plugin.call('sessionState', {sessionId})` 共享轮询精简状态，不接收会话正文或工具快照。DOM 会话识别、工作面板点击与插件自有定位桥接保持不变。

生产路径已删除宿主模块动态导入、私有 store/React 提取、宿主数据根目录推导和构建指纹探针。旧磁盘数据源仅位于测试夹具，正式恢复器不接收宿主磁盘数据源。

## 边界和失败行为

| 边界 | 行为 |
| --- | --- |
| 桌面权限拒绝、操作缺失或查询失败 | `statusKnown:false`，不是已知空闲；不回退私有 IPC、store 或磁盘 |
| 接口查询 | 默认总超时 1500ms、缓存 1000ms、32 个会话、同会话单飞、实际调用并发最多 2 |
| 无取消能力的挂起调用 | 调用方按时返回，但仍占实际并发槽，防止无限创建挂起请求 |
| 历史分页 | 最多 20 页、2000 条消息、8 MiB 去正文证据，物理游标必须递减；截断明确不完整 |
| 私有存储 | 沿用每会话/根目录 8 MiB、200 条记录、总计 128 MiB 的证据配额 |
| 渲染桥接 | 不传整段证据；只白名单接收归一化状态；旧 `sessionEvidence` 上传入口不再接受输入 |
| 生命周期 | 会话代次、A→B→A、退订和卸载使迟到响应失效；查询错误不复活旧任务 |
| 根目录缺失 | 只使用公开会话路径或本会话自有采集根目录，不猜测宿主 scratch 路径 |
| 旧历史缺少前像 | 保留未知/冲突，不能因升级凭空恢复；已保存可核验快照仍可审阅 |

`desktop.control` 本身是宽权限，本插件代码将使用范围限制为上述两项只读操作；不能把代码约束误写成宿主提供了细粒度授权。

## 可复现检查

在仓库根目录运行：

```bash
npm run typecheck
npm test
npm run build
node scripts/check-public-runtime.mjs plugin
npm run test:e2e
```

构建自动扫描四个正式 JavaScript 入口的 AST，拒绝动态 `import()`、`eval`、`Function`、非字面量 `require` 及已知私有宿主路径/加载器特征。它是针对本次回归的本地检查，不代替官方市场扫描或完整安全审计。发布副本准备后应再次扫描该副本，使用 PluginCheck、PluginPack 生成 `.piplug`，并核对包内实际入口。

关键用例：`public-host-source.test.ts` 验证公开接口形状、边界、脱敏与超时；`public-state-adapter.test.ts` 验证共享轮询与会话隔离；`public-source-main.test.ts` 使用真实 Agent 事件和后端构建，验证精确工具归属、前后快照与拒权未知语义。现有历史、导航、文件操作和 Git 用例继续保留。

## 官方依据与待验收项

接口核对版本：[`vastsa/PI-Desktop@a7a98ee`](https://github.com/vastsa/PI-Desktop/tree/a7a98ee051b1b35eb959830eabe0cebca3e39215)。参考 `docs/plugin-development.md`、`packages/plugin-sdk/src/index.ts`、`apps/desktop/electron/main/mcp-control.ts`、`apps/desktop/electron/main/ipc/session-ipc.ts` 和 `packages/agent-runtime/src/sidecar.ts`。

- 需在原生客户端验证新增权限批准/拒绝、长会话、后台任务、无项目会话、冷启动、真实跨会话及卸载。
- DOM 标记不是稳定 SDK；多实例或标记歧义继续停止绑定，不猜当前会话。
- 官方可信扩展文档对 `agent.extension` 的本地/开发导入、签名及市场准入有限制。移除动态加载问题不等于该权限已获市场批准；需要官方复验。

## 本次验证结果

- 类型检查通过；64 个单元/集成测试文件通过，601 项通过、1 项跳过。
- 聚焦 Renderer/运行浮窗浏览器测试 56/56 通过。未把模拟宿主测试等同于原生验收，也未宣称完整 211 项浏览器套件已通过。
- 构建及四个正式入口的 AST 扫描通过；公开副本类型检查通过，隐私预检 202 个文件、0 阻断。
- 官方 PluginCheck、PluginPack 通过；高风险权限需用户批准的警告保留。
- 安装包：`output/scheme-a-1.4.41/plugin/dist/local.diff-view-1.4.41.piplug`，850246 字节，15 个 store-only 条目。逐文件字节与已检查副本一致，包内四个实际 JS 入口再次扫描通过。
- SHA-256：`d563769fa321879aecfaba89034adb0128cc3643a3f720b7ef24feb3b6af83d6`。
- 分支：`fix/public-host-state-adapter`。没有自动提交、推送、安装、重载或市场提交。
