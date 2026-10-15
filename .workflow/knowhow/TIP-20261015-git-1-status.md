---
id: "TIP-20261015-git-1-status"
title: "Git 切页约 1 秒停顿来自 status 串行任务与限流轮询组合"
keywords: ["Git", "卡顿", "历史", "分支", "performance", "JobQueue", "boundedTransport", "jobPoll", "限流", "status", "GitLens"]
status: active
created: 2026-10-15
source: pi-desktop
---

1.4.30 的 GitManagement.tsx:74-106 每次切页（包括历史分页）清空数据并同时申请完整 status 与目标页读取，再以 allSettled 等待二者；176/189 行用 busy 禁用导航与控件。虽然 main.ts:49-56 和 local-management.ts:276-282 有4路读写队列，但 core/jobs.ts:21-22 将普通后台任务全部串行，先执行 status 再执行 branches/history。view/transport.ts:20-23 限制滚动每秒6次 wire 调用，41-54 每任务独立按40/80/160/300ms轮询；两个 jobStart 加两轮双任务 jobPoll 即耗完6次，后端约300-350ms完成但结果到约1000ms才可取。2026-10-15 同机当前仓库5次中位数：独立历史151ms/分支102ms，切页链路1015ms/1007ms；实际 JobQueue+boundedTransport 配两个100ms假任务也复现约1002ms。隔离400深层路径改动使status约133→606ms（2004 realpath、2000 lstat），目标列表不明显变慢。优化优先解耦只读列表与完整status、合并同页任务/轮询并保留6/s限额、让Git只读由已有读写队列调度且保留写互斥，分离loading与mutationBusy并防旧响应覆盖；不应取消路径安全校验、直接放宽限额或只改CSS。GitLens0.2.7历史/分支只发目标请求且无Git数据缓存，其分支后端3进程反比本项目2进程慢；不能把体验差归因于分支命令算法。测量基于真实源码+本地桥接桩，不是宿主端到端；现有jobs/transport单测分开覆盖，缺组合延迟回归。
