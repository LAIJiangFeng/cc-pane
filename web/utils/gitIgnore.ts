/**
 * git-ignore 路径匹配（F7.2：文件树中忽略项斜体区分）。
 *
 * 后端 `get_git_ignored_paths` 用 `git status --ignored=matching`，被忽略的目录整体
 * 上报一次（不递归展开内部文件）。因此一个节点算「被忽略」当且仅当：它本身命中忽略集，
 * 或它的某个祖先目录命中忽略集。这里把忽略路径预处理成前缀集合，单次 O(深度) 查询，
 * 供虚拟化文件树在每行渲染时调用。
 *
 * 路径大小写：Windows 文件系统大小写不敏感，git 输出与树节点路径同源（都来自后端），
 * 但仍统一小写归一以容忍分隔符/大小写差异。
 */

/** 把单个路径归一为小写、正斜杠、去尾斜杠的形式。 */
function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 不可变的忽略匹配器：isIgnored(path) 判断节点是否被忽略（含祖先目录继承）。 */
export interface GitIgnoreMatcher {
  isIgnored(path: string): boolean;
}

/** 空匹配器：永远返回 false，用于非 git 仓库或忽略集为空时，避免空指针判断。 */
export const NO_IGNORES: GitIgnoreMatcher = { isIgnored: () => false };

/**
 * 由忽略路径列表构建匹配器。
 *
 * 集合只存归一后的忽略路径本身；查询时从节点逐级上溯父目录，命中任一即视为忽略。
 * 这样被忽略目录下的子节点（git 不展开）也能继承忽略态。重复/无效输入安全。
 */
export function createGitIgnoreMatcher(ignoredPaths: readonly string[]): GitIgnoreMatcher {
  if (ignoredPaths.length === 0) return NO_IGNORES;

  const ignored = new Set<string>();
  for (const raw of ignoredPaths) {
    const norm = normalize(raw);
    if (!norm) continue;
    ignored.add(norm);
  }
  if (ignored.size === 0) return NO_IGNORES;

  return {
    isIgnored(path: string): boolean {
      const norm = normalize(path);
      if (!norm) return false;
      // 自身命中即忽略；否则逐级上溯父目录，命中任一祖先即继承忽略。
      let cursor = norm;
      while (true) {
        if (ignored.has(cursor)) return true;
        const slash = cursor.lastIndexOf("/");
        if (slash <= 0) break;
        cursor = cursor.slice(0, slash);
      }
      return false;
    },
  };
}
