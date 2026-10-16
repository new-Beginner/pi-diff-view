---
id: "TIP-20261016-release-plugin-pluginpack-git"
title: "公开 Release 不直接打包开发 plugin 目录：PluginPack 不遵守 Git 忽略规则"
keywords: ["Release", "PluginPack", "PluginCheck", "公开发布", "打包", "白名单", "隐私", "plugin/docs", "gitignore", "prepare-public"]
status: active
created: 2026-10-16
source: pi-desktop
---

发布 v1.4.35 前发现直接对 plugin/ 执行 PluginPack 会包含 Git 已忽略但磁盘仍存在的 plugin/docs 报告、截图和旧 renderer/index.css，开发包共有86文件约2.9MB；PluginCheck通过仅代表满足安装规则，不代表适合公开分发。公开发布应先用 node scripts/prepare-public.mjs <唯一目录名> 生成 output/<目录>/plugin 的运行文件白名单副本，再用 node scripts/check-public.mjs output/<目录> 执行隐私预检，最后对该精简 plugin 目录调用 PluginCheck/PluginPack。现有白名单为15个运行及许可证文件，不能删除原开发文档来凑包。发布时核对ZIP所有条目均为store-only、包内运行字节与目标Git提交一致，并检查上传附件digest和匿名下载SHA-256。精简包与开发包即使版本同为1.4.35，哈希也不同，发布说明必须使用实际公开附件哈希。
