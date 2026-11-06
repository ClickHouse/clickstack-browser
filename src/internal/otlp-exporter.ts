import { diag } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { gzip, post } from "./transport.ts";

// A final flush larger than this is split, so the parts that fit the shared keepalive budget arrive
// even when the whole would not
const KEEPALIVE_PART_BYTES = 16 * 1024;

/**
 * Sends gzip-compressed OTLP/JSON request bodies built by an upstream serializer, such as
 * `JsonTraceSerializer`, with `fetch`.
 *
 * @remarks
 * Upstream's browser transport sets `keepalive` on every request that fits its limits and never
 * reads the response, which Chromium counts against the page's 64 KiB budget until then. With small
 * batches, exports during a burst use up the budget and the final flush when the user leaves finds
 * no room. This exporter asks for `keepalive` only while the page is hidden, the one time a request
 * has to outlive the page, and then splits a batch over 16 KiB compressed, so the parts that fit
 * the budget arrive even when the whole would not. Failed exports are not retried.
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
   * Sends the items in one request, or in parts while the page is hidden.
   *
   * @param items - The batch from the batch processor.
   * @param resultCallback - Called with success once every request finished. Failures are logged
   * here once.
   */
  export(items: T[], resultCallback: (result: ExportResult) => void): void {
    const sending = this.#send(items)
      .catch((error: unknown) => {
        this.#warn(error);
      })
      .then(() => {
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

  async #send(items: T[]): Promise<void> {
    const body = await this.#compress(items);
    if (body === undefined) {
      return;
    }

    // Only a hidden page needs keepalive, the one time the budget limits what arrives. Read after
    // compressing, so a page hidden while the body was compressed still gets keepalive and the split.
    const hidden = document.visibilityState === "hidden";
    const bodies = hidden ? await this.#split(items, body) : [body];

    await Promise.all(bodies.map((part) => this.#post(part, hidden)));
  }

  async #compress(items: T[]): Promise<Uint8Array<ArrayBuffer> | undefined> {
    const json = this.#serializer.serializeRequest(items);

    // The serializers encode with TextEncoder, whose buffer is a plain ArrayBuffer
    return json === undefined
      ? undefined
      : gzip(json as Uint8Array<ArrayBuffer>);
  }

  // The items' body, and while it is over KEEPALIVE_PART_BYTES, the bodies of each half of the items.
  // A single item that is still larger stays one body.
  async #split(
    items: T[],
    body: Uint8Array<ArrayBuffer>,
  ): Promise<Uint8Array<ArrayBuffer>[]> {
    if (body.byteLength <= KEEPALIVE_PART_BYTES || items.length < 2) {
      return [body];
    }

    const half = Math.ceil(items.length / 2);
    const bodies: Uint8Array<ArrayBuffer>[] = [];
    for (const part of [items.slice(0, half), items.slice(half)]) {
      const partBody = await this.#compress(part);
      if (partBody !== undefined) {
        bodies.push(...(await this.#split(part, partBody)));
      }
    }

    return bodies;
  }

  async #post(body: Uint8Array<ArrayBuffer>, hidden: boolean): Promise<void> {
    try {
      const response = await post(this.#url, this.#headers, body, hidden);
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
