# 106 · 终端渲染发版验收闸门（F6 落地）

> 配套 `docs/105-pebrel-borrow-upgrade-plan.md` 的 F6。借鉴 Pebrel ROADMAP 的
> 「可重复闸门」纪律：把已经存在的性能/视觉/IME 验证手段，收敛成发版前**必须逐项
> 过、任一不过即阻断**的清单。
>
> 本文不新增能力，只做两件事：(1) 补齐唯一缺失的**跨版本回归判定**工具
> `scripts/compare-performance.mjs`；(2) 把散落脚本接成 npm/CI 可重复入口并写成清单。

## 平台边界（先读）

遵守 `AGENTS.md` 的验收隔离：

- **当前环境可验**：性能报告汇总、跨版本回归比较、静态回放像素对账（headless
  Chromium/Playwright）、bundle 预算、主题对比度、xterm 构建校验。
- **Windows-host-required**：真实 WebView2 渲染、桌面 soak（`smoke-v13-desktop.mjs`
  的进程内存/CPU 曲线）、IME 全链路、全局热键。**不得在 WSL/Linux 声称已验证**；
  WSL 跑过的项在清单里标 `[WSL]`，Windows 实机复跑标 `[WIN]`。

---

## 闸门 1 · 性能回归（F6.1）

**口径**：所有指标越低越好；候选构建相对基线劣化超过容差（默认 10%，即「不低于
基线 90%」）判回归。比较 `summarize-performance.mjs` 的报告形状（前端堆峰值、
积压字符、上报延迟、定时器延迟、采样耗时、进程私有内存峰值）。

前端与后端各自每 15 秒采样，启动相位不同会使 `frontendAgeMs` 在同样健康的两个
构建中分别接近 0 秒和 15 秒。新版汇总保留原始年龄，并用同一 boot/PID 下连续
样本推导 `maxFrontendUpdateIntervalMs`；它同时取原始年龄作下限，仍能发现上报
停止。两侧均有连续样本时按更新间隔比较；旧报告或数据不足时保留原始年龄门禁。
这是采样相位修正，不提高 10% 容差，也不移除停报检测。

**产报告**（两个构建各跑一次同负载 soak，得到各自的 `performance.jsonl` 目录）：

```bash
# 旧构建（基线）soak 后：
node scripts/summarize-performance.mjs --dir <baseline-perf-dir> > baseline.json
# 新构建（候选）soak 后：
node scripts/summarize-performance.mjs --dir <candidate-perf-dir> > candidate.json
```

**判定**（退出码即闸门，回归 → 1）：

```bash
npm run perf:compare -- --baseline baseline.json --candidate candidate.json
# 自定义容差：追加 --tolerance 0.15
# 机器可读：追加 --json
```

- [ ] `perf:compare` 退出码 0（无回归），结论行打印「持平/改善」。
- [ ] 若判回归：要么修，要么在发版说明里**显式记录**该指标劣化幅度与原因，不得静默放行。
- [ ] 比较器单测通过：`npm run perf:test`（含 `compare-performance.test.mjs` 8 例）。

> 桌面验收另有 `summarize-desktop-acceptance.mjs`（进程内存首尾中位数、CPU、
> queuedChars、contextLosses、failedWrites、layoutSwitch 四联 WebGL 等）。它是
> **单构建体检**，跨版本对比仍走 `perf:compare`。

---

## 闸门 2 · 视觉对账（F6.2）

**已有**：`smoke-terminal-static-replay.mjs` 用 headless Chromium 渲染
`fixtures/terminal-static-replay.html`，对 **dom + webgl × history/bottom** 四组
做**像素级**断言（`before.equals(during)`、`before.equals(after)`），覆盖静态恢复
帧与 CJK 内容；同时校验快照解析压缩比与 pageerror 为空。

```bash
# 需要 Playwright 模块路径（项目未硬依赖 playwright）：
npm run smoke:static-replay -- <playwright-module-path> [browser-channel]
```

- [ ] 静态回放四组全部像素对账通过、无 pageerror。
- [ ] 归档 before/during/after 截图（脚本已写入临时 artifacts 目录），PR 里新旧并排。

固定样张集已扩展 boxdraw、块/浓度/象限字符、Powerline 分隔符、CJK 对齐标尺、
256 色和真彩渐变，均随 `terminal-static-replay.html` 的四组恢复测试归档。
它验证已选样张的恢复一致性，不代表所有字体组合的完整字形覆盖。当前发版还须保证：
- [ ] WebGL 透明/花屏回归项过 `smoke-transparent-webgl.mjs`（见 `CLAUDE.md` 已记录的坑）。
- [ ] 主题对比度过 `npm run check:theme-contrast`；bundle 预算过 `npm run check:bundle`。

---

## 闸门 3 · IME 人工清单（F6.3）

中文输入全链路，**Windows WebView2 实机**逐项手测（自动化未覆盖，人工兜底）。
发版前在真实 Windows 宿主过一遍并勾选；WSL 不算数。

预编辑（composition）：
- [ ] 候选拼音串以预编辑态显示在光标处，不直接落盘到 shell。
- [ ] 预编辑期间终端不丢字、不重复、不乱码。

候选窗定位：
- [ ] 候选词窗跟随**真实光标行列**（含分屏/缩放 1.0 场景），不固定在左上角。
- [ ] 切换 pane 后候选窗定位仍正确。

提交（commit）：
- [ ] 选词提交后，中文字符以正确宽度（全角占两列）落到终端。
- [ ] 连续提交多词不粘连、不漏字。

退格 / 编辑：
- [ ] 预编辑态退格删的是候选串而非已提交内容。
- [ ] 提交后退格按字符（非字节）删除中文，不留半个字。

粘贴 / 复制交互：
- [ ] 复制/粘贴不破坏进行中的 IME 会话（回归项，见 `docs/27-linux-clipboard-fix.md`
      记录的 `clearNativeEditState` 在 WebView2 上破坏 IME 的教训）。

---

## 发版阻断规则（F6.4）

发版前，以下任一**不过即阻断**，不得发布：

1. **闸门 1**：`npm run perf:test` 通过，且 `perf:compare` 退出码 0（或劣化已在发版说明显式记录并签字放行）。
2. **闸门 2**：`smoke:static-replay` 四组像素对账全过、无 pageerror；`check:theme-contrast` / `check:bundle` 通过。
3. **闸门 3**：IME 人工清单在 **Windows 实机**逐项勾选完成（标 `[WIN]`）。
4. 平台基线：`npx tsc --noEmit`、`npm run test:run`、`cargo test --workspace`、
   `cargo clippy --workspace -- -D warnings` 全绿（CI 已覆盖，发版前确认最近一次 CI 通过）。

> 性能 soak 与桌面体检属 Windows-host-required，CI（无桌面会话）跑不了；它们由
> 发版负责人在 Windows 宿主手动执行并把报告归档到 `docs/diagnostics/`。CI 能自动
> 跑的是纯逻辑/像素对账/bundle 那部分。

## 一键自检（当前环境可验子集）

```bash
npm run perf:test          # 比较器 + 汇总器单测
npx tsc --noEmit           # 类型
npm run test:run           # 前端测试
npm run check:bundle       # 需先 npm run build
```
