import { memo } from "react";
import { useTranslation } from "react-i18next";
import { isStatusPulsing, statusColorToken, statusLabelKey } from "@/lib/statusPresentation";
import type { OscProgressBadge, TerminalStatusType } from "@/types";

interface StatusIndicatorProps {
  status: TerminalStatusType | null;
  /** 当前运行的工具名（仅 toolRunning 状态下展示在 tooltip）。 */
  toolName?: string | null;
  /** OSC 9;4 兜底徽章（F5）：进度环叠加层，不参与状态机判定。 */
  oscProgress?: OscProgressBadge | null;
  size?: number;
}

/**
 * 会话状态点 + 可选 OSC 9;4 进度环叠加。
 *
 * 无 oscProgress 时 DOM 与原实现完全一致（纯 span），7 个既有调用点零风险。
 * 有 oscProgress 时外层改为 relative 容器，内部渲染 conic-gradient 进度环。
 * 环的颜色按 OSC state 映射（running=accent, paused=warning, error=danger,
 * indeterminate=accent+旋转动画），**不改状态点本体颜色**（F5.2：hook 优先）。
 */
export default memo(function StatusIndicator({
  status,
  toolName,
  oscProgress,
  size = 8,
}: StatusIndicatorProps) {
  const { t } = useTranslation("dialogs");

  if (!status) return null;

  const labelKey = statusLabelKey(status);
  const baseLabel = labelKey ? t(labelKey) : "";
  const label = status === "toolRunning" && toolName ? `${baseLabel}: ${toolName}` : baseLabel;
  const isPulsing = isStatusPulsing(status);
  const bgColor = statusColorToken(status);

  // --- 无 OSC 徽章：保持原有单 span 结构 ---
  if (!oscProgress) {
    return (
      <span
        className={`inline-block rounded-full shrink-0 transition-colors duration-[var(--dur)] ${
          isPulsing ? "cc-status-pulse" : ""
        }`}
        title={label}
        style={{ width: size, height: size, backgroundColor: bgColor }}
      />
    );
  }

  // --- 有 OSC 徽章：进度环叠加 ---
  const oscLabel = t(`oscProgress_${oscProgress.state}` as never) as string;
  const fullLabel = `${label} · ${oscLabel}${oscProgress.progress > 0 ? ` ${oscProgress.progress}%` : ""}`;
  const ringSize = size + 4;
  const ringColor = OSC_STATE_COLOR[oscProgress.state] ?? "var(--app-accent)";
  const isIndeterminate = oscProgress.state === "indeterminate";
  // conic-gradient 百分比：indeterminate 用 25% 弧段旋转模拟
  const pct = isIndeterminate ? 25 : Math.min(100, Math.max(0, oscProgress.progress));

  return (
    <span
      className="relative inline-flex items-center justify-center shrink-0"
      title={fullLabel}
      style={{ width: ringSize, height: ringSize }}
    >
      {/* 进度环 */}
      <span
        className={`absolute inset-0 rounded-full ${isIndeterminate ? "cc-osc-spin" : ""}`}
        style={{
          background: `conic-gradient(${ringColor} ${pct}%, transparent ${pct}%)`,
          mask: "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))",
          WebkitMask:
            "radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))",
        }}
        aria-hidden="true"
      />
      {/* 状态点本体（颜色不变，F5.2） */}
      <span
        className={`rounded-full ${isPulsing ? "cc-status-pulse" : ""}`}
        style={{ width: size, height: size, backgroundColor: bgColor }}
      />
    </span>
  );
});

const OSC_STATE_COLOR: Record<string, string> = {
  running: "var(--app-accent)",
  paused: "var(--app-status-warning)",
  error: "var(--app-status-danger)",
  indeterminate: "var(--app-accent)",
};
