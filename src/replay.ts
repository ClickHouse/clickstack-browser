/**
 * Session replay for apps that set up the upstream OpenTelemetry browser SDK themselves.
 *
 * @packageDocumentation
 */

export { startReplay } from './replay/start.ts';
export type { ReplayController, ReplayStartOptions } from './replay/start.ts';
