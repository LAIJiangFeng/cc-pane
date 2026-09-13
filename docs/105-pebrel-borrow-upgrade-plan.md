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

### F7 小体验项（打包做） · P2

- **F7.1** 浅色背景下终端文字自动对比度增强（保留本就可读的配色）。
- **F7.2** 文件树中 git-ignore 的文件/目录用斜体区分。
- **F7.3** 通知点击定位到源 pane，即使该 tab 已被移到别的窗口。
- **F7.4** 终端内联图片（OSC 1337 / iTerm2 协议），接 `xterm-addon-image`，供 AI CLI 输出图表。
  - 验收：各自独立可验；F7.4 需确认与现有 WebGL/DOM 渲染路径不冲突（CLAUDE.md 已记录 WebGL 透明/花屏坑）。

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
