/**
 * The script-tag build: the `ClickStack` global carries the npm entry's API plus the bundled
 * OpenTelemetry API as `ClickStack.otel`, because script-tag pages cannot import
 * `@opentelemetry/api` to create their own spans and logs.
 *
 * @packageDocumentation
 */

import { context, trace } from '@opentelemetry/api';
import { logs } from './logs-api.ts';

export * from './index.ts';

/**
 * The OpenTelemetry API instances the SDK registers with.
 *
 * @public
 */
export const otel: { trace: typeof trace; context: typeof context; logs: typeof logs } = {
  trace,
  context,
  logs,
};
