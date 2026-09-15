/**
 * 相对时间格式化（如"3 分钟前"）
 */
import i18n from "@/i18n";

export function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (seconds < 60) return i18n.t("relativeTime.justNow");
  if (minutes < 60) return i18n.t("relativeTime.minutesAgo", { count: minutes });
  if (hours < 24) return i18n.t("relativeTime.hoursAgo", { count: hours });
  if (days < 7) return i18n.t("relativeTime.daysAgo", { count: days });
  return date.toLocaleDateString();
}

/**
 * 完整日期时间格式化
 */
export function formatFullTime(isoString: string): string {
  return new Date(isoString).toLocaleString();
}

/**
 * 文件大小格式化（支持 B / KB / MB / GB）
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}
