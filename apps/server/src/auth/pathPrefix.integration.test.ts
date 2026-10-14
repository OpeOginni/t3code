import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAdministrativeScopes,
  EnvironmentHttpApi,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import { computeDpopAccessTokenHash } from "@t3tools/shared/dpop";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Etag from "effect/http/Etag";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The integration fixture implements a prefix-stripping HTTP/upgrade proxy.
import * as NodeHttp from "node:http";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Tests need an actual websocket handshake and ES256 signing.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Type of sockets returned by Node's HTTP upgrade event.
import type * as NodeStream from "node:stream";

import * as Config from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as AuthHttp from "./http.ts";
import {
  bootstrapRemoteBearerSession,
  exchangeRemoteDpopAccessToken,
  fetchRemoteSessionState,
  issueRemoteDpopWebSocketTicket,
  resolveRemoteWebSocketConnectionUrl,
  resolveRemoteDpopWebSocketConnectionUrl,
} from "../../../../packages/client-runtime/src/authorization/remote.ts";
import { fetchRemoteEnvironmentDescriptor } from "../../../../packages/client-runtime/src/environment/descriptor.ts";
import {
  layerRemoteHttpClient,
  makeEnvironmentHttpApiClient,
  makeEnvironmentHttpApiUrlBuilder,
} from "../../../../packages/client-runtime/src/rpc/http.ts";

class ProxyTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.auth,
  EnvironmentHttpApi.groups.metadata,
) {}

const environmentHandler = Effect.fnUntraced(function* (id: string) {
  const identity = Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make(id)),
  });
  const config = Config.layerTest(process.cwd(), { prefix: "t3-prefix-proxy-" });
  const context = yield* Layer.build(
    EnvironmentAuth.layer.pipe(
      Layer.provide(Sqlite.layerMemory),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(identity),
      Layer.provideMerge(config),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
  const dependencies = Layer.succeedContext(context);
  const metadata = HttpApiBuilder.group(ProxyTestApi, "metadata", (handlers) =>
    Effect.succeed(
      handlers.handle("descriptor", () =>
        Effect.succeed({
          environmentId: EnvironmentId.make(id),
          label: id,
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0-test",
          orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
          capabilities: { repositoryIdentity: true },
        }),
      ),
    ),
  );
  // Test-only provisioning and upgrade adapters; all credentials use the real auth service.
  const fixtures = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/fixture/pairing",
      Effect.gen(function* () {
        const service = yield* EnvironmentAuth.EnvironmentAuth;
        return HttpServerResponse.jsonUnsafe(
          yield* service.issuePairingCredential({ scopes: [...AuthAdministrativeScopes] }),
        );
      }),
    ),
    HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const service = yield* EnvironmentAuth.EnvironmentAuth;
        const request = yield* HttpServerRequest.HttpServerRequest;
        const result = yield* service.authenticateWebSocketUpgrade(request).pipe(Effect.result);
        return result._tag === "Success"
          ? HttpServerResponse.jsonUnsafe({ environmentId: id })
          : HttpServerResponse.empty({ status: 401 });
      }),
    ),
  );
  const api = HttpRouter.toWebHandler(
    Layer.mergeAll(HttpApiBuilder.layer(ProxyTestApi), fixtures).pipe(
      Layer.provide(metadata),
      Layer.provide(AuthHttp.layer),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
      Layer.provide(HttpPlatform.layer.pipe(Layer.provideMerge(Etag.layerWeak))),
      Layer.provide(dependencies),
      HttpRouter.provideRequest(dependencies),
    ),
    { disableLogger: true },
  );
  yield* Effect.addFinalizer(() => Effect.promise(() => api.dispose()));
  return api;
});

/** A real HTTP/upgrade listener that strips a mount before dispatching to independent T3 auth APIs. */
const prefixProxy = Effect.fnUntraced(function* (forwardPrefix = true) {
  const mounts = ["/ws/example-workspace", "/nested/a%2Fb/second"];
  const environments = yield* Effect.forEach(mounts, (_, index) =>
    environmentHandler(`environment-${index}`),
  );
  const sockets = new Set<NodeStream.Duplex>();
  const requests: Array<string> = [];
  let origin = "";
  let redirectTo: string | undefined;
  const dispatch = async (incoming: NodeHttp.IncomingMessage) => {
    const url = new URL(incoming.url ?? "/", origin);
    requests.push(url.pathname);
    const index = mounts.findIndex((mount) => url.pathname.startsWith(`${mount}/`));
    if (index < 0) return new Response(null, { status: 404 });
    const mount = mounts[index]!;
    url.pathname = url.pathname.slice(mount.length);
    if (
      redirectTo !== undefined &&
      ["/oauth/token", "/api/auth/browser-session"].includes(url.pathname)
    ) {
      return new Response(null, { status: 307, headers: { location: redirectTo } });
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    if (forwardPrefix) headers.set("x-forwarded-prefix", mount);
    else headers.delete("x-forwarded-prefix");
    headers.set("x-forwarded-proto", "http");
    const chunks: Array<Buffer> = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = chunks.length === 0 ? undefined : Buffer.concat(chunks).toString();
    return environments[index]!.handler(
      new Request(url, {
        method: incoming.method ?? "GET",
        headers,
        ...(body === undefined ? {} : { body }),
      }),
    );
  };
  const server = NodeHttp.createServer((request, response) => {
    void dispatch(request)
      .then(async (result) => {
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
      })
      .catch((error: unknown) => response.destroy(error instanceof Error ? error : undefined));
  });
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    void dispatch(request)
      .then((response) => {
        if (response.status !== 200) {
          socket.end(
            `HTTP/1.1 ${response.status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
          );
          return;
        }
        const accept = NodeCrypto.createHash("sha1")
          .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        socket.on("end", () => socket.end());
      })
      .catch(() => socket.destroy());
  });
  yield* Effect.promise(
    () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    return yield* Effect.die(new Error("Expected a TCP address."));
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    mounts,
    requests,
    redirect: (url: string) => {
      redirectTo = url;
    },
    dispose: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
});

function upgrade(wsUrl: string, cookie?: string): Promise<number> {
  const url = new URL(wsUrl);
  url.protocol = "http:";
  return new Promise((resolve, reject) => {
    const request = NodeHttp.request(url, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": Buffer.alloc(16, 1).toString("base64"),
        ...(cookie === undefined ? {} : { cookie, origin: url.origin }),
      },
    });
    request.once("error", reject);
    request.once("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    request.once("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.end();
  });
}

async function pairingCredential(base: string) {
  // @effect-diagnostics-next-line globalFetch:off -- Exercise native fetch through the actual HTTP proxy fixture.
  const response = await fetch(`${base}/fixture/pairing`);
  expect(response.status).toBe(200);
  return (await response.json()) as { credential: string };
}

async function discoveryStatus(origin: string) {
  // @effect-diagnostics-next-line globalFetch:off -- Assert the proxy exposes no root discovery workaround.
  return (await fetch(`${origin}/.well-known/t3/environment`)).status;
}

async function browserCookie(base: string) {
  const pairing = await pairingCredential(base);
  // @effect-diagnostics-next-line globalFetch:off -- Native fetch exposes the actual proxy Set-Cookie headers.
  const response = await fetch(`${base}/api/auth/browser-session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: pairing.credential }),
  });
  expect(response.status).toBe(200);
  const [cookie] = response.headers.getSetCookie();
  expect(cookie).toContain(`Path=${new URL(base).pathname}/;`);
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Lax");
  return cookie!.split(";", 1)[0]!;
}

async function cookieSession(base: string, cookie: string, origin = new URL(base).origin) {
  // @effect-diagnostics-next-line globalFetch:off -- Simulate browser cookie and Origin headers without launching a browser.
  const response = await fetch(`${base}/api/auth/session`, { headers: { cookie, origin } });
  return (await response.json()) as { authenticated: boolean };
}

it.live(
  "pairs, authenticates, calls APIs and upgrades two independently prefixed environments without forwarded-prefix hints",
  () =>
    Effect.acquireUseRelease(
      prefixProxy(false),
      (proxy) =>
        Effect.gen(function* () {
          const tokens: Array<string> = [];
          const socketUrls: Array<string> = [];
          for (const [index, mount] of proxy.mounts.entries()) {
            const base = `${proxy.origin}${mount}`;
            const pairing = yield* Effect.promise(() => pairingCredential(base));
            const target = resolveRemotePairingTarget({
              pairingUrl: `https://app.t3.codes/pair?host=${encodeURIComponent(`${base}?token=ignored#fragment`)}#token=${pairing.credential}`,
            });
            const descriptor = yield* fetchRemoteEnvironmentDescriptor(target);
            expect(descriptor.environmentId).toBe(`environment-${index}`);
            const access = yield* bootstrapRemoteBearerSession({
              ...target,
              credential: target.credential,
            });
            tokens.push(access.access_token);
            expect(
              yield* fetchRemoteSessionState({ ...target, bearerToken: access.access_token }),
            ).toMatchObject({ authenticated: true });
            const client = yield* makeEnvironmentHttpApiClient(target.httpBaseUrl);
            const sessions = yield* client.auth.clients({
              headers: { authorization: `Bearer ${access.access_token}` },
            });
            expect(sessions).toBeDefined();
            expect(makeEnvironmentHttpApiUrlBuilder(base).auth.session()).toBe(
              `${base}/api/auth/session`,
            );
            const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
              ...target,
              bearerToken: access.access_token,
            });
            expect(new URL(socketUrl).pathname).toBe(`${mount}/ws`);
            expect(socketUrl).not.toContain(pairing.credential);
            socketUrls.push(socketUrl);
            expect(yield* Effect.promise(() => upgrade(socketUrl))).toBe(101);
            // Reconnection obtains another ticket without falling back to root.
            const reconnected = yield* resolveRemoteWebSocketConnectionUrl({
              ...target,
              bearerToken: access.access_token,
            });
            expect(yield* Effect.promise(() => upgrade(reconnected))).toBe(101);
          }
          const wrongToken = yield* fetchRemoteSessionState({
            httpBaseUrl: `${proxy.origin}${proxy.mounts[1]}`,
            bearerToken: tokens[0]!,
          });
          expect(wrongToken.authenticated).toBe(false);
          const wrongSocket = socketUrls[0]!.replace(proxy.mounts[0]!, proxy.mounts[1]!);
          expect(yield* Effect.promise(() => upgrade(wrongSocket))).toBe(401);
          expect(yield* Effect.promise(() => discoveryStatus(proxy.origin))).toBe(404);
        }).pipe(Effect.provide(layerRemoteHttpClient(globalThis.fetch))),
      (proxy) => Effect.promise(() => proxy.dispose()),
    ),
);

it.live(
  "verifies DPoP against the external prefixed URI without accepting a proof for another mount",
  () =>
    Effect.acquireUseRelease(
      prefixProxy(),
      (proxy) =>
        Effect.gen(function* () {
          const base = `${proxy.origin}${proxy.mounts[0]}`;
          const pairing = yield* Effect.promise(() => pairingCredential(base));
          const now = yield* Clock.currentTimeMillis;
          const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
            namedCurve: "P-256",
          });
          const proof = (url: string, accessToken?: string) => {
            const header = Buffer.from(
              JSON.stringify({
                typ: "dpop+jwt",
                alg: "ES256",
                jwk: publicKey.export({ format: "jwk" }),
              }),
            ).toString("base64url");
            const payload = Buffer.from(
              JSON.stringify({
                htm: "POST",
                htu: url,
                jti: NodeCrypto.randomUUID(),
                iat: Math.floor(now / 1000),
                ...(accessToken === undefined
                  ? {}
                  : { ath: computeDpopAccessTokenHash(accessToken) }),
              }),
            ).toString("base64url");
            const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
              key: privateKey,
              dsaEncoding: "ieee-p1363",
            }).toString("base64url");
            return `${header}.${payload}.${signature}`;
          };
          const token = yield* exchangeRemoteDpopAccessToken({
            httpBaseUrl: base,
            credential: pairing.credential,
            dpopProof: proof(`${base}/oauth/token`),
          });
          expect(token.token_type).toBe("DPoP");
          const wsUrl = yield* resolveRemoteDpopWebSocketConnectionUrl({
            httpBaseUrl: base,
            wsBaseUrl: base.replace(/^http:/, "ws:"),
            accessToken: token.access_token,
            dpopProof: proof(`${base}/api/auth/websocket-ticket`, token.access_token),
          });
          expect(yield* Effect.promise(() => upgrade(wsUrl))).toBe(101);
          const rejected = yield* issueRemoteDpopWebSocketTicket({
            httpBaseUrl: base,
            accessToken: token.access_token,
            dpopProof: proof(
              `${proxy.origin}${proxy.mounts[1]}/api/auth/websocket-ticket`,
              token.access_token,
            ),
          }).pipe(Effect.result);
          expect(rejected).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "EnvironmentAuthInvalidError", dpopFailureReason: "request_mismatch" },
          });
        }).pipe(Effect.provide(layerRemoteHttpClient(globalThis.fetch))),
      (proxy) => Effect.promise(() => proxy.dispose()),
    ),
);

it.live("does not redirect pairing credentials to another mount or origin", () =>
  Effect.acquireUseRelease(
    Effect.all([prefixProxy(), prefixProxy()]),
    ([proxy, unrelated]) =>
      Effect.gen(function* () {
        const base = `${proxy.origin}${proxy.mounts[0]}`;
        for (const destination of [
          `${proxy.origin}${proxy.mounts[1]}/oauth/token`,
          `${unrelated.origin}${unrelated.mounts[0]}/oauth/token`,
        ]) {
          proxy.redirect(destination);
          const result = yield* bootstrapRemoteBearerSession({
            httpBaseUrl: `${base}?token=secret#secret`,
            credential: "pairing-secret",
          }).pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure._tag).toBe("RemoteEnvironmentAuthFetchError");
          const client = yield* makeEnvironmentHttpApiClient(base);
          const browserPairing = yield* client.auth
            .browserSession({
              payload: { credential: "browser-pairing-secret" },
            })
            .pipe(Effect.result);
          expect(browserPairing._tag).toBe("Failure");
        }
        expect(proxy.requests).toEqual([
          `${proxy.mounts[0]}/oauth/token`,
          `${proxy.mounts[0]}/api/auth/browser-session`,
          `${proxy.mounts[0]}/oauth/token`,
          `${proxy.mounts[0]}/api/auth/browser-session`,
        ]);
        expect(unrelated.requests).toEqual([]);
      }).pipe(Effect.provide(layerRemoteHttpClient(globalThis.fetch))),
    (proxies) => Effect.promise(() => Promise.all(proxies.map((proxy) => proxy.dispose()))),
  ),
);

it.live("scopes browser cookies to each mount and keeps HTTP and upgrade origin checks", () =>
  Effect.acquireUseRelease(
    prefixProxy(),
    (proxy) =>
      Effect.gen(function* () {
        const bases = proxy.mounts.map((mount) => `${proxy.origin}${mount}`);
        const cookies = yield* Effect.promise(() => Promise.all(bases.map(browserCookie)));
        for (const [index, base] of bases.entries()) {
          expect(yield* Effect.promise(() => cookieSession(base, cookies[index]!))).toMatchObject({
            authenticated: true,
          });
          expect(
            yield* Effect.promise(() => cookieSession(base, cookies[1 - index]!)),
          ).toMatchObject({ authenticated: false });
          expect(
            yield* Effect.promise(() =>
              cookieSession(base, cookies[index]!, "https://unrelated.test"),
            ),
          ).toMatchObject({ authenticated: false });
          expect(
            yield* Effect.promise(() =>
              upgrade(`${base.replace(/^http:/, "ws:")}/ws`, cookies[index]),
            ),
          ).toBe(101);
          expect(
            yield* Effect.promise(() =>
              upgrade(`${base.replace(/^http:/, "ws:")}/ws`, cookies[1 - index]),
            ),
          ).toBe(401);
        }
      }),
    (proxy) => Effect.promise(() => proxy.dispose()),
  ),
);
