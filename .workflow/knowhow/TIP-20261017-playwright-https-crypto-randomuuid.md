---
id: "TIP-20261017-playwright-https-crypto-randomuuid"
title: "Playwright 虚拟测试域名须使用 HTTPS 以支持 crypto.randomUUID"
keywords: ["Playwright", "crypto.randomUUID", "安全上下文", "HTTPS", "invalid", "Git 布局", "主题测试", "初始化超时"]
status: active
created: 2026-10-17
source: pi-desktop
---

本项目 Git 布局和主题浏览器测试曾在等待“本地 Git”按钮或 .dv-panel 时超时。trace 控制台显示 Panel 初始化抛出 crypto.randomUUID is not a function：测试使用 http://git-layout.invalid 与 http://theme-fixture.invalid，它们不是浏览器安全上下文。修复 tests/e2e/git-layout.spec.ts 与 tests/e2e/theme.spec.ts 的 route 和 goto，统一改为 https:// 对应虚拟域名；仍由 Playwright route.fulfill 提供页面，无需外网或修改生产代码。使用本机 Chrome 重新运行相关 53 项界面测试全部通过。
