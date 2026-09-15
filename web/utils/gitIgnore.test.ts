import { describe, expect, it } from "vitest";

import { createGitIgnoreMatcher, NO_IGNORES } from "./gitIgnore";

describe("createGitIgnoreMatcher", () => {
  it("空忽略集返回永远 false 的匹配器", () => {
    const matcher = createGitIgnoreMatcher([]);
    expect(matcher).toBe(NO_IGNORES);
    expect(matcher.isIgnored("/repo/anything.ts")).toBe(false);
  });

  it("直接命中忽略文件", () => {
    const matcher = createGitIgnoreMatcher(["/repo/secret.env"]);
    expect(matcher.isIgnored("/repo/secret.env")).toBe(true);
    expect(matcher.isIgnored("/repo/kept.txt")).toBe(false);
  });

  it("被忽略目录下的子节点继承忽略态（git --ignored=matching 不展开）", () => {
    const matcher = createGitIgnoreMatcher(["/repo/build"]);
    expect(matcher.isIgnored("/repo/build")).toBe(true);
    expect(matcher.isIgnored("/repo/build/out.js")).toBe(true);
    expect(matcher.isIgnored("/repo/build/deep/nested/x.map")).toBe(true);
    // 兄弟目录不受影响
    expect(matcher.isIgnored("/repo/src/index.ts")).toBe(false);
    // 前缀相似但非子路径不应误判（/repo/buildlog ≠ /repo/build/...）
    expect(matcher.isIgnored("/repo/buildlog.txt")).toBe(false);
  });

  it("Windows 反斜杠与大小写差异都能匹配", () => {
    const matcher = createGitIgnoreMatcher(["C:\\Repo\\Build"]);
    expect(matcher.isIgnored("C:\\Repo\\Build")).toBe(true);
    expect(matcher.isIgnored("c:/repo/build/out.js")).toBe(true);
    expect(matcher.isIgnored("C:\\REPO\\BUILD\\X.js")).toBe(true);
  });

  it("忽略路径尾部斜杠被裁剪后仍匹配", () => {
    const matcher = createGitIgnoreMatcher(["/repo/dist/"]);
    expect(matcher.isIgnored("/repo/dist")).toBe(true);
    expect(matcher.isIgnored("/repo/dist/bundle.js")).toBe(true);
  });

  it("仅含空字符串时退回空匹配器", () => {
    const matcher = createGitIgnoreMatcher([""]);
    expect(matcher).toBe(NO_IGNORES);
  });

  it("异常空白路径不会误伤正常路径", () => {
    const matcher = createGitIgnoreMatcher(["   "]);
    expect(matcher.isIgnored("/repo/src/main.ts")).toBe(false);
  });

  it("多条忽略规则并存", () => {
    const matcher = createGitIgnoreMatcher([
      "/repo/node_modules",
      "/repo/.env",
      "/repo/coverage",
    ]);
    expect(matcher.isIgnored("/repo/node_modules/pkg/index.js")).toBe(true);
    expect(matcher.isIgnored("/repo/.env")).toBe(true);
    expect(matcher.isIgnored("/repo/coverage/lcov.info")).toBe(true);
    expect(matcher.isIgnored("/repo/src/main.ts")).toBe(false);
  });

  it("根节点本身不会被误判为忽略", () => {
    const matcher = createGitIgnoreMatcher(["/repo/build"]);
    // 上溯到根（slash <= 0）应停止，不把 "/" 当忽略
    expect(matcher.isIgnored("/repo")).toBe(false);
    expect(matcher.isIgnored("/")).toBe(false);
  });

  it("空路径查询安全返回 false", () => {
    const matcher = createGitIgnoreMatcher(["/repo/build"]);
    expect(matcher.isIgnored("")).toBe(false);
  });
});
