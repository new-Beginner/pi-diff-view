---
id: "TIP-20261017-review"
title: "子项目原生 review 的相对展示路径覆盖绝对工具目标，会重复导入并阻断快照接续"
keywords: ["行数未知", "重复路径", "pi-antigravity", "review.path", "绝对路径", "host-history", "子项目", "历史迁移"]
status: active
created: 2026-10-17
source: pi-desktop
---

会话44c9b6fb-e7de-41a0-b478-58f1dc763ed6的Write/Edit参数指向gemini-cliproxy/pi-antigravity/src等绝对路径，但result.details.review.path返回src等子项目相对展示路径。src/core/host-history.ts:167先设置path:target再展开review覆盖它，capture在父项目root下解析，导致同一callId在错误父目录和真实子目录下重复归档，真实12文件显示23项。用真实Write记录在scratch空SnapshotStore中运行当前HostHistoryImporter可复现错误src/desktop/plugin-tools.ts，且无告警。修复需在所有证据入口校验标准Write/Edit实际目标身份，不能盲信展示路径；历史迁移须按session/user/callId与规范绝对身份归并并同步贡献记录及别名，不能仅UI去重。相关36个历史blob在本次检查全部SHA-256核验通过；应依精确工具顺序和端点hash恢复，不用当前磁盘或工作区Git diff替代。
