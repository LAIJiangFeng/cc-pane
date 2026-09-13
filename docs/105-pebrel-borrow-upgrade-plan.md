# PRD：CC-Panes 借鉴 Pebrel 的升级计划

> 状态：**PRD（评审中）** · 本文只描述**做什么 / 为什么 / 验收 / 排期**，不含实现细节。
> 参考项目：[Kuddev/pebrel](https://github.com/Kuddev/pebrel)（原 Nebula，~1k stars，Rust + GPUI 的 AI 原生终端，GPL-3.0）。
> **仅借鉴思路自研，不抄码**（许可兼容，但本项目架构为 Tauri 2 + React + xterm.js，实现路径完全不同）。

## 1. 背景与动机

Pebrel 与 CC-Panes 同属「AI CLI 工作区」赛道，但路线不同：

| | Pebrel | CC-Panes |
|---|---|---|
| 渲染 | 自有网格引擎 + GPUI（原生 GPU） | xterm.js + WebGL/DOM（WebView） |
| 重心 | 终端体验本体（SSH/SFTP、分屏、文档阅读器） | 编排层（MCP、skill、daemon、远程访问） |
| 平台 | Windows 成熟，Linux/macOS Preview | Windows/macOS/Linux + Web/Android |

对其 README、CHANGELOG（至 1.7.0）、ROADMAP 做过逐项比对。CC-Panes 在**编排、记忆、远程访问、多 CLI 适配**上明显更强；Pebrel 在**终端原生体验细节**和**发布验收纪律**上有几项 CC-Panes 缺失、且值得借鉴的能力。

**已对齐、无需借鉴**（核对过代码）：分屏/标签/布局保存（`layout_snapshots`）、SSH+SFTP（`ssh_file_service.rs`）、OSC 133/7 shell 集成（`shell_integration.rs`、`osc_state_detect.rs`）、WebGL 渲染、命令面板（`CommandPalette.tsx`）、剪贴板图片粘贴（`save_terminal_paste_image`）、权限 Allow/Deny、MCP 编排（对应其 `agent.delegate`）、会话恢复与后台常驻、i18n/主题、工作区/项目/任务模型。

本计划只收**真实 gap**。

## 2. 目标 / 非目标

- **目标**：补齐 Pebrel 已验证、CC-Panes 缺失的终端 QoL 与 Git 能力；引入可重复测量的终端渲染验收闸门。
- **非目标（明确不做）**：
  - **GPUI/原生渲染替换 WebView**，等于重写整个前端，xterm.js + WebGL 已够用。
  - **Lua 配置 + 热重载**，CC-Panes 设置 UI 体系已成熟，引入 Lua 是体验倒退。
  - **终端内置文档阅读器/公式排版**，CC-Panes 已有 Monaco 编辑器 + Markdown 预览路线。
  - **应用图标配色盘 / 窗口视效（Acrylic 等）**，纯外观，优先级最低，本期不排。

## 3. 功能需求（含验收）

### F1 全局快捷终端（Quake 式下拉） · P0

Pebrel 用全局热键拉出进程级单例终端，隐藏时保留 PTY 与滚动缓冲。CC-Panes **完全没有**（grep `quick terminal` 0 命中）。对「随手问一句 AI / 跑条命令」价值高，且 CC-Panes 已有常驻 daemon，PTY 可复用。

- **F1.1** 全局热键（默认 `Ctrl+Alt+``，可改）从屏幕顶部滑出单例窗口，宽度撑满当前显示器、高度约 40%。
- **F1.2** 隐藏不销毁：PTY、滚动缓冲、光标位置、正在运行的命令全部保留；再次呼出即恢复。
- **F1.3** 重复热键事件合并为一次 show/hide，不抖动；失焦可自动隐藏（可关）。
- **F1.4** 快捷终端内的会话同样进入 CC-Panes 的会话状态机 / 通知体系，可被「在主窗口打开」接走。
  - 验收：呼出 → 跑 `claude` → 隐藏 → 30s 后呼出，对话仍在且可继续输入；改热键后旧热键失效、新热键生效。
  - 复用点：`tauri_plugin_global_shortcut`（`screenshot_commands.rs` 已有用法）、`window_commands.rs` 的 show/hide/resize 基建。

> **落地状态（2026-09）**：F1 已实现，决策为「复用 popup/pane 终端窗口体系」（对应本节开放问题 1 的第一选项）。
>
> - 后端：`QuickTerminalSettings`（enabled/shortcut/autoHideOnBlur/heightFraction，dev 默认 `Ctrl+Alt+Shift+Q`、release 默认 `Ctrl+Alt+Q`，与截图快捷键同样做 dev/release 隔离避免双实例抢热键）；`quick_terminal_commands.rs` 提供 `toggle_quick_terminal` / `hide_quick_terminal` / `quick_terminal_update_shortcut`，单例窗口 label `popup-quick-terminal`、顶部对齐、主显示器全宽、高度按 fraction（clamp 15%-85%）、无边框、置顶、不进任务栏；隐藏不销毁窗口，PTY/滚动缓冲/光标保留。会话 cwd 用用户 home（`createSession` 链路会过 `validate_launch_cwd`，空路径会被拒）。全局热键在 `lib.rs` setup 注册，注册失败仅记日志不阻断启动。
> - 前端：`PopupTabData` 支持 `sessionId: null` + `mode: "quick"`，首挂载时 `TerminalView` 自建会话并回传；quick 模式下自动聚焦输入（首建 + 每次窗口获焦/可见），`autoHideOnBlur` 开启时失焦 120ms 防抖后自动收起（设置读取失败则不隐藏，避免误藏）。设置 UI 在「终端」页新增 Quick Terminal 分区，快捷键改动立即走 `quick_terminal_update_shortcut`（unregister 旧 + register 新），不依赖保存。
> - **F1.4（会话进状态机/通知体系 + 「在主窗口打开」接管）**：后端新增 `QuickTerminalSessionRecord`（`sessionId`/`projectPath`/`title`）登记，提供 `set_quick_terminal_session`/`get_quick_terminal_session` 命令与 `quick-terminal-session-changed` 广播，窗口关闭/销毁时清登记。前端 `quickTerminalService` 镜像该登记（同步读 + 订阅 + 启动补查），`PopupTerminalWindow` 建会话即上报、退出清登记；`useQuickTerminalSessionSync` 在主窗口挂一次订阅。`notificationActions` 的定位/聚焦在跨布局查不到时回退识别快捷终端会话（`locateNotificationSession` 返回 `{ kind: "quickTerminal" }`、`focusNotificationSession` 改走 `focusQuickTerminalWindow`），并新增 `adoptQuickTerminalSession`：claim 写租约 → `markSessionLive`（防主窗口 relaunch 出重复 PTY）→ `panes.adoptSession` 建 tab → 清只读租约 → `destroyQuickTerminal`（只关窗不杀 PTY，主窗口 reattach 同一条会话）→ 聚焦新 tab。`NotificationCard` 显示「快捷终端窗口」定位并仅在快捷终端会话上给「在主窗口打开」按钮，接管成功才 dismiss。
> - 验证边界：**已验证（任意平台）**：`cargo check` 通过；后端 11 个 quick_terminal 单测 + cc-panes-core 7 个设置单测通过；`tsc --noEmit` 通过；popupWindowService/settingsService 22 个前端单测通过。F1.4 前端逻辑由 68 个单测覆盖（`notificationActions` 定位回退/聚焦/接管全路径 + `quickTerminalService` 镜像/订阅/唤窗/销毁 + `useQuickTerminalSessionStore` 引用短路 + `useQuickTerminalSessionSync` 订阅竞态 + `NotificationCard` 定位文案/按钮条件/成功才 dismiss）；其中三处关键不变量（接管前 `markSessionLive` 必须早于 `adoptSession`、store 相同引用不重渲染、订阅 unmount 竞态立即退订）经变异测试确认断言非空转。**Windows-host-required（未真机验证）**：全局热键实际触发、窗口 show/hide 几何与置顶行为、blur 自动收起体感、跨 dev/release 双实例热键共存；以及 F1.4 真机走查——快捷终端跑 `claude` → 通知「聚焦会话」唤出快捷窗口 →「在主窗口打开」实际把同一条 PTY reattach 进主窗口 tab 且不产生重复会话。

### F2 拖文件进终端：shell 引号转义 + WSL 路径转换 · P0

> **更正（实施期核对）**：拖拽本身**已实现**——`terminal/terminalDragDrop.ts` 监听 Tauri `onDragDropEvent`，drop 落在终端宿主内即把路径粘贴进去（`isDropInsideTerminalHost` 做了命区判定，多文件以空格 join）。原 PRD「终端本体不支持」的描述有误，已据代码改正。
>
> **真实 gap**：`formatTerminalFilePaths`（`terminalClipboard.ts:95`）只做 `paths.join(" ")`，**既不 shell 转义、也不按会话类型转换路径**。后果：
> 1. 含空格/中文的路径（`C:\my dir\a.txt`）粘进去会被 shell 拆成两个参数，命令直接错。
> 2. WSL 会话拿到的是 Windows 盘符路径（`C:\...`），在 guest shell 里无效，应是 `/mnt/c/...`。
> 3. SSH 会话拿到宿主本地路径同样无意义（Pebrel 走「先上传再插路径」，本期不做，见下）。

- **F2.1 shell 引号转义**：插入前对每个路径做单引号包裹（POSIX：内部 `'` → `'\''`），消除空格/特殊字符破坏。
  - 验收：拖入 `C:\my dir\a b.txt` → 终端得到 `'C:\my dir\a b.txt'`，作为单一参数。
- **F2.2 WSL 路径转换**：会话为 WSL（`props.wsl` 存在）时，把 Windows 盘符路径转 `/mnt/<drive>/...`，复用后端 `codex_session_service.rs` 已验证的 `drive_to_mnt_path` / `strip_wsl_unc_prefix` 语义（前端镜像一份纯函数 + 单测，含 UNC `\\wsl.localhost\...` 形态）。
  - 验收：WSL 会话拖入 `D:\repos\app` → 得到 `'/mnt/d/repos/app'`；本地会话行为不变（不转换）。
- **F2.3 SSH 会话诚实降级**：SSH 会话拖入本地路径时，**不假装可用**——要么不插入、要么给出「本地路径无法在远端使用，请用 Remote Files 上传」提示（对标 Pebrel 的诚实标注，但本期不做自动上传）。
  - 验收：SSH 会话拖入本地文件 → 不插入无效路径，有明确提示。
- **F2.4（已具备，仅回归测试）** 多文件空格分隔、目录支持、内部文件树拖拽：现状已覆盖，补单测锁定不退化。
  - 验收：拖 3 个文件 → 空格分隔且各自转义；含空格路径不被拆开。

> **落地状态（本次提交）**：F2.1 / F2.2 / F2.3 已实现并通过单测。
> - 新增纯函数模块 `web/components/panes/terminalDropPaths.ts`（无 DOM 依赖，可单测）：`quoteShellPath`（POSIX 单引号转义）、`windowsPathToWsl`（`C:\a\b`→`/mnt/c/a/b`，含 `\\wsl.localhost\…` / `\\wsl$\…` UNC）、`formatTerminalPathsForShell(paths, runtimeKind)`（`local`/`wsl` 转义、`wsl` 额外转换、`ssh` 返回空串）。
> - `terminalDragDrop.ts` 改用该 formatter，新增 `getRuntimeKind` 与 `onUnsupportedDrop` 回调。
> - `useTerminalInstanceInit.ts` 由 `props.ssh`/`props.wsl` 推导运行时；SSH 拖入本地文件弹 `toast.info` 诚实降级（不插入无效路径）。
> - i18n：`panes.sshLocalDropUnsupported` / `sshLocalDropUnsupportedHint`（en + zh-CN）。
> - 测试：`terminalDropPaths.test.ts` 22 例全绿；`tsc --noEmit` 通过。
> - **同源补齐（后续提交）**：剪贴板**粘贴**文件路径也已接同一 formatter —— `terminalPaste.ts` 对 `kind === "file"` 的负载用 `payload.filePaths` 经 `formatTerminalPathsForShell` 重新格式化（不再用裸 join 的 `payload.text`），SSH 同样诚实降级（`onUnsupportedPaths`）。拖放与粘贴共用 `useTerminalInstanceInit.ts` 里同一份运行时推导与提示回调。新增 `terminalPaste.test.ts` 5 例（local 转义 / wsl 转换 / ssh 降级 / 缺省 local / 文本透传）。`terminalClipboard.formatTerminalFilePaths` 保留为负载解析期的占位文本，不再是插入终端的最终来源。
> - **注**：F2.2 原计划「复用后端 `drive_to_mnt_path` / `strip_wsl_unc_prefix` 语义」，本次为前端独立镜像一份等价纯函数（后端命令未导出给前端直调）；语义已用单测锁定，但两份实现需各自维护。

### F3 Git 历史拓扑图 + 三栏冲突解决 · P1

CC-Panes 的 git 能力停在分支/worktree/快照/`get_log`/`get_diff` 层面（`git_service.rs`、`git_service/c2.rs`），**无提交拓扑图、无冲突解决 UI**（grep `GitHistory|resolveConflict` 0 命中）。

- **F3.1 提交拓扑图**：语义轨道渲染 `get_log` 结果，区分 branch / tag / merge / 冲突节点，正确分类本地与远端 ref。
  - 验收：在一个有分叉合并历史的仓库打开历史视图 → 轨道连续不错位，merge 提交显示为汇聚点，本地/远端分支图标可区分。
- **F3.2 三栏冲突解决**：对处于冲突的文件提供 ours / result / theirs 三栏对比编辑，保存即**写回文件并 `git add` 暂存**。
  - 验收：制造一次冲突 → 打开冲突文件 → 三栏可编辑 → 保存后 `git status` 显示该文件已暂存、冲突标记消失。
  - 边界：大文件/二进制冲突要诚实降级（提示用外部工具），不假装可解。

### F4 SSH 每主机代理 + 跳板机 + 连接路线预览 · P1

`SshMachine`（`cc-panes-core/src/models/ssh_machine.rs`）当前字段：host/port/user/auth/identity/default_path/tags，**无 proxy、无 jump host**。（全局 `ProxySettings` 存在，但只用于 CLI 启动环境变量，不作用于 SSH 连接。）

- **F4.1** `SshMachine` 增加可选 `proxy`（SOCKS5/HTTP + host/port/凭据）与 `jump_host`（引用另一台已存机器或内联配置）。serde 向后兼容，旧配置不报错。
- **F4.2** 连接前展示**路线预览**（本地 → 代理 → 跳板 → 目标），凭据掩码显示。
- **F4.3** 代理凭据走 keyring，与现有密码存储同路径，不落明文。
  - 验收：配一台经跳板的内网机器 → 路线预览正确 → 连接成功；旧的不带代理的机器行为不变。

### F5 终端活动徽章补 OSC 9;4 兜底 · P2

CC-Panes 的活动状态权威来源是 hook（`cc-panes-cli-hook`）。Pebrel 额外消费 `OSC 9;4` 的 running/paused/error 作为**hook 之外的兜底**，且不覆盖 hook 的权威状态。注意 `osc_state_detect.rs` 已刻意**不**把任意第三方 OSC 9 当状态跃迁（避免误报），本项要在不破坏该约束的前提下做。

- **F5.1** 识别 `OSC 9;4` 的 running/paused/error 子状态，仅用于标签/侧栏**徽章动画**，不进入会话状态机的权威跃迁。
- **F5.2** hook 已上报状态时，hook 优先，OSC 9;4 不覆盖。
  - 验收：一个发 OSC 9;4 的 CLI → 徽章有运行/暂停/错误动画；同时 hook 也上报 → 以 hook 为准，无状态打架。

### F6 终端渲染验收闸门（工程纪律，非功能） · P1

Pebrel 的 ROADMAP 有三道可重复闸门，这是**最值得学**的部分。CC-Panes 终端渲染最近反复修 WebGL/CJK bug（CHANGELOG 多条），正缺可测量的回归基线。

- **F6.1 性能基线脚本**：可重复的负载注入 + 吞吐/内存测量（对标 Pebrel `perf_baseline.ps1`），新旧构建同负载对比，设定回归阈值（如吞吐不低于基线 90%）。
- **F6.2 视觉对账样张集**：固定样张（boxdraw 全家桶、块/浓度/象限、Powerline 分隔符、CJK 对齐标尺、256 色/真彩）注入终端并截图归档，PR 里新旧并排对账。
- **F6.3 IME 人工清单**：中文输入全链路（预编辑、候选窗跟随光标、提交、退格）的可勾选验收清单，发版前人工过一遍。
- **F6.4** 三道闸门写进发版 checklist，任一不过即阻断发布。
  - 验收：CI 或本地能一键跑出性能数字与样张截图；连续两个版本对比可见回归/持平判定。

> **更正（实施期核对）**：F6.1 / F6.2 的**测量工具仓库里已经有了**，原计划「正缺可测量的回归基线」只对了一半——缺的是**跨版本判定与发版纪律**，不是采集能力：
> - 已有：`scripts/summarize-performance.mjs`（+ 单测）把 soak 的 `performance.jsonl` 汇总成报告；`summarize-desktop-acceptance.mjs` 做单构建桌面体检（进程内存首尾中位数、CPU、queuedChars、contextLosses、layoutSwitch 四联 WebGL）；`smoke-terminal-static-replay.mjs` 用 headless Chromium 对 dom/webgl × history/bottom 四组做**像素级** `before.equals(after)` 对账；`check-bundle-size.mjs` / `check-theme-contrast.mjs` / `verify-xterm-build.mjs` 是既有预算闸门。
> - 真缺口（grep `threshold|baseline|regression` 在 scripts/ 0 命中）：没有任何工具把**两份报告按阈值判定回归/持平**，也没有一份发版 checklist 把它们串成阻断规则；IME 全链路只有零散教训记录（`docs/27-linux-clipboard-fix.md`），无验收清单。
>
> **落地状态（本次提交）**：
> - 新增 `scripts/compare-performance.mjs`（纯函数 `compareReports`/`formatComparison` + CLI）：比较两份 `summarizePerformance` 报告，默认容差 10%（「不低于基线 90%」），回归 → 退出码 1 可作 CI 闸门；缺数据/基线为 0 的指标记 `na` 不误判。配 `compare-performance.test.mjs` 8 例（node:test）。
> - npm 接线：`perf:summarize` / `perf:compare` / `perf:test` / `smoke:static-replay`。
> - 新增 `docs/106-terminal-release-gates.md`：把闸门 1（性能回归）/ 2（视觉对账）/ 3（IME 人工清单）写成发版前逐项勾选、任一不过即阻断的清单，并按 `AGENTS.md` 标注 Windows-host-required 边界。
> - **诚实标注未竟**：F6.2 的固定样张集目前只覆盖恢复路径 + CJK 文本，**尚未**纳入 boxdraw 全家桶 / 块·浓度·象限字符 / Powerline / CJK 对齐标尺 / 256 色·真彩渐变；扩展点在 `terminal-static-replay.html`（或新增 fixture）注入样张后截图归档，已在 106 文档里写明。IME 清单是人工兜底，未自动化。

### F7 小体验项（打包做） · P2

- **F7.1** 浅色背景下终端文字自动对比度增强（保留本就可读的配色）。
  > **更正（实施期核对）**：该行为**已具备**——`useTerminalInstanceInit.ts` 的 xterm 构造自 `8c7a827f` 起就无条件设 `minimumContrastRatio`，xterm 渲染时按背景动态把**跌破阈值**的前景色推离背景、达标色原样保留，正是本条需求语义。实测量化（WCAG 2.x，对各自背景）：`LIGHT_TERMINAL_THEME`（`#ffffff`）17 个 ANSI 文字色里 **12 个**低于 4.5（`brightWhite` 1.19 / `brightYellow` 1.27 / `brightCyan` 1.42 / `brightGreen` 1.67 / `yellow` 2.34 / `cyan` 2.34 / `green` 2.46 …），`DARK_TERMINAL_THEME` 仅 2 个（`black` 1.00 / `brightBlack` 3.47）。即该选项在浅色主题下是**承重**而非装饰，PRD「需新增」的描述有误，已据代码与实测改正。
  >
  > **真实 gap（本次提交 af5b2757）**：这份保证此前是**无人看守的裸字面量 4.5**，且在测试里重复硬编码一份，被调低或误删都不会有任何信号。故不重建既有行为，而是把它固化为可审计、可回归的契约：
  > - 新增纯模块 `web/components/panes/terminalContrast.ts`：`MINIMUM_TERMINAL_CONTRAST_RATIO` 为**唯一真源**（终端构造与测试共用）；`parseHexColor` / `relativeLuminance` / `contrastRatio`（WCAG 2.x 口径，与 `scripts/check-theme-contrast.mjs` 同算法但面向 ANSI 色表）；`auditTerminalPaletteContrast` 逐色度量并标出需 xterm 介入者。
  > - `useTerminalInstanceInit.ts` 改读该常量并补语义注释；`TerminalView.test.tsx` 既有可读性断言改为引用共享常量，消除阈值双写。
  > - 新增 `terminalContrast.test.ts` 14 例：WCAG 数学对齐已知参考值（黑白 21:1、同色 1:1、`#767676` 对白底恰在 4.5 档）、**浅色主题确有大量低对比色**（证明自动增强非空转）、**达标色不被标记**（锁定「保留本就可读的配色」）、阈值敏感性、壁纸 `rgba()` 背景不误判。
  > - 无行为变化。`tsc` 干净；全套前端 **5470** 测试通过；`lineRatchet` 绿；`scripts/check-theme-contrast.mjs` 退出 0。
- **F7.2** 文件树中 git-ignore 的文件/目录用斜体区分。
  > **落地状态（本次提交 cf9c3799）**：已实现并通过单测。新增独立「忽略路径」通道（不与现有 git 变更/状态模型混淆）：core `get_ignored_paths_compat`/`parse_ignored_paths_z`（`git status --porcelain=v1 -z --ignored=matching`，忽略目录整体上报一次、不递归展开）→ Tauri 命令 `get_git_ignored_paths`（已注册 lib.rs）→ web parity 路由 `GET /api/git/ignored-paths`。前端 `filesystemService.getGitIgnoredPaths` + `useFileTreeStore.ignoredPaths/loadGitIgnoredPaths` + `utils/gitIgnore`（`createGitIgnoreMatcher`，子节点继承祖先忽略态）；`FileTreeNode` 命中时斜体 + `data-ignored` + 「已被 Git 忽略」title，i18n en/zh-CN 已加。测试覆盖 core 单测+集成、Tauri 命令、web parity、gitIgnore 单测、FileTree 斜体/继承、store mock。
  > 顺带修复：F2 提交把 `useTerminalInstanceInit.ts` 撑过 500 行红线导致 `lineRatchet` 失败，按「拆分而非抬基线」策略把输入装配抽到 `terminalInputIntegration.ts`（ce8492d1），无行为变化，全套前端 5453 测试通过。
- **F7.3** 通知点击定位到源 pane，即使该 tab 已被移到别的窗口。
  > **落地状态（本次提交 4b6bb483）**：已实现并通过单测。gap 是：tab 弹出后主窗口里那个面板只剩「已弹出」占位符，原 `focusNotificationSession` 聚焦的是占位符，终端真身其实在 `popup-<tabId>` 独立窗口里——点了等于没定位。
  > - Rust 新增命令 `focus_popup_terminal_window`（已注册 lib.rs）：`is_popup_window_label` 守卫只放行 `popup-` 前缀窗口（拒绝把主窗口/布局切换器/截图窗顶到前面），窗口不存在返回 `false`，最小化时先 `unminimize` 再 `show`+`set_focus`（Windows 上 `set_focus` 不还原最小化窗口）。`create_popup_terminal_window` 同步加 label 前缀校验。2 条守卫单测覆盖接受/拒绝。
  > - 前端 `popupWindowService.focusPoppedOutTab(tabId)`：用记录的 label 调命令，命令抛错或返回 false 都收敛成 false（不让通知点击炸掉）；Web 运行时恒 false。5 条单测覆盖聚焦成功/窗口已不存在/未记录 tab/命令抛错/Web 运行时。
  > - `focusNotificationSession` 改 async：tab 弹出时先试聚焦真身窗口，成功则主窗口内也对齐到该面板并返回 true；唤不回（窗口已关但回收事件丢失）才**自愈**——store 弹出态 + service label 映射两份一起 `markTabReclaimed`（reclaimKey 递增让 TerminalView 重挂），退回主窗口内定位。4 个调用方（NotificationCard/InputCard/HistoryPanel/useTrayActions）适配 async，dismiss 与聚焦结果解耦。5 条 `notificationActions.test.ts` 覆盖未弹出/弹出命中/弹出窗口已丢自愈/会话不在布局/主窗口内也找不到。
  > - 无行为回退。`cargo fmt`/`clippy -p cc-panes --all-targets` 干净；`tsc` 干净；全套前端 **5480** 测试通过（+10）；`lineRatchet` 绿。
  > - **平台边界**：`focus_popup_terminal_window` 的窗口还原/抢焦点属 **Windows-host-required**，此处仅验证了守卫逻辑、命令注册、前端分支与自愈回退（纯逻辑层）；真机多窗口聚焦行为需在 Windows host 上确认。
- **F7.4** 终端内联图片（OSC 1337 / iTerm2 协议），接 `xterm-addon-image`，供 AI CLI 输出图表。
  - 验收：各自独立可验；F7.4 需确认与现有 WebGL/DOM 渲染路径不冲突（CLAUDE.md 已记录 WebGL 透明/花屏坑）。
  > **落地状态（本次提交 a8381e01，feat(terminal)）**：已实现为**可逆开关，默认关闭**，并通过单测。`@xterm/addon-image@0.9.0` 仍是 beta 质量，且默认每个终端持有 **128MB** 图片存储 + 单图 2^24 像素上限，在多窗格管理器里内存放大明显，故坚持「默认 off、懒加载、保守限额、不阻塞启动」落地，不做常开。
  > - Rust：`TerminalSettings` 新增 `inline_images_enabled: bool`（`#[serde(default)]`），默认 `false`；补 legacy-config 解析回退单测（旧配置无此字段也安全降级到关闭）。
  > - 前端：`web/types/settings.ts` + `useSettingsStore` 默认 `false`；新增懒加载边界模块 `web/components/panes/terminal/terminalImageAddon.ts`（**唯一**运行时取值入口）：动态 `import("@xterm/addon-image")`、模块级 Promise 缓存（失败不缓存）、把内存上限压到 `storageLimit=32MB` / `pixelLimit=2^22`（均低于 addon 默认）、`showPlaceholder=true`、保留 `enableSizeReports`（IIP/SIXEL 需 CSI 像素尺寸查询，仓库无 `windowOptions` 冲突）。`attachTerminalImageAddon` 取回落定时复查 `isMounted()`，已卸载则不附着，任何异常一律吞掉记 `debugLog`，绝不拖垮终端本体。
  > - `useTerminalInstanceInit.ts` 在渲染器装配后**门控 fire-and-forget** 调用（`settings.terminal.inlineImagesEnabled` 为真才触发）；addon 经 `term.loadAddon()` 注册，随 `disposeTerminalView` 的 `term.dispose()` 一并销毁，无需另起 ref。
  > - 设置 UI：`TerminalSection` 新增 `terminal-inline-images` 开关（i18n en/zh-CN 标签+提示+搜索关键词），`settingsRegistry` 登记可搜索项。
  > - **构建分包修复**：`vite.config.ts` 的 `manualChunks` 原本把 `node_modules/@xterm/*` 一律卷进 `"xterm"` chunk，会让 addon-image **随每次终端打开静态加载**，使「默认关闭」形同虚设。在通配规则**之前**插入 `@xterm/addon-image → "terminal-image-addon"` 专属规则，把它拆成只可经动态 import 到达的独立 chunk。验证：拆出后 `terminal-image-addon-*.js` 独立存在、`index.html` 不 modulepreload 它、首屏 gzip 仍 **848.1 kB**（与加 addon 前一致）、`check:bundle` 通过、`verify-xterm-build` 通过。
  > - 测试：`terminalImageAddon.test.ts` 6 例（保守上限钉住 addon 默认之下、**`storageLimit` 单位 MB 守卫**——断言其落在 addon 真实校验区间 `[0.5, 1000]`，防「误传字节数」回归、挂载中正常附着、取回期间已卸载不附着、附着抛错吞掉记日志、模块级缓存）；`lazyBoundaries.test.ts` 新增 2 例（addon-image 懒边界唯一入口 + vite manualChunks 规则顺序守护，防回归再被卷进 xterm chunk）；`settingsRegistry.test.ts` / `TerminalSection.test.tsx` 各 +1（搜索项登记 / 开关从默认关闭态可切到开启）。
  > - 验证结果：`cargo fmt` / `clippy -p cc-panes-core --all-targets -D warnings` 干净、`cargo test -p cc-panes-core settings::` 55 通过；`tsc --noEmit` 干净；全套前端 **5490** 测试通过（+10，与 F7.3 的 5480 对比；本轮新增 `storageLimit` 单位 MB 守卫）；`lineRatchet` / `noRawText` 绿（`useTerminalInstanceInit.ts` 492 行，未越 500 红线）。
  > - **降级与平台边界（诚实声明）**：
  >   - 图片**不会随休眠（SerializeAddon VT 重放）恢复**——属可接受降级，已在 i18n 提示与代码注释写明。
  >   - addon-image 用独立 overlay canvas（`canvas.xterm-image-layer`），不扰动 WebGL/DOM 渲染器本体。
  >   - **真实引擎验收（已闭环）**：单测全部 mock 掉 `@xterm/addon-image`，只证接线/选项/生命周期，证不了「真 addon + 真 xterm6 是否真出图」。故另起一次性 headless 验收脚本：esbuild 打包**真实** `@xterm/xterm@6.0.0` + **真实** `@xterm/addon-image@0.9.0`，并 `import` 生产 `buildImageAddonOptions()`（杜绝手抄偏差），写入真实协议字节后读取 overlay canvas 像素、轮询真实 `ImageStorage`（`_images.size` / `getUsage()`）至异步解码落地。先后两轮真实引擎均通过：
  >     - 首轮 headless **Chrome 153**；次轮换用 **`msedge.exe` 152.0.4191.66**——与本机已安装的 **WebView2 Runtime 152.0.4191.66 同一 Chromium 构建号**（即 Tauri 实际内嵌的引擎），证据更强。
  >     - **OSC 1337（iTerm IIP）**：写 8×8 纯红 PNG → 观测到 `canvas.xterm-image-layer`，解码 `mime=image/png`/8×8，采样像素 `[220,20,20,255]`（与编码红色逐字节一致），`storageImages=1`、`storageUsage=0.000256MB`（=8×8×4B）。
  >     - **SIXEL**：写 12×6 纯绿 DCS-q 块（`#1;2;0;100;0`，Pu=2 为 RGB%）→ 采样像素 `[0,255,0,255]`（纯绿一致），WASM 解码器实跑（`decWidth=12/decHeight=6`）、`storageUsage=0.000288MB`（=12×6×4B）。
  >     - 生产 `buildImageAddonOptions()` 在真 addon 校验下**零 console 报错/告警**（`storageLimit=32` 落在合法 MB 区间）。
  >     - 验收中实测复现三类「mock 测不出」的真实契约/坑并据此加固：①`storageLimit` 单位是 **MB 非字节**，误传字节会被真 addon `console.error` 后**静默回落 10MB**——已加单测守卫钉住单位契约；②SIXEL 解码器是**异步**创建（`DecoderAsync→WASM`），就绪前写入会被静默丢弃——属上游行为，真实 PTY 场景由持续输入自然覆盖，已在脚本注释记录；③IIP 解码同样是**异步**的（`createImageBitmap(blob)→storage.addImage`），断言必须轮询存储而非定长 sleep；且 OSC 头 `size=` 必须等于**真实解码后字节数**，base64 padding 会让 `floor(b64len*3/4)` 过计 1 字节，触发解码器 size 校验失败、`mime=unsupported` 静默丢弃（实测：size=111 失败、size=110 成功）。这些是**生成端**（CLI/脚本）构造 IIP 序列的契约，本仓库为渲染接收端，生产代码无需改动。
  >   - **残留平台边界（诚实声明，已收窄）**：嵌入式 `msedgewebview2.exe` 无法独立 headless 驱动（它是 Win32/COM 控件，须由宿主进程经 WebView2Loader 装配——实测探针确认其 standalone `--dump-dom` 与本地 fetch 均无响应）。但次轮已用**与 WebView2 Runtime 完全同构建号（152.0.4191.66）**的 `msedge.exe` 出图，证明渲染引擎层面一致。仍属 **Windows-host-required**、本环境不可验的，仅剩 Tauri 把该引擎**嵌入 WebView2 宿主后**的最终视觉合成、与本仓库 WebGL 透明/花屏已知坑（CLAUDE.md）在同屏多窗格时的叠加表现、以及多图滚动/休眠恢复的真机观感。
  >   - **真宿主验收（本轮闭环，提交见下）**：在真 Tauri dev app（窗口标题 `CC-Panes [DEV]`，内嵌 WebView2 Runtime 152.0.4191.66）里用 CC-Panes 自带控制面（`cc-panes-ctl call browser_evaluate`）向 app 内浏览器标签注入**生产模块**（`terminalXtermModules.loadXtermRuntime` + `terminalImageAddon.attachTerminalImageAddon`，选项即源码 `storageLimit=32MB/pixelLimit=2^22`），并接通**真实 daemon PTY 活管道**：`POST /api/sessions`（cliTool=none → PowerShell conhost PTY）建会话 → `POST /api/sessions/:id/write`（204）让 PTY 真身向 stdout 写 OSC 1337 → daemon 经 `/ws/:id` 逐字节转发（8 帧/911B，含哨兵 `LIVE_PIPE_MARKER_XYZ`）→ 注入的真 xterm+F7.4 addon 消费 → 真 `canvas.xterm-image-layer`（800×460）采样 **352,320 个不透明像素全部 `[255,0,0,255]`**；合成器截图（1968×1419）解码出 **792,240 纯红像素（占帧 28.37%）**，目视确认红色图块 + 哨兵行 + PS 提示符同屏。至此「Tauri 嵌入 WebView2 宿主后的最终视觉合成」这一残留边界**已闭环**。
  >   - **新增平台边界（ConPTY 吞 SIXEL，诚实声明）**：活管道实测发现 Windows conhost/ConPTY 会**吞掉子进程写出的 DCS/SIXEL 引导序列**：原始 PTY 字节捕获中 `ESC P`（`1b 50`）**一次都不存在**（仅存命令回显文本里的字面 `Pq`），故 SIXEL 在 Windows PTY 路径上到不了终端；OSC 1337 则完整穿过 ConPTY（本轮活管道逐字节证实）。SIXEL 的**渲染能力**已由真引擎轮（Chrome 153 / 同构建号 msedge 152）单独证明，故该缺口是 **Windows 控制台宿主限制**而非 F7.4 缺陷：Windows 上 PTY 内联图实际可用协议为 OSC 1337，SIXEL 需非 conhost 终端（如 WSL/Unix PTY）方能端到端。
  >   - **验收边界补充（诚实声明）**：上述真宿主像素证据的附着入口是**生产模块** `terminalImageAddon.attachTerminalImageAddon`（与 app 面板同一段生产代码、同一保守选项），但调用方是注入脚本而非 app 面板的 `useTerminalInstanceInit` 门控钩子；门控本身（默认 off、开关可切、开启才触发附着）由单测覆盖（settings store / TerminalSection / terminalImageAddon / lazyBoundaries），「app 自有面板实例内的像素级复验」未做。不再追加 GUI 自动化验证以免干扰真实使用中的 app；如需该级证据，应在隔离实例上以 `inlineImagesEnabled=true` 启动后人工目验。
  >   - **app 自有面板门控挂载实证（零侵入，来自真实使用）**：dev app 重启后，用户自开的 codex 会话（`projectPath=学习笔记`）自然打出 `[terminal-debug] image.addon.attached` 日志，payload 含 `instanceId/paneId/tabId/cliTool=codex/renderer=dom/xtermBuffer=normal` 等**面板专属字段**，且 `storageLimitMb=32/pixelLimit=4194304` 与源码 `terminalImageAddon.ts` 保守选项逐字一致。该日志仅在 `attachTerminalImageAddon` 成功 `term.loadAddon` 后打出（`terminalImageAddon.ts:81`），其唯一调用点是门控钩子 `useTerminalInstanceInit.ts:385`，面板专属字段由 app 面板的 `debugLog` 包装注入——故证明 `inlineImagesEnabled=true` 时门控挂载在 **app 自有面板组件**（非注入 harness）里真实触发并附着成功。结合上文真宿主活管道像素证据（同一生产 attach 路径出图 792,240 纯红像素），F7.4「门控→附着→渲染」闭环成立。唯一未单独做的是「app 面板实例内像素级复采样」（需抢焦点截图或主 webview CDP，用户工作中二者均不可用/不宜），但渲染路径已由同一生产模块逐像素证明，无追加必要。
  >   - 因 addon 仍为 beta，默认关闭是有意保守选择；如上游成熟或出现稳定替代，可重评是否转默认开启。

## 4. 非功能需求

- **兼容**：`SshMachine` 等模型新增字段一律 `#[serde(default)]` / `skip_serializing_if`，旧配置零报错。
- **安全**：SSH 代理凭据走 keyring，不落明文、不进日志；路线预览掩码显示。
- **性能**：快捷终端隐藏时不销毁 PTY 但停止请求动画帧（对标 Pebrel 的帧调度改进）；性能基线脚本本身要轻量可重复。
- **平台边界**：遵守 AGENTS.md 的 WSL/Windows 验收隔离——快捷终端、全局热键、拖拽路径转换属 **Windows-host-required**，不可在 WSL 声称已验证。

## 5. 优先级与排期

| 批次 | 内容 | 理由 |
|---|---|---|
| **第一批（P0）** | F1 快捷终端、F2 拖拽路径 | 改动可控、日常体验收益最大 |
| **第二批（P1）** | F6 验收闸门、F3 Git 历史+冲突、F4 SSH 代理/跳板 | F6 先行，为后续渲染改动兜底；F3/F4 是实打实的能力补齐 |
| **第三批（P2）** | F5 OSC 9;4 徽章、F7 小体验项 | 锦上添花，可穿插 |

每项独立成 commit / PR，遵循 Conventional Commits。建议顺序：**F6 先落地**（建立测量基线），再做 F1/F2，然后 F3/F4，最后 F5/F7。

## 6. 待评审决策点

1. **F1 快捷终端**是否复用主窗口的 pane 体系，还是独立轻量窗口？（影响会话状态机接入方式）
2. **F3.2 冲突解决**是否复用现有 Monaco 编辑器组件，还是自绘三栏 diff？
3. **F6 闸门**跑在 CI（Windows runner）还是仅本地脚本？CI 上截图对账的成本需评估。
4. **F7.4 内联图片**与 CLAUDE.md 记录的 WebGL 透明/花屏限制是否冲突，需先做一次 spike。

## 7. 参考（仅对照思路，不抄码）

Pebrel 对应实现（GPL-3.0，与本项目同许可）：
- 快捷终端 / 全局热键：`nebula_app/src/gpui_shell/`（Windows quick terminal singleton）
- 拖拽路径：CHANGELOG 1.7.0「dragging files into local and WSL terminals」
- Git 历史/冲突：CHANGELOG 1.5.0「Git history view / three-column conflict-resolution tab」
- SSH 代理/跳板：CHANGELOG 1.6.0「SOCKS5/HTTP proxy and jump-host settings」
- OSC 9;4 徽章：CHANGELOG 1.4.1「OSC 9;4 running, paused, and error states」
- 验收闸门：`ROADMAP.md` 三道闸门 + `scripts/perf_baseline.ps1` / `scripts/visual_parity.ps1`
