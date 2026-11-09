import { diag } from "@opentelemetry/api";
import type {
  Session,
  SessionProvider,
  SessionPublisher,
} from "@opentelemetry/browser-sdk/session";
import type { LoggerProvider } from "@opentelemetry/sdk-logs";
import { record } from "@rrweb/record";
import type { eventWithTime } from "@rrweb/types";
import { pageState } from "../internal/global.ts";
import { ATTR_SESSION_ID } from "../semconv.ts";
import { VERSION } from "../version.ts";
import { splitIntoChunks } from "./chunker.ts";
import {
  ATTR_RRWEB_CHUNK,
  ATTR_RRWEB_EVENT,
  ATTR_RRWEB_OFFSET,
  ATTR_RRWEB_TOTAL_CHUNKS,
  EVENT_FULL_SNAPSHOT,
  EVENT_INCREMENTAL_SNAPSHOT,
  EVENT_META,
  MAX_REPLAY_PER_SESSION_MS,
  MOUSE_BLUR,
  MOUSE_FOCUS,
  REPLAY_SCOPE_NAME,
  SOURCE_DRAG,
  SOURCE_INPUT,
  SOURCE_MOUSE_INTERACTION,
  SOURCE_MOUSE_MOVE,
  SOURCE_SCROLL,
  SOURCE_TOUCH_MOVE,
} from "./constants.ts";
import { MutationLimiter } from "./limiter.ts";

// rrweb's own maskAllInputs leaves <input type="hidden"> values.
// Masking by tag name covers every input type.
const MASK_ALL_INPUTS = { input: true, textarea: true, select: true };

/**
 * Options of {@link Recorder}.
 *
 * @internal
 */
export interface RecorderOptions {
  /** The upstream session manager, usable after `await start()`. */
  sessionManager: SessionProvider & SessionPublisher;
  /** The provider from `createReplayProvider`. The recorder handles shutdown. */
  provider: LoggerProvider;
  /** Masks all text (rrweb `maskTextSelector: '*'`) */
  maskAllText: boolean;
  /** Masks the values of all inputs, such as text areas and selects. Otherwise only passwords. */
  maskAllInputs: boolean;
  /** Rewrites the page URL in meta events; already guarded, so it never throws. */
  sanitizeUrl?: ((url: string) => string) | undefined;
}

/**
 * Records the page with rrweb and emits each event as `rr-web.*` log records of the current
 * session.
 *
 * @remarks
 * Each event becomes one or more chunks with a limited size. Per session, `rr-web.event` numbers the
 * events and `rr-web.offset` numbers the records, both starting at 1, and the first
 * event is a meta event followed by a full snapshot.
 *
 * After a session change, nothing is recorded until the tab is visible.
 * For visible tabs, nothing is recorded until the first user input, then a full snapshot opens
 * the new session. An idle open tab rotates its session every inactivity timeout, and a snapshot
 * per rotation would store data nobody watches. Sessions will stop recording after the configured timeout.
 *
 * The session id is cached from the session manager's observer. `getSessionId()` is called again
 * only for user input, because upstream counts every call as session activity, and DOM mutations
 * alone must not keep a session alive.
 *
 * @internal
 */
export class Recorder {
  readonly #sessionManager: SessionProvider & SessionPublisher;
  readonly #provider: LoggerProvider;
  readonly #sanitizeUrl: ((url: string) => string) | undefined;
  readonly #logger: ReturnType<LoggerProvider["getLogger"]>;
  readonly #recordOptions: {
    maskTextSelector?: string;
    maskInputOptions: { password: boolean } | typeof MASK_ALL_INPUTS;
    userTriggeredOnInput: true;
  };
  readonly #limiter = new MutationLimiter(() => {
    this.#onThrottled();
  });
  #sessionId = "";
  #sessionStart = 0;
  #events = 0;
  #offset = 0;
  // The stop function from record(). Set while rrweb runs. rrweb delivers events from pending
  // timers even after stop, so events count only while it is set.
  #stopRrweb: (() => void) | undefined;
  #paused = false;
  #waitingForVisible = false;
  #waitingForInput = false;
  #needsSnapshot = false;
  #snapshotQueued = false;
  #capReached = false;
  #stopped = false;
  #warned = false;
  #snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  #shutdown: Promise<void> | undefined;

  /**
   * Creates a recorder. Nothing is recorded until {@link Recorder.start}.
   *
   * @param options - The session manager, replay provider, the masking choices, and the URL rewriter.
   */
  constructor(options: RecorderOptions) {
    this.#sessionManager = options.sessionManager;
    this.#provider = options.provider;
    this.#sanitizeUrl = options.sanitizeUrl;
    this.#logger = options.provider.getLogger(REPLAY_SCOPE_NAME, VERSION);
    this.#recordOptions = {
      ...(options.maskAllText ? { maskTextSelector: "*" } : {}),
      maskInputOptions: options.maskAllInputs
        ? MASK_ALL_INPUTS
        : { password: true },
      // Differentiates user-typed input from values that scripts write
      userTriggeredOnInput: true,
    };
  }

  /** Starts following the session and recording. */
  start(): void {
    pageState().recording = true;

    // SessionManager.start() rotates a restored session that is already past its maxDuration on a
    // 0 ms timer. Reading the session earlier would record that dead session.
    setTimeout(() => {
      this.#begin();
    }, 0);
  }

  /** Drops replay events until {@link Recorder.resume}. */
  pause(): void {
    this.#paused = true;
  }

  /** Sends replay events again, starting with a full snapshot. */
  resume(): void {
    this.#paused = false;
    this.#requestSnapshot();
  }

  /**
   * Stops rrweb and its listeners and sends the buffered records. Later calls return the same
   * promise.
   *
   * @returns A promise that resolves once the records are sent.
   */
  shutdown(): Promise<void> {
    this.#shutdown ??= this.#shutDown();
    return this.#shutdown;
  }

  async #shutDown(): Promise<void> {
    this.#stopped = true;

    this.#reconcile();
    document.removeEventListener("visibilitychange", this);
    document.removeEventListener("DOMContentLoaded", this);
    pageState().recording = false;

    await this.#provider.shutdown();
  }

  #begin(): void {
    if (this.#stopped) {
      return;
    }

    const manager = this.#sessionManager;

    this.#enterSession(
      manager.getSessionId() ?? "",
      (manager as { getSession?: () => Session }).getSession?.().startTimestamp,
    );

    manager.addObserver({
      onSessionStarted: (session) => {
        this.#onSessionStarted(session);
      },
      onSessionEnded: () => undefined,
    });

    document.addEventListener("visibilitychange", this);

    if (document.readyState === "loading") {
      // On a loading document rrweb takes its first snapshot from its own load listener, outside
      // its error handling; once the document is interactive it takes it inside record()
      document.addEventListener("DOMContentLoaded", this, { once: true });
    } else {
      this.#reconcile();
    }
  }

  #enterSession(id: string, startTimestamp: number | undefined): void {
    this.#sessionId = id;
    this.#sessionStart = startTimestamp ?? Date.now();
    // ClickStack joins chunks by event number, so a leftover chunk of an earlier page's event would
    // be joined into a later event with the same number. A random start keeps the numbers of page
    // loads and tabs apart, and below 2^52 counting on stays exact.
    this.#events = Math.floor(Math.random() * 2 ** 52);
    // Offsets order the records, so they count on from the time in microseconds, above the
    // previous page load's
    this.#offset = Date.now() * 1000;
    this.#limiter.reset();
    this.#capReached =
      Date.now() - this.#sessionStart > MAX_REPLAY_PER_SESSION_MS;
  }

  #onSessionStarted(session: Session): void {
    if (this.#stopped) {
      return;
    }

    this.#enterSession(session.id, session.startTimestamp);
    this.#waitingForVisible = document.visibilityState !== "visible";
    this.#waitingForInput = !this.#waitingForVisible;
    this.#needsSnapshot = true;
    this.#reconcile();
  }

  #reconcile(): void {
    const shouldRun = !this.#stopped && !this.#capReached;
    if (shouldRun && this.#stopRrweb === undefined) {
      this.#needsSnapshot = true;
      // rrweb emits its meta event and full snapshot before record() returns.
      this.#stopRrweb = () => undefined;
      this.#stopRrweb = record({
        ...this.#recordOptions,
        emit: (event) => {
          this.#emit(event);
        },
        errorHandler: (error) => this.#onRrwebError(error),
      });
    } else if (!shouldRun && this.#stopRrweb !== undefined) {
      const stop = this.#stopRrweb;

      this.#stopRrweb = undefined;
      clearTimeout(this.#snapshotTimer);
      stop();
    }
  }

  #isGated(): boolean {
    return this.#paused || this.#waitingForVisible || this.#waitingForInput;
  }

  #requestSnapshot(): void {
    this.#needsSnapshot = true;

    if (this.#snapshotQueued) {
      return;
    }

    this.#snapshotQueued = true;

    // Deferred, so a request made inside rrweb's emit does not re-enter rrweb
    queueMicrotask(() => {
      this.#snapshotQueued = false;

      if (this.#stopRrweb !== undefined && !this.#isGated()) {
        record.takeFullSnapshot(true);
      }
    });
  }

  #emit(event: eventWithTime): void {
    if (this.#stopRrweb === undefined) {
      return;
    }

    if (isUserInput(event)) {
      // Called for its side effect only. Upstream counts the call as session activity
      this.#sessionManager.getSessionId();

      if (this.#waitingForInput) {
        this.#waitingForInput = false;
        this.#requestSnapshot();
        return;
      }
    }

    if (this.#isGated()) {
      return;
    }

    if (this.#needsSnapshot) {
      if (event.type === EVENT_FULL_SNAPSHOT) {
        this.#needsSnapshot = false;
      } else if (event.type !== EVENT_META) {
        return;
      }
    }

    if (event.timestamp - this.#sessionStart > MAX_REPLAY_PER_SESSION_MS) {
      this.#capReached = true;

      // Stopping rrweb from inside its own emit would re-enter it.
      queueMicrotask(() => {
        this.#reconcile();
      });

      return;
    }

    if (isFromBlockedFrame(event)) {
      return;
    }

    const kept = this.#limiter.filter(
      event,
      (id) => record.mirror.getNode(id),
      performance.now(),
    );

    if (kept !== undefined) {
      this.#send(kept);
    }
  }

  #send(event: eventWithTime): void {
    const sanitizeUrl = this.#sanitizeUrl;
    const recorded =
      event.type === EVENT_META && sanitizeUrl !== undefined
        ? {
            ...event,
            data: { ...event.data, href: sanitizeUrl(event.data.href) },
          }
        : event;
    const chunks = splitIntoChunks(JSON.stringify(recorded));
    const eventNumber = ++this.#events;

    chunks.forEach((body, index) => {
      this.#logger.emit({
        timestamp: event.timestamp,
        body,
        attributes: {
          [ATTR_SESSION_ID]: this.#sessionId,
          [ATTR_RRWEB_EVENT]: eventNumber,
          [ATTR_RRWEB_CHUNK]: index + 1,
          [ATTR_RRWEB_TOTAL_CHUNKS]: chunks.length,
          [ATTR_RRWEB_OFFSET]: ++this.#offset,
        },
      });
    });
  }

  #onThrottled(): void {
    this.#warnOnce(
      "replay drops attribute changes of nodes that change too often",
    );

    // One full snapshot a second after the last drop restores what the dropped changes left out
    clearTimeout(this.#snapshotTimer);
    this.#snapshotTimer = setTimeout(() => {
      this.#requestSnapshot();
    }, 1000);
  }

  #onRrwebError(error: unknown): boolean {
    this.#warnOnce("rrweb failed", error);

    // True makes rrweb eat the error, otherwise it reaches the page and the errors
    // instrumentation records it as an application error.
    return true;
  }

  #warnOnce(message: string, ...args: unknown[]): void {
    if (!this.#warned) {
      this.#warned = true;
      diag.warn(`@clickhouse/clickstack-browser: ${message}`, ...args);
    }
  }

  /**
   * Handles `visibilitychange` and `DOMContentLoaded` on the document. The recorder is its own
   * listener object, so shutdown removes both by the same reference.
   *
   * @param event - The document event.
   */
  handleEvent(event: Event): void {
    if (event.type === "DOMContentLoaded") {
      this.#reconcile();
    } else if (
      this.#waitingForVisible &&
      document.visibilityState === "visible"
    ) {
      this.#waitingForVisible = false;
      this.#requestSnapshot();
    }
  }
}

// rrweb 2.1.7 records the document of a blocked same-origin iframe anyway, through the mutation
// that attaches it and every later event from inside it. rrweb marks the elements it blocks with
// an rr_width attribute in its mirror, so an event is dropped when its node or an enclosing frame
// carries one.
function isFromBlockedFrame(event: eventWithTime): boolean {
  if (event.type !== EVENT_INCREMENTAL_SNAPSHOT) {
    return false;
  }

  const data = event.data as {
    id?: number;
    positions?: { id: number }[];
    adds?: { parentId: number }[];
    removes?: { parentId: number }[];
    texts?: { id: number }[];
    attributes?: { id: number }[];
  };
  const id =
    data.id ??
    data.positions?.[0]?.id ??
    (data.adds?.[0] ?? data.removes?.[0])?.parentId ??
    (data.texts?.[0] ?? data.attributes?.[0])?.id;

  for (
    let node: Node | null | undefined =
      id === undefined ? null : record.mirror.getNode(id);
    node;
    node = (node.ownerDocument ?? (node as Document)).defaultView?.frameElement
  ) {
    const meta = record.mirror.getMeta(node) as {
      attributes?: { rr_width?: unknown };
    } | null;

    if (meta?.attributes?.rr_width !== undefined) {
      return true;
    }
  }

  return false;
}

// Focus and blur fire on element.focus(), and input written by scripts carries userTriggered
// false, so neither counts as user input.
function isUserInput(event: eventWithTime): boolean {
  if (event.type !== EVENT_INCREMENTAL_SNAPSHOT) {
    return false;
  }

  const { data } = event;
  switch (data.source) {
    case SOURCE_MOUSE_MOVE:
    case SOURCE_SCROLL:
    case SOURCE_TOUCH_MOVE:
    case SOURCE_DRAG:
      return true;
    case SOURCE_MOUSE_INTERACTION:
      return data.type !== MOUSE_FOCUS && data.type !== MOUSE_BLUR;
    case SOURCE_INPUT:
      return data.userTriggered === true;
    default:
      return false;
  }
}
