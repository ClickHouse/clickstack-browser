import { diag } from "@opentelemetry/api";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { ATTR_URL_FULL } from "@opentelemetry/semantic-conventions";

// The upstream instrumentations emit these events with `url.full` but have no `sanitizeUrl` hook.
const EVENTS_WITHOUT_HOOK = new Set([
  "browser.navigation_timing",
  "browser.resource_timing",
]);

/**
 * Wraps a user `sanitizeUrl` so that it never throws.
 *
 * @remarks
 * Upstream navigation calls the hook without a guard, so a throw would escape `history.pushState`
 * into the app. A failed or non-string result becomes `''`, so a broken hook records no URL rather
 * than the raw one. The first failure is reported through `diag.warn`.
 *
 * @param sanitizeUrl - The user's hook.
 * @returns The guarded hook.
 * @internal
 */
export function guardSanitizeUrl(
  sanitizeUrl: (url: string) => string,
): (url: string) => string {
  let warned = false;

  return (url) => {
    try {
      const sanitized = sanitizeUrl(url);
      if (typeof sanitized === "string") {
        return sanitized;
      }
    } catch (error) {
      if (!warned) {
        warned = true;
        diag.warn(
          "@clickhouse/clickstack-browser: sanitizeUrl failed; the URL is left out",
          error,
        );
      }
    }

    return "";
  };
}

/**
 * Rewrites `url.full` on the navigation timing and resource timing events, which have no upstream
 * hook.
 *
 * @param sanitizeUrl - The guarded hook.
 * @returns A log record processor to run before the export.
 * @internal
 */
export function createUrlSanitizerLogRecordProcessor(
  sanitizeUrl: (url: string) => string,
): LogRecordProcessor {
  return {
    onEmit: (logRecord) => {
      const url = logRecord.attributes[ATTR_URL_FULL];

      if (
        logRecord.eventName !== undefined &&
        EVENTS_WITHOUT_HOOK.has(logRecord.eventName) &&
        typeof url === "string"
      ) {
        logRecord.setAttribute(ATTR_URL_FULL, sanitizeUrl(url));
      }
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}
