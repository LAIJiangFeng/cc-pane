//! F1 全局快捷终端（Quake 式下拉）设置 — docs/105。
//!
//! 从 `models::settings` 拆出：settings.rs 已触到行数棘轮上限，新增设置项一律
//! 往外拆而不是继续堆（见 `orchestrator_settings.rs` 同范式）。仍由
//! `models::settings` 重导出，调用方 import 路径不变。

use serde::{Deserialize, Serialize};

/// 快捷终端窗口高度占主显示器高度比例的 clamp 下限。
pub const MIN_HEIGHT_FRACTION: f64 = 0.15;
/// 快捷终端窗口高度占主显示器高度比例的 clamp 上限。
pub const MAX_HEIGHT_FRACTION: f64 = 0.85;

fn default_enabled() -> bool {
    true
}

fn default_auto_hide_on_blur() -> bool {
    true
}

fn default_height_fraction() -> f64 {
    0.4
}

fn default_shortcut() -> String {
    // dev 用不同默认键，避免与同时运行的 release 实例抢同一全局热键
    // （与 ScreenshotSettings 同一套 cfg!(debug_assertions) 隔离）。
    if cfg!(debug_assertions) {
        "Ctrl+Alt+Shift+Q".to_string()
    } else {
        "Ctrl+Alt+Q".to_string()
    }
}

/// F1 全局快捷终端设置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickTerminalSettings {
    /// 是否启用全局热键 toggle 快捷终端。默认开启（P0 开箱即用）。
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// 全局热键（tauri global-shortcut 可解析格式，如 "Ctrl+Alt+Q"）。
    #[serde(default = "default_shortcut")]
    pub shortcut: String,
    /// 窗口失焦时自动收起（Quake 经典行为）。默认开启。
    #[serde(default = "default_auto_hide_on_blur")]
    pub auto_hide_on_blur: bool,
    /// 窗口高度占主显示器高度比例，clamp 到 [MIN_HEIGHT_FRACTION, MAX_HEIGHT_FRACTION]。
    #[serde(default = "default_height_fraction")]
    pub height_fraction: f64,
}

impl Default for QuickTerminalSettings {
    fn default() -> Self {
        Self {
            enabled: default_enabled(),
            shortcut: default_shortcut(),
            auto_hide_on_blur: default_auto_hide_on_blur(),
            height_fraction: default_height_fraction(),
        }
    }
}

impl QuickTerminalSettings {
    /// 老 config.toml 缺键 / 越界时回落到合理默认（与 OrchestratorSettings 同范式）。
    pub fn merge_missing_defaults(&mut self) {
        if !self.height_fraction.is_finite() {
            self.height_fraction = default_height_fraction();
        }
        self.height_fraction = self
            .height_fraction
            .clamp(MIN_HEIGHT_FRACTION, MAX_HEIGHT_FRACTION);
        if self.shortcut.trim().is_empty() {
            self.shortcut = default_shortcut();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        // 老配置文件不含这些键，反序列化必须整体回落默认而不是失败
        let parsed: QuickTerminalSettings = serde_json::from_str("{}").unwrap();
        assert!(parsed.enabled);
        assert!(parsed.auto_hide_on_blur);
        assert_eq!(parsed.height_fraction, default_height_fraction());
        assert_eq!(parsed.shortcut, default_shortcut());
    }

    #[test]
    fn defaults_follow_debug_assertions_for_shortcut() {
        let expected = if cfg!(debug_assertions) {
            "Ctrl+Alt+Shift+Q"
        } else {
            "Ctrl+Alt+Q"
        };
        assert_eq!(QuickTerminalSettings::default().shortcut, expected);
    }

    #[test]
    fn height_fraction_is_clamped_high() {
        let mut s = QuickTerminalSettings {
            height_fraction: 5.0,
            ..Default::default()
        };
        s.merge_missing_defaults();
        assert_eq!(s.height_fraction, MAX_HEIGHT_FRACTION);
    }

    #[test]
    fn height_fraction_is_clamped_low() {
        let mut s = QuickTerminalSettings {
            height_fraction: 0.01,
            ..Default::default()
        };
        s.merge_missing_defaults();
        assert_eq!(s.height_fraction, MIN_HEIGHT_FRACTION);
    }

    #[test]
    fn non_finite_height_fraction_is_repaired() {
        let mut s = QuickTerminalSettings {
            height_fraction: f64::NAN,
            ..Default::default()
        };
        s.merge_missing_defaults();
        assert_eq!(s.height_fraction, default_height_fraction());
    }

    #[test]
    fn empty_shortcut_is_repaired() {
        let mut s = QuickTerminalSettings {
            shortcut: "   ".to_string(),
            ..Default::default()
        };
        s.merge_missing_defaults();
        assert_eq!(s.shortcut, default_shortcut());
    }

    #[test]
    fn round_trips_with_camel_case_keys() {
        let parsed: QuickTerminalSettings =
            serde_json::from_str(r#"{"autoHideOnBlur":false,"heightFraction":0.6}"#).unwrap();
        assert!(!parsed.auto_hide_on_blur);
        assert_eq!(parsed.height_fraction, 0.6);

        let json = serde_json::to_string(&parsed).unwrap();
        assert!(json.contains("autoHideOnBlur"));
        assert!(json.contains("heightFraction"));
    }
}
