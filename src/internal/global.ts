/**
 * Flags shared by every copy of this package on the page, for example the npm build and the
 * script-tag build loaded together.
 *
 * @internal
 */
export interface PageState {
  /** Set by the first `init` (or a `shutdown` before it); later calls to `init` are ignored. */
  initialized?: boolean;
  /** Set while a recorder runs. rrweb keeps its recording state in module scope, one per page. */
  recording?: boolean;
}

const KEY = Symbol.for("@clickhouse/clickstack-browser");

/**
 * Returns the page-wide flags, creating them on first use.
 *
 * @returns The flags object stored on `globalThis`.
 * @internal
 */
export function pageState(): PageState {
  const holder = globalThis as unknown as Record<symbol, PageState | undefined>;
  return (holder[KEY] ??= {});
}
