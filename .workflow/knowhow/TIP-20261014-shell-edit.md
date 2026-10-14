---
id: "TIP-20261014-shell-edit"
title: "Shell 更新工作树会使两次标准 Edit 的捕获链不连续"
keywords: ["未知行数", "快照不连续", "Shell", "git restore", "scratch worktree", "ambiguous", "捕获链"]
status: active
created: 2026-10-14
source: pi-desktop
---

src/agent/capture.ts:207-215 在 prior.after 与下一次 Edit 的 before 不一致时设 ambiguous=true，并把整条文件记录前后端点改成 unavailable；Bash/Shell 不作为文件修改证据（同文件:145）。会话227ede1d-b1ce-4136-b968-112acd9c508d中，scratch worktree 的04-e2e-test-plan.md经历Edit→Bash git restore --source=origin/main→Edit，实时贡献记录出现ambiguous=true；src/core/host-history.ts:210 会跳过该贡献。该提示是当前保守归属策略的结果，与有效快照被未知占位挡住属于不同路径；处理时不能通过读取当前文件或直接清除ambiguous伪造历史。
