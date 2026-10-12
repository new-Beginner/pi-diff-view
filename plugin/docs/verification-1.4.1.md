# 1.4.1 悬停样式与文本快照恢复

## 更新后如何使用

在插件页手动 reload，再展开原轮次文件。文件行不再显示选中、悬停或按下色块；箭头默认隐藏，鼠标移入文件行时才显示：未展开向右，展开向下。键盘焦点轮廓、文件类型图标、右侧操作与原有危险操作确认保持不变。

## package-lock.json 的实际原因与修复

当前会话的宿主修改证据只保留了完整 `before`（76,124 字节）、修改后 SHA-256 和两条成功的 Edit 指令；没有 `after` 文件，工具返回的 diff 又被截断为空。插件的并行 Task 端点采样曾将该文件标为归属不确定，因而不能计算可靠行数。这不是 JSON 被排除，也不是文件超限。

修复增加数据型 Edit 重放：

1. 读取同会话、同文件的完整历史 before。
2. 校验成功的工具身份、目标路径及宿主记录的 after 哈希。
3. 重放有界、非重叠的 PUT/CUT 操作，或唯一匹配的旧式文本替换。
4. 只有完整结果的 SHA-256 与宿主记录一致时，才持久化恢复的 after 并计算行数。

结构化证据现在保留 Edit 的 `ops` / `old_string` / `new_string`，经过路径过滤；聊天正文、Shell 命令和 stdout 仍不保留。图片继续排除。

真实旧记录的只读校验已成功：76,124 字节的恢复结果匹配宿主 after SHA-256 `708f8002bb63bf7b1ba01b8c2b8d90a8aebfea3ff99bce053cf0fa5f1c5768bf`。没有读取当前工作区文件补造历史，也没有写宿主记录。

## 验证与复现

完整回归：类型检查与构建通过；31 个单元/集成测试文件，276 项通过，1 项 POSIX FIFO 测试因 Windows 不适用而跳过；89 项浏览器测试通过。侧栏与主题专项 34 项通过，覆盖浅色/深色、选中/展开、鼠标按下、键盘焦点、默认隐藏与悬停箭头方向。恢复专项为 5 个文件、62 项通过，覆盖大锁文件截断、归属未知记录升级、重启持久化、换行、哈希不匹配、错误路径及失败工具拒绝。

```bash
npm run typecheck
npx vitest run tests/unit/edit-replay.test.ts tests/unit/host-transcript.test.ts tests/integration/host-history.test.ts tests/integration/host-evidence-store.test.ts tests/integration/session-history-main.test.ts
npm test
npm run build
E2E_BROWSER='C:/Program Files/Google/Chrome/Application/chrome.exe' npm run test:e2e
```

## 边界

- 不执行 Edit 指令中的代码，不运行 Shell，不覆盖真实文件，不写宿主数据库。
- before 真正缺失、哈希不匹配、寄存器粘贴、重命名/删除指令或不支持的语法仍保持未知；不猜测历史。
- 本地目录及安装包版本统一为 1.4.1，安装包为 `plugin/dist/local.diff-view-1.4.1.piplug`。没有新增权限。
- 浏览器回归使用模拟桥接；未自动安装或 reload，不宣称真实宿主 UI 已验收。
