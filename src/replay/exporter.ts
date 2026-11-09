import { diag, type Attributes, type HrTime } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import {
  defaultResource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import { compress, post } from "../internal/transport.ts";

// Keeps requests far below the collector's default body limit
const MAX_REQUEST_CHARS = 4 * 1024 * 1024;

// Replay's share of the keepalive budget that all exporters share, so a long replay pending when
// the page is hidden leaves room for the last traces and logs
const KEEPALIVE_MAX_BYTES = 32 * 1024;

type Batch = [ReadableLogRecord, ...ReadableLogRecord[]];

type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: AnyValue[] } };

function toAnyValue(value: unknown): AnyValue {
  if (typeof value === "number") {
    // note: OTLP JSON strings for 64-bit ints
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(toAnyValue) } };
  }
  return { stringValue: String(value) };
}

function toKeyValues(
  attributes: Attributes,
): { key: string; value: AnyValue }[] {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ key, value: toAnyValue(value) }));
}

function toNanoseconds([seconds, nanoseconds]: HrTime): string {
  return (BigInt(seconds) * 1_000_000_000n + BigInt(nanoseconds)).toString();
}

/**
 * Serializes replay records as an OTLP/JSON logs export request.
 *
 * @remarks
 * All records share one resource and one scope since they come from one logger.
 *
 * @param records - The records to send, at least one.
 * @returns The JSON text of the request.
 * @internal
 */
export function toOtlpJson(
  records: readonly [ReadableLogRecord, ...ReadableLogRecord[]],
): string {
  const [{ resource, instrumentationScope }] = records;
  return JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: toKeyValues(resource.attributes) },
        scopeLogs: [
          {
            scope: {
              name: instrumentationScope.name,
              version: instrumentationScope.version,
            },
            logRecords: records.map((record) => ({
              timeUnixNano: toNanoseconds(record.hrTime),
              observedTimeUnixNano: toNanoseconds(record.hrTimeObserved),
              body: toAnyValue(record.body),
              attributes: toKeyValues(record.attributes as Attributes),
            })),
          },
        ],
      },
    ],
  });
}

function* bySize(records: readonly ReadableLogRecord[]): Generator<Batch> {
  let group: Batch | undefined;
  let chars = 0;

  for (const record of records) {
    // Replay record bodies are always strings.
    const size = (record.body as string).length;

    if (group !== undefined && chars + size <= MAX_REQUEST_CHARS) {
      group.push(record);
      chars += size;
    } else {
      if (group !== undefined) {
        yield group;
      }
      group = [record];
      chars = size;
    }
  }

  if (group !== undefined) {
    yield group;
  }
}

// The two halves of a batch, or undefined for a single record.
function split(batch: Batch): [Batch, Batch] | undefined {
  const [first, ...rest] = batch;
  const [second, ...tail] = rest.splice(Math.ceil(batch.length / 2) - 1);
  return second === undefined
    ? undefined
    : [
        [first, ...rest],
        [second, ...tail],
      ];
}

async function encode(batch: Batch): Promise<Uint8Array<ArrayBuffer>> {
  return compress(new TextEncoder().encode(toOtlpJson(batch)));
}

// Gzip bodies of at most KEEPALIVE_MAX_BYTES each, splitting the batch as needed. A single record
// that is still larger stays one body.
async function keepaliveBodies(
  batch: Batch,
): Promise<Uint8Array<ArrayBuffer>[]> {
  const body = await encode(batch);
  const halves =
    body.byteLength > KEEPALIVE_MAX_BYTES ? split(batch) : undefined;

  if (halves === undefined) {
    return [body];
  }

  return [
    ...(await keepaliveBodies(halves[0])),
    ...(await keepaliveBodies(halves[1])),
  ];
}

/**
 * Sends replay records as gzip-compressed OTLP/JSON with `fetch`.
 *
 * @internal
 */
export class ReplayExporter implements LogRecordExporter {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #pending = new Set<Promise<void>>();
  // Bytes of this exporter's keepalive requests still in flight.
  #keepaliveBytes = 0;
  #warned = false;

  /**
   * Creates an exporter for one OTLP logs URL.
   *
   * @param url - The absolute OTLP/HTTP logs URL.
   * @param apiKey - The ingestion key for the `authorization` header, if any.
   */
  constructor(url: string, apiKey: string | undefined) {
    this.#url = url;
    this.#headers = {
      ...(apiKey ? { authorization: apiKey } : {}),
      "content-type": "application/json",
    };
  }

  /**
   * Sends the records in requests with limited body size.
   *
   * @param records - The batch from the batch processor.
   * @param resultCallback - Called with success once every request finished. Failures are logged
   * here once.
   */
  export(
    records: ReadableLogRecord[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    const sending = this.#send(records)
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

  async #send(records: readonly ReadableLogRecord[]): Promise<void> {
    for (const batch of bySize(records)) {
      if (document.visibilityState === "hidden") {
        // This is the final flush. Only keepalive requests outlive the page, and the browser caps
        // their bodies. Every part is sent at once, with keepalive while this exporter's share and
        // the shared budget last. Parts beyond them are lost if the page unloads.
        const bodies = await keepaliveBodies(batch);
        await Promise.all(bodies.map((body) => this.#post(body, true)));
      } else {
        await this.#post(await encode(batch), false);
      }
    }
  }

  async #post(body: Uint8Array<ArrayBuffer>, hidden: boolean): Promise<void> {
    const withinShare =
      hidden && this.#keepaliveBytes + body.byteLength <= KEEPALIVE_MAX_BYTES;
    if (withinShare) {
      this.#keepaliveBytes += body.byteLength;
    }

    try {
      const response = await post(this.#url, this.#headers, body, withinShare);
      if (!response.ok) {
        this.#warn(`HTTP ${String(response.status)}`);
      }
    } catch (error) {
      this.#warn(error);
    } finally {
      if (withinShare) {
        this.#keepaliveBytes -= body.byteLength;
      }
    }
  }

  #warn(reason: unknown): void {
    if (!this.#warned) {
      this.#warned = true;
      diag.warn(
        `@clickhouse/clickstack-browser: replay export to ${new URL(this.#url).host} failed; later failures are not logged`,
        reason,
      );
    }
  }
}

/**
 * Creates the logger provider that batches replay records with the upstream browser batch
 * processor which also flushes when the page is hidden
 *
 * @param url - The absolute OTLP/HTTP logs URL.
 * @param apiKey - The ingestion key, if any.
 * @param resourceAttributes - The RUM resource attributes, so replay records carry the same
 * `service.name` (ClickStack finds a session's replay by it).
 * @returns The provider. Its `shutdown()` sends what is buffered.
 * @internal
 */
export function createReplayProvider(
  url: string,
  apiKey: string | undefined,
  resourceAttributes: Attributes,
): LoggerProvider {
  return new LoggerProvider({
    resource: defaultResource().merge(
      resourceFromAttributes(resourceAttributes),
    ),
    processors: [
      new BatchLogRecordProcessor({
        exporter: new ReplayExporter(url, apiKey),
        scheduledDelayMillis: 5000,
      }),
    ],
  });
}
