---
id: "TIP-20261014-before-write-edit"
title: "历史恢复误用整轮 before 导致 Write→Edit 假断链"
keywords: ["行数未知", "假断链", "Write Edit", "整轮端点", "recorded.before", "capturedBefore", "历史恢复", "幂等", "快照"]
status: active
created: 2026-10-14
source: pi-desktop
---

在 1.4.26 的 src/core/host-history.ts:408-409，缺失单次工具快照且该调用是文件记录最后一条 evidence 时，回退将 recorded.before/after（整轮端点）复制到单次事件。Write 新建→Edit 修改的整轮 before 是 absent，因而被错误写入最后一次 Edit 的 before。第一次 sync 生成该错误分段；第二次 sync 将错误分段作为 exact callId 证据恢复，capturedBefore=true，412 行判定 prior.after 与 Edit.before 不同并标 ambiguous，导致“2 段·净行数未知”。会话 6133c73b-2423-4ae5-abce-de1bb03c9cc2、轮次 ce67933c-2946-4df6-ba35-8b7b9d1a6369 的 render-path-preview.mjs 已用原始 Write 内容、Edit 第56行指令和两份 blob SHA256 验证确实连续；隔离重复导入复现 false→true→true，实际记录只读。plugin/main.js:3356 含相同逻辑。修复方向：整轮 before 只能关联第一条调用，after 只能关联最后一条；单次端点应来自对应 callId 的真实快照/经过哈希核验的重放，不可盲目把前次 after 当成本次 before。已污染的历史分段须按原始工具证据核验修复。应补 Write→Edit 多次导入幂等回归，并保留真实断链/并发冲突保护；此根因不同于 TIP-20261014-shell-edit 的真实 Shell 断链。
