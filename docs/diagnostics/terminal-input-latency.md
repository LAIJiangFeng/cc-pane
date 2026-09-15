# DEV 输入延迟测量（2026-09-14）

此次测试限定于 Windows `CC-Panes [DEV]` 0.12.18、WebView2 本地调试端口 9223。正式版 0.12.17 未替换。采样只保存时间、数量和匿名事件分类，不保存按键值、拼音文本或终端输出。

## 当前结论与回退范围（2026-09-14）

用户最终明确：重启的是整台 Windows，随后原有 release 也恢复流畅。这个对照说明本轮 DEV 改动不是恢复流畅的必要条件；此前的等待与缓冲数字保留为现象证据，不能据此认定是某个应用模块、输入法或驱动导致。下文是按时间保留的诊断过程，历史阶段的“当前生效”不代表最终代码状态。

用户批准收缩后，仅撤回以下试验：

- 撤销 Tauri、daemon 与 PTY 路径新增的 `terminal-input.slow` 分段计时，保留 `write_terminal` 的异步命令与 `spawn_blocking`，以及原有错误返回、权限和输入保序。
- 输出合批统一恢复 16ms 预算，移除 2ms 交互预算及专用判定接口；仍从首个片段计算固定截止时间，避免持续小片段不断推迟投递。原来不超过 1KiB 的短回显立即投递路径保留。
- 移除 Windows 候选字体同步封装及对应装配和封装测试，由 xterm 管理输入框；不恢复先前已撤掉的 120ms 预览保留或 Windows textarea 样式覆盖。

保留中文标点交给 xterm 的正确性修复、性能快照 DTO 字段修复、键盘闲置队列立即发送、无尺寸变化时跳过冗余布局及 DEV 逐键日志减负。共享工作树中的其他 WebGL、回放、流控和并行任务改动不在本次回退范围。历史测试工具和数字证据留在诊断目录，不自动运行或注入正式版。

本次只修改源码并验证，不替换已安装 release、不刷新固定测试前端，也不为装载回退而重启当前程序。正在运行的旧 DEV/固定前端如仍存在，需后续重新构建并启动才会采用这些源码回退。

回退前文件副本及只含本轮回退的补丁位于 `D:\temp\ccpanes-input-scope-rollback-20260913T214302Z\`。已通过 Windows 前端 6 文件 / 83 项定向测试、`tsc --noEmit`、Rust 修改文件格式检查；输出时钟 4 项、输入保序 2 项、交互回显快路 4 项、daemon 写入权限 2 项定向测试及 `cargo check --locked --offline -p cc-panes --lib` 均退出 0。一次交互快路筛选命令没有命中测试，未计为验证通过，随后按实际测试名补跑的 4 项均通过。以上不是新的 Windows 输入手感验收。

## 已修正的代码问题

- `performanceService.ts`：去掉传给性能记录器的前端专用字段 `blocked`、`pendingCallbacks`。Rust 的 DTO 禁止未知字段，此前整份快照因此被拒绝；实际 DEV 的前端样本曾陈旧数十分钟。修正后已观察到 8 个终端的有效快照，采样时前端年龄约 391ms。
- `write_terminal`：将阻塞的 PTY/daemon 写入放入 `spawn_blocking`，通过异步命令等待结果，避免在原生 UI 线程等待。前端每会话队列以及后端每会话输入锁继续负责顺序和互斥，查询回复的来源分类不变。此改动通过编译并已进入 DEV，但对照测试没有证明它消除了输入尖峰。

Tauri 官方明确说明，同步命令默认在主线程运行：[Calling Rust from the Frontend](https://v2.tauri.app/develop/calling-rust/)。这个线程风险有源码依据，不能据此直接认定它就是所有拼音延迟的根因。

## 用户手工输入的采样

在原有 8 个 DEV 终端上捕获 34 次按键、33 次组合更新、6 次组合提交，以及 7 个提交后的输出渲染相关样本。

| 指标 | 中位数 | 最大值 |
| --- | ---: | ---: |
| 按键事件排队 | 0.7ms | 49.6ms |
| 拼音更新事件处理 | 1.1ms | 2.5ms |
| 拼音更新到下一帧机会 | 3.6ms | 6.7ms |
| `onData` 到后续已解析输出的渲染 | 104.2ms | 229.4ms |

这 7 个渲染相关样本不能排除同一 CLI 的其他输出，因此还使用独立回显进程复测。手工样本冻结在 `manual-input-capture-0022.json`。

## 独立回显对照

在同一 DEV 页面临时创建测试终端，使用真实 Tauri IPC、daemon、Windows PTY 和 Node 原始输入回显。所有会话均指定 `workspaceName=ccpane-workspace`，每次结束后只关闭本次创建的会话并移除临时视图。正常应用当时停留在首页，不能把该结果视为多终端输出压力测试。

每轮含英文 24 次、直接插入中文 8 次、经过浏览器组合事件后提交中文 12 次。逐次等待匹配的输出和渲染，下一次再发送。

| Node 回显场景 | 修改前中位数 / 最大值 | 异步写入后 | 原生消息通道对照 |
| --- | ---: | ---: | ---: |
| 英文 | 6.8 / 17.5ms | 6.2 / 18.2ms | 6.6 / 11.9ms |
| 直接插入中文 | 28.1 / 84.7ms | 36.2 / 53.4ms | 27.4 / 31.7ms |
| 组合后提交中文 | 95.7 / 282.3ms | 76.6 / 400.2ms | 62.6 / 102.2ms |

在第一轮 Node 测试中，中文组合提交到收到输出的中位数约 94.2ms，而收到输出后的解析约 0.1ms、到渲染回调约 1.3ms。优先继续定位提交后的通信与 PTY 处理，不应把布局读取单独认定为主要瓶颈。

原生消息通道对照仅在本次 DEV 页面触发 Tauri 自带的 postMessage fallback：让一次无业务副作用的性能状态查询走原有回退路径，随即恢复 `fetch`。认证和命令权限仍由 Tauri 原有实现处理，未复制或导出 invoke key。该通道选择只持续到页面刷新，未作为正式产品配置；目前观察到改善，但样本小、未随机交错、未证明唯一因果。

## 采样工具

```powershell
node scripts/dev-terminal-input-probe.mjs watch 9223 D:/temp/ccpanes-dev-input-measure-20260914/postmessage-manual
node scripts/dev-terminal-input-probe.mjs snapshot 9223
node scripts/dev-terminal-input-probe.mjs stop 9223
```

`watch` 安装采样并每 5 秒覆盖写一份 `input-latest.json`。最多保留 256 个样本，采样 10 分钟后自动停止；关闭或刷新页面会清理监听。DEV 重建断开调试连接后需要重新安装。工具通过 DEV 的 React refs 查找已有 xterm 实例，新建终端需重新安装才能测量其输出渲染相关时间。

`nextFrameMs` 是动画帧回调机会，`afterFrameTaskMs` 是其后的任务回调，不代表已经测得屏幕像素呈现时间。浏览器合成组合事件也不等同于真实微软拼音；原生候选窗出现前的延迟不在此 DOM 探针的测量范围内。

本机对照脚本和 JSON 位于 `D:\temp\ccpanes-dev-input-measure-20260914\`。其中保留了修改前文件副本、三轮 Node 对照数据和手工输入基线。

## 验证状态

- PASS：13 项前端采样与性能记录器测试；Windows TypeScript 检查。
- PASS：`cargo.exe check -p cc-panes --lib --offline`，退出码 0；本次 Rust 文件格式检查。
- PASS：DEV 自动重建并以新进程启动，真实 PTY 对照完成且测试会话清理成功。
- PARTIAL：中文提交仍有明显尾延迟，尚未达到原生终端手感；当前原生消息通道仍需用户手工输入对照。没有宣称问题全部修复。

## 后续优化：固定输出批处理截止时间

用户第二轮输入采样累计 444 个记录，环形窗口保留最后 256 个。其中 76 个提交到后续渲染的相关样本，中位数 57.7ms、最大值 525.6ms。英文/中文比例与上一轮不同，不能直接根据中位数计算改善比例。该采集随后因 DEV 重建而断开，已冻结为 `postmessage-manual-capture-004049.json`。

进一步检查发现，旧合批循环反复调用 `recv_timeout(16ms)`，收到新片段后又重新等待 16ms；持续到达的小片段可以不断推迟刷出时间。现在增加 `OutputBatchClock`：

- 从一批首次收到数据起计算截止时间，新片段不会把截止时间推后。
- 普通输出保留 16ms 合批预算，最近 100ms 内有用户输入时使用 2ms 预算。
- 小于等于 1KiB 的交互回显继续保留原来的立即投递路径；大段 TUI 重绘仍受大小上限和流控约束。
- 超时、达到大小阈值或交互快路刷出后清除时钟。输出字节和 `endSeq` 顺序不变。

### 连续输出基准

使用独立 Node 进程每 4ms 产生一段带序号和生成时间的合成文本，通过真实 Windows PTY 和 daemon WebSocket 接收。这个测试量的是连续输出转发，不是系统输入法候选窗的呈现时间。

| 后台构建 | 收到的数据 | 中位延迟 | P95 | 最大延迟 |
| --- | ---: | ---: | ---: | ---: |
| DEV 仍在运行的旧 daemon | 120/120 | 220ms | 510ms | 583ms |
| 新 daemon，独立数据目录 | 120/120 | 17ms | 32ms | 33ms |

旧 daemon 的启动时二进制哈希为 `1454d1e405cd5880a250c5b7b78f5f2342e22c1c2dfd1752db3d627d90ec5bb8`；通过验证并暂存的新构建为 `4f9731b72ade0547331f5f0fcbb291174b57d5bc9d4beba2809f6f58e4d12819`。新旧构建也包含工作树其他已有修复，因此不把所有差异都归因于本次计时器改动；计时器不被连续片段推迟的行为另有确定性单元测试。

首次隔离运行因固定的启动加运行超时只收齐 87 段，按失败处理，没有把它算作通过。测试随后将启动等待和实际输出等待分开，并保留 120/120 的完整性断言。Windows 原生按键注入对照因 DEV 未保持前台被保护逻辑停止，未作为输入性能验证通过。

验证：流控筛选测试 25 项、批处理筛选测试 10 项通过；四个 Windows 辅助二进制构建通过。隔离 daemon 已关闭，测试未结束任何现有 DEV 会话。

### 当前生效边界

新二进制、旧版本回滚副本以及 DEV 数据库/配置备份位于 `D:\temp\ccpanes-dev-input-measure-20260914\upgrade-ready\`。准备阶段 DEV 有 8 个存量终端，重启前复核为 4 个，包含 HSEIP 项目。用户明确授权“重启”后，已完成切换；正式版未替换。

对暂存的同一新二进制再次运行完整性验证，仍为 120/120，延迟中位数 18ms、P95 32ms、最大 33ms；见 `batch-after-confirmation.json`。准备包的四个二进制哈希均已复核，DEV 数据库采用 SQLite 在线备份。

### 已完成 DEV 后台切换

2026-09-14 01:47 左右，更新前再次进行 DEV 数据库在线备份和配置备份，随后将四个已验证的辅助二进制同步至源码打包目录和 DEV 运行目录。旧映射中的二进制移至回滚目录，DEV 原后台 PID 54572 已关闭。

DEV 沿用自身的恢复启动流程拉起新后台 PID 74244，其启动时哈希已确认与验证包一致。通过 DEV 前端创建并关闭一个验证会话，确认桌面端已经连接新后台；DEV Web 访问服务也通过应用自带接口重启，继续使用原端口 18080。

在实际运行的 DEV 新后台再次测试连续输出，120/120 完整，中位数 17ms、P95 32ms、最大 33ms，见 `batch-live-after-upgrade.json`。随后新增测试终端并尝试采样，输出目录为 `after-backend-upgrade-manual`；DEV 自动重载中断了这一轮，没有获得可用于验收的手工输入复测。整体微软拼音手感仍需用户复测，不以该连续输出基准替代。

## 原版 xterm 对照与 Windows 键盘拦截回归（2026-09-14）

用户提出先试原版 xterm。将本机安装的 `@xterm/xterm` 6.0.0 与 npm 官方同版本包核对，`lib/xterm.js`、`lib/xterm.mjs`、`css/xterm.css`、`CompositionHelper.ts`、`CoreBrowserTerminal.ts`、`WriteBuffer.ts` 均逐字节一致。

独立测试页位于 `D:\temp\ccpanes-xterm-clean-test\index.html`，使用官方默认配置/样式，通过公开 `onData` / `write` 做本地回显，旁边放普通文本框。没有接入 CC-Panes 的快捷键、输入日志、队列或 PTY；没有采集用户输入内容。样例仅支持换行和简单退格，不模拟完整 shell 行编辑。

1. 独立 Edge 窗口：用户反馈“这个很流畅”。
2. 关闭该 Edge 测试窗口，以独立 WinForms WebView2 宿主打开同一页面：用户再次反馈“流畅”。运行时为 `152.0.4191.66`，初始化与页面结构检查通过。源码及状态文件在 `webview2-host/`；当时仅一个测试窗口，CC-Panes DEV 为零，正式版保留。

这两轮是主观手感对照，支持优先检查 CC-Panes 的接入与完整往返链路；不能推出所有 WebView2 宿主配置均等价，也不能推出 PTY 延迟已解决。

### 已复现并修复的接入缺陷

`terminalCustomKeyHandler.ts` 原先对所有平台的 `isComposing` / `keyCode === 229` 返回 `false`。xterm 6.0.0 会在调用自己的 `CompositionHelper.keydown` **之前**检查这个返回值，因此 Windows 输入法不经过 `compositionstart` 的中文标点输入被跳过。

新增测试使用真正的 xterm 6.0.0 DOM 事件链，而非模拟 `onData`：对原版与安装应用拦截器的终端发送相同事件。修复前，原版能发出 `，`、`。`、`！`，应用接入版均无输出，3 个对照用例失败。修复后，Windows 将输入法事件交回 xterm，仍跳过应用快捷键处理；其他平台的现有 workaround 和平台 guard 优先级保留。

验证：新对照测试、Linux IME guard、快捷键 store、终端复制粘贴按键测试共 4 文件 / 100 项通过。该结果证明一个输入正确性缺陷得到修复，尚未证明此前几十至数百毫秒的延迟全部由此引起。此修复目前在源码中，未启动 DEV 或替换正式版。

### 恢复 Windows 默认输入框样式与历史用途

用户授权先恢复原版行为后，移除 `index.css` 中本轮新增的 Windows `.xterm-helper-textarea` 覆盖，包括 `opacity: 1`、透明字色、额外 padding、固定初始位置和最小宽高。原规则备份在 `D:\temp\ccpanes-xterm-clean-test\rollback\windows-ime-override.css`。xterm 官方 CSS 和运行时的 `_syncTextArea` / `CompositionHelper` 继续管理隐藏输入框位置、尺寸和组合文字。保留候选字体同步、主题配色、Mac 样式、平台兼容 guard 与输出流控。

历史目的已对照实际提交与当前代码：

- `7e0d79d0`（08-25）：避免应用快捷键打断 IME 组词。全局快捷键应让行，但 Windows 的 xterm 自定义处理器也返回 `false`，连上游自己的 IME 分支一起跳过，适用范围过宽。
- `5089593c`（06-23）：Linux 的 textarea/selection 清理误用于 Windows，导致粘贴后输入法失效、下一键被吞。该提交将非 Linux 的清理改成 no-op，本轮保留。
- `213b32fd`（06-24）：输入 FIFO/合批随粘贴与输入稳定性修复引入，用于减少零碎调用并保持顺序；当前键盘路径已取消固定 8ms 等待，队列仍保留顺序保证。
- 多终端输出流控与回放分块用于限制后台输出占用和队列积压，不能因输入优化整体删除。
- 本轮 Windows 样式覆盖的注释假设默认隐藏输入框会拖慢 TSF，但没有证明该覆盖必要。上游会动态定位 textarea，两轮默认配置手工对照均流畅，故撤回该试验；不将撤回本身宣称为已定位全部延迟。

这一阶段完成的是 Windows 输入分支和样式恢复。逐键字符统计合并以及真实 PTY 往返的进一步定位尚未实施，不混入本轮对照变量。

验证用前端构建位于 `D:\temp\ccpanes-xterm-clean-test\candidate-build\dist`，Vite 构建与现有 xterm 产物检查均退出 0。构建仍报告 CSS 模板、循环分块及大块体积警告。对编译后的 CSS 解析确认：官方 textarea `opacity: 0` 规则存在，Windows 覆盖消失，Mac 专用规则保留；结果在 `candidate-build/verification.json`。该产物包含当前共享工作树的其他改动，仅用于后续对照，不是独立发布包。当前独立 WebView2 窗口仍是原版对照页，未将此构建加载到 CC-Panes。

## 固定前端 DEV 实机与 WebGL 刷新采证

用户随后授权启动 CC-Panes DEV。通过 `ccpane-workspace` 的 Runner profile `5ab9206a-5319-413f-be47-086ff26b9d5f` 启动，四个后台程序重新构建并同步，前端从上述已验证的 `candidate-build/dist` 固定提供，Tauri 使用 `--no-watch`。关闭独立原版对照宿主后，仅一个 DEV 窗口运行。用户再次反馈“还是卡”，因此前两项修复未完成整体流畅度验收。

### 已核对代码真正生效

- DEV PID `129552`，主页面 `http://localhost:14200/`，加载 `main-DVnFW2Eq.js`。实际 HTTP 返回内容与验证构建逐字节相同，SHA-256 为 `13ac297432b221e5c86b5e03ed350475e8285d8e89ab8f21b252bdac53e10353`。
- 9 个现存 xterm 的 Windows 输入法自定义处理器均允许进入上游分支；9 个隐藏输入框计算样式均为 `opacity: 0`、`min-width: 0px`、`min-height: 0px`。
- 新 daemon 运行目录与刚构建的二进制一致，SHA-256 为 `5efc289ae657926b21962527b2389c28072073883f160964f31ca0217bd9f4e6`。

详细启动和核对记录：`D:\temp\ccpanes-xterm-clean-test\launch-dev\`。这部分证据替代上一节“尚未加载到 CC-Panes”的阶段状态。

### 第一轮 180 秒刷新计数：未捕获打字

仅在当前 DEV 安装有时限的观测器，计数和计时后仍调用原方法，不切换渲染器，不重启，不采集输入文字。现场 9 个终端中 1 个可见，使用 WebGL。**这一轮 DEV 未获焦，按键/组合事件计数为 0，只能作为未打字的基线。**

| 可见终端指标 | 180 秒观测 |
| --- | ---: |
| `term.write` 调用 | 1091 次 |
| WebGL `renderRows` 调用 | 1097 次，约 6.1 次/秒 |
| `renderRows` JavaScript 调用耗时 | 平均约 0.59ms，最大 3.5ms |
| 额外 `term.refresh` | 6 次，均来自 `webgl.heartbeat` |
| 图集清理 / 渲染器重建 / context loss | 均为 0 |
| 检查时输出排队、在途写入 | 均为 0 |

15 秒 JavaScript CPU 采样中，脚本执行约 0.493 秒，布局约 0.0018 秒，样式重算约 0.037 秒；CPU 采样大部分为 idle。不能把 `renderRows` 的同步 JavaScript 耗时当作 GPU 完成或屏幕像素呈现时间。这些数据未显示持续的重建/清图集循环，但仍缺少打字时对照，不能排除输入期间出现不同表现。

原始计数与 CPU 汇总位于 `D:\temp\ccpanes-xterm-clean-test\live-audit\`：`idle-baseline.json`、`cpu-summary.json`、`cpu-profile.json`。同时调用现有性能记录器写入 incident marker。

为后续手工输入重新开启最长 10 分钟采样，`render-latest.json` 每 5 秒覆盖；输入环形记录最多 256 条、刷新分桶最多 1800 条、各 IPC resource duration 最多 64 条。自动到期或显式 stop 会卸载本次观测器，`pagehide` 同样清理。观察范围补充 FitAddon/layout 调用与 IPC Resource Timing；Tauri 的 `invoke` 不可包装时不会声称测到了该 hook，结果通过 `ipcHookInstalled` 标识。

### 用户输入后的采证结果

用户回复“好了”后，主动停止并卸载本次探针，冻结到 `live-audit/typing-capture-20260913T191107Z.json`，汇总在 `typing-summary.json`。累计 164 个 DOM 输入事件，其中 77 个 keydown、77 个 compositionupdate 的 `isTrusted` 为 true；10 个 compositionend 的该标记为 false，不将它们宣称为已确认的原生提交事件，也不据此推断存在某个应用注入补丁。

| 本轮指标 | 中位数 | P95 / 最大值 |
| --- | ---: | ---: |
| 按键排队（77 次） | 0.6ms | 4.1 / 21.9ms |
| 拼音更新事件处理（77 次） | 1.1ms | 1.9 / 2.0ms |
| 拼音更新到下一帧机会 | 4.1ms | 6.6 / 8.3ms |
| `write_terminal` Resource Timing（13 次） | 109.6ms | 1333.2 / 1333.2ms |
| `record_terminal_input` Resource Timing（11 次） | 4.5ms | 1367.1 / 1367.1ms |
| onData 到后续已解析输出的渲染（12 个相关样本） | 103ms | 195.6 / 195.6ms |

输入附近 24 个一秒分桶合计 132 次渲染，约 5.5 次/秒、峰值 9 次/秒，未高于未打字基线的量级。同期有 154 次写入和 3 次显式 refresh。整轮图集清理、重建、context loss 均为 0；FitAddon.fit 共 1 次、proposeDimensions 共 3 次，都不在探针定义的输入后 150ms 窗口内。未见逐键 fit/重建/清图集的调用循环。

当前证据把重点转向终端写入命令的完整往返：这个耗时包含 WebView2/Tauri 调度、Rust 到 daemon 通信、锁等待和 PTY 写入确认，不能直接称为纯网络延迟或已经定位到某个 Rust 锁。另一个独立问题是逐键字符统计存在长尾；后台目前已有累计计数逻辑，因此也不能未经测量就称每次按键都同步写数据库。下一阶段应分段测量这些等待，再决定如何改动。当前结论不等于完全排除 GPU 呈现或原生候选窗问题，后两者不在探针测量范围内。

## 分段对照：中文编码、字体与 WSL

用户要求继续拆查，并询问是否中文字体导致特别慢。开始执行时，原 DEV、daemon 和调试端口均已退出；通过既有固定前端 Runner 恢复单个 DEV，仍使用已验证前端，未改正式版。新 Runner 实例为 `472083a9-f713-4a6d-87b8-d105a02e22fd`。因此下列受控对照与此前人工采样不属于同一进程生命周期，也不具有完全相同的 CLI/UI 负载。

### 固定字节的真实 PTY 往返

在当前 DEV 后台创建并清理独立临时会话，不给用户原终端发送字符。Node 原始输入进程接受固定测试帧，中文 `中文` 和英文 `abcdef` 均为 6 个 UTF-8 字节，返回仅含测试序号的 ASCII 确认。确认通过 daemon WebSocket 读取，不创建 xterm 视图，不绘制中文，也不保存用户输入。每个条件先预热，再交错轮换 8 个正式样本。

先测 Windows 本地，再从 DEV SQLite 的启动元数据确认：先前人工输入的 `e33d0ac4-eb7e-486e-983a-96d843b87841` 是 `codex / wsl`，使用默认 Ubuntu。补测使用同一个 Ubuntu 和工作目录 `/mnt/d/SynologyDrive/workspace/ccpane-workspace`，测试进程仍为原始输入 Node，**没有将 Node 结果等同于 Codex TUI**。

| 环境与路径 | 英文写入中位数 | 中文写入中位数 |
| --- | ---: | ---: |
| Windows，经 Tauri 命令 | 5.8ms | 6.8ms |
| Windows，直连 daemon，每次新建 TCP 连接 | 2.45ms | 2.62ms |
| Ubuntu，经 Tauri 命令 | 5.6ms | 5.8ms |
| Ubuntu，直连 daemon，每次新建 TCP 连接 | 2.11ms | 2.22ms |
| Ubuntu，直接 HTTP 客户端 | 1.98ms | 2.19ms |

Tauri 的 commandMs 在 WebView2 内计时；直接 TCP 路径模仿当前 Rust 客户端的单次建连、整包 write 和读到连接结束。Ubuntu 直接 TCP 的建连中位数约 1.1ms，收到首响应约 2.1ms，未复现等待服务器断连导致的固定百毫秒延迟。中位数之差不作为严格的逐阶段分解。

证据：`live-audit/route-comparison.json`、`route-comparison-wsl.json`。Windows 首次清理校验误把 `output-flow` 对不存在会话返回的 HTTP 200/null 当成失败，命令退出 1；随后通过该临时会话的 `/status` 返回 404 独立确认已清理，见 `route-cleanup-verified.json`。修正该诊断脚本的校验后，WSL 测量和清理均退出 0，见 `route-comparison-cleanup-wsl.json`。数据完整性与这次校验器错误分开记录。

### 组合事件后的只读 IPC 对照

仅在现有 DEV 页面短暂添加独立 textarea，使用 CDP 生成固定的普通输入或组合输入；无字符进入任何终端。每次事件都调用同一个只读命令，保持返回结果不变，测试完成移除 textarea 并恢复原焦点。组合结束采用 0ms 任务延后，模仿 xterm 提交时机。每个条件排除预热后 8 个样本。

- 同步版本查询：普通中文输入后中位数 2.6ms，组合中文输入后 3.4ms。
- 异步 daemon 状态查询（包含 `spawn_blocking` 与 Rust→daemon）：普通中文输入后中位数 5.9ms，组合中文输入后 7.3ms；相应英文为 8.3ms 和 6.6ms。

证据：`ime-ipc-comparison.json`、`ime-ipc-async-comparison.json`，两次命令退出 0，临时输入框均确认移除。CDP 组合事件不是微软拼音实机候选窗测试，不能用此宣布真实输入法与 Tauri 的交互已完全排除。

另外核对当前 Windows PTY 依赖：`portable-pty 0.8.1` 的 ConPTY writer 是 `filedescriptor 0.8.3`，其 Windows `flush()` 直接返回 `Ok(())`，不会调用 `FlushFileBuffers` 等待读取方。因此没有依据通过删除这里的 `flush()` 来消除 100ms 等待。

**当前边界：** 受控 Windows/Ubuntu 路径都能在几毫秒内处理中文，未显示“中文编码天然慢”或基础传输固定等待 100ms。结合此前低耗时的绘制与组词事件，字体不是目前最有证据的主因；但本轮未做实际终端字体 A/B，也未复现完整应用的原生输入和负载，尚不能把剩余延迟归因于 Codex、字体、Tauri 或某一个锁。

### 用户纠正问题范围：不限于 WSL Codex

用户明确指出“不是 wsl codex，几乎所有场景输入都有”。前文的 `codex / wsl` 仅是抽样会话元数据，不能把通用卡顿收窄成该 CLI 的问题。简化的 Node 回显和独立 textarea 测试未覆盖完整 TerminalView、应用字体、全局快捷键、后台轮询和窗口调度等共同因素，不能根据其低延迟宣布某个共同层已被完全排除。

下一阶段按完整 CC-Panes 界面的共同输入路径采证；普通搜索框/设置输入框是否同样卡顿尚待用户确认。为弥补此前把大量 IPC 归到 `other` 而丢失命令定位信息的不足，当前 DEV 增加最长 10 分钟的通用观察器：覆盖终端 textarea、普通 input/textarea 与 contenteditable，只记录元素类别、事件类型、时间和各 IPC 命令名，不记录按键值、输入文字、URL 查询参数或命令参数。命令聚合最多 96 类，输入/请求各保留最后 512 条，长任务最多 128 条，每 5 秒覆盖 `live-audit/common-input-latest.json`，到期或 pagehide 自动卸载。

### 连续中文输入：临时输入优先测试

用户进一步明确：少量输入可以流畅，连续输入中文会卡顿，并授权先尽可能优化输入限制做测试。为避免继续在单个 CLI 上推断，直接在现有完整 DEV 页面安装可撤回的输入优先开关，无页面重载、无渲染器切换、无正式版修改。

开关只调度以下后台查询/数字统计的 HTTP IPC：系统统计、终端状态、任务绑定、上下文/用量查询、待办提醒、字符计数、性能快照和窗口最大化状态。编辑控件有输入时，让它们等待约 350ms 的安静期；队首等待达 1 秒且存在后台名额时可继续派发，避免连续输入让状态查询一直饿死。后台最多 2 个在途请求、32 个等待请求；队列满时回到原始调用，不丢请求。1 秒是优先级让行预算，不是后台服务本身的响应上限。

`write_terminal`、输出 ACK、resize、复制粘贴、设置写入、布局/会话保存及创建/关闭等生命周期调用不进入该队列。保持请求参数、响应、错误与 abort 语义；不生成本地假回显，也不移除输入顺序保证。普通键盘原有固定 8ms 等待已在此前修复中取消，本轮不重复宣称新增此改动。

右下角“输入优先：开/关”允许在同一 DEV 切换对照；“退出测试”、页面关闭或最多 10 分钟到期会恢复原 fetch 并继续投递待发请求。相关代码仅在 `D:\temp\ccpanes-xterm-clean-test\live-audit\`，未加入产品默认行为。`test-input-priority.mjs` 的 6 项检查通过，覆盖关键输入绕行、后台并发、开关关闭时排空、abort、原始错误/恢复及关键操作直通。

采样同步记录开关状态、队列等待与命令耗时，前一阶段数据冻结在 `before-input-priority.json`，当前结果继续覆盖 `common-input-latest.json`。这是一项后台请求竞争假设的试验，是否改善连续中文输入仍需用户实际对照，尚未宣称流畅度问题已解决。

### 输入优先试验未解决，转入简化渲染对照

用户反馈“还是有点卡，完全无法跟上我打字的速度”。核对记录确认此前开关确实处于开启状态，捕获 96 次终端 keydown、90 次 compositionupdate、13 次 compositionend，存在连续中文输入，并非未采到输入或开关失效。38 次 `write_terminal` 累计耗时约 3307ms，平均约 87ms，最大约 365ms；仍未达到手感验收。数据冻结在 `priority-mode-failed-live.json`，临时输入优先调度已撤回。

同轮还观察到若干长时间后台操作（CLI 枚举、会话创建、会话索引刷新等）。仅从 Resource Timing 不能判定它们是否占住 UI 线程，不能把这些长请求直接当作卡顿根因。后续采样单独保留最近 256 条写入请求和 256 条超过 100ms 的请求，避免用户回复前的空闲轮询覆盖关键写入记录；支持时另记录长动画帧中的脚本耗时与强制布局耗时，不保存参数或输入文字。

在同一个 DEV 的现有终端上启动第二项可撤回对照：DOM 渲染，字体改为 `Consolas, "Microsoft YaHei UI", monospace`，关闭光标闪烁、额外对比度增强与重叠字形缩放。原配置中英文主字体已是 Consolas，但中文 fallback 包含打包的 Maple Mono NF CN；本轮同时避开 WebGL 和这条打包字体路径。未创建新终端、未重建 PTY，也不修改 settings store 或正式版配置。

当前已对页面内 10 个现存 xterm 应用该配置，包括 2 个可见终端；界面右下角显示“简化渲染测试：DOM＋系统字体”，可点“恢复原配置”。最长 10 分钟后恢复，若正在组词则等当前组合结束；恢复后释放本次保存的终端引用。新建的终端不自动加入本次临时对照。记录在 `simple-renderer-enabled.json` 和 `simple-renderer-verification.json`。

这是一次组合条件的简化试验：即使改善，也需要之后分别加回字体或 WebGL 才能归因；当前等待用户在新配置下连续输入，尚未宣称修复。

### 用户将现象细化到“选字阶段”

用户进一步说明中文候选/选字阶段明显卡顿。仍需区分候选框弹出、翻页或移动选择本身迟缓，与按空格/数字选定后汉字回显迟缓；这两者不能仅凭“选字慢”合并归因。输入法具体类型也待用户确认。进程检查见到 ChsIME/TextInputHost，但进程存在不等于已确认当前窗口正在使用哪一个输入法配置。

简化渲染观察期记录了 4 轮 composition（共 47 次 update），这些输入发生在测试开启期间；检查时该 10 分钟模式已到期并恢复原配置，记录冻结为 `simple-renderer-user-candidate-lag.json`。后续不要误以为当前仍运行 DOM/系统字体模式。

浏览器长动画帧中存在 60～140ms 的 React 离散事件处理，但与现有终端输入事件逐时刻核对后，这几个长帧均不落在记录的组词区间内，暂不能称为选字卡顿根因。此前 DOM/帧机会与 IPC 数据不包含原生候选窗的完整响应时间。下一轮应针对已确认的输入法和具体选字步骤取证，避免继续把单个 CLI、字体或后台往返当作既定根因。

### 用户将排查重点转向持续增长的记录与缓冲

用户明确要求检查“记录缓冲一直加”，不再把输入法作为预设原因。本轮保留原 DEV 和终端，仅查看容量与计数，不导出终端文本、输入文字或堆快照。

- `terminalCast.ts` 确实存在未设容量上限的输出录制数组，且 `stopRecording` 返回数组后未释放模块内引用。但在 2026-09-13 21:03:06 UTC 的当前 DEV 实测中，录制为关闭、事件数为 0，不能把这一静态缺陷当作此次卡顿根因。后续无输出时断点未命中，记录为未知，没有用旧值冒充实时状态。
- 同一快照有 5 个 xterm：4 个隐藏终端各 24 行，可见终端 62 行；textarea 长度、xterm 待写入量、前端输出排队与在途量均为 0。可见终端累计接收 22,057,563 字符是计数，并不代表这些字符全部保留在缓冲。后续可见缓冲缩为 12 行。上述均为空闲快照，不排除连续输入期间短暂积压。
- 输入 FIFO 源码限制为每会话 4 Mi 字符、全局 8 Mi 字符，保留量包含排队与在途请求，完成后递减，闲置时删除会话条目。字符用量统计在 Rust 中按日期、CLI、工作空间累计数字，flush 用 `mem::take` 取走 pending map，没有逐字追加文字历史。
- xterm textarea 会保留组合输入上下文，需在连续输入时观察其长度；不能在组词中直接清空。回放、文本历史和画面快照另有自己的保留与淘汰路径，不能仅从累计字节计数推断泄漏。

现有固定前端 `main-DVnFW2Eq.js` 上安装了最长 5 分钟的容量探针，首次成功启动于 2026-09-13 21:07:44 UTC。每 500ms 采样一次，最多 600 个容量样本、512 个输入事件、128 个长任务和 128 个序列化耗时；每 5 秒覆盖 `D:\temp\ccpanes-xterm-clean-test\live-audit\buffer-growth-latest.json`。只保留长度、数量、时刻和耗时。

输入探针计量 `terminalService.write` 发起到原 Promise 完成之间的待完成字符/调用量，保持原返回 Promise 和错误语义，不把它称为仅 FIFO 排队耗时。另采集 textarea 长度、xterm 行数和输出积压，已有 serializer 可用时记录完整快照序列化耗时。到期或 pagehide 恢复包装函数并移除事件监听；不改 settings、不清历史、不重启 DEV。安装阶段尝试从调试器闭包跨调用读取模块变量失败，失败探针的定时器、观察器和包装已清理，最终输入采样改为现有 service 对象计量，未让调试断点持续参与打字。首次确认文件正常更新时尚无用户输入，不能宣称复现或修复。

### 缓冲采样收到“卡了”的结果

本次采到 28.145 秒连续输入，103 次真实 keydown、104 次真实 compositionupdate、10 次 compositionend（后者 `isTrusted=false`，来源仍未证明）。收到反馈后停止并恢复探针，完整数字记录冻结在 `live-audit/buffer-growth-frozen.json`，汇总为 `buffer-growth-summary.json`。

| 指标 | 本轮结果 |
| --- | --- |
| textarea 最大保留长度 | 51 个 UTF-16 代码单元 |
| 输入待完成量峰值 | 1 笔调用、24 个 UTF-16 代码单元 |
| 完成写入 | 10 笔，最长 1572.7ms；另有一笔 565.7ms |
| 输入窗口内输出排队 | 500ms 快照中均为 0；短暂在途最多 1857 个字符 |
| 输入窗口内 JS 堆 | 开始约 53.0MB，最后约 49.4MB，期间 44.1～81.5MB，有回落 |
| 按键排队 | 中位 0.8ms、P95 4.2ms、最大 38.3ms |
| 画面序列化 | 2 次，2.2ms / 1.9ms，均发生在本轮组词之前 |

整轮 20 个长任务中，19 个发生在用户开始打字前；输入窗口内有一个 68ms 长任务，位于 24 字符那次提交之后。不能用整轮最大内存约 158MB 或输入前的长任务，代替用户打字时的证据。500ms 容量快照也不能排除更短的输出积压。

这轮没有支持“文字历史持续膨胀导致卡顿”的数据，确认的异常是单次写入 Promise 的长等待。该耗时仍包含进入 Tauri 前后的调度、后台通信、锁和 PTY 确认，不能直接称为 PTY 本身耗时，亦不能证明它解释了候选框阶段的全部卡顿。既有 IPC Resource Timing 缓冲已经被启动阶段的 250 条记录填满；冻结文件中的那些请求不属于本轮输入，禁止用来拼接这次延迟。

为继续拆分，在 `write_terminal`、daemon 写入 handler 和本地终端 writer 路径增加 `terminal_input_timing` 数字记录，只记录超过 25ms 的阶段：应用线程池等待/后台操作/恢复，daemon 准入/线程池/后台，输入锁、session writer 查找、writer ACK 和底层 PTY write。保留原返回结果、输入保序和权限校验，不记录输入文字；写入现有轮转日志，不增加历史数组。没有慢记录不能单独当作某段已证实快速，还需核验运行二进制和日志可用性。
