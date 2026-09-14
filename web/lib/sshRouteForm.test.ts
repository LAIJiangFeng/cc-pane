import { describe, expect, it } from "vitest";
import {
  emptyRouteForm,
  isRouteFormDirty,
  parsePort,
  proxyNeedsCredentials,
  routeFormFromMachine,
  routeFormToMachineFields,
  routeFormToRequestFields,
  validateRouteForm,
  type RouteFormState,
} from "./sshRouteForm";
import type { SshMachine } from "@/types";

const t = ((key: string) => key) as never;

function machine(overrides: Partial<SshMachine> = {}): SshMachine {
  return {
    id: overrides.id ?? "m",
    name: overrides.name ?? "machine",
    host: overrides.host ?? "target.example",
    port: overrides.port ?? 22,
    authMethod: overrides.authMethod ?? "key",
    tags: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("parsePort", () => {
  it("accepts in-range ports and rejects the rest", () => {
    expect(parsePort("1080")).toBe(1080);
    expect(parsePort(" 22 ")).toBe(22);
    expect(parsePort("0")).toBeNull();
    expect(parsePort("65536")).toBeNull();
    expect(parsePort("abc")).toBeNull();
    expect(parsePort("")).toBeNull();
  });
});

describe("proxyNeedsCredentials", () => {
  it("is true only when proxy is enabled with a username", () => {
    expect(
      proxyNeedsCredentials({ ...emptyRouteForm, proxyEnabled: true, proxyUsername: "u" }),
    ).toBe(true);
    expect(
      proxyNeedsCredentials({ ...emptyRouteForm, proxyEnabled: true, proxyUsername: "  " }),
    ).toBe(false);
    expect(
      proxyNeedsCredentials({ ...emptyRouteForm, proxyEnabled: false, proxyUsername: "u" }),
    ).toBe(false);
  });
});

describe("routeFormFromMachine", () => {
  it("returns the empty form for a new machine", () => {
    expect(routeFormFromMachine(null)).toEqual(emptyRouteForm);
  });

  it("restores proxy and reference jump host", () => {
    const form = routeFormFromMachine(
      machine({
        proxy: { kind: "http", host: "p.example", port: 8080, username: "u" },
        jumpHost: { machineId: "j1", port: 22 },
        hasStoredProxyPassword: true,
      }),
    );
    expect(form.proxyEnabled).toBe(true);
    expect(form.proxyKind).toBe("http");
    expect(form.proxyHost).toBe("p.example");
    expect(form.proxyPort).toBe("8080");
    expect(form.proxyUsername).toBe("u");
    expect(form.rememberProxyPassword).toBe(true);
    expect(form.jumpEnabled).toBe(true);
    expect(form.jumpMode).toBe("reference");
    expect(form.jumpMachineId).toBe("j1");
    // 密码输入永远是空的，绝不从存储回填。
    expect(form.proxyPasswordInput).toBe("");
  });

  it("restores an inline jump host in inline mode", () => {
    const form = routeFormFromMachine(
      machine({
        jumpHost: { host: "j.example", port: 2222, user: "root" },
      }),
    );
    expect(form.jumpMode).toBe("inline");
    expect(form.jumpHost).toBe("j.example");
    expect(form.jumpPort).toBe("2222");
    expect(form.jumpUser).toBe("root");
  });
});

describe("routeFormToMachineFields", () => {
  it("emits nothing when both proxy and jump are disabled", () => {
    expect(routeFormToMachineFields(emptyRouteForm)).toEqual({});
  });

  it("omits a proxy with a blank host or bad port", () => {
    expect(
      routeFormToMachineFields({
        ...emptyRouteForm,
        proxyEnabled: true,
        proxyHost: "",
        proxyPort: "1080",
      }),
    ).toEqual({});
    expect(
      routeFormToMachineFields({
        ...emptyRouteForm,
        proxyEnabled: true,
        proxyHost: "p.example",
        proxyPort: "bad",
      }),
    ).toEqual({});
  });

  it("emits proxy without username when anonymous", () => {
    const fields = routeFormToMachineFields({
      ...emptyRouteForm,
      proxyEnabled: true,
      proxyKind: "socks5",
      proxyHost: "p.example",
      proxyPort: "1080",
    });
    expect(fields.proxy).toEqual({
      kind: "socks5",
      host: "p.example",
      port: 1080,
      username: undefined,
    });
  });

  it("emits an inline jump host with trimmed user and identity", () => {
    const fields = routeFormToMachineFields({
      ...emptyRouteForm,
      jumpEnabled: true,
      jumpMode: "inline",
      jumpHost: "j.example",
      jumpPort: "2222",
      jumpUser: " root ",
      jumpIdentityFile: " ~/.ssh/id ",
    });
    expect(fields.jumpHost).toEqual({
      host: "j.example",
      port: 2222,
      user: "root",
      identityFile: "~/.ssh/id",
    });
  });

  it("never leaks the proxy password into machine fields", () => {
    const fields = routeFormToMachineFields({
      ...emptyRouteForm,
      proxyEnabled: true,
      proxyHost: "p.example",
      proxyPort: "1080",
      proxyUsername: "u",
      proxyPasswordInput: "supersecret",
      rememberProxyPassword: true,
    });
    expect(JSON.stringify(fields)).not.toContain("supersecret");
  });
});

describe("routeFormToRequestFields", () => {
  it("remembers only when proxy needs credentials and remember is on", () => {
    const req = routeFormToRequestFields({
      ...emptyRouteForm,
      proxyEnabled: true,
      proxyHost: "p.example",
      proxyPort: "1080",
      proxyUsername: "u",
      rememberProxyPassword: true,
      proxyPasswordInput: "pw",
    });
    expect(req.rememberProxyPassword).toBe(true);
    expect(req.proxyPasswordInput).toBe("pw");
  });

  it("does not send a password for an anonymous proxy", () => {
    const req = routeFormToRequestFields({
      ...emptyRouteForm,
      proxyEnabled: true,
      proxyHost: "p.example",
      proxyPort: "1080",
      proxyPasswordInput: "ignored",
    });
    expect(req.rememberProxyPassword).toBe(false);
    expect(req.proxyPasswordInput).toBeUndefined();
  });

  it("clears the stored proxy password when the proxy is removed", () => {
    const req = routeFormToRequestFields(
      { ...emptyRouteForm },
      machine({ hasStoredProxyPassword: true }),
    );
    expect(req.clearStoredProxyPassword).toBe(true);
  });

  it("clears when remember is turned off with a stored password", () => {
    const req = routeFormToRequestFields(
      {
        ...emptyRouteForm,
        proxyEnabled: true,
        proxyHost: "p.example",
        proxyPort: "1080",
        proxyUsername: "u",
        rememberProxyPassword: false,
      },
      machine({ hasStoredProxyPassword: true }),
    );
    expect(req.clearStoredProxyPassword).toBe(true);
  });
});

describe("validateRouteForm", () => {
  it("passes for an untouched empty form", () => {
    expect(validateRouteForm(emptyRouteForm, false, null, t)).toBeNull();
  });

  it("requires a proxy host and valid port", () => {
    expect(
      validateRouteForm(
        { ...emptyRouteForm, proxyEnabled: true },
        false,
        null,
        t,
      ),
    ).toBe("ssh.proxy.hostRequired");
    expect(
      validateRouteForm(
        { ...emptyRouteForm, proxyEnabled: true, proxyHost: "p", proxyPort: "x" },
        false,
        null,
        t,
      ),
    ).toBe("ssh.proxy.portInvalid");
  });

  it("rejects remember-without-password on add", () => {
    expect(
      validateRouteForm(
        {
          ...emptyRouteForm,
          proxyEnabled: true,
          proxyHost: "p",
          proxyPort: "1080",
          proxyUsername: "u",
          rememberProxyPassword: true,
        },
        false,
        null,
        t,
      ),
    ).toBe("ssh.proxy.passwordRequiredToRemember");
  });

  it("allows remember-without-new-password when one is already stored", () => {
    expect(
      validateRouteForm(
        {
          ...emptyRouteForm,
          proxyEnabled: true,
          proxyHost: "p",
          proxyPort: "1080",
          proxyUsername: "u",
          rememberProxyPassword: true,
        },
        true,
        machine({ hasStoredProxyPassword: true }),
        t,
      ),
    ).toBeNull();
  });

  it("requires a jump machine in reference mode and a host in inline mode", () => {
    expect(
      validateRouteForm(
        { ...emptyRouteForm, jumpEnabled: true, jumpMode: "reference" },
        false,
        null,
        t,
      ),
    ).toBe("ssh.jump.machineRequired");
    expect(
      validateRouteForm(
        { ...emptyRouteForm, jumpEnabled: true, jumpMode: "inline" },
        false,
        null,
        t,
      ),
    ).toBe("ssh.jump.hostRequired");
    expect(
      validateRouteForm(
        {
          ...emptyRouteForm,
          jumpEnabled: true,
          jumpMode: "inline",
          jumpHost: "j",
          jumpPort: "0",
        },
        false,
        null,
        t,
      ),
    ).toBe("ssh.jump.portInvalid");
  });
});

describe("isRouteFormDirty", () => {
  const base: RouteFormState = { ...emptyRouteForm };

  it("is clean for an unchanged existing machine", () => {
    expect(isRouteFormDirty(base, machine())).toBe(false);
  });

  it("is dirty when the proxy is enabled in add mode", () => {
    expect(
      isRouteFormDirty({ ...base, proxyEnabled: true, proxyHost: "p", proxyPort: "1080" }, null),
    ).toBe(true);
  });

  it("is dirty when the proxy config differs from the stored machine", () => {
    expect(
      isRouteFormDirty(
        { ...base, proxyEnabled: true, proxyHost: "new", proxyPort: "1080" },
        machine({ proxy: { kind: "socks5", host: "old", port: 1080 } }),
      ),
    ).toBe(true);
  });

  it("is dirty when a proxy password was typed", () => {
    expect(
      isRouteFormDirty({ ...base, proxyPasswordInput: "x" }, machine()),
    ).toBe(true);
  });
});
