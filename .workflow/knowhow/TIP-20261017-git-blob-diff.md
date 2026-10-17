---
id: "TIP-20261017-git-blob-diff"
title: "旧歧义捕获缺正文时可用精确历史 Git blob 加工具重放恢复，不用工作区 diff"
keywords: ["行数未知", "历史正文", "git cat-file", "精确哈希", "Write", "Edit重放", "review缺哈希", "歧义恢复"]
status: active
created: 2026-10-17
source: pi-desktop
---

补充 TIP-20261017-28311ece 的恢复路径：1.4.46 的 HostHistoryImporter 支持成功 Write 在 review 存在但缺 afterHash 时从完整 args.content 推导输出哈希；缺 review 元数据可由同条标准工具调用补齐，明确身份冲突仍拒绝。旧 ambiguous 捕获只提供同会话/同根/精确首末 toolCallId 的端点哈希约束，恢复的歧义采样字节还须成功工具内容或 Edit 重放匹配 afterHash，不能只因两个 blob 都在就清除归属歧义。数据修复时如 blob 缺失，可有界枚举目标路径的历史提交，以 git cat-file blob <commit>:<path> 取原始字节，仅 SHA-256 完全匹配已记录捕获哈希时补回插件 blob store，再走相同重放校验；这不是使用当前磁盘或 Git diff 猜会话变更。目标会话实际补回13份精确历史正文，截图8个文件均恢复确定统计；整轮19文件仍有5文件链不完整而保持未知。真实修复前备份目标 runs/inbox/contributions 与导航索引，清理旧租约另需停止写入者确认和指纹校验。回归 tests/integration/review-missing-hashes.test.ts 覆盖缺前像、错hash、未链接调用、多哈希冲突、重复同步及采样双blob不构成工具证明。
