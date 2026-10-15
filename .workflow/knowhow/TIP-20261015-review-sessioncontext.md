---
id: "TIP-20261015-review-sessioncontext"
title: "侧栏冷启动 review 缺少 sessionContext 时跳过历史恢复"
keywords: ["首次打开", "行数未知", "侧栏切换", "冷启动", "sessionContext", "contexts", "历史恢复", "ready", "串行队列", "死锁"]
status: active
created: 2026-10-15
source: pi-desktop
---

症状：首次打开会话修改列表大量行数未知，稍后或切换侧栏再返回恢复。src/main.ts onLoad 清空 contexts；execute 的 review 只有 history && context 才先 importInbox/syncSession，context 缺失时 ReviewService.review 仅导入 inbox，直接暴露 ambiguous/unavailable 早期记录。src/renderer/index.tsx trackSession 先逐块 sessionEvidence 再 sessionContext，首屏 review 可先执行；publish 失败只报告，已取走的 queued 不会自动重试。已用真实历史 blob/原生快照与重建早期标记的隔离夹具复现同一 run：context 前重复 review 仍未知，context 后恢复完整统计。修复方向：为 review 建立目标会话、授权根目录的有界历史准备步骤，或在入队前建立 ready 屏障；不能在现有串行 JobQueue/history queue 内等待排在后面的 sessionContext，否则可能死锁。按 generation/session/root/证据版本去重，保留真实缺失与冲突，不用当前磁盘补造历史；补测 review 先于 sessionContext 与证据上传失败重试。原始首屏请求轨迹未保存，不能断言具体事件是延迟还是上传失败。
