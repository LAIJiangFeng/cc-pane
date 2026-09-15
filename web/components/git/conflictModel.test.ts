import { describe, expect, it } from "vitest";
import type {
  GitConflictContent,
  GitConflictFile,
  GitConflictVersions,
} from "@/services/gitService";
import {
  acceptSide,
  initialResultText,
  presentStages,
  sideView,
  sortConflictFiles,
  toVersionViews,
} from "./conflictModel";

function text(content: string | null, overrides: Partial<GitConflictContent> = {}): GitConflictContent {
  return {
    content,
    size: content === null ? overrides.size ?? 0 : new Blob([content]).size,
    isBinary: false,
    tooLarge: false,
    ...overrides,
  };
}

function versions(overrides: Partial<GitConflictVersions> = {}): GitConflictVersions {
  return {
    path: "src/app.ts",
    absolutePath: "/repo/src/app.ts",
    base: text("base\n"),
    ours: text("ours\n"),
    theirs: text("theirs\n"),
    result: text("<<<<<<< ours\n"),
    ...overrides,
  };
}

function file(path: string, isBinary: boolean, kinds: string[] = ["base", "ours", "theirs"]): GitConflictFile {
  return {
    path,
    absolutePath: `/repo/${path}`,
    isBinary,
    stages: kinds.map((kind, index) => ({
      kind: kind as GitConflictFile["stages"][number]["kind"],
      stage: index + 1,
      blob: "0".repeat(40),
      mode: "100644",
    })),
  };
}

describe("sideView", () => {
  it("available text maps to no reason", () => {
    const view = sideView("ours", text("hello"));
    expect(view.unavailableReason).toBeNull();
    expect(view.content).toBe("hello");
  });

  it("null content flags missing", () => {
    expect(sideView("theirs", text(null)).unavailableReason).toBe("missing");
  });

  it("binary wins over tooLarge", () => {
    const view = sideView("result", text(null, { isBinary: true, tooLarge: true }));
    expect(view.unavailableReason).toBe("binary");
  });

  it("too-large text is flagged", () => {
    expect(sideView("base", text(null, { tooLarge: true, size: 3_000_000 })).unavailableReason).toBe("tooLarge");
  });
});

describe("toVersionViews", () => {
  it("resolvable when ours/theirs/result all have text", () => {
    expect(toVersionViews(versions()).resolvable).toBe(true);
  });

  it("missing base still resolves", () => {
    const views = toVersionViews(versions({ base: text(null) }));
    expect(views.resolvable).toBe(true);
    expect(views.base.unavailableReason).toBe("missing");
  });

  it("binary ours blocks resolution", () => {
    const views = toVersionViews(versions({ ours: text(null, { isBinary: true }) }));
    expect(views.resolvable).toBe(false);
  });

  it("too-large theirs blocks resolution", () => {
    const views = toVersionViews(versions({ theirs: text(null, { tooLarge: true }) }));
    expect(views.resolvable).toBe(false);
  });
});

describe("initialResultText", () => {
  it("prefers the worktree result", () => {
    expect(initialResultText(versions())).toBe("<<<<<<< ours\n");
  });

  it("falls back to ours, then theirs, then empty", () => {
    expect(initialResultText(versions({ result: text(null) }))).toBe("ours\n");
    expect(
      initialResultText(versions({ result: text(null), ours: text(null) })),
    ).toBe("theirs\n");
    expect(
      initialResultText(versions({ result: text(null), ours: text(null), theirs: text(null) })),
    ).toBe("");
  });
});

describe("acceptSide", () => {
  it("returns side content for editing", () => {
    const views = toVersionViews(versions());
    expect(acceptSide(views, "ours")).toBe("ours\n");
    expect(acceptSide(views, "theirs")).toBe("theirs\n");
  });

  it("returns null for a degraded side", () => {
    const views = toVersionViews(versions({ theirs: text(null, { isBinary: true }) }));
    expect(acceptSide(views, "theirs")).toBeNull();
  });
});

describe("presentStages", () => {
  it("add/add conflict has no base", () => {
    expect(presentStages(file("a.bin", false, ["ours", "theirs"]))).toEqual(["ours", "theirs"]);
  });
});

describe("sortConflictFiles", () => {
  it("text files first, then binary, alphabetical inside", () => {
    const sorted = sortConflictFiles([
      file("z.txt", false),
      file("m.bin", true),
      file("a.txt", false),
    ]);
    expect(sorted.map((entry) => entry.path)).toEqual(["a.txt", "z.txt", "m.bin"]);
  });

  it("does not mutate the input", () => {
    const input = [file("b.txt", false), file("a.txt", false)];
    sortConflictFiles(input);
    expect(input.map((entry) => entry.path)).toEqual(["b.txt", "a.txt"]);
  });
});
