import type {
  AdvertisedEndpoint,
  AdvertisedEndpointHostedHttpsCompatibility,
  AdvertisedEndpointProvider,
  AdvertisedEndpointReachability,
  AdvertisedEndpointSource,
  AdvertisedEndpointStatus,
} from "@t3tools/contracts";

export interface CreateAdvertisedEndpointInput {
  readonly id: string;
  readonly label: string;
  readonly provider: AdvertisedEndpointProvider;
  readonly httpBaseUrl: string;
  readonly reachability: AdvertisedEndpointReachability;
  readonly hostedHttpsCompatibility?: AdvertisedEndpointHostedHttpsCompatibility;
  readonly desktopCompatibility?: "compatible" | "unknown";
  readonly source: AdvertisedEndpointSource;
  readonly status?: AdvertisedEndpointStatus;
  readonly isDefault?: boolean;
  readonly description?: string;
}

/** Base URLs name a directory, not an origin or an individual endpoint. */
function normalizeServerBaseUrl(rawValue: string): string {
  const url = new URL(rawValue);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** Resolve a server-relative route inside its mount, without carrying base URL secrets. */
export function environmentEndpointUrl(baseUrl: string, pathname: string): string {
  const base = new URL(normalizeServerBaseUrl(baseUrl));
  const url = new URL(pathname.replace(/^\/+/, ""), base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
    throw new Error("Environment endpoint must stay within its server base URL.");
  }
  return url.toString();
}

export function environmentWebSocketUrl(wsBaseUrl: string): string {
  // Older configured endpoints use /ws without the directory slash.
  const url = new URL(wsBaseUrl);
  if (url.pathname.endsWith("/ws")) {
    url.search = "";
    url.hash = "";
    url.username = "";
    url.password = "";
    return url.toString();
  }
  return environmentEndpointUrl(wsBaseUrl, "/ws");
}

export function normalizeHttpBaseUrl(rawValue: string): string {
  const url = new URL(normalizeServerBaseUrl(rawValue));
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Endpoint must use HTTP or HTTPS. Received ${url.protocol}`);
  }

  return url.toString();
}

export function deriveWsBaseUrl(httpBaseUrl: string): string {
  const url = new URL(normalizeHttpBaseUrl(httpBaseUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function classifyHostedHttpsCompatibility(
  httpBaseUrl: string,
  fallback: AdvertisedEndpointHostedHttpsCompatibility = "unknown",
): AdvertisedEndpointHostedHttpsCompatibility {
  const url = new URL(normalizeHttpBaseUrl(httpBaseUrl));
  if (url.protocol === "http:") {
    return "mixed-content-blocked";
  }
  return fallback === "mixed-content-blocked" ? "unknown" : fallback;
}

export function createAdvertisedEndpoint(input: CreateAdvertisedEndpointInput): AdvertisedEndpoint {
  const httpBaseUrl = normalizeHttpBaseUrl(input.httpBaseUrl);
  return {
    id: input.id,
    label: input.label,
    provider: input.provider,
    httpBaseUrl,
    wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
    reachability: input.reachability,
    compatibility: {
      hostedHttpsApp:
        input.hostedHttpsCompatibility ?? classifyHostedHttpsCompatibility(httpBaseUrl),
      desktopApp: input.desktopCompatibility ?? "compatible",
    },
    source: input.source,
    status: input.status ?? "available",
    ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
    ...(input.description === undefined ? {} : { description: input.description }),
  };
}
