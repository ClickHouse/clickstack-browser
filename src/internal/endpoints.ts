// A signal path at the end of what should be a base URL, such as an OTLP traces URL pasted as the
// endpoint
const SIGNAL_PATH = /\/v1\/(?:traces|logs)\/*$/;

/**
 * Resolves a collector URL to an absolute http(s) URL.
 *
 * @remarks
 * A relative value, such as a same-origin proxy path, resolves against the page URL, because the
 * upstream SDK accepts only absolute URLs.
 *
 * @param url - The URL from the options.
 * @returns The absolute URL, or `undefined` when `url` is empty, unparsable or not http(s).
 * @internal
 */
export function resolveUrl(url: string | undefined): URL | undefined {
  if (!url) {
    return undefined;
  }

  try {
    const resolved = new URL(url, location.href);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return undefined;
    }

    resolved.hash = "";

    return resolved;
  } catch {
    return undefined;
  }
}

/**
 * Builds the OTLP/HTTP URL of one signal from the collector base URL.
 *
 * @remarks
 * `/v1/traces` or `/v1/logs` is appended to the path, as for `OTEL_EXPORTER_OTLP_ENDPOINT`, after
 * dropping a `/v1/traces` or `/v1/logs` the endpoint already ends with.
 *
 * @param endpoint - The collector base URL.
 * @param signal - The signal whose path is appended.
 * @returns The absolute URL, or `undefined` when `endpoint` is empty, unparsable or not http(s).
 * @internal
 */
export function signalUrl(
  endpoint: string | undefined,
  signal: "traces" | "logs",
): string | undefined {
  const url = resolveUrl(endpoint);
  if (url === undefined) {
    return undefined;
  }
  const base = url.pathname.replace(SIGNAL_PATH, "").replace(/\/+$/, "");
  url.pathname = `${base}/v1/${signal}`;
  return url.href;
}

/**
 * Whether an endpoint already ends with `/v1/traces` or `/v1/logs`, which {@link signalUrl} drops.
 *
 * @param endpoint - The collector base URL.
 * @returns `true` for an endpoint such as `https://collector/v1/traces`.
 * @internal
 */
export function hasSignalPath(endpoint: string | undefined): boolean {
  const url = resolveUrl(endpoint);

  return url !== undefined && SIGNAL_PATH.test(url.pathname);
}
