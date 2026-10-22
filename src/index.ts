/**
 * Browser RUM and session replay for ClickStack
 *
 * @remarks
 * {@link init} starts everything with a few options. Apps that set up the upstream SDK
 * themselves use `startReplay` from `@clickhouse/clickstack-browser/replay` instead.
 *
 * @packageDocumentation
 */

export {
  getSessionId,
  init,
  pauseReplay,
  resumeReplay,
  shutdown,
  startNewSession,
} from "./init/init.ts";
export type { ClickStackBrowserOptions, ConsoleLevel } from "./init/init.ts";
export { setUser } from "./rum/user.ts";
export type { User } from "./rum/user.ts";
