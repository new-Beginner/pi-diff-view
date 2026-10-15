---
id: "TIP-20261015-git-hover"
title: "Git 文件 hover 色块源于通用按钮规则优先级高于透明覆盖"
keywords: ["Git", "hover", "色块", "CSS优先级", "specificity", "gm-file", "按钮透明"]
status: active
created: 2026-10-15
source: pi-desktop
---

现象：本地 Git 列表悬停文件时出现只覆盖文件名按钮、不覆盖复选框及统计操作区的大块灰底。src/view/git-management.css:10 的 .git-management button:hover:not(:disabled) 优先级为 (0,3,1)，高于 :48 的 .git-management .gm-file:is(:hover,:active) 的 (0,3,0)，后写的透明规则仍会失效；active 也有相同问题。用现有 CSS 在本机 Edge 的独立页面验证：默认按钮背景透明，hover 约 #ebebec，pressed 更深，圆角为 0，父行背景始终透明。后续优化应显式划分通用按钮与文件行的交互规则并验证计算样式，不应仅依靠调整规则顺序或一味加 !important；保留键盘 focus-visible。此次仅分析，未实施修复。
