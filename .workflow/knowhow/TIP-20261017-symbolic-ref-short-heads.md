---
id: "TIP-20261017-symbolic-ref-short-heads"
title: "同名标签会使 symbolic-ref --short 返回 heads/分支名，分支身份需读完整本地引用"
keywords: ["分支", "标签同名", "symbolic-ref", "heads/main", "detached HEAD", "Git", "当前分支"]
status: active
created: 2026-10-17
source: pi-desktop
---

在 diff-view 的三类分支操作稳定性回归中，真实临时仓库同时含 refs/heads/main 和 refs/tags/main 时，git symbolic-ref --quiet --short HEAD 返回 heads/main，而非 main。这会影响状态标题、当前分支保护及确认时身份校验。src/git/local-management.ts 的 currentBranch 改读 git symbolic-ref --quiet HEAD，仅接受 refs/heads/ 前缀并精确截取分支名；只有退出码1按 detached HEAD 处理，其他失败抛出，避免伪装为空分支。repositorySummary 使用 allSettled 确保两个子读取都结束后才释放队列。tests/integration/branch-stability.test.ts 的同名标签+detached HEAD 测试修复前实测 heads/main 失败，修复后通过，标签保持不变。版本1.4.43。不要通过字符串猜测 heads/ 前缀或对所有非零退出码返回 null。
