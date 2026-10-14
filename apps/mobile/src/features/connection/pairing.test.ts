import { describe, expect, it } from "vite-plus/test";

import {
  buildPairingUrl,
  extractPairingUrlFromQrPayload,
  PairingQrPayloadEmptyError,
  parsePairingUrl,
} from "./pairing";

describe("buildPairingUrl", () => {
  it("uses HTTP for a schemeless IP address", () => {
    expect(buildPairingUrl("192.168.1.100:3773", "pairing-token")).toBe(
      "http://192.168.1.100:3773/#token=pairing-token",
    );
  });

  it("keeps HTTPS as the default for a schemeless hostname", () => {
    expect(buildPairingUrl("remote.example.com", "pairing-token")).toBe(
      "https://remote.example.com/#token=pairing-token",
    );
  });

  it("preserves an explicit scheme for an IP address", () => {
    expect(buildPairingUrl("https://192.168.1.100:3773", "pairing-token")).toBe(
      "https://192.168.1.100:3773/#token=pairing-token",
    );
  });
});

describe("extractPairingUrlFromQrPayload", () => {
  it("trims raw pairing urls from qr payloads", () => {
    expect(
      extractPairingUrlFromQrPayload("  https://remote.example.com/pair#token=pairing-token  "),
    ).toBe("https://remote.example.com/pair#token=pairing-token");
  });

  it("unwraps mobile deep links that carry an encoded pairing url", () => {
    expect(
      extractPairingUrlFromQrPayload(
        "t3code://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token",
      ),
    ).toBe("https://remote.example.com/pair#token=pairing-token");
  });

  it("rejects empty qr payloads", () => {
    expect(() => extractPairingUrlFromQrPayload("   ")).toThrowError(PairingQrPayloadEmptyError);
    expect(() => extractPairingUrlFromQrPayload("   ")).toThrowError(
      "Scanned QR code did not contain a pairing URL.",
    );
  });
});

describe("parsePairingUrl", () => {
  it("round-trips a mount named pair without forwarding query or fragment secrets", () => {
    const link = buildPairingUrl(
      "https://proxy.test/nested/pair/?token=old-secret#fragment",
      "pairing-token",
    );
    expect(link).toBe("https://proxy.test/nested/pair/pair#token=pairing-token");
    expect(parsePairingUrl(link)).toEqual({
      host: "https://proxy.test/nested/pair",
      code: "pairing-token",
    });
  });
  it("round-trips direct prefixed links without their pairing route or secrets", () => {
    const fields = parsePairingUrl(
      "http://localhost:8888/ws/a%2Fb/pair?token=secret#token=pairing-token",
    );
    expect(fields).toEqual({ host: "http://localhost:8888/ws/a%2Fb", code: "pairing-token" });
    expect(buildPairingUrl(fields.host, fields.code)).toBe(
      "http://localhost:8888/ws/a%2Fb/pair#token=pairing-token",
    );
  });
  it("reads hosted pairing links into backend host fields", () => {
    expect(
      parsePairingUrl(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%2F#token=pairing-token",
      ),
    ).toEqual({
      host: "https://desktop.tailnet.ts.net",
      code: "pairing-token",
    });
  });
});
