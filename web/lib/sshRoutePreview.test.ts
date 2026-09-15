import { describe, expect, it } from "vitest";
import { buildSshRoutePreview } from "./sshRoutePreview";
import type { SshMachine } from "@/types";

function machine(overrides: Partial<SshMachine> = {}): SshMachine {
  return {
    id: overrides.id ?? "m",
    name: overrides.name ?? "machine",
    host: overrides.host ?? "target.example",
    port: overrides.port ?? 22,
    authMethod: overrides.authMethod ?? "key",
    tags: [],
    proxy: overrides.proxy,
    jumpHost: overrides.jumpHost,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("buildSshRoutePreview", () => {
  it("is direct when there is no proxy or jump host", () => {
    const preview = buildSshRoutePreview(
      machine({ host: "target.example", port: 2222 }),
      [],
    );
    expect(preview.direct).toBe(true);
    expect(preview.usesProxy).toBe(false);
    expect(preview.usesJump).toBe(false);
    expect(preview.hops).toEqual([
      { type: "target", endpoint: "target.example:2222" },
    ]);
  });

  it("puts a lone proxy before the target", () => {
    const preview = buildSshRoutePreview(
      machine({
        proxy: { kind: "socks5", host: "proxy.example", port: 1080 },
      }),
      [],
    );
    expect(preview.direct).toBe(false);
    expect(preview.usesProxy).toBe(true);
    expect(preview.hops).toEqual([
      {
        type: "proxy",
        endpoint: "proxy.example:1080",
        proxyKind: "socks5",
      },
      { type: "target", endpoint: "target.example:22" },
    ]);
  });

  it("reuses the owning machine proxy to reach an inline jump host", () => {
    const preview = buildSshRoutePreview(
      machine({
        proxy: { kind: "http", host: "proxy.example", port: 8080 },
        jumpHost: { host: "jump.example", port: 22 },
      }),
      [],
    );
    expect(preview.usesProxy).toBe(true);
    expect(preview.usesJump).toBe(true);
    // 代理 → 跳板 → 目标：内联跳板复用所属主机的代理。
    expect(preview.hops.map((h) => h.type)).toEqual(["proxy", "jump", "target"]);
    expect(preview.hops[1].endpoint).toBe("jump.example:22");
  });

  it("uses the referenced jump machine own proxy, not the owner proxy", () => {
    const jumpMachine = machine({
      id: "jump1",
      name: "Jump Box",
      host: "jump.example",
      port: 2200,
      proxy: { kind: "socks5", host: "jumpproxy.example", port: 1080 },
    });
    const owner = machine({
      proxy: { kind: "http", host: "ownerproxy.example", port: 8080 },
      jumpHost: { machineId: "jump1", port: 22 },
    });
    const preview = buildSshRoutePreview(owner, [jumpMachine, owner]);
    expect(preview.warnings).toEqual([]);
    expect(preview.hops.map((h) => h.type)).toEqual(["proxy", "jump", "target"]);
    expect(preview.hops[0].endpoint).toBe("jumpproxy.example:1080");
    expect(preview.hops[1].endpoint).toBe("jump.example:2200");
    expect(preview.hops[1].machineName).toBe("Jump Box");
  });

  it("flags a missing referenced jump machine", () => {
    const preview = buildSshRoutePreview(
      machine({ jumpHost: { machineId: "ghost", port: 22 } }),
      [],
    );
    expect(preview.warnings).toEqual([
      { code: "jumpMachineMissing", machineId: "ghost" },
    ]);
    // 无法解析跳板时不编造 hop，仅保留目标。
    expect(preview.hops.map((h) => h.type)).toEqual(["target"]);
  });

  it("flags nested jump hosts as unsupported", () => {
    const nestedJump = machine({
      id: "jump1",
      host: "jump.example",
      jumpHost: { host: "deeper.example", port: 22 },
    });
    const preview = buildSshRoutePreview(
      machine({ jumpHost: { machineId: "jump1", port: 22 } }),
      [nestedJump],
    );
    expect(preview.warnings).toContainEqual({
      code: "nestedJumpUnsupported",
      machineId: "jump1",
    });
  });

  it("ignores a referenced jump when machineId is blank", () => {
    const preview = buildSshRoutePreview(
      machine({ jumpHost: { machineId: "   ", port: 22 } }),
      [],
    );
    expect(preview.usesJump).toBe(false);
    expect(preview.direct).toBe(true);
  });
});
