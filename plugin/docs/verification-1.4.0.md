# 1.4.0 变更审查侧栏更新

## 本版变化

- 按 Codex 参考图调整为胶囊式范围选择与增删统计、42px 紧凑文件行、细分隔线、弱化目录文字和文件类型图标。
- 每行提供打开差异与更多操作，无需先选中文件；复制路径、复制差异针对菜单所属文件。保留原有暂存、撤销和确认流程。
- 菜单在滚动区域底部向上展开，支持 Escape 关闭、键盘焦点、深浅主题和宿主颜色 token。
- 图片按扩展名排除：PNG/APNG、JPEG、GIF、WebP、BMP、ICO、TIFF、AVIF、HEIC/HEIF、SVG/SVGZ 等。大小写不影响识别。
- 新图片不会进入工具捕获、工作区快照或宿主历史导入；旧图片记录不再进入审查、轮次卡片和运行统计。普通代码、Markdown、JSON、日志及非图片二进制文件仍保留。
- 不删除真实图片、不修改 Git 跟踪规则、不隐藏独立“本地 Git”里的真实状态。已有原始历史文件不做破坏性清理。

## 已验证证据

- 类型检查与构建通过；30 个单元/集成测试文件，251 项通过、1 项跳过（Windows 不适用的 POSIX FIFO 测试）。
- 完整浏览器回归：本机 Chrome、模拟桥接，87 项通过；其中侧栏与主题专项 32 项通过。
- 官方 PluginCheck 通过；版本元数据一致，`git diff --check` 通过。原有 Agent/renderer 高风险权限仍需用户明确授权，没有新增权限。

```bash
npm run typecheck
npm test
npm run build
E2E_BROWSER='C:/Program Files/Google/Chrome/Application/chrome.exe' npm run test:e2e
```

侧栏专项复现：

```bash
E2E_BROWSER='C:/Program Files/Google/Chrome/Application/chrome.exe' npx playwright test tests/e2e/review.spec.ts tests/e2e/theme.spec.ts
```

覆盖每行菜单、非选中文件复制、展开/折叠、旧图片在选中与统计之前过滤、底部菜单边界、360/600/1100px 深浅主题、自动分页和危险操作确认。独立测量结果：文件行高 42px、顶栏 53px；360px 宽度下文档宽度为 360px。

## 安装与边界

版本元数据统一为 1.4.0；官方安装包路径为 `plugin/dist/local.diff-view-1.4.0.piplug`。本地目录安装用户在插件页手动 reload 后生效。

- 行内打开按钮展开插件内的历史差异，不冒充外部编辑器接口。
- 图片按扩展名识别；不通过猜测内容或 MIME 清除无扩展名文件。
- 验证使用模拟宿主桥接，未自动安装、reload 或完成真实宿主 UI 验收。
- 截图和测试临时产物保存在会话临时目录；图片查看工具无法访问该目录，未将截图视觉查看记为已通过检查。
