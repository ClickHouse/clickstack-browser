import { diag } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { gzip, post } from "./transport.ts";

/**
 * Sends gzip-compressed OTLP/JSON request bodies built by an upstream serializer, such as
 * `JsonTraceSerializer`, with `fetch`.
 *
 * @remarks
 * Upstream's browser transport sets `keepalive` on every request that fits its limits and never
 * reads the response, which Chromium counts against the page's 64 KiB budget until then. With small
 * batches, exports during a burst use up the budget and the final flush when the user leaves finds
 * no room. This exporter asks for `keepalive` only while the page is hidden, the one time a request
 * has to outlive the page. Failed exports are not retried.
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
      "content-encoding": "gzip",
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

  async #post(json: Uint8Array): Promise<void> {
    try {
      // The serializers encode with TextEncoder, whose buffer is a plain ArrayBuffer
      const body = await gzip(json as Uint8Array<ArrayBuffer>);
      const response = await post(
        this.#url,
        this.#headers,
        body,
        document.visibilityState === "hidden",
      );
      if (!response.ok) {
        this.#warn(`HTTP ${String(response.status)}`);
      }
    } catch (error) {
      this.#warn(error);
    }
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
