import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

/**
 * Like X-Forwarded-Proto, this header must be overwritten by the reverse proxy.
 * It describes only the stripped mount path; it never changes the accepted origin.
 */
export function requestPathPrefix(request: HttpServerRequest.HttpServerRequest): string {
  const prefix = request.headers["x-forwarded-prefix"]?.replace(/\/+$/, "") ?? "";
  if (!prefix) return "";
  if (!prefix.startsWith("/") || /[\\?#,;\s]/.test(prefix)) {
    throw new Error("Invalid forwarded path prefix.");
  }
  const url = new URL(`http://localhost${prefix}/`);
  if (url.origin !== "http://localhost" || url.pathname !== `${prefix}/`) {
    throw new Error("Invalid forwarded path prefix.");
  }
  return prefix;
}

export function externalRequestUrl(
  request: HttpServerRequest.HttpServerRequest,
): Option.Option<URL> {
  return Option.flatMap(HttpServerRequest.toURL(request), (url) => {
    try {
      url.pathname = `${requestPathPrefix(request)}${url.pathname}`;
      return Option.some(url);
    } catch {
      return Option.none();
    }
  });
}
