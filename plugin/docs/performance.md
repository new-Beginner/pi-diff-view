# v1.1.0 加载优化

> 目标文件首屏已在本机测试进入 0.1–0.2 秒区间；这不是所有仓库、所有冷启动的保证，也不是 PI-Desktop 宿主验收结果。完整 Git 扫描仍可能需要数秒。

## 安装

在 PI-Desktop 插件页安装 `plugin/dist/local.diff-view-1.1.0.piplug`，手动确认权限并重新加载插件。新包不会删除旧历史。

## 测量结果

同一机器，Windows + Node.js + 本机 Chrome。轮次数据包含 256 个路径，每份前后快照约 1002 行，各有一行替换；内容寻址使相同内容共用两份 blob。三次独立页面导航，不清除操作系统磁盘缓存；不能当作 256 份独立大文件的磁盘冷读结果。

| 测量范围 | 优化前（三次，ms） | v1.1.0（三次，ms） |
|---|---|---|
| 定位、review 文件元数据、目标 diff 首页的后端读取 | 557.1 / 300.8 / 306.4 | 34.1 / 32.2 / 31.1 |
| 页面导航至 diff 首次绘制，包括 JS/CSS、桥接往返 | 1031.7 / 1020.6 / 1040.2 | 109.8 / 133.1 / 107.4 |

前后版本从相同快照读取。后端旧版使用 `turnSummary → review → file`，新版使用 `selectTarget → review → file`；浏览器通过本地 HTTP 测试桥接调用实际 ReviewService/SnapshotStore/JobQueue，非模拟 diff。没有测量宿主 Electron iframe 建立、文末按钮到页签打开及真实宿主调度成本，不能据此承诺宿主端到端 200ms。

真实 Git 另测：2000 个基础跟踪文件、600 个修改，已暂存完整扫描约 1.7 秒，未暂存约 2.6 秒；Git 对象读取均仅两个批处理进程，分别共 10 / 9 个 Git 进程。工作树原始字节扫描、路径校验和可写文件重验没有省略。时间随机器负载变化。

## 做了什么

- 新捕获在保存时记录与 before/after 哈希绑定的增删统计，打开文件目录不再为所有文件读取正文和计算 diff。
- 精确 runId 跳转只验证对应轮次/文件元数据，不枚举无关历史，不先请求整轮卡片统计。
- 文件目录并行检查 blob 类型、大小与存在性；首选文件及随后选中的文件才读取正文、验哈希。旧记录没有统计时保留精确计算回退。
- 快速后台任务最多等待 40ms 就直接返回结果；慢任务继续使用短请求轮询，无写操作重试。桥接改为每个 JS realm 滚动一秒最多六次请求，允许短突发，保留超时与载荷限制。
- 已知 root/runId 的首屏优先读取 diff，非关键的历史/设置 bootstrap 延后 180ms；bootstrap 完成不再触发重复 review。
- 预取改为一份低频相邻首页；点击共享未完成请求。正文缓存按桥接实例隔离，分页继续保持原始顺序。
- Git 对象以 `cat-file --batch-check/--batch` 有界批量读取，按字节解析二进制帧；工作树最多 16 路并发，不使用会运行项目 filters 的工作树 diff。

候选恢复操作只有在实际读取、验证正文后才执行，并继续重新验证授权、最新捕获、恢复状态及工作区内容。不缓存可变工作树来跳过冲突检查。

## 复现检查

```bash
npm run typecheck
npx vitest run tests/integration/open-performance.test.ts tests/integration/git-performance.test.ts tests/unit/transport-performance.test.ts
npm test
npm run build
E2E_BROWSER='C:/Program Files/Google/Chrome/Application/chrome.exe' npm run test:e2e
```


最终检查：类型检查与构建通过；单元/集成 139 项通过、1 项 Windows 下跳过；Chrome 浏览器回归 48 项通过（包含首轮 review 未完成时切换目标）。官方 PluginPack 校验通过，唯一警告是原有 Agent/renderer 高风险权限需用户显式授权。未执行真实宿主安装验收。
设置 `PI_SCRATCH_DIR` 可指定临时仓库和浏览器工件目录。性能测试输出实测值，不设置与机器有关的 200ms 硬断言；验证 256 路径打开只 hydrate 目标的两个快照、不扫描历史，缺失/损坏快照禁用恢复，预取去重、滚动限速、Git 二进制/BOM/CRLF、容量预算、filters 不执行和操作冲突拒绝。

仍有原来的安全上限：捕获最多 256 路径，审查列表最多 100 项/约 32KiB，正文默认每页 80 行；选中文末列表之外的文件仍会提升到审查首项。不用减少上限或仅显示加载骨架冒充 diff 秒开。
