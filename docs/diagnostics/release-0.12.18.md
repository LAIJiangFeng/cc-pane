# v0.12.18 稳定性发布验收

状态：代码与自动验证已推进至发布候选；尚未打 tag。Windows 中文 IME 人工验收待反馈，公开发布保留此门禁。

发布分支基于远端 `dev/v0.12.18@cea038ce`，叠加已审阅的本地终端稳定性修改。共享源工作树和用户正在使用的安装实例未替换。

## 实施范围

- 终端输入/输出队列、在途写入取消、生命周期、IME 与图集修复。
- 休眠与 checkpoint 按原始尺寸恢复，重放期间保护布局。
- orchestrator 端点持久化后宣布就绪，退出时按 PID/启动身份登记停止。
- 安装升级保留 daemon；更新清单必须包含五个平台、便携包、APK 和可验证签名。
- SSH 非阻塞握手限时；跳板在写入受阻时仍处理反向数据。
- daemon 接收 Hook 状态时记录时间，30 秒内普通输出不覆盖状态，过期后允许回退。
- 保留远端快捷终端、Git 冲突、SSH 路线、进度徽章与默认关闭的内联图片功能。

本地 cc-switch 导入、其他界面半成品及新功能 backlog 不纳入。

## 已执行验收

| 项目 | 状态 | 证据与边界 |
|---|---|---|
| Windows TypeScript、workspace check、Clippy | PASS | 本地退出码 0；后续 Rust 修复另由最终提交 CI 复验 |
| 全量前端、Rust 基线 | PASS | `848677f0` CI 的 Windows/Linux/macOS 后端、前端与构建全绿 |
| SSH 修复 | PASS | 75 个 SSH 相关测试；原生认证路线 9 次全部成功 |
| 最新终端状态修复 | PASS | Windows 终端相关 141 测试；原生 daemon 验证 Thinking + 37% 进度、清除后仍 Thinking、31 秒后新输出回退 Active |
| Runner 生命周期 | PASS | 独立配置、真实启动/复用/自然退出/再启动；Windows focused 退出码 0 |
| 静态恢复像素 | PASS | DOM/WebGL × 历史/底部四组；框线、块字符、Powerline、中文标尺、256 色/真彩样张 |
| 原生休眠恢复 | PASS | 仅测试计时器缩短到 3 秒；隐藏后实例确实释放，同一 PTY 无新增输出，恢复内容截图逐字节一致 |
| WebGL 透明、主题、bundle | PASS | Windows Edge / RTX 4090；构建检查退出码 0 |
| 快捷终端 | PASS | 真实 Windows 全局热键显示/隐藏/再显示；通知按钮接管同一 PTY/PID |
| Git 冲突与拓扑 | PASS | 临时仓库产生真实 UU 冲突，生产 UI 保存后暂存；merge/tag/remote-ref 拓扑四行 |
| 本地 / WSL Unicode | PASS | 实际子进程收到并回显中文、Emoji 和混合文本 |
| OSC 显示与状态 | PASS（分层） | WebView2 实际显示 37% 徽章；新 daemon 通过真实 PTY 与 Hook HTTP 路径保留权威状态 |
| 自然退出 | PASS | 尾部输出先于退出事件，真实 exitCode=7，WebSocket 关闭 |
| 端点生命周期 | PASS | 验收实例正常退出后 manifest 为 stopped，保留重连凭证 |
| 短时性能比较 | PASS | 同负载两分钟/构建，各 8 个聚焦样本；10% 容差，见下表 |
| 发布工具测试 | PASS | 性能工具 11 测试 + 发布资产门禁 9 测试 |
| Windows IME 人工全链路 | PENDING | 候选窗口已准备；连续组词、候选窗、退格、粘贴、切 pane 须用户实测 |
| 最终提交 CI、包、更新签名 | 发布时检查 | tag 前要求最终提交 CI 全绿；发布工作流在公开前下载资产并验证 minisign |

休眠全窗口截图因光标/悬浮控件变化不完全相同，内容区域截图一致；没有把前者记为通过。SSH 测试使用临时认证服务与随机凭据，未连接业务主机。

## 性能记录

基线为正式 `v0.12.17@01ddca2e`，候选为 `4e6863d1` 优化构建，两个可见终端、100 ms 输出周期、45 秒预热、120 秒采样。后续 Hook 修复另做定向原生验证，本表不冒充该后续提交的重新采样。

| 指标 | 基线 | 候选 | 变化 |
|---|---:|---:|---:|
| JS 堆峰值 | 46,652,678 B | 39,665,858 B | -15.0% |
| 终端积压峰值 | 412 字符 | 0 字符 | -100% |
| 前端更新最大间隔 | 15,004 ms | 15,010 ms | +0.04% |
| 定时器最大延迟 | 15.1 ms | 14.4 ms | -4.6% |
| 采样最大耗时 | 23 ms | 25 ms | +8.7% |
| 单进程私有内存峰值 | 442,245,120 B | 277,438,464 B | -37.3% |
| 输入回显中位数（附加观察） | 182.5 ms | 157 ms | -14.0% |

原始 `maxFrontendAgeMs` 为 695 / 14,712 ms，旧比较器因此退出 1。两端均每 15 秒上报，差异来自两个采样时钟的启动相位。工具现比较连续更新间隔，并把原始年龄作为下限以捕获停报；原始值和首次失败均保留。没有放宽 10% 容差，也没有重采或挑选样本。方法与停报回归测试见 [106 发布闸门](../106-terminal-release-gates.md)。

## 记录位置与发布顺序

工作空间 `evidence/release-0.12.18-20260915/` 保存本地日志、截图与结果。主要记录：

- `candidate-desktop-nptG6h/results.json`：原生恢复、快捷终端、Git、自然退出。
- `candidate-desktop-JWMC72/results.json`：认证 SSH、本地/WSL Unicode、性能、IME 待验。
- `final-daemon-tCjKxt/result.json`：修复后实际 daemon 的 Hook/OSC/超时验证。
- `baseline-perf/`、`candidate-perf/`、`perf-comparison-final.json`：完整采样与比较。
- `hook-status-tests-result.json`、`runner-final-result.json`：最后定向测试退出码。

临时 profile 与认证 fixture 文件属于私有验收环境，不上传；交付只引用不含凭据的结果。

发布顺序：补齐 IME → 核对最终提交 CI → tag `v0.12.18` → 所有发布矩阵与签名门禁成功 → 核对公开资产与更新清单 → 同步稳定/开发远端分支。任一必需项 FAIL/PENDING 不按 PASS 发布。
