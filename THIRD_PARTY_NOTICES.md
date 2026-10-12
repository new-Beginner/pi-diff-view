# 来源与第三方许可

Diff view 以 MIT 许可发布。

参考但未直接移植的功能设计：
- 用户本地 `dsh-file-review` / `dsh-diff-review-likecodex`：路径聚合、评论锚点、轮次隔离和冲突保护，原项目 MIT 许可。
- [Codex 官方审查文档](https://developers.openai.com/codex/app/review/)：审查范围和交互行为；不复用商标资产或宣称官方关系。
- [PI-Desktop](https://github.com/vastsa/PI-Desktop/tree/v0.17.0)：使用官方 panel-basic 模板和公开插件契约。

打包运行依赖：
| 依赖 | 版本 | 许可 |
|---|---|---|
| diff | 8.0.4 | BSD-3-Clause |
| highlight.js | 11.11.1 | BSD-3-Clause |
| React / React DOM | 18.3.1 | MIT |

完整许可文本随插件 `licenses/` 一起打包；构建产物保留第三方 legal comments。开发依赖版本由 package-lock.json 固定。
