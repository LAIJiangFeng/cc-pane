import { describe, expect, it } from "vitest";

import {
  formatTerminalPathsForShell,
  quoteShellPath,
  windowsPathToWsl,
} from "./terminalDropPaths";

describe("quoteShellPath", () => {
  it("wraps a plain path in single quotes", () => {
    expect(quoteShellPath("/tmp/a.txt")).toBe("'/tmp/a.txt'");
  });

  it("quotes a path with spaces so the shell keeps it as one argument", () => {
    expect(quoteShellPath("C:\\my dir\\a b.txt")).toBe("'C:\\my dir\\a b.txt'");
  });

  it("preserves non-ASCII characters", () => {
    expect(quoteShellPath("/Users/me/企业基本信息.sql")).toBe(
      "'/Users/me/企业基本信息.sql'",
    );
  });

  it("escapes embedded single quotes with the '\\'' idiom", () => {
    // /tmp/o'brien -> '/tmp/o'\''brien'
    expect(quoteShellPath("/tmp/o'brien")).toBe("'/tmp/o'\\''brien'");
  });
});

describe("windowsPathToWsl", () => {
  it("converts a drive-letter path with backslashes", () => {
    expect(windowsPathToWsl("D:\\repos\\app")).toBe("/mnt/d/repos/app");
  });

  it("converts a drive-letter path with forward slashes", () => {
    expect(windowsPathToWsl("C:/Users/me")).toBe("/mnt/c/Users/me");
  });

  it("lowercases the drive letter", () => {
    expect(windowsPathToWsl("E:\\Data")).toBe("/mnt/e/Data");
  });

  it("does not treat a drive-relative path as absolute", () => {
    // `C:relative` has no separator after the colon; not a real absolute path.
    expect(windowsPathToWsl("C:relative")).toBeNull();
  });

  it("converts a \\\\wsl.localhost UNC path to the guest path", () => {
    expect(windowsPathToWsl("\\\\wsl.localhost\\Ubuntu\\home\\me")).toBe(
      "/home/me",
    );
  });

  it("converts a \\\\wsl$ UNC path", () => {
    expect(windowsPathToWsl("\\\\wsl$\\Debian\\etc\\hosts")).toBe("/etc/hosts");
  });

  it("returns null for a non-WSL UNC path", () => {
    expect(windowsPathToWsl("\\\\server\\share\\file.txt")).toBeNull();
  });

  it("returns null for an already-POSIX path", () => {
    expect(windowsPathToWsl("/home/me/file.txt")).toBeNull();
  });

  it("returns null for a relative path", () => {
    expect(windowsPathToWsl("relative/path.txt")).toBeNull();
  });
});

describe("formatTerminalPathsForShell", () => {
  it("quotes and space-joins local paths", () => {
    expect(
      formatTerminalPathsForShell(["/Users/me/Desktop/企业基本信息.sql", "/tmp/second.sql"]),
    ).toBe("'/Users/me/Desktop/企业基本信息.sql' '/tmp/second.sql'");
  });

  it("keeps a path with spaces as a single quoted argument", () => {
    expect(formatTerminalPathsForShell(["C:\\my dir\\a b.txt"])).toBe(
      "'C:\\my dir\\a b.txt'",
    );
  });

  it("filters out empty paths", () => {
    expect(formatTerminalPathsForShell(["", "/tmp/a.txt", ""])).toBe("'/tmp/a.txt'");
  });

  it("returns an empty string when all paths are empty", () => {
    expect(formatTerminalPathsForShell(["", ""])).toBe("");
  });

  it("defaults to local when runtimeKind is omitted", () => {
    expect(formatTerminalPathsForShell(["D:\\repos\\app"])).toBe("'D:\\repos\\app'");
  });

  it("converts Windows paths to guest paths for wsl sessions", () => {
    expect(
      formatTerminalPathsForShell(["D:\\repos\\app"], { runtimeKind: "wsl" }),
    ).toBe("'/mnt/d/repos/app'");
  });

  it("converts each wsl path and keeps already-POSIX ones unchanged", () => {
    expect(
      formatTerminalPathsForShell(["D:\\repos\\app", "/home/me/x.txt"], {
        runtimeKind: "wsl",
      }),
    ).toBe("'/mnt/d/repos/app' '/home/me/x.txt'");
  });

  it("quotes spaces after wsl conversion", () => {
    expect(
      formatTerminalPathsForShell(["D:\\my dir\\a b.txt"], { runtimeKind: "wsl" }),
    ).toBe("'/mnt/d/my dir/a b.txt'");
  });

  it("returns an empty string for ssh sessions (honest no-op)", () => {
    expect(
      formatTerminalPathsForShell(["D:\\repos\\app"], { runtimeKind: "ssh" }),
    ).toBe("");
  });
});
