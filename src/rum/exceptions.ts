import type { Attributes } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import {
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
  ATTR_EXCEPTION_TYPE,
  ATTR_URL_FULL,
} from "@opentelemetry/semantic-conventions";
import { logs } from "../logs-api.ts";
import { VERSION } from "../version.ts";

const SCOPE = "@clickhouse/clickstack-browser";

/**
 * Describes a thrown value as `exception.*` attributes. Errors, and objects shaped like them (such
 * as errors from another frame), give their name, message and stack; other values are recorded as
 * JSON text, because upstream records them with no message at all.
 *
 * @param value - The thrown value or rejection reason.
 * @returns The attributes.
 * @internal
 */
export function exceptionAttributes(value: unknown): Attributes {
  if (typeof value === "string") {
    return { [ATTR_EXCEPTION_MESSAGE]: value };
  }

  if (
    typeof value === "object" &&
    value !== null &&
    ("message" in value || "stack" in value)
  ) {
    const { name, message, stack } = value as Record<string, unknown>;

    return {
      ...(typeof name === "string" ? { [ATTR_EXCEPTION_TYPE]: name } : {}),
      ...(typeof message === "string"
        ? { [ATTR_EXCEPTION_MESSAGE]: message }
        : {}),
      ...(typeof stack === "string"
        ? { [ATTR_EXCEPTION_STACKTRACE]: stack }
        : {}),
    };
  }

  return { [ATTR_EXCEPTION_MESSAGE]: toText(value) };
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

/**
 * Records an error your code caught, such as in a React error boundary, as an `exception` log
 * event: the same event that uncaught errors produce.
 *
 * @remarks
 * Does nothing before `init` has started or after `shutdown`. Inside an active span, the event is
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
