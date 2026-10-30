import type { Attributes } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import {
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
  ATTR_EXCEPTION_TYPE,
  ATTR_URL_FULL,
} from "@opentelemetry/semantic-conventions";
import { logs } from "../logs-api.ts";
import { VERSION } from "../version.ts";

const SCOPE = "@clickhouse/clickstack-browser";
const MAX_CAUSES = 5;

/**
 * Describes a thrown value as `exception.*` attributes. Errors, and objects shaped like them (such
 * as errors from another frame), give their name, message and stack; other values are recorded as
 * JSON text, because upstream records them with no message at all.
 *
 * @remarks
 * An error's `cause` chain, up to five deep, is appended to the stack as `Caused by:` sections, the
 * layout of Java's `printStackTrace`.
 *
 * @param value - The thrown value or rejection reason.
 * @returns The attributes.
 * @internal
 */
export function exceptionAttributes(value: unknown): Attributes {
  if (typeof value === "string") {
    return { [ATTR_EXCEPTION_MESSAGE]: value };
  }

  if (isErrorLike(value)) {
    const { name, message } = value as Record<string, unknown>;
    const stacktrace = stackWithCauses(value);

    return {
      ...(typeof name === "string" ? { [ATTR_EXCEPTION_TYPE]: name } : {}),
      ...(typeof message === "string"
        ? { [ATTR_EXCEPTION_MESSAGE]: message }
        : {}),
      ...(stacktrace === undefined
        ? {}
        : { [ATTR_EXCEPTION_STACKTRACE]: stacktrace }),
    };
  }

  return { [ATTR_EXCEPTION_MESSAGE]: toText(value) };
}

function isErrorLike(value: unknown): value is object {
  return (
    typeof value === "object" &&
    value !== null &&
    ("message" in value || "stack" in value)
  );
}

function stackWithCauses(error: object): string | undefined {
  const { stack } = error as { stack?: unknown };
  let text = typeof stack === "string" ? stack : undefined;
  const seen = new Set<unknown>([error]);
  let { cause } = error as { cause?: unknown };

  for (
    let depth = 0;
    depth < MAX_CAUSES && cause !== undefined && !seen.has(cause);
    depth++
  ) {
    seen.add(cause);

    const causeText = isErrorLike(cause) ? errorText(cause) : toText(cause);
    text = `${text ?? Error.prototype.toString.call(error)}\nCaused by: ${causeText}`;
    cause = isErrorLike(cause)
      ? (cause as { cause?: unknown }).cause
      : undefined;
  }

  return text;
}

// The error's "name: message" line followed by its frames. Chromium's stack starts with that line;
// Firefox and Safari list only the frames.
function errorText(error: object): string {
  const header = Error.prototype.toString.call(error);
  const { stack } = error as { stack?: unknown };

  if (typeof stack !== "string") {
    return header;
  }

  return stack.startsWith(header) ? stack : `${header}\n${stack}`;
}

function toText(value: unknown): string {
  try {
    // Typed as string, but undefined for undefined, functions and symbols
    const json = JSON.stringify(value) as string | undefined;

    if (json !== undefined) {
      return json;
    }
  } catch {
    // A circular structure or a BigInt
  }

  return String(value);
}

let consoleError: Error | undefined;

/**
 * Serializes console arguments into the log body: errors as their message and stack (upstream's
 * default JSON-encodes them, which gives `{}`), everything else as upstream does. Remembers the
 * first error for {@link consoleExceptionProcessor}.
 *
 * @param args - The console call's arguments.
 * @returns The log body.
 * @internal
 */
export function serializeConsoleArgs(args: unknown[]): string {
  consoleError = args.find((arg): arg is Error => arg instanceof Error);

  return args
    .map((arg) => {
      if (arg instanceof Error) {
        return errorText(arg);
      }

      if (typeof arg === "object" && arg !== null) {
        try {
          return JSON.stringify(arg);
        } catch {
          return Object.prototype.toString.call(arg);
        }
      }

      return String(arg);
    })
    .join(" ");
}

/**
 * Adds `exception.*` attributes to a console log record whose arguments included an error, as the
 * logging bridges of other languages do for a logged exception.
 *
 * @remarks
 * Upstream's console instrumentation calls the serializer and then emits the record in the same
 * call, so the remembered error belongs to the next record.
 *
 * @internal
 */
export const consoleExceptionProcessor: LogRecordProcessor = {
  onEmit: (logRecord) => {
    const error = consoleError;
    consoleError = undefined;

    if (error !== undefined && logRecord.eventName === "browser.console") {
      logRecord.setAttributes(exceptionAttributes(error));
    }
  },
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

/**
 * Records an error your code caught, such as in a `try`/`catch`, as an `exception` log event: the
 * same event that uncaught errors produce.
 *
 * @remarks
 * Errors passed to `console.error`, including React's reports of errors caught by error
 * boundaries, are already recorded; calling this for them as well records them twice. Does nothing
 * before `init` has started or after `shutdown`. Inside an active span, the event is
 * linked to that span.
 *
 * @example
 * ```ts
 * try {
 *   await checkout();
 * } catch (error) {
 *   recordException(error, { "app.operation": "checkout" });
 * }
 * ```
 *
 * @param error - The caught value. Values that are not errors are recorded as JSON text.
 * @param attributes - Further attributes for the event. Default: none.
 * @public
 */
export function recordException(error: unknown, attributes?: Attributes): void {
  logs.getLogger(SCOPE, VERSION).emit({
    eventName: "exception",
    severityNumber: SeverityNumber.ERROR,
    attributes: { ...exceptionAttributes(error), ...attributes },
  });
}

/**
 * Records failed loads of images, scripts, stylesheets and media as `exception` log events with
 * the type `ResourceLoadError`.
 *
 * @remarks
 * These `error` events do not bubble, so upstream's errors instrumentation, which listens on
 * `window` without capture, never sees them.
 *
 * @param sanitizeUrl - The guarded URL rewriter, if any.
 * @returns A function that removes the listener.
 * @internal
 */
export function listenForResourceErrors(
  sanitizeUrl: ((url: string) => string) | undefined,
): () => void {
  const onError = ({ target }: Event): void => {
    if (!(target instanceof Element)) {
      return;
    }

    const url = resourceUrl(target);
    if (!url) {
      return;
    }

    const recorded = sanitizeUrl ? sanitizeUrl(url) : url;
    const element = `<${target.tagName.toLowerCase()}>`;
    logs.getLogger(SCOPE, VERSION).emit({
      eventName: "exception",
      severityNumber: SeverityNumber.ERROR,
      attributes: {
        [ATTR_EXCEPTION_TYPE]: "ResourceLoadError",
        [ATTR_EXCEPTION_MESSAGE]: recorded
          ? `Failed to load ${element} ${recorded}`
          : `Failed to load ${element}`,
        ...(recorded ? { [ATTR_URL_FULL]: recorded } : {}),
      },
    });
  };

  window.addEventListener("error", onError, true);

  return () => {
    window.removeEventListener("error", onError, true);
  };
}

function resourceUrl(element: Element): string {
  if (
    element instanceof HTMLImageElement ||
    element instanceof HTMLMediaElement
  ) {
    return element.currentSrc || element.src;
  }

  if (
    element instanceof HTMLScriptElement ||
    element instanceof HTMLSourceElement ||
    element instanceof HTMLTrackElement
  ) {
    return element.src;
  }

  if (element instanceof HTMLLinkElement) {
    return element.href;
  }

  return "";
}
