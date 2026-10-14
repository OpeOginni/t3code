import { describe, expect, it } from "vite-plus/test";
import {
  createAdvertisedEndpoint,
  deriveWsBaseUrl,
  environmentEndpointUrl,
  environmentWebSocketUrl,
  normalizeHttpBaseUrl,
} from "./advertisedEndpoint.ts";

describe("server base URLs", () => {
  it.each(["", "/", "/ws/example-workspace", "/ws/example-workspace/", "/nested/a%2Fb/c%20d///"])(
    "preserves the mount and encoding in %s",
    (path) => {
      const prefix = path.replace(/\/+$/, "");
      const base = `https://proxy.test${path}?token=secret#token=secret`;
      expect(normalizeHttpBaseUrl(base)).toBe(`https://proxy.test${prefix}/`);
      expect(deriveWsBaseUrl(base)).toBe(`wss://proxy.test${prefix}/`);
      expect(environmentEndpointUrl(base, "/.well-known/t3/environment")).toBe(
        `https://proxy.test${prefix}/.well-known/t3/environment`,
      );
      expect(environmentEndpointUrl(base, "/api/assets/a%2Fb?signature=signed")).toBe(
        `https://proxy.test${prefix}/api/assets/a%2Fb?signature=signed`,
      );
      expect(environmentWebSocketUrl(deriveWsBaseUrl(base))).toBe(`wss://proxy.test${prefix}/ws`);
    },
  );

  it("keeps legacy explicit websocket endpoints without propagating pairing secrets", () => {
    expect(environmentWebSocketUrl("wss://proxy.test/ws?token=secret#token=secret")).toBe(
      "wss://proxy.test/ws",
    );
    expect(environmentWebSocketUrl("wss://proxy.test/nested/ws")).toBe(
      "wss://proxy.test/nested/ws",
    );
    expect(environmentWebSocketUrl("wss://proxy.test/ws/")).toBe("wss://proxy.test/ws/ws");
  });

  it("does not resolve routes outside the selected environment", () => {
    expect(() =>
      environmentEndpointUrl("https://proxy.test/one", "https://other.test/api"),
    ).toThrow();
    expect(() => environmentEndpointUrl("https://proxy.test/one", "../two/api")).toThrow();
    expect(environmentEndpointUrl("https://user:secret@proxy.test/one?token=secret", "/api")).toBe(
      "https://proxy.test/one/api",
    );
  });

  it("advertises prefixed HTTP and websocket bases", () => {
    expect(
      createAdvertisedEndpoint({
        id: "proxy",
        label: "Proxy",
        provider: { id: "manual", label: "Proxy", kind: "manual", isAddon: false },
        httpBaseUrl: "https://proxy.test/one",
        reachability: "public",
        source: "user",
      }),
    ).toMatchObject({ httpBaseUrl: "https://proxy.test/one/", wsBaseUrl: "wss://proxy.test/one/" });
  });
});
