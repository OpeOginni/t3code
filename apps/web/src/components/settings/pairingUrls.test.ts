import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from "./pairingUrls";

describe("settings pairing URL helpers", () => {
  it("keeps nested prefixes in direct and hosted links", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://app.t3.codes");
    expect(
      resolveDesktopPairingUrl("https://proxy.test/ws/a%2Fb/?ignored=yes#secret", "PAIRCODE"),
    ).toBe("https://proxy.test/ws/a%2Fb/pair#token=PAIRCODE");
    expect(resolveHostedPairingUrl("https://proxy.test/ws/a%2Fb/", "PAIRCODE")).toBe(
      "https://app.t3.codes/pair?host=https%3A%2F%2Fproxy.test%2Fws%2Fa%252Fb#token=PAIRCODE",
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses direct backend pairing URLs for HTTP endpoints", () => {
    expect(resolveHostedPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBeNull();
    expect(resolveDesktopPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBe(
      "http://192.168.1.44:3773/pair#token=PAIRCODE",
    );
  });

  it("uses hosted pairing URLs for HTTPS endpoints", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");

    expect(resolveHostedPairingUrl("https://host.tailnet.example.ts.net:3773", "PAIRCODE")).toBe(
      "https://preview.t3.codes/pair?host=https%3A%2F%2Fhost.tailnet.example.ts.net%3A3773#token=PAIRCODE",
    );
  });
});
