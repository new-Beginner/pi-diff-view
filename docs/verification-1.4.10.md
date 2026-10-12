# 1.4.10：固定表头与完整展开

> 更新后手动 reload 本地插件，或安装 `plugin/dist/local.diff-view-1.4.10.piplug`。未修改或重载客户端，未自动安装。

## 原因与修复

只读检查本机客户端 `ChatSurface-BAAchiTD.js` 与 `index-CHSdQZWQ.css`：`entryExtra` 的 `.pi-entry-extra-viewport` 即使 `data-expanded=true` 仍使用最大高度，并设置 `overflow-y:auto`。因此旧版“展开”只是加大滚动区，表头也会随整卡滚走。上版模拟夹具展开时直接设 `none`，没有复现真实限制。

- `src/renderer/summary-style.ts`：仅以 `:has(.dv-turn-card)` 适配本插件的插槽视口。收起保留宿主限高并允许滚动，移除遮挡文件的渐隐；展开取消高度上限及内部滚动。卡片表头 sticky，提供不透明主题背景。
- `TurnChangeSummary.tsx`：观察本卡片最近的宿主展开标记，切换时回到卡片顶部。展开自动串行读取后续有界元数据页，出错停止并保留人工重试。校验分页身份和偏移，拒绝无进度响应；卸载断开观察器。
- 保留客户端唯一展开按钮、文件点击、查看变更、统计说明。样式不命中其他插件的插槽、回复正文或侧边栏。

## 已执行专项验证

- 类型检查通过。
- 卡片专项首轮 21 项通过；追加页面吸顶、深色夹具与错误分页断言后，4 项针对性用例通过。
- 900px 浅色 17 文件、360px 深色 65 文件：收起滚动表头固定；展开 `max-height:none`、`overflow:visible`，高度覆盖全部文件；页面滚动仍吸顶；65 文件无需手动加载第二页。
- 其他插件容器保持原本 `480px` 和 `overflow:auto`；收起仍限高，已加载文件不丢失。
- 人工分页失败、自动分页无进度都停止循环请求；人工重试成功，后续 feed 刷新不缩回首批。

## 全量验证

- `npm run typecheck`、`npm run build`、`git diff --check` 通过。
- `npm test`：37 个测试文件，324 项通过、1 项 Windows 不适用的 POSIX FIFO 测试跳过。
- 本机 Chrome `npm run test:e2e`：124 项全部通过，含生产 renderer、卡片分页、Git 操作、文件打开、侧边栏状态保留与静默刷新。
- 两张截图已目检；测试使用模拟宿主，不等同于真实客户端安装验收。

## 复现

```bash
npm run typecheck
npm test
npm run build
E2E_BROWSER='C:/Program Files/Google/Chrome/Application/chrome.exe' npm run test:e2e
```

## 边界

这是插件 CSS 与元数据分页展示修复，不新增权限或依赖，不修改客户端安装文件、宿主历史、Git 与历史采集逻辑，不执行真实项目暂存、提交或推送。自动化使用实现组件、受控数据与按实际宿主规则构建的夹具，不宣称真实客户端 reload 后已完成点击验收。

![17 文件完整展开](screenshots/card-1.4.10-expanded-light.png)

![窄屏完整展开](screenshots/card-1.4.10-expanded-narrow.png)
