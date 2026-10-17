import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import {
  ConsoleInstrumentation,
  type ConsoleMethod,
} from "@opentelemetry/browser-instrumentation/experimental/console";
import { ErrorsInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/errors";
import { FetchInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/fetch";
import { NavigationInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/navigation";
import { NavigationTimingInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/navigation-timing";
import { UserActionInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/user-action";
import { WebVitalsInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/web-vitals";
import { XhrInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/xhr";
import { startBrowserSdk, type WebSdk } from "@opentelemetry/browser-sdk";
import {
  createDocumentLogRecordProcessor,
  createDocumentSpanProcessor,
  createLocationDocumentProvider,
} from "@opentelemetry/browser-sdk/document";
import {
  createDefaultSessionIdGenerator,
  createLocalStorageSessionStore,
  createSessionLogRecordProcessor,
  createSessionManager,
  createSessionSpanProcessor,
  type SessionManager,
  type SessionStore,
} from "@opentelemetry/browser-sdk/session";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { LongTaskInstrumentation } from "@opentelemetry/instrumentation-long-task";
import { browserDetector } from "@opentelemetry/opentelemetry-browser-detector";
import { detectResources } from "@opentelemetry/resources";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_TELEMETRY_DISTRO_NAME,
  ATTR_TELEMETRY_DISTRO_VERSION,
} from "@opentelemetry/semantic-conventions";
import { signalUrl } from "../internal/endpoints.ts";
import { pageState } from "../internal/global.ts";
import { createReplayProvider } from "../replay/exporter.ts";
import { Recorder } from "../replay/recorder.ts";
import {
  createUrlSanitizerLogRecordProcessor,
  guardSanitizeUrl,
} from "../rum/sanitize-url.ts";
import { userLogRecordProcessor, userSpanProcessor } from "../rum/user.ts";
import { VERSION } from "../version.ts";

/**
 * How much of the console is captured as `browser.console` log events. Each level includes the
 * more severe ones (`'info'` also captures `console.log`).
 *
 * @public
 */
export type ConsoleLevel = "error" | "warn" | "info" | "debug";

const CONSOLE_METHODS: Record<ConsoleLevel, ConsoleMethod[]> = {
  error: ["error"],
  warn: ["error", "warn"],
  info: ["error", "warn", "info", "log"],
  debug: ["error", "warn", "info", "log", "debug"],
};

/**
 * Options of {@link init}.
 *
 * @public
 */
export interface ClickStackBrowserOptions {
  /**
   * OTLP/HTTP base URL of the collector, for example `https://example-collector.clickhouse.com:4318`, or a
   * same-origin proxy path such as `/otel`. `/v1/traces` and `/v1/logs` are appended to its path,
   * and a relative value resolves against the page URL.
   */
  endpoint: string;
  /**
   * Ingestion API key, sent as the `authorization` header. Default: none.
   */
  apiKey?: string | undefined;
  /** `service.name` of every span, log record and replay record. */
  serviceName: string;
  /**
   * Deployment environment, such as `production` or `staging`, recorded as the resource attribute
   * `deployment.environment.name`. Default: none.
   */
  environment?: string | undefined;
  /**
   * Backend origins, such as `https://example-api.clickhouse.com`, whose fetch and XHR requests carry W3C
   * trace context headers so backend traces join the browser's. Same-origin requests always
   * carry them. A regular expression is matched against the full request URL. Each backend must
   * allow the `traceparent`, `tracestate` and `baggage` request headers in CORS. Default: none.
   */
  traceOrigins?: (string | RegExp)[] | undefined;
  /** Records a session replay, with all text and form values masked. Default: `true`. */
  replay?: boolean | undefined;
  /** Console level captured as log events, or `false` for none. Default: `'error'`. */
  console?: ConsoleLevel | false | undefined;
  /**
   * Rewrites every URL before it is recorded, for example to remove tokens from query strings. It
   * applies to the page URL on spans and logs, fetch and XHR spans, navigation events, navigation
   * and resource timing events, and the page URL in the replay. A hook that throws or returns a
   * non-string records an empty URL. Default: none, URLs are recorded as they are.
   */
  sanitizeUrl?: ((url: string) => string) | undefined;
}

interface Run {
  sessionId: string | null;
  replayPaused: boolean;
  started?: Promise<void>;
  stopping?: Promise<void>;
  sessionManager?: SessionManager;
  sdk?: WebSdk;
  deregister?: () => void;
  recorder?: Recorder;
}

// One SDK instance per page, so its state lives here
const run: Run = { sessionId: null, replayPaused: false };

/**
 * Starts browser RUM and session replay on the upstream OpenTelemetry browser SDK.
 *
 * @remarks
 * Starts in the background. It restores or creates the session,
 * starts the SDK with the session, document and user processors,
 * enables the fetch, XHR, errors, navigation, user action, web vitals, navigation
 * timing, resource timing, long task and console instrumentations, and records the replay.
 * Telemetry from before the SDK has started is not captured. Without a document (such as for server-side
 * rendering, workers) it does nothing. Only the first call on a page counts, subsequent calls log a
 * warning.
 *
 * @example
 * ```ts
 * init({ endpoint: 'https://example-collector.clickhouse.com:4318', serviceName: 'example-app' });
 * ```
 *
 * @param options - The endpoint, the service name, and the few choices this package offers.
 * @public
 */
export function init(options: ClickStackBrowserOptions): void {
  if (typeof document === "undefined") {
    return;
  }

  const page = pageState();
  if (page.initialized) {
    diag.warn(
      "@clickhouse/clickstack-browser: init already ran on this page; this call is ignored",
    );

    return;
  }

  page.initialized = true;

  const tracesUrl = signalUrl(options.endpoint, "traces");
  const logsUrl = signalUrl(options.endpoint, "logs");

  if (
    tracesUrl === undefined ||
    logsUrl === undefined ||
    !options.serviceName
  ) {
    // The SDK (which installs the diagnostics logger) does not start on this path
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
    diag.error(
      "@clickhouse/clickstack-browser: init needs an http(s) endpoint and a serviceName",
    );

    return;
  }

  run.started = start(options, tracesUrl, logsUrl).catch((error: unknown) => {
    diag.error("@clickhouse/clickstack-browser: init failed", error);
  });
}

async function start(
  options: ClickStackBrowserOptions,
  tracesUrl: string,
  logsUrl: string,
): Promise<void> {
  const sessionManager = createSessionManager({
    sessionIdGenerator: createDefaultSessionIdGenerator(),
    sessionStore: safeStore(createLocalStorageSessionStore()),
    maxDuration: 4 * 60 * 60,
    inactivityTimeout: 15 * 60,
  });

  run.sessionManager = sessionManager;
  await sessionManager.start();

  // Loaded on demand because the module reads `window` when imported, which breaks server-side
  // imports of this package.
  const { ResourceTimingInstrumentation } =
    await import("@opentelemetry/browser-instrumentation/experimental/resource-timing");
  if (run.stopping !== undefined) {
    return;
  }

  run.sessionId = sessionManager.getSessionId();
  sessionManager.addObserver({
    onSessionStarted: (session) => {
      run.sessionId = session.id;
    },
    onSessionEnded: () => undefined,
  });

  const headers: Record<string, string> = options.apiKey
    ? { authorization: options.apiKey }
    : {};
  const resourceAttributes = {
    ...detectResources({ detectors: [browserDetector] }).attributes,
    [ATTR_TELEMETRY_DISTRO_NAME]: "clickstack-browser",
    [ATTR_TELEMETRY_DISTRO_VERSION]: VERSION,
    [ATTR_SERVICE_NAME]: options.serviceName,
    ...(options.environment
      ? { [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: options.environment }
      : {}),
  };
  const sanitizeUrl = options.sanitizeUrl
    ? guardSanitizeUrl(options.sanitizeUrl)
    : undefined;
  const sanitize = sanitizeUrl ? { sanitizeUrl } : {};

  // The exporters' own requests must not become telemetry.
  const ignoreUrls = [tracesUrl, logsUrl];
  const propagateTraceHeaderCorsUrls = (options.traceOrigins ?? []).map(
    toUrlPattern,
  );
  const consoleLevel = options.console ?? "error";

  // Constructed disabled: an enabled instrumentation starts in its constructor before the SDK's
  // providers exist and loses its first events (such as the initial navigation)
  const instrumentations = [
    new FetchInstrumentation({
      enabled: false,
      ignoreUrls,
      propagateTraceHeaderCorsUrls,
      ...sanitize,
    }),
    new XhrInstrumentation({
      enabled: false,
      ignoreUrls,
      propagateTraceHeaderCorsUrls,
      ...sanitize,
    }),
    new ResourceTimingInstrumentation({ enabled: false, ignoreUrls }),
    new ErrorsInstrumentation({ enabled: false }),
    new NavigationInstrumentation({ enabled: false, ...sanitize }),
    new NavigationTimingInstrumentation({ enabled: false }),
    new UserActionInstrumentation({ enabled: false }),
    new WebVitalsInstrumentation({ enabled: false }),
    new LongTaskInstrumentation({ enabled: false }),
    ...(consoleLevel
      ? [
          new ConsoleInstrumentation({
            enabled: false,
            logMethods: CONSOLE_METHODS[consoleLevel],
          }),
        ]
      : []),
  ];

  const documentProvider = createLocationDocumentProvider(sanitize);
  run.sdk = startBrowserSdk({
    logLevel: "WARN",
    resourceAttributes,
    logs: {
      processors: [
        createSessionLogRecordProcessor(sessionManager),
        createDocumentLogRecordProcessor(documentProvider),
        userLogRecordProcessor,
        ...(sanitizeUrl
          ? [createUrlSanitizerLogRecordProcessor(sanitizeUrl)]
          : []),
      ],
      exportConfig: { url: logsUrl, headers },
    },
    traces: {
      processors: [
        createSessionSpanProcessor(sessionManager),
        createDocumentSpanProcessor(documentProvider),
        userSpanProcessor,
      ],
      exportConfig: { url: tracesUrl, headers },
    },
  });
  run.deregister = registerInstrumentations({ instrumentations });

  if (options.replay !== false && pageState().recording !== true) {
    run.recorder = new Recorder({
      sessionManager,
      provider: createReplayProvider(
        logsUrl,
        options.apiKey,
        resourceAttributes,
      ),
      maskAllText: true,
      maskAllInputs: true,
      sanitizeUrl,
    });

    if (run.replayPaused) {
      run.recorder.pause();
    }

    run.recorder.start();
  }
}

// Upstream LocalStorageSessionStore throws synchronously when localStorage is blocked or full, and
// SessionManager calls save() from its rotation timers without catching, which stops rotation.
function safeStore(store: SessionStore): SessionStore {
  return {
    save: async (session) => {
      try {
        await store.save(session);
      } catch {
        // The session then lives in memory for this page only
      }
    },
    get: async () => {
      try {
        return await store.get();
      } catch {
        return null;
      }
    },
  };
}

// Upstream matches a string against the full request URL exactly. An origin must match every URL
// under it
function toUrlPattern(origin: string | RegExp): RegExp {
  if (origin instanceof RegExp) {
    return origin;
  }
  const escaped = origin
    .replace(/\/+$/, "")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}(?:[/?#]|$)`);
}

/**
 * Returns the current session id, the same `session.id` that spans, log records and replay
 * records carry (for example to link a support ticket or a backend trace to the session)
 *
 * @remarks
 * Does not count as session activity.
 *
 * @returns The id, or `null` before `init` has started or after {@link shutdown}.
 * @public
 */
export function getSessionId(): string | null {
  return run.sessionId;
}

/**
 * Stops sending replay events until {@link resumeReplay}, for example while the user withholds
 * consent. RUM continues. Works before `init`
 *
 * @public
 */
export function pauseReplay(): void {
  run.replayPaused = true;
  run.recorder?.pause();
}

/**
 * Sends replay events again after {@link pauseReplay}, starting with a full snapshot.
 *
 * @public
 */
export function resumeReplay(): void {
  run.replayPaused = false;
  run.recorder?.resume();
}

/**
 * Stops RUM and replay for the rest of the page. Sends what is buffered, stops recording, disables
 * the instrumentations, and ends session tracking. A later `init` on this page is ignored. Upstream
 * instrumentations leave their fetch, XHR, history, and console wrappers in place, passing calls
 * through.
 *
 * @returns A promise that resolves once buffered telemetry is sent. It never rejects. Later calls
 * return the same promise.
 * @public
 */
export function shutdown(): Promise<void> {
  run.stopping ??= stop();
  return run.stopping;
}

async function stop(): Promise<void> {
  pageState().initialized = true;

  try {
    await run.started;
    await run.recorder?.shutdown();

    run.deregister?.();

    await run.sdk?.shutdown();
  } catch (error) {
    diag.warn("@clickhouse/clickstack-browser: shutdown failed", error);
  }

  run.sessionManager?.shutdown();
  run.sessionId = null;
}
