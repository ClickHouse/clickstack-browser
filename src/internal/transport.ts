import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";

// Upstream's default export timeout. A collector that accepts the connection and never answers
// would otherwise hold the request, and one of the browser's few connections to its host, forever.
const TIMEOUT_MS = 10_000;

// The browser's keepalive limits per page: about 64 KiB of bodies (60 KiB leaves room for headers)
// and, in Chromium, 9 requests at a time. Shared by every exporter.
const KEEPALIVE_MAX_BYTES = 60 * 1024;
const KEEPALIVE_MAX_REQUESTS = 9;
let keepaliveBytes = 0;
let keepaliveRequests = 0;

// The part of that budget requests made while the page is visible may use, so one still in flight
// when the tab closes arrives, and the rest is left to the final flush
const VISIBLE_MAX_BYTES = 16 * 1024;
const VISIBLE_MAX_REQUESTS = 3;
let visibleBytes = 0;
let visibleRequests = 0;

/**
 * Compresses `data` with the browser's gzip `CompressionStream`.
 *
 * @remarks
 * Reads the output with a reader loop. In Chromium, `new Response(stream).arrayBuffer()` does not
 * finish while the page is being hidden, which is exactly when the final batch is sent.
 *
 * @param data - The bytes to compress.
 * @returns The gzip bytes.
 * @internal
 */
export async function gzip(
  data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();

  // Not awaited before reading. A large write waits for the reader (for backpressure)
  const written = writer.write(data).then(() => writer.close());
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;

  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    parts.push(read.value);
    size += read.value.byteLength;
  }

  await written;

  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }

  return result;
}

/**
 * Posts an OTLP request body outside any trace and reads the response.
 *
 * @remarks
 * Keepalive is used when allowed and the limits shared by all exporters allow: while the page is
 * visible, only within a small part of them, and while it is hidden, within all of them. A
 * keepalive request the browser rejects anyway is sent once more without it; it still arrives
 * unless the page is unloading. Chromium counts a keepalive request against the page's budget until its
 * response body is read, so the limits are released only then; cancelling the body instead would
 * show every export as failed in DevTools. The request and the read are aborted after 10 s.
 *
 * @param url - The absolute OTLP/HTTP URL.
 * @param headers - The request headers.
 * @param body - The request body.
 * @param allowKeepalive - Whether the request may use keepalive at all.
 * @returns The response, with its body read.
 * @internal
 */
export async function post(
  url: string,
  headers: Record<string, string>,
  body: Uint8Array<ArrayBuffer>,
  allowKeepalive: boolean,
): Promise<Response> {
  const visible = document.visibilityState !== "hidden";
  const keepalive =
    allowKeepalive &&
    keepaliveBytes + body.byteLength <= KEEPALIVE_MAX_BYTES &&
    keepaliveRequests < KEEPALIVE_MAX_REQUESTS &&
    (!visible ||
      (visibleBytes + body.byteLength <= VISIBLE_MAX_BYTES &&
        visibleRequests < VISIBLE_MAX_REQUESTS));
  const countedVisible = keepalive && visible;
  if (keepalive) {
    keepaliveBytes += body.byteLength;
    keepaliveRequests++;
  }
  if (countedVisible) {
    visibleBytes += body.byteLength;
    visibleRequests++;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);

  // Set right at each call since context does not survive awaits, and the upstream fetch
  // instrumentation would otherwise trace this request.
  const send = (withKeepalive: boolean): Promise<Response> =>
    context.with(suppressTracing(context.active()), () =>
      fetch(url, {
        method: "POST",
        headers,
        body,
        keepalive: withKeepalive,
        signal: controller.signal,
      }),
    );

  try {
    const response = await send(keepalive).catch((error: unknown) => {
      // A rejection is a TypeError. An abort is not retried.
      if (keepalive && error instanceof TypeError) {
        return send(false);
      }

      throw error;
    });
    await response.arrayBuffer();

    return response;
  } finally {
    clearTimeout(timer);
    if (keepalive) {
      keepaliveBytes -= body.byteLength;
      keepaliveRequests--;
    }
    if (countedVisible) {
      visibleBytes -= body.byteLength;
      visibleRequests--;
    }
  }
}
