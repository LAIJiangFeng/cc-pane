// F7.4：终端内联图片（OSC 1337 / iTerm inline image protocol + SIXEL）。
//
// @xterm/addon-image 是独立的懒加载边界，刻意不并入 loadXtermRuntime()：
//   - 它是 beta 质量，且每个终端默认持有 128MB 图片存储 + 单图 2^24 像素上限，
//     在多窗格管理器里内存放大明显；
//   - 图片不会随休眠（SerializeAddon VT 重放）恢复，属于「降级可接受」的增强；
//   - 故按可逆开关（settings.terminal.inlineImagesEnabled，默认 false）落地，
//     只有显式开启的会话才动态取回这个 ~700KB 的 chunk，首屏与未开启会话零成本。
//
// 边界规则（由 editor/lazyBoundaries.test.ts 钉住）：本模块是 @xterm/addon-image
// 在运行时代码里的唯一取值入口；其余文件只允许 `import type`。
//
// 生命周期：addon 经 term.loadAddon() 注册，随 cleanup 的 term.dispose() 一并销毁，
// 无需另起 ref。异步取回落定时若组件已卸载（isMounted() === false）则不附着，
// 避免把 addon 挂到已 dispose 的终端上。
import type { Terminal } from "@xterm/xterm";
import type { IImageAddonOptions, ImageAddon } from "@xterm/addon-image";

/**
 * 每个终端的图片 FIFO 存储上限（MB）。addon 默认 128MB，对多窗格过于激进；
 * 取 32MB 在「能缓存若干张终端尺寸图片」与「8 窗格最坏 ~256MB」之间折中。
 */
export const TERMINAL_IMAGE_STORAGE_LIMIT_MB = 32;

/**
 * 单张图像素上限。addon 默认 2^24（4096×4096）；取 2^22（2048×2048）覆盖
 * 绝大多数终端内联图，同时把解码期临时内存（pixelLimit×4 ≈ 16MB）压一半。
 */
export const TERMINAL_IMAGE_PIXEL_LIMIT = 4_194_304;

let imageAddonModulePromise: Promise<typeof import("@xterm/addon-image")> | null = null;

/** 动态取回 addon-image 模块（模块级 Promise 缓存；失败不缓存，与 xterm 边界一致）。 */
export function loadImageAddonModule(): Promise<typeof import("@xterm/addon-image")> {
  if (!imageAddonModulePromise) {
    imageAddonModulePromise = import("@xterm/addon-image");
    imageAddonModulePromise.catch(() => {
      imageAddonModulePromise = null;
    });
  }
  return imageAddonModulePromise;
}

/** 构造保守的图片 addon 选项（独立导出便于审计与单测钉住上限）。 */
export function buildImageAddonOptions(): IImageAddonOptions {
  return {
    storageLimit: TERMINAL_IMAGE_STORAGE_LIMIT_MB,
    pixelLimit: TERMINAL_IMAGE_PIXEL_LIMIT,
    // 缓存淘汰后保留占位框，滚动回看时不至于留下空洞（addon 默认即 true）。
    showPlaceholder: true,
    // enableSizeReports 维持默认 true：IIP/SIXEL 客户端依赖 CSI 14/16/18 t 像素
    // 尺寸查询来正确缩放图片；本仓库未另行配置 windowOptions，无冲突。
  };
}

export interface AttachTerminalImageAddonDeps {
  term: Terminal;
  /** 组件是否仍挂载：异步取回落定时复查，已卸载则不附着。 */
  isMounted: () => boolean;
  debugLog: (event: string, payload?: Record<string, unknown>) => void;
}

/**
 * 按开关懒加载并附着图片 addon。返回已附着的 addon（供调用方持有/重置）或 null。
 * 失败（取回异常 / 构造异常 / 已卸载）一律吞掉并记日志，绝不让图片能力拖垮终端本体。
 */
export async function attachTerminalImageAddon({
  term,
  isMounted,
  debugLog,
}: AttachTerminalImageAddonDeps): Promise<ImageAddon | null> {
  try {
    const mod = await loadImageAddonModule();
    // 取回是异步的：落定时组件可能已卸载、终端已 dispose，此时不得再附着。
    if (!isMounted()) {
      debugLog("image.addon.skipped-unmounted", {});
      return null;
    }
    const addon = new mod.ImageAddon(buildImageAddonOptions());
    term.loadAddon(addon);
    debugLog("image.addon.attached", {
      storageLimitMb: TERMINAL_IMAGE_STORAGE_LIMIT_MB,
      pixelLimit: TERMINAL_IMAGE_PIXEL_LIMIT,
    });
    return addon;
  } catch (error) {
    debugLog("image.addon.failed", { error: String(error) });
    return null;
  }
}
