import type { Attributes } from "@opentelemetry/api";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { SpanProcessor } from "@opentelemetry/sdk-trace";

let customAttributes: Attributes = {};

/**
 * Sets attributes recorded on every span and log record emitted from now on, such as a tenant, a
 * plan or a feature flag, replacing the previous set. Works before `init`. Replay records carry
 * none of them.
 *
 * @remarks
 * Attributes that the SDK, an instrumentation or `setUser` sets, such as `session.id` or
 * `user.id`, win over these. Prefer namespaced keys, such as `app.team.name`.
 *
 * @example
 * ```ts
 * setAttributes({ "app.team.name": team.name, "app.plan": team.plan });
 * ```
 *
 * @param attributes - The attributes, or `null` to stop recording them.
 * @public
 */
export function setAttributes(attributes: Attributes | null): void {
  customAttributes = { ...attributes };
}

// The custom attributes whose keys the record does not have yet
function missingFrom(current: object): Attributes {
  const missing: Attributes = {};

  for (const [key, value] of Object.entries(customAttributes)) {
    if (!(key in current)) {
      missing[key] = value;
    }
  }

  return missing;
}

/**
 * Adds the attributes from {@link setAttributes} to every span when it starts, without replacing
 * any it already has. Runs after the other span processors.
 *
 * @internal
 */
export const attributesSpanProcessor: SpanProcessor = {
  onStart: (span) => {
    span.setAttributes(missingFrom(span.attributes));
  },
  onEnd: () => undefined,
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

/**
 * Adds the attributes from {@link setAttributes} to every log record when it is emitted, without
 * replacing any it already has. Runs after the other log record processors.
 *
 * @internal
 */
export const attributesLogRecordProcessor: LogRecordProcessor = {
  onEmit: (logRecord) => {
    logRecord.setAttributes(missingFrom(logRecord.attributes));
  },
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};
