# v0.12.18 稳定性发布验收

状态：实施中，尚未发布。发布基线为远端 `dev/v0.12.18@cea038ce`，叠加已审阅的本地终端稳定性修改。

## 实施范围

- 终端输入/输出队列、在途写入取消、生命周期、IME 与图集修复。
- 休眠与 checkpoint 按原始尺寸恢复，重放期间布局保护。
- orchestrator 端点发布/退出登记与身份核对。
- 安装升级保留 daemon；更新清单与签名完整性门禁。
- 保留远端快捷终端、Git 冲突、SSH 路线、进度徽章与内联图片功能。

本地 cc-switch 导入、其他界面半成品及新功能 backlog 不纳入。共享源工作树与正在使用的安装实例不被替换。

## 验收状态

| 项目 | 状态 | 证据 |
|---|---|---|
| 发布候选 TypeScript | PASS | Windows `tsc --noEmit`，退出码 0 |
| Windows workspace check | PASS | 退出码 0 |
| 更新清单失败门禁 | PASS | 9 个 Node 测试 |
| 静态恢复像素对账 | PASS | DOM/WebGL × 历史/底部四组，扩展字符与颜色样张 |
| 全量前端、Rust 测试与 Clippy | PENDING | 运行中 |
| Windows WebView2 与 IME | PENDING | 必须真实宿主验收 |
| 快捷终端 / Git 冲突 / SSH 路线 / OSC | PENDING | 必须真实宿主验收 |
| 同负载短时性能比较 | PENDING | 默认容差 10% |
| 最终提交 CI、包与更新签名 | PENDING | 未打 tag |

每项记录实际退出码。PENDING/FAIL 不得按 PASS 发布。运行证据在工作空间的 `evidence/release-0.12.18-20260915/`，不包含凭据、业务数据或用户终端输入。
