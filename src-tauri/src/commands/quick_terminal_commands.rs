//! F1 全局快捷终端（Quake 式下拉）— docs/105
//!
//! 单例置顶窗口，全局热键 toggle show/hide（hide 不销毁 → PTY/滚动缓冲/光标全保留）。
//! 复用 popup 窗口体系：label 走 `popup-` 前缀（通过 `is_popup_window_label` 守卫），
//! URL 走 `index.html?mode=popup`（复用 `PopupTerminalWindow.tsx` 渲染 `TerminalView`）。
//!
//! 工作目录：快捷终端没有「当前项目」概念，`createSession` 的 `validate_launch_cwd`
//! 会拒绝空路径，故一律以用户 home 目录作为 cwd（Quake 终端惯例）。
//!
//! 平台边界：窗口创建/定位/热键注册属 **Windows-host-required**（AGENTS.md），
//! 纯逻辑（label 守卫、rect 计算、home 解析、fraction clamp）可在任意平台单测。

use crate::commands::PopupDataStore;
use crate::services::SettingsService;
use crate::utils::{AppError, AppResult};
use cc_panes_core::models::quick_terminal_settings::{MAX_HEIGHT_FRACTION, MIN_HEIGHT_FRACTION};
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tracing::debug;

/// 快捷终端窗口 label。`popup-` 前缀使其通过 `is_popup_window_label` 守卫，
/// 可被通知聚焦体系（F7.3）正常唤到前面。
pub const QUICK_TERMINAL_LABEL: &str = "popup-quick-terminal";

/// 快捷终端在 PopupDataStore 中的 tabId，前端据此识别 quick 模式。
pub const QUICK_TERMINAL_TAB_ID: &str = "quick-terminal";

/// 快捷终端会话变更事件（F1.4）。
///
/// 载荷为 `Option<QuickTerminalSessionRecord>`：`Some` = 快捷终端里有一条活会话，
/// `None` = 没有（窗口已销毁 / 会话已退出）。主窗口据此把快捷终端会话接进
/// 通知定位与「在主窗口打开」接管。
pub const QUICK_TERMINAL_SESSION_CHANGED_EVENT: &str = "quick-terminal-session-changed";

/// 快捷终端里那条会话的登记项（docs/105 F1.4）。
///
/// 除了 `session_id`，还带上 `project_path` / `title`：快捷终端会话不在任何布局里，
/// 也就不会被 `useSessionLayoutPersistence` 写进 `savedSessions`，主窗口接管
/// （`panes.adoptSession`）时无处查它的 cwd。不带上就只能拿空路径建 tab，
/// 而这个 tab 一旦被重建（分屏/恢复/重启）会在错误目录里重启。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickTerminalSessionRecord {
    pub session_id: String,
    /// 会话创建时的 cwd（快捷终端一律是用户 home）。
    pub project_path: String,
    /// 接管后新 tab 的标题，让它在主窗口里可辨认（缺省用项目名 = home 路径，很难读）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// 快捷终端当前会话登记。
///
/// **为什么需要它**：快捷终端的 tab 不在任何布局里（它是独立窗口自建会话），主窗口
/// 的 `findTabBySessionAcrossLayouts` 永远查不到 → 通知卡片连「聚焦会话」按钮都不
/// 渲染。后端记下「哪条会话住在快捷终端窗口里」，主窗口才能在跨布局查不到时回退到
/// 这一条，并把快捷窗口唤到前面。
///
/// 单值而非集合：快捷终端是单例窗口，同时只有一条会话。
pub type QuickTerminalSessionStore = std::sync::Mutex<Option<QuickTerminalSessionRecord>>;

fn lock_quick_terminal_session_store(
    store: &QuickTerminalSessionStore,
) -> AppResult<std::sync::MutexGuard<'_, Option<QuickTerminalSessionRecord>>> {
    store
        .lock()
        .map_err(|e| AppError::from(format!("quick_terminal_session_store lock: {e}")))
}

/// 写入快捷终端会话登记；仅在值真正变化时广播（避免重复挂载触发的事件风暴）。
/// 返回 `true` 表示发生了变更并已广播。
fn set_quick_terminal_session_inner(
    app: &AppHandle,
    store: &QuickTerminalSessionStore,
    record: Option<QuickTerminalSessionRecord>,
) -> AppResult<bool> {
    let changed = {
        let mut guard = lock_quick_terminal_session_store(store)?;
        if *guard == record {
            false
        } else {
            *guard = record.clone();
            true
        }
    };
    if !changed {
        return Ok(false);
    }
    // 广播失败不让调用方炸：写入已生效，主窗口下次 `get` 仍能拿到正确值。
    if let Err(e) = app.emit(QUICK_TERMINAL_SESSION_CHANGED_EVENT, record.clone()) {
        debug!("quick_terminal: failed to emit session change: {e}");
    }
    debug!("quick_terminal: session changed -> {:?}", record);
    Ok(true)
}

/// 把前端传来的原始值归一化成登记项：空白 id / 空白 cwd 都不算有效登记。
///
/// `project_path` 缺失时回退到 home（与建窗时同一条解析），而不是拒登记：
/// 登记丢了会让通知定位整个失效，代价远大于一份回退 cwd。
fn build_quick_terminal_session_record(
    session_id: Option<String>,
    project_path: Option<String>,
    title: Option<String>,
) -> Option<QuickTerminalSessionRecord> {
    let session_id = session_id.filter(|id| !id.trim().is_empty())?;
    let project_path = project_path
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .unwrap_or_else(resolve_quick_terminal_project_path);
    Some(QuickTerminalSessionRecord {
        session_id,
        project_path,
        title: title
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
    })
}

/// SettingsService 未托管时的回退高度比例（与 `QuickTerminalSettings::default` 一致）。
const FALLBACK_HEIGHT_FRACTION: f64 = 0.4;

/// 无显示器时的回退尺寸。
const FALLBACK_RECT: (f64, f64, f64, f64) = (0.0, 0.0, 1200.0, 400.0);

/// clamp 高度比例到设置模型允许的范围（防御：get_settings 可能返回未经
/// `merge_missing_defaults` 的存量值）。
fn effective_height_fraction(fraction: f64) -> f64 {
    if fraction.is_finite() {
        fraction.clamp(MIN_HEIGHT_FRACTION, MAX_HEIGHT_FRACTION)
    } else {
        FALLBACK_HEIGHT_FRACTION
    }
}

/// 从 home 目录解析快捷终端 cwd。home 不可用时回退到当前目录 `.`
/// （桌面环境 home 必然存在；`.` 仅为测试/极端兜底，仍是合法存在的目录）。
fn resolve_project_path_from_home(home: Option<&Path>) -> String {
    match home {
        Some(p) if !p.as_os_str().is_empty() => p.to_string_lossy().to_string(),
        _ => ".".to_string(),
    }
}

/// 解析快捷终端工作目录（用户 home）。
fn resolve_quick_terminal_project_path() -> String {
    resolve_project_path_from_home(dirs::home_dir().as_deref())
}

/// 构造快捷终端的最小 tabData JSON。
/// `sessionId: null` → 前端 `TerminalView` 首次挂载时自建会话（PowerShell / 配置的 CLI）。
/// `mode: "quick"` → 前端识别快捷终端模式（去 tab 栏、自动聚焦输入、blur 自动收起）。
fn build_quick_terminal_tab_data(project_path: &str) -> String {
    serde_json::json!({
        "tabId": QUICK_TERMINAL_TAB_ID,
        "paneId": QUICK_TERMINAL_TAB_ID,
        "sessionId": null,
        "projectPath": project_path,
        "title": "Quick Terminal",
        "mode": "quick",
    })
    .to_string()
}

/// 计算快捷终端窗口矩形：主显示器全宽、顶部对齐、高度按 `height_fraction`。
/// 返回逻辑像素 `(x, y, width, height)`。
fn compute_quick_terminal_rect(app: &AppHandle, height_fraction: f64) -> (f64, f64, f64, f64) {
    let fraction = effective_height_fraction(height_fraction);
    let Ok(Some(monitor)) = app.primary_monitor() else {
        return FALLBACK_RECT;
    };
    let scale = monitor.scale_factor();
    if scale <= 0.0 {
        return FALLBACK_RECT;
    }
    let pos = monitor.position();
    let size = monitor.size();
    let x = pos.x as f64 / scale;
    let y = pos.y as f64 / scale;
    let width = size.width as f64 / scale;
    let height = (size.height as f64 / scale) * fraction;
    (x, y, width, height)
}

/// 核心 toggle 逻辑。可从命令和热键回调两个入口调用。
///
/// - 窗口不存在 → 创建（顶部全宽、置顶、无装饰、skip_taskbar）
/// - 窗口可见 → hide（PTY 保留）
/// - 窗口隐藏 → show + focus
async fn toggle_quick_terminal_inner(
    app: &AppHandle,
    popup_store: &PopupDataStore,
    height_fraction: f64,
) -> AppResult<()> {
    // 已存在：切换可见性
    if let Some(window) = app.get_webview_window(QUICK_TERMINAL_LABEL) {
        let visible = window.is_visible().unwrap_or(false);
        if visible {
            window.hide().map_err(|e| AppError::from(e.to_string()))?;
            debug!("quick_terminal: hidden");
        } else {
            window.show().map_err(|e| AppError::from(e.to_string()))?;
            window
                .set_focus()
                .map_err(|e| AppError::from(e.to_string()))?;
            debug!("quick_terminal: shown");
        }
        return Ok(());
    }

    // 首次创建
    let (x, y, width, height) = compute_quick_terminal_rect(app, height_fraction);
    debug!("quick_terminal: creating window rect=({x},{y},{width},{height})");

    let project_path = resolve_quick_terminal_project_path();
    let tab_data = build_quick_terminal_tab_data(&project_path);
    popup_store
        .lock()
        .map_err(|e| AppError::from(format!("popup_store lock: {e}")))?
        .insert(QUICK_TERMINAL_LABEL.to_string(), tab_data);

    WebviewWindowBuilder::new(
        app,
        QUICK_TERMINAL_LABEL,
        WebviewUrl::App("index.html?mode=popup".into()),
    )
    .title("Quick Terminal")
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(true)
    .inner_size(width, height)
    .position(x, y)
    .focused(true)
    .build()
    .map_err(|e| {
        // 创建失败时清理已存入的 tabData，避免泄漏
        if let Ok(mut s) = popup_store.lock() {
            s.remove(QUICK_TERMINAL_LABEL);
        }
        AppError::from(format!("Failed to create quick terminal window: {e}"))
    })?;

    Ok(())
}

/// 切换快捷终端可见性（前端命令面板 / 设置 UI 调用）。
#[tauri::command]
pub async fn toggle_quick_terminal(
    app: AppHandle,
    popup_store: State<'_, PopupDataStore>,
    settings_service: State<'_, Arc<SettingsService>>,
) -> AppResult<()> {
    debug!("cmd::toggle_quick_terminal");
    let height_fraction = settings_service
        .get_settings()
        .quick_terminal
        .height_fraction;
    toggle_quick_terminal_inner(&app, &popup_store, height_fraction).await
}

/// 隐藏快捷终端（前端 auto_hide_on_blur 失焦时调用）。窗口不存在时为 no-op。
#[tauri::command]
pub fn hide_quick_terminal(app: AppHandle) -> AppResult<()> {
    debug!("cmd::hide_quick_terminal");
    if let Some(window) = app.get_webview_window(QUICK_TERMINAL_LABEL) {
        window.hide().map_err(|e| AppError::from(e.to_string()))?;
    }
    Ok(())
}

/// 上报快捷终端当前会话（F1.4）。
///
/// 由快捷终端窗口在 `TerminalView.onSessionCreated` 时调用；传 `None` 表示会话已结束。
/// 跨布局查不到这条会话的通知会回退到这里，从而能把快捷窗口唤到前面。
/// `project_path` / `title` 供「在主窗口打开」接管时建 tab 使用。
#[tauri::command]
pub fn set_quick_terminal_session(
    app: AppHandle,
    session_store: State<'_, QuickTerminalSessionStore>,
    session_id: Option<String>,
    project_path: Option<String>,
    title: Option<String>,
) -> AppResult<()> {
    set_quick_terminal_session_inner(
        &app,
        &session_store,
        build_quick_terminal_session_record(session_id, project_path, title),
    )?;
    Ok(())
}

/// 读取快捷终端当前会话登记（F1.4）。主窗口启动/窗口重建时补查，避免错过广播。
#[tauri::command]
pub fn get_quick_terminal_session(
    session_store: State<'_, QuickTerminalSessionStore>,
) -> AppResult<Option<QuickTerminalSessionRecord>> {
    Ok(lock_quick_terminal_session_store(&session_store)?.clone())
}

/// 销毁快捷终端窗口（F1.4「在主窗口打开」接管后调用）。
///
/// **不杀 PTY**：销毁窗口只断掉它那条 WebSocket 订阅，后端没有 kill-on-disconnect，
/// 会话仍活着 → 主窗口刚 adopt 的 tab 能 reattach 到同一条 PTY，历史与光标全保留。
/// 同时清掉会话登记与 tabData，下次热键会重新建窗建会话。
#[tauri::command]
pub fn destroy_quick_terminal(
    app: AppHandle,
    popup_store: State<'_, PopupDataStore>,
    session_store: State<'_, QuickTerminalSessionStore>,
) -> AppResult<()> {
    debug!("cmd::destroy_quick_terminal");
    set_quick_terminal_session_inner(&app, &session_store, None)?;
    if let Ok(mut guard) = popup_store.lock() {
        guard.remove(QUICK_TERMINAL_LABEL);
    }
    if let Some(window) = app.get_webview_window(QUICK_TERMINAL_LABEL) {
        window
            .destroy()
            .map_err(|e| AppError::from(format!("Failed to destroy quick terminal window: {e}")))?;
    }
    Ok(())
}

/// 窗口关闭路径（非 `destroy_quick_terminal`，如 Alt+F4）的会话登记清理。
/// PTY 不受影响（同 destroy 说明），只是「住在快捷窗口里」这条映射失效了。
pub fn clear_quick_terminal_session(app: &AppHandle) {
    let Some(store) = app.try_state::<QuickTerminalSessionStore>() else {
        return;
    };
    if let Err(e) = set_quick_terminal_session_inner(app, store.inner(), None) {
        debug!("quick_terminal: clear session failed: {e}");
    }
}

/// 更新快捷终端全局热键（设置 UI 调用）。仿 `screenshot_update_shortcut`：
/// 先注销旧键再注册新键。`new_shortcut` 为空 = 仅注销（禁用热键）。
#[tauri::command]
pub fn quick_terminal_update_shortcut(
    app: AppHandle,
    old_shortcut: String,
    new_shortcut: String,
) -> AppResult<()> {
    debug!("cmd::quick_terminal_update_shortcut new={new_shortcut}");
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    // 先注销旧快捷键（忽略错误，可能已不存在）
    if !old_shortcut.trim().is_empty() {
        if let Ok(old_sc) = old_shortcut.parse::<tauri_plugin_global_shortcut::Shortcut>() {
            let _ = app.global_shortcut().unregister(old_sc);
        }
    }

    // 空新键 = 禁用热键（不注册）
    if new_shortcut.trim().is_empty() {
        return Ok(());
    }

    let new_sc: tauri_plugin_global_shortcut::Shortcut = new_shortcut
        .parse()
        .map_err(|e| format!("Invalid shortcut format: {e}"))?;

    let app_handle = app.clone();
    app.global_shortcut()
        .on_shortcut(new_sc, move |_app, _shortcut, event| {
            if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                spawn_toggle_quick_terminal(&app_handle);
            }
        })
        .map_err(|e| format!("Shortcut conflict: {e}"))?;

    Ok(())
}

/// 从同步上下文（全局热键回调）触发 toggle。
/// 热键回调是 sync closure，不能 await；用 `async_runtime::spawn` 桥接。
pub fn spawn_toggle_quick_terminal(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(store) = app.try_state::<PopupDataStore>() else {
            debug!("quick_terminal: PopupDataStore not managed, skip");
            return;
        };
        let height_fraction = app
            .try_state::<Arc<SettingsService>>()
            .map(|svc| svc.get_settings().quick_terminal.height_fraction)
            .unwrap_or(FALLBACK_HEIGHT_FRACTION);
        if let Err(e) = toggle_quick_terminal_inner(&app, store.inner(), height_fraction).await {
            debug!("quick_terminal toggle failed: {e}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_passes_popup_guard_format() {
        // 与 window_commands::is_popup_window_label 同逻辑：popup- 前缀 + 非空后缀
        assert!(QUICK_TERMINAL_LABEL.starts_with("popup-"));
        let suffix = &QUICK_TERMINAL_LABEL["popup-".len()..];
        assert!(!suffix.is_empty(), "suffix must not be empty");
        assert_eq!(suffix, "quick-terminal");
    }

    #[test]
    fn label_is_not_confusable_with_real_tab_popup() {
        // 真实 tab 弹出用 popup-<uuid/tabId>，快捷终端用固定 label，不会撞车
        assert_ne!(QUICK_TERMINAL_LABEL, "popup-");
        assert!(QUICK_TERMINAL_LABEL.len() > "popup-".len() + 1);
    }

    #[test]
    fn tab_data_json_has_required_fields() {
        let json = build_quick_terminal_tab_data("/home/user");
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        assert_eq!(parsed["tabId"], QUICK_TERMINAL_TAB_ID);
        assert_eq!(parsed["paneId"], QUICK_TERMINAL_TAB_ID);
        assert!(parsed["sessionId"].is_null());
        assert_eq!(parsed["projectPath"], "/home/user");
        assert_eq!(parsed["mode"], "quick");
        assert_eq!(parsed["title"], "Quick Terminal");
    }

    #[test]
    fn tab_data_json_is_stable_across_calls() {
        // 幂等：多次调用产出相同 JSON（无随机 id / 时间戳）
        assert_eq!(
            build_quick_terminal_tab_data("/x"),
            build_quick_terminal_tab_data("/x")
        );
    }

    #[test]
    fn project_path_is_embedded_verbatim() {
        let json = build_quick_terminal_tab_data(r"C:\Users\me");
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["projectPath"], r"C:\Users\me");
    }

    #[test]
    fn resolve_project_path_uses_home_when_present() {
        let home = Path::new("/home/tester");
        assert_eq!(resolve_project_path_from_home(Some(home)), "/home/tester");
    }

    #[test]
    fn resolve_project_path_falls_back_when_home_missing() {
        assert_eq!(resolve_project_path_from_home(None), ".");
        assert_eq!(resolve_project_path_from_home(Some(Path::new(""))), ".");
    }

    #[test]
    fn resolve_quick_terminal_project_path_is_non_empty() {
        // 真实环境 home 必然存在；即便兜底也是 "."，绝不为空（空会让 validate_launch_cwd 失败）
        assert!(!resolve_quick_terminal_project_path().is_empty());
    }

    #[test]
    fn height_fraction_is_clamped() {
        assert_eq!(effective_height_fraction(5.0), MAX_HEIGHT_FRACTION);
        assert_eq!(effective_height_fraction(0.01), MIN_HEIGHT_FRACTION);
        assert_eq!(effective_height_fraction(0.5), 0.5);
    }

    #[test]
    fn non_finite_height_fraction_falls_back() {
        assert_eq!(
            effective_height_fraction(f64::NAN),
            FALLBACK_HEIGHT_FRACTION
        );
        assert_eq!(
            effective_height_fraction(f64::INFINITY),
            FALLBACK_HEIGHT_FRACTION
        );
    }

    #[test]
    fn fallback_rect_is_nonzero() {
        let (x, y, w, h) = FALLBACK_RECT;
        assert!(w > 0.0 && h > 0.0);
        assert!(x.is_finite() && y.is_finite());
    }
}
