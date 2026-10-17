/**
 * Builds the OTLP/HTTP URL of one signal from the collector base URL.
 *
 * @remarks
 * `/v1/traces` or `/v1/logs` is appended to the path, as for `OTEL_EXPORTER_OTLP_ENDPOINT`. A
 * relative endpoint, such as a same-origin proxy path, resolves against the page URL, because the
 * upstream SDK accepts only absolute URLs.
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
  if (!endpoint) {
    return undefined;
  }
  try {
    const url = new URL(endpoint, location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/${signal}`;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}
