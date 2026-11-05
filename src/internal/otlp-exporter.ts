import { context, diag } from "@opentelemetry/api";
import {
  ExportResultCode,
  suppressTracing,
  type ExportResult,
} from "@opentelemetry/core";

// The browser's keepalive limits per page: about 64 KiB of bodies (60 KiB leaves room for headers)
// and, in Chromium, 9 requests at a time. Shared by the traces and logs exporters.
const KEEPALIVE_MAX_BYTES = 60 * 1024;
const KEEPALIVE_MAX_REQUESTS = 9;
let keepaliveBytes = 0;
let keepaliveRequests = 0;

/**
 * Sends OTLP/JSON request bodies built by an upstream serializer, such as `JsonTraceSerializer`,
 * with `fetch`.
 *
 * @remarks
 * Upstream's browser transport sets `keepalive` on every request that fits the browser's limits.
 * Chromium counts a keepalive request against the page's 64 KiB budget until its response body is
 * read, so exports during a burst use up the budget, get rejected and retried with backoff, and the
 * final flush when the user leaves finds no room. This exporter sets `keepalive` only while the
 * page is hidden, the one time a request has to outlive the page. Failed exports are not retried.
 *
 * @internal
 */
export class OtlpJsonExporter<T> {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #serializer: {
    serializeRequest(items: T[]): Uint8Array | undefined;
  };
  readonly #pending = new Set<Promise<void>>();
  #warned = false;

  /**
   * Creates an exporter for one OTLP/HTTP signal URL.
   *
   * @param url - The absolute OTLP/HTTP URL, such as the traces URL.
   * @param apiKey - The ingestion key for the `authorization` header, if any.
   * @param serializer - The upstream OTLP/JSON serializer for the signal.
   */
  constructor(
    url: string,
    apiKey: string | undefined,
    serializer: { serializeRequest(items: T[]): Uint8Array | undefined },
  ) {
    this.#url = url;
    this.#headers = {
      ...(apiKey ? { authorization: apiKey } : {}),
      "content-type": "application/json",
    };
    this.#serializer = serializer;
  }

  /**
   * Sends the items in one request.
   *
   * @param items - The batch from the batch processor.
   * @param resultCallback - Called with success once the request finished. Failures are logged
   * here once.
   */
  export(items: T[], resultCallback: (result: ExportResult) => void): void {
    const body = this.#serializer.serializeRequest(items);
    const sending = (body ? this.#post(body) : Promise.resolve()).then(() => {
      this.#pending.delete(sending);

      resultCallback({ code: ExportResultCode.SUCCESS });
    });

    this.#pending.add(sending);
  }

  /** Resolves when every started request has finished */
  async forceFlush(): Promise<void> {
    await Promise.all(this.#pending);
  }

  /** Resolves when every started request has finished */
  shutdown(): Promise<void> {
    return this.forceFlush();
  }

  async #post(body: Uint8Array): Promise<void> {
    const keepalive =
      document.visibilityState === "hidden" &&
      keepaliveBytes + body.byteLength <= KEEPALIVE_MAX_BYTES &&
      keepaliveRequests < KEEPALIVE_MAX_REQUESTS;
    if (keepalive) {
      keepaliveBytes += body.byteLength;
      keepaliveRequests++;
    }

    try {
      const response = await this.#fetch(body, keepalive).catch(
        (error: unknown) => {
          // The browser rejects keepalive requests beyond its limits. Without keepalive the
          // request still arrives unless the page is unloading.
          if (keepalive) {
            return this.#fetch(body, false);
          }

          throw error;
        },
      );

      if (!response.ok) {
        this.#warn(`HTTP ${String(response.status)}`);
      }

      // Chromium counts a keepalive request against the budget until its body is read. Cancelling
      // the body instead would show every export as failed in DevTools.
      await response.arrayBuffer();
    } catch (error) {
      this.#warn(error);
    } finally {
      if (keepalive) {
        keepaliveBytes -= body.byteLength;
        keepaliveRequests--;
      }
    }
  }

  #fetch(body: Uint8Array, keepalive: boolean): Promise<Response> {
    // Set right at the call since context does not survive the awaits before it, and the
    // upstream fetch instrumentation would otherwise trace this request.
    return context.with(suppressTracing(context.active()), () =>
      fetch(this.#url, {
        method: "POST",
        headers: this.#headers,
        // The serializers encode with TextEncoder, whose buffer is a plain ArrayBuffer
        body: body as Uint8Array<ArrayBuffer>,
        keepalive,
      }),
    );
  }

  #warn(reason: unknown): void {
    if (!this.#warned) {
      this.#warned = true;
      diag.warn(
        `@clickhouse/clickstack-browser: export to ${new URL(this.#url).host} failed; later failures are not logged`,
        reason,
      );
    }
  }
}
