/**
 * 壁纸相关类型（镜像 cc-panes-core WallpaperSettings）。
 *
 * 从 settings.ts 抽出以遵守文件行数棘轮；settings.ts 通过 `export * from "./wallpaper"`
 * 重导出，所有现有 `@/types` 导入零改动。
 */

/** 壁纸种类 / 铺放方式 / 视频省电策略 */
export type WallpaperKind = "none" | "image" | "video";
export type WallpaperFit = "cover" | "contain" | "tile" | "center";
export type WallpaperPowerSaver = "auto" | "always" | "never";

/** 主区壁纸设置（镜像 cc-panes-core WallpaperSettings） */
export interface WallpaperSettings {
  enabled: boolean;
  kind: WallpaperKind;
  /** wallpapers_dir 下的相对文件名（受控 uuid 文件名） */
  file: string | null;
  fit: WallpaperFit;
  /** 媒体层不透明度 0.1..1 */
  opacity: number;
  /** 高斯模糊 px 0..64 */
  blur: number;
  /** 压暗遮罩 0..0.9 */
  dim: number;
  /** 终端背景不透明度 0..1（1 = 不透明走原路径；0 = 全透明，字直接浮在壁纸上） */
  terminalOpacity: number;
  /**
   * 面板玻璃模糊 px 0..24。壁纸激活时面板背景变透明，面板自身的
   * backdrop-filter 会直接糊在壁纸上（视频会被糊没），此值接管该 token。
   * 默认 0 = 壁纸之上不叠玻璃模糊。
   */
  glassBlur: number;
  video: WallpaperVideoSettings;
  music: WallpaperMusicSettings;
}

export interface WallpaperVideoSettings {
  autoplay: boolean;
  /** 0.25..2 */
  playbackRate: number;
  pauseWhenUnfocused: boolean;
  powerSaver: WallpaperPowerSaver;
}

export interface WallpaperMusicSettings {
  enabled: boolean;
  file: string | null;
  /** 0..1 */
  volume: number;
  loopPlayback: boolean;
  autoplay: boolean;
  /** 失焦是否暂停：独立于 video.pauseWhenUnfocused，默认 false（BGM 属全局氛围） */
  pauseWhenUnfocused: boolean;
  /**
   * 用视频壁纸自带的音轨当 BGM（仅 kind=video 有意义），忽略 `file`。
   * 走独立 audio 喂同一文件，video 保持 muted——见 Rust 侧同名字段注释。
   */
  useVideoAudio: boolean;
}

/** 壁纸库文件（list_wallpapers 返回项） */
export interface WallpaperFileInfo {
  name: string;
  kind: "image" | "video" | "audio";
  sizeBytes: number;
}
