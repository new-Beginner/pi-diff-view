---
id: "TIP-20261015-scratch-blob-write"
title: "scratch 文件已有内容 blob 仍行数未知：首个 Write 前态缺失而非断链"
keywords: ["行数未知", "scratch", "beforeExists", "Write", "快照", "blob", "首态缺失", "采集诊断"]
status: active
created: 2026-10-15
source: pi-desktop
---

Diff view 的 scratch 文件即便 Write 后和 Edit 后内容 blob 均可通过 SHA-256 核验，整轮首个 Write 的 before 仍可能是 unavailable。原生 scratch Write/Edit 结果可只有 root/path/tag 而无 details.review，review-changes/<session> 也可能不存在；host-history.ts:195-200 此时只能从 Write 参数恢复 after，不能将 Write 自动视为新增。review-service.ts:82-88 因 before 非 text 而保留 statsKnown=false。诊断应分别检查 blob、beforeExists、ambiguous，并用原始 Write 内容+Edit 指令+最终哈希重放区分缺首态与真实断链；不可读取当前文件或盲补 absent。隔离副本加入假设的可信 beforeExists:false 能恢复统计，只能证明缺哪项证据，不能充当真实历史证明。src/agent/capture.ts:178-186 的逐路径异常仅设 incomplete，缺少 callId/目标/错误原因诊断，旧记录漏采具体原因可能无法追溯；当前源码模拟与随后真实新一轮能正常捕获 absent，不足以证明旧轮一定是重载或旧版本导致。此问题不同于整轮端点误配和未知占位冲突。
