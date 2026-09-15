/**
 * 终端文字对比度审计（F7.1：浅色背景下自动增强对比度，保留本就可读的配色）。
 *
 * 结论性事实：xterm 的 `minimumContrastRatio` 就是这个特性的实现——渲染时按背景
 * 动态调整前景色，**只**改跌破阈值的颜色，本就达标的颜色保持原样。因此本模块不做
 * 二次调色，而是把该保证变成可审计、可回归的契约：
 *
 * - `MINIMUM_TERMINAL_CONTRAST_RATIO` 是唯一真源，终端构造与测试共用同一常量，
 *   避免阈值在两处各写一遍而静默漂移（曾因裸字面量 4.5 分散而无人看守）。
 * - `auditTerminalPaletteContrast` 纯函数度量调色板每个 ANSI 色对背景的 WCAG 2.x
 *   对比度，并标出哪些颜色需要 xterm 介入。用途是把「浅色主题确实存在大量低对比
 *   颜色，自动增强不是摆设」这一前提用单测锁死：若有人把阈值调到 1 或删掉该选项，
 *   相关测试立刻失败。
 *
 * 计算遵循 WCAG 2.x 相对亮度与对比度定义（与 scripts/check-theme-contrast.mjs 的
 * UI token 闸门同口径，但此处面向终端 ANSI 色表）。
 */

import type { TerminalThemePalette } from "./terminalTheme";

/**
 * 终端文字最低对比度阈值（WCAG AA 正文级）。
 *
 * 同时作为 xterm `minimumContrastRatio` 的取值：低于此比值的颜色会被 xterm 自动
 * 推离背景以恢复可读，达标颜色不受影响。亮/暗主题一律适用，不随壁纸透明度变化
 * （xterm 的对比度判定忽略 alpha，见 terminalTheme.withTransparentTerminalBackground）。
 */
export const MINIMUM_TERMINAL_CONTRAST_RATIO = 4.5;

/** 参与审计的调色板颜色键（背景与选区色不参与，它们是被对比的对象而非文字色）。 */
export const TERMINAL_TEXT_COLOR_KEYS = [
  "foreground",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

export type TerminalTextColorKey = (typeof TERMINAL_TEXT_COLOR_KEYS)[number];

/** 单个颜色的审计结果。 */
export interface TerminalContrastAuditEntry {
  color: TerminalTextColorKey;
  /** 原始色值（便于失败信息定位）。 */
  value: string;
  /** 对背景的 WCAG 对比度，1..21。 */
  ratio: number;
  /** 低于阈值 → xterm 会在渲染时自动调整该颜色。 */
  needsAdjustment: boolean;
}

/** `#RGB` / `#RRGGBB` 解析为 0-255 通道；不支持的格式（rgba()、关键字）返回 null。 */
export function parseHexColor(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  const hex =
    match[1].length === 3
      ? match[1]
          .split("")
          .map((ch) => ch + ch)
          .join("")
      : match[1];
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/** WCAG 2.x 相对亮度（0=黑，1=白）。 */
export function relativeLuminance(rgb: readonly [number, number, number]): number {
  const weights = [0.2126, 0.7152, 0.0722];
  return rgb.reduce((sum, channel, index) => {
    const normalized = channel / 255;
    const linear =
      normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    return sum + linear * weights[index];
  }, 0);
}

/**
 * WCAG 对比度，范围 1..21。任一色无法解析（如 rgba() 选区色）时返回 null，
 * 由调用方决定跳过——对比度审计只对可解析的纯色负责，不猜测 alpha 合成结果。
 */
export function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseHexColor(foreground);
  const bg = parseHexColor(background);
  if (!fg || !bg) return null;
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * 审计整个调色板：逐色计算对 `palette.background` 的对比度并标记是否需自动调整。
 *
 * 背景不可解析（如开了壁纸透明度后变成 rgba()）时返回空数组——此时 xterm 用的是
 * 逻辑背景 RGB（见 withTransparentTerminalBackground 注释），审计交由不透明主题进行。
 */
export function auditTerminalPaletteContrast(
  palette: TerminalThemePalette,
  threshold: number = MINIMUM_TERMINAL_CONTRAST_RATIO,
): TerminalContrastAuditEntry[] {
  const entries: TerminalContrastAuditEntry[] = [];
  for (const color of TERMINAL_TEXT_COLOR_KEYS) {
    const value = palette[color];
    const ratio = contrastRatio(value, palette.background);
    if (ratio === null) continue;
    entries.push({ color, value, ratio, needsAdjustment: ratio < threshold });
  }
  return entries;
}
