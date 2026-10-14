import type {
  EnvironmentPresentation,
  PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { connectionCatalogDisplayUrl } from "@t3tools/client-runtime/connection";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { deriveWsBaseUrl } from "@t3tools/shared/advertisedEndpoint";

import type { SavedRemoteConnection } from "../lib/connection";
import type { EnvironmentRuntimeState } from "./remote-runtime-types";

function projectedWsBaseUrl(httpBaseUrl: string, socketUrl: string | undefined) {
  try {
    const url = new URL(socketUrl || deriveWsBaseUrl(httpBaseUrl));
    if (socketUrl) url.pathname = url.pathname.replace(/\/ws$/, "/");
    url.search = "";
    url.hash = "";
    url.username = "";
    url.password = "";
    // Root projections historically omit the slash; mounts must remain directories.
    return url.pathname === "/" ? url.origin : url.toString();
  } catch {
    // An unavailable SSH route displays user@host, not an HTTP base URL.
    return httpBaseUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  }
}

export function createRemoteEnvironmentProjectionAtoms(input: {
  readonly presentationAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<EnvironmentPresentation | null>;
  readonly preparedConnectionAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<Option.Option<PreparedConnection>>;
  readonly serverConfigAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerConfig | null>;
}) {
  const savedConnectionAtom = Atom.family((environmentId: EnvironmentId) => {
    let previousEntry: EnvironmentPresentation["entry"] | null = null;
    let previousPrepared: PreparedConnection | null = null;
    let previous: SavedRemoteConnection | null = null;

    return Atom.make((get) => {
      const presentation = get(input.presentationAtom(environmentId));
      if (presentation === null) {
        previousEntry = null;
        previousPrepared = null;
        previous = null;
        return null;
      }

      const prepared = Option.getOrNull(get(input.preparedConnectionAtom(environmentId)));
      if (
        previous !== null &&
        presentation.entry === previousEntry &&
        prepared === previousPrepared
      ) {
        return previous;
      }

      const displayUrl = connectionCatalogDisplayUrl(presentation.entry) ?? "";
      const httpBaseUrl = prepared?.httpBaseUrl ?? displayUrl;
      const wsBaseUrl = projectedWsBaseUrl(httpBaseUrl, prepared?.socketUrl);
      const authorization = prepared?.httpAuthorization ?? null;
      // Credentials follow the route in use, which may not be the preferred one.
      const relayManaged = prepared
        ? prepared.target._tag === "RelayConnectionTarget"
        : presentation.entry.target._tag === "RelayConnectionTarget";

      previousEntry = presentation.entry;
      previousPrepared = prepared;
      previous = {
        environmentId,
        environmentLabel: presentation.entry.target.label,
        pairingUrl: displayUrl,
        displayUrl,
        httpBaseUrl,
        wsBaseUrl,
        bearerToken: authorization?._tag === "Bearer" ? authorization.token : null,
        ...(relayManaged
          ? {
              authenticationMethod: "dpop" as const,
              relayManaged: true as const,
              ...(authorization?._tag === "Dpop"
                ? { dpopAccessToken: authorization.accessToken }
                : {}),
            }
          : { authenticationMethod: "bearer" as const }),
      };
      return previous;
    }).pipe(Atom.withLabel(`mobile:saved-connection:${environmentId}`));
  });

  const runtimeStateAtom = Atom.family((environmentId: EnvironmentId) => {
    let previousConnection: EnvironmentPresentation["connection"] | null = null;
    let previousServerConfig: ServerConfig | null = null;
    let previous: EnvironmentRuntimeState | null = null;

    return Atom.make((get) => {
      const presentation = get(input.presentationAtom(environmentId));
      if (presentation === null) {
        previousConnection = null;
        previousServerConfig = null;
        previous = null;
        return null;
      }

      const connection = presentation.connection;
      const serverConfig = get(input.serverConfigAtom(environmentId));
      if (
        previous !== null &&
        connection.phase === previousConnection?.phase &&
        connection.error === previousConnection?.error &&
        connection.traceId === previousConnection?.traceId &&
        serverConfig === previousServerConfig
      ) {
        return previous;
      }

      previousConnection = connection;
      previousServerConfig = serverConfig;
      previous = {
        connectionState: connection.phase,
        connectionError: connection.error,
        connectionErrorTraceId: connection.traceId,
        serverConfig,
      };
      return previous;
    }).pipe(Atom.withLabel(`mobile:environment-runtime-state:${environmentId}`));
  });

  return { savedConnectionAtom, runtimeStateAtom };
}
