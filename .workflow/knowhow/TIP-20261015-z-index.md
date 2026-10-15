---
id: "TIP-20261015-z-index"
title: "运行变更胶囊避让返回底部按钮：不能仅调整内部 z-index"
keywords: ["返回底部", "jump-latest-btn", "运行胶囊", "遮挡", "z-index", "openLayer", "层叠上下文"]
status: active
created: 2026-10-15
source: pi-desktop
---

RunningChangePill.tsx 的 update 只测量 .composer-shell 和 .todo-dock，胶囊居中放在 ceiling - 8；宿主 .jump-latest-btn 也在输入区上方居中，因此可能重叠。宿主官方 openLayer 的父层级为 600–899，箭头层级为 5，降低 .dv-running-float 内部 z-index 不能让它穿过父层叠上下文。源码核对与 12 组最小 CSS 浏览器验证证实这一点，兼容零尺寸 fixed 容器则有不同层叠结果。推荐在所属会话范围内只读测量可见箭头，重叠时将胶囊底边移到箭头顶边上方 8px，保持任务栏避让；箭头消失恢复原位置。不改宿主样式、不绕过官方安全暂停。本次仅分析验证，尚未实现项目修复，原生客户端待验收。相关文件 src/renderer/RunningChangePill.tsx、src/renderer/floating-layer.ts、tests/e2e/running.spec.ts；宿主 apps/desktop/src/styles/chat-shell.css、apps/desktop/src/plugins/renderer-layers/layer-stack.ts。
