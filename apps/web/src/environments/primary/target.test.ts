import { afterEach, expect, it, vi } from "vite-plus/test";
import { resolvePrimaryEnvironmentHttpUrl } from "./target";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each(["", "/", "/ws/example-workspace", "/nested/a%2Fb/"])(
  "keeps configured HTTP mount %s without pairing secrets",
  (prefix) => {
    vi.stubGlobal("window", { location: new URL("https://app.t3.codes/") });
    vi.stubEnv("VITE_HTTP_URL", `https://proxy.test${prefix}?token=secret#token=secret`);
    vi.stubEnv("VITE_WS_URL", "");
    vi.stubEnv("VITE_DEV_SERVER_URL", "");
    expect(resolvePrimaryEnvironmentHttpUrl("/.well-known/t3/environment")).toBe(
      `https://proxy.test${prefix.replace(/\/$/, "")}/.well-known/t3/environment`,
    );
    expect(resolvePrimaryEnvironmentHttpUrl("/api/auth/session", { check: "a b" })).toBe(
      `https://proxy.test${prefix.replace(/\/$/, "")}/api/auth/session?check=a+b`,
    );
  },
);
