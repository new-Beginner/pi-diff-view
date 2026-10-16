---
id: "TIP-20261016-gitlens"
title: "分支切换成功后的刷新异常会被误报为切换失败，GitLens也不会绕过覆盖保护"
keywords: ["分支切换", "branchSwitch", "GitLens", "刷新失败", "误报", "stash", "覆盖保护"]
status: active
created: 2026-10-16
source: pi-desktop
---

diff-view 1.4.37 的 src/view/GitManagement.tsx execute:119-146 在同一 try/catch 中执行 branchSwitch 和 refreshData；切换返回成功后，若 branches 刷新失败，仍设置 switchFailure，同时保留“操作已完成”提示。2026-10-16 在 scratch 中将 GitManagement 内存打包并用本机 Chrome 注入 transport：branchSwitch 成功将模拟真实分支设为 feature，随后 branches 抛错，复现两条相互矛盾提示，调用顺序 status/branches/branchSwitch/branches/branches。修复应拆开 mutation 与刷新阶段；后端分支切换返回已确认的 current/head，刷新失败仅提示数据未刷新，不能报告命令失败或自动重试写操作。参考对象是 PI-Desktop 官方 pi.gitlens 0.2.7（本地包 ../pi-desktop-plugins/packages/pi.gitlens-0.2.7.piplug），不是 VS Code GitLens；main.js:404-408 仅 git switch 后返回 current/branches，无自动 stash、强制覆盖或远程分支列表。隔离克隆当前仓库并只复制工作区 README 修改，main→publish/main 时 diff-view 与官方 GitLens 均返回同样 would be overwritten 错误，这是正常保护，不能靠改 switch 参数绕过。用户此次原始报错尚未取得，以上是复现发现而非断言其唯一根因。
