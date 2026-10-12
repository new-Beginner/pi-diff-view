# 1.3.2 会话差异恢复修复

升级包：`plugin/dist/local.diff-view-1.3.2.piplug`。本次没有自动安装、重载插件、批准权限或修改宿主数据库；当前已安装 1.3.1 仍需替换为新包。升级后的真实 PI-Desktop UI 不在自动化测试结论内。

## 原因与证据

| 证据 | 问题 | 修复路径 |
|---|---|---|
| 本机 0.18.0 renderer 的 tool_start/tool_end 创建顶层 `toolCallId/toolName/toolArgs/toolResult/toolStatus`；本次只读现场 JSONL 没有对应工具消息，review-changes 的 messageId 是复合 call ID | 旧导入器仅扫描 JSONL 的 blocks，无法把原生快照关联到实时工具消息，报告 Unlinked host modification evidence | 从当前/retained transcript 提取最小证据 DTO，剔除聊天正文后有界同步到主进程；仍验证 session/root、工具身份、文件路径及历史字节哈希 |
| 现场旧捕获有 ambiguous、before/after unavailable；原实现只合并不存在的文件条目 | 即使恢复到原生完整快照，已有未知条目也不被修复 | 原生 before + 结构化 hunks/Write 内容必须通过 after SHA-256 才替换未知条目；不读取当前工作文件来重建历史 |
| session:turnEnded 原来只导入 inbox；审查刷新未同步历史；旧 inbox 周期重读 | 结束状态和恢复后的内容可能被旧运行记录覆盖 | 结束通知触发授权历史重读，真实 renderer 状态负责结算；review/turnSummary 也同步；记录对应捕获版本，阻止旧 inbox 回退，仍接受更新版本 |
| 老捕获可能缺 userMessageId；新版本对旧 generation 筛选严格 | 未确认身份的记录可能遮住已经验证的当前轮次 | 全部记录工具 ID 必须精确关联到同一宿主用户消息，才补身份并合并重复来源；只允许有可靠恢复标记的记录跨重载，不按时间猜身份 |

宿主 `pi.session.listMessages` 的权限为 `session.read.own`，不能用来读取普通聊天，因此本版没有添加无效的会话读取权限，也没有增加 SQLite 依赖。排查阶段只读核对了数据库结构/状态；插件运行代码不访问数据库。

## 数据边界

- 用户/助手正文、思考文本、Shell 命令和输出不传输、不保存。只使用完成状态、文本存在标记及结构化文件工具证据。
- 敏感/内部/依赖路径按同一份浏览器安全路径规则在传输前过滤，主进程再次校验。
- 编码后的每个分块不超过 28,000 字节；通过已有后台队列传输，不绕过 2 秒 RPC 超时与限速规则。
- 缓冲最多 3 个会话，每会话累计证据最多 8 MiB；有序接收且完整校验后才提交。可见 transcript 缩小时保留之前收到的证据；卸载清空内存缓冲。
- 完整 after 文本必须匹配原生记录的 SHA-256；损坏、缺失、截断或无法确定归属的证据继续显示未知，不伪造 +0/-0。
- 外部修改、未知 Shell/Task 并发、安装前真正缺失的证据仍不是可保证恢复的历史。

## 回归覆盖

- 真实宿主顶层 DTO、复合工具 ID、JSONL 无工具消息时的实时恢复。
- CRLF、空文件、严格哈希重建、非法路径、损坏快照、跨会话隔离。
- 旧 ambiguous 捕获修复、精确调用 ID 补归属、旧 inbox 防覆盖与新版本继续导入。
- renderer 分块、多字节/转义字符、正文剔除、缺块/错序拒绝、窗口缩小保留。
- 主进程链路：实时 DTO → 分块 → sessionContext → 差异统计 → 结束状态 → 文末卡片。
- 最终 ESM renderer 浏览器回归：结构化证据确实上传且大小有界，运行胶囊、侧栏和草稿保护。

最终验证：`npm run check` 通过（类型检查、27 个测试文件、229 项测试通过，1 项 Windows FIFO 测试跳过，以及构建）；`E2E_BROWSER="C:/Program Files/Google/Chrome/Application/chrome.exe" npm run test:e2e` 的 81 项浏览器用例全部通过。官方插件校验/打包、安装包 SHA-256 与版本一致性写入根目录 `release-1.3.2.json`。这些浏览器用例使用模拟宿主，不能替代真实宿主升级后的 UI 验收。

## 使用新版本

在 PI-Desktop 插件页安装上面的 1.3.2 安装包并重新加载插件。回到原会话后，实时 transcript 的结构化证据会补入原记录；有完整、可验证证据的文件恢复差异，结束的任务不再沿用旧运行状态。真正缺失的快照仍会明确显示未知。未声称已在真实宿主完成升级后点击/外观验收。
