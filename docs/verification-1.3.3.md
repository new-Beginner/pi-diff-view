# 1.3.3 重启历史证据修复与宿主落盘故障核查

**本地安装目录 `plugin/` 已更新，手动 reload 即可；无需重新安装。此版修复插件证据持久化，不修复宿主的聊天消息落盘队列，也不声称恢复已经丢失的聊天正文。没有自动 reload、关闭应用、修改宿主数据库或清空宿主队列。**

## 原因与修复

| 证据 | 发现 | 修复路径 |
|---|---|---|
| 1.3.2 的 `HostEvidenceBuffer` 只使用进程内 Map；加载/卸载清空，renderer 的 retained transcript 也不跨重启 | JSONL 尚未落盘的工具关联与结构化 Edit/Write 证据重启即丢失 | `HostEvidenceStore` 在插件私有 `evidence/` 原子保存去正文证据，按会话/项目恢复；先恢复后合并，空窗口不能擦除旧证据 |
| 新增回归：完整历史导入后删除原生 before/after，缩短消息记录，再同步；旧代码将 completed 降为 incomplete 且丢回复 ID | 宿主历史源缩短时覆盖了本插件已经保存的完整证据 | 只以同会话/项目已有记录引用、SHA-256 核验通过的历史 blob 补齐缺失边；无更新消息时保留已验证完成状态与回复关联 |
| 主进程回归实际 unload/load，删除 JSONL 与原生 before，再上传空 transcript | 旧版没有持久化证据目录，重启恢复仅能碰巧保留旧 run，不能重新关联宿主证据 | 新版从证据归档恢复并验证无 warnings、unchanged=1、正确增删统计和回复 ID；清空后不复活 |

不读取当前工作文件或 Git 来拼造旧版本；不同哈希不替代，归属不明仍只读/未知。旧版真正没有保存的工具证据不能由新版本凭空补回。

## 官方文档与接口核对

- [官方插件开发文档](https://github.com/vastsa/PI-Desktop/blob/main/docs/plugin-development.md)：插件设置与 `pi.plugin.getDataPath()` 的路径按插件 ID 私有。本次直接获取官方 main 文档核对。
- [官方插件 API](https://github.com/vastsa/PI-Desktop/blob/main/docs/spec/07-plugins/03-plugin-api.md#plugin-owned-sessions-p0p1-requires-the-matching-permission)：`pi.session.get/listMessages` 等读操作限插件自有会话。不能通过加 `session.read.own` 来读取普通主聊天，本版未增加权限、未绕过宿主 IPC。
- 本机 0.18.0 常规聊天的 SQLite/JSONL 和原生 review-changes 属内部实现，不是公开持久化 API；插件保留限定当前授权会话的只读恢复适配。路径或格式变化仍是兼容性边界。
- 原生 CLI `native-pi:` 会话、无项目会话与未授权项目不在本次修复范围；没有放松项目授权或会话路径校验。

## 宿主聊天丢失的现场证据

本次检查只读，只输出状态/计数，不输出用户消息正文。

- 宿主 `session-message-outbox.json` 有 **1024 条**记录（约 10.5 MB）。
- `logs/app/persistence.log` 中 `stream did not contain valid UTF-8` 与 `session persistence flush paused` 各 **3804 次**，`session persistence outbox is full` **8920 次**。
- SQLite 中 **8 个活跃会话没有消息**；其中 **5 个会话已有本插件捕获记录，但宿主数据库和 JSONL 均没有对应消息**。这不是所有历史都被删，其他有消息的会话仍可恢复。
- 两份 `pi.sqlite.v21.bak/v22.bak` 都没有这 8 个空会话的消息。现有 outbox 的会话范围也未包含上述 5 个空会话。
- 插件磁盘上仍有 **132 轮 run、712 个 blob**；部分历史缺失/未知还包含旧版并发归属不明，不能一概冒称已恢复。

宿主持久化队列暂停且达到容量上限，使新消息不能落盘：运行时内存仍能显示，重启后内存丢失便没有对应历史。1.3.3 保存的是差异证据，不是聊天备份，不会解除宿主写入阻塞。

代码来源：本机 `D:/Mypi_deskktop/PI-Desktop/resources/app.asar` 内 `out/main/chunks/index-BCpWHuBu.js`。独立只读解析归档核对：第 19844 行 `MAX_ENTRIES = 1024`；第 19901 行 `flushLoop` 在未识别错误时 `return`，跳过后面的队首移除；第 19977 行 `isPoisonMessageError` 只识别 `PERMISSION_DENIED:`。bundle SHA-256 为 `841d3b2dfd8a9d17cebb1204f82de23fccd604d7bd30b2263cf427ad6c5eac8a`。已确认队列阻塞机制，底层 UTF-8 错误的具体源头尚未定位，不能简单认定删除队首就安全。

### 宿主问题的处理边界

需要在宿主消息持久化实现中定位 UTF-8 错误来源、修复重试/坏记录隔离，并验证积压队列正常排空及重启后消息可读取。**不要直接清空整个 outbox**：其中仍有未提交消息。若采取队列修复，应先完整备份，在应用关闭或停止写入的条件下操作，并保留原始坏记录用于恢复。

本次没有热改宿主安装文件、重放消息、写数据库、删除队列或声称聊天已恢复；宿主队列阻塞仍是独立未解除的问题。

## 存储与隐私边界

- 归档只保存会话/消息/工具身份、时间、完成状态、文本存在标记和结构化文件工具证据；不保存用户/助手正文、思考文本、Shell 命令/输出。
- 文件工具内容仍按公共路径规则过滤敏感/内部/依赖路径，读取归档时再次白名单规范化。
- 每个会话项目记录最多 **8 MiB**，最多 **200 份**，总量 **128 MiB**；满容量明确报错，不静默删其他会话。
- 分块顺序和完整 revision 校验后提交，跨会话/项目不复用；损坏、超限、符号链接或身份不符的记录拒绝导入。
- 清空插件历史同时清除磁盘 `evidence/` 和内存证据缓存；宿主原始聊天、项目文件和 Git 不受影响。

## 验证

已执行类型检查、全部单元/集成测试：**28 个测试文件，236 项通过，1 项 Windows FIFO 测试跳过**。新增证据归档的 6 项测试覆盖重启、空窗口、正文剔除、跨身份隔离、部分上传、敏感路径、损坏/链接/超限、容量满和历史清理。收紧后的主进程重启回归单独再跑，2 项通过。

`npm run build` 成功；使用本机 Chrome 跑项目已有浏览器回归，**81 项全部通过**。限定代码复核未发现确定的新缺陷。

测试使用隔离临时目录和模拟宿主；未在你的真实宿主执行 reload 或重启，不能据此宣称真实 UI 与宿主聊天落盘故障已经通过验收。
