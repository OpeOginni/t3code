import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/http";
import { externalRequestUrl, requestPathPrefix } from "./requestUrl.ts";
import { requestUrls, authorizationServerMetadata } from "./McpOAuth.ts";

const request = (prefix?: string) =>
  HttpServerRequest.fromWeb(
    new Request("http://proxy.test/oauth/token?ignored=yes", {
      headers: {
        host: "proxy.test",
        "x-forwarded-proto": "https",
        ...(prefix === undefined ? {} : { "x-forwarded-prefix": prefix }),
      },
    }),
  );

describe("external request URLs", () => {
  it.each([undefined, "/", "/ws/one", "/ws/one/", "/nested/a%2Fb/c%20d"])(
    "restores the stripped prefix %s",
    (prefix) => {
      const path = prefix?.replace(/\/+$/, "") ?? "";
      expect(Option.getOrThrow(externalRequestUrl(request(prefix))).href).toBe(
        `https://proxy.test${path}/oauth/token?ignored=yes`,
      );
      const urls = requestUrls(request(prefix));
      expect(urls).toEqual({
        issuer: `https://proxy.test${path}`,
        resource: `https://proxy.test${path}/mcp`,
      });
      expect(authorizationServerMetadata(urls).token_endpoint).toBe(
        `https://proxy.test${path}/oauth/mcp/token`,
      );
    },
  );

  it.each([
    "https://other.test/",
    "/one?secret=yes",
    "/one#secret",
    "/one/../two",
    "/one/%2e%2e/two",
    "/one, /two",
    "/one\\two",
  ])("rejects invalid prefix %s instead of changing the authenticated origin or path", (prefix) => {
    expect(() => requestPathPrefix(request(prefix))).toThrow();
    expect(externalRequestUrl(request(prefix))).toEqual(Option.none());
  });
});
