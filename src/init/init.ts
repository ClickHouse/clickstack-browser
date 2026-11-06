import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  type Attributes,
} from "@opentelemetry/api";
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
import { browserDetector } from "@opentelemetry/browser-sdk/browser-detector";
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
} from "@opentelemetry/browser-sdk/session";
import { LongTaskInstrumentation } from "@opentelemetry/instrumentation-long-task";
import {
  JsonLogsSerializer,
  JsonTraceSerializer,
} from "@opentelemetry/otlp-transformer";
import { detectResources } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_TELEMETRY_DISTRO_NAME,
  ATTR_TELEMETRY_DISTRO_VERSION,
} from "@opentelemetry/semantic-conventions";
import { hasSignalPath, resolveUrl, signalUrl } from "../internal/endpoints.ts";
import { pageState } from "../internal/global.ts";
import { OtlpJsonExporter } from "../internal/otlp-exporter.ts";
import { createReplayProvider } from "../replay/exporter.ts";
import { Recorder } from "../replay/recorder.ts";
import {
  consoleExceptionProcessor,
  exceptionAttributes,
  listenForResourceErrors,
  serializeConsoleArgs,
} from "../rum/exceptions.ts";
import {
  createUrlSanitizerLogRecordProcessor,
  guardSanitizeUrl,
} from "../rum/sanitize-url.ts";
import {
  attributesLogRecordProcessor,
  attributesSpanProcessor,
} from "../rum/attributes.ts";
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
   * OTLP/HTTP base URL of the collector, for example `https://example-collector.clickhouse.com:4318`,
   * or a same-origin proxy path such as `/otel`. `/v1/traces` and `/v1/logs` are appended to its
   * path, and a relative value resolves against the page URL. Required unless both
   * `tracesEndpoint` and `logsEndpoint` are set.
   */
  endpoint?: string | undefined;
  /**
   * Full URL for traces, used as is, like `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`. Replaces the traces
   * URL built from `endpoint`. Default: none.
   */
  tracesEndpoint?: string | undefined;
  /**
   * Full URL for logs and replay, used as is, like `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`. Replaces the
   * logs URL built from `endpoint`. Default: none.
   */
  logsEndpoint?: string | undefined;
  /**
   * Ingestion API key, sent as the `authorization` header. Default: none.
   */
  apiKey?: string | undefined;
  /** `service.name` of every span, log record and replay record. */
  serviceName: string;
  /**
   * Version of the app, such as `2.0.0` or a commit SHA, recorded as the resource attribute
   * `service.version`. Default: none.
   */
  serviceVersion?: string | undefined;
  /**
   * Deployment environment, such as `production` or `staging`, recorded as the resource attribute
   * `deployment.environment.name`. Default: none.
   */
  environment?: string | undefined;
  /**
   * Further resource attributes of all telemetry, replay records included, such as
   * `service.namespace`. `serviceName`, `serviceVersion` and `environment` win over the same keys
   * here. Default: none.
   */
  resourceAttributes?: Attributes | undefined;
  /**
   * Backend origins, such as `https://example-api.clickhouse.com`, whose fetch and XHR requests carry W3C
   * trace context headers so backend traces join the browser's. Same-origin requests always
   * carry them. A regular expression is matched against the full request URL. Each backend must
   * allow the `traceparent`, `tracestate` and `baggage` request headers in CORS. Default: none.
   */
  traceOrigins?: (string | RegExp)[] | undefined;
  /** Records a session replay. Default: `true`. */
  replay?: boolean | undefined;
  /**
   * Masks all text in the replay. With `false`, elements with the `rr-mask` class are still
   * masked. Default: `true`.
   */
  maskAllText?: boolean | undefined;
  /**
   * Masks the values of all inputs, text areas and selects in the replay. With `false`, only
   * passwords are masked. Default: `true`.
   */
  maskAllInputs?: boolean | undefined;
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

// Upstream sends up to 512 records per request, and a closing page can still send only about
// 60 KiB with keepalive, so a large batch pending at unload is lost whole. 64 records are a few KiB
// after gzip. A record count does not bound bytes, so very large records can still exceed the
// limit. Logs wait 5 s like spans, instead of upstream's 1 s, so an active page sends fewer requests.
const BATCH_CONFIG = { maxExportBatchSize: 64, scheduledDelayMillis: 5000 };

// Kept in step with ClickStackBrowserOptions by the type check, for the unknown-option warning
const OPTION_NAMES = new Set(
  Object.keys({
    endpoint: true,
    tracesEndpoint: true,
    logsEndpoint: true,
    apiKey: true,
    serviceName: true,
    serviceVersion: true,
    environment: true,
    resourceAttributes: true,
    traceOrigins: true,
    replay: true,
    maskAllText: true,
    maskAllInputs: true,
    console: true,
    sanitizeUrl: true,
  } satisfies Record<keyof ClickStackBrowserOptions, true>),
);

interface Run {
  sessionId: string | null;
  replayPaused: boolean;
  started?: Promise<void>;
  stopping?: Promise<void>;
  sessionManager?: SessionManager;
  sdk?: WebSdk;
  stopResourceErrors?: () => void;
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

  const tracesUrl = options.tracesEndpoint
    ? resolveUrl(options.tracesEndpoint)?.href
    : signalUrl(options.endpoint, "traces");
  const logsUrl = options.logsEndpoint
    ? resolveUrl(options.logsEndpoint)?.href
    : signalUrl(options.endpoint, "logs");

  if (
    tracesUrl === undefined ||
    logsUrl === undefined ||
    !options.serviceName
  ) {
    // The SDK (which installs the diagnostics logger) does not start on this path
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
    diag.error(
      "@clickhouse/clickstack-browser: init needs a serviceName and an http(s) endpoint, or both tracesEndpoint and logsEndpoint",
    );

    return;
  }

  page.initialized = true;
  run.started = start(
    options,
    tracesUrl,
    logsUrl,
    optionWarnings(options),
  ).catch((error: unknown) => {
    diag.error("@clickhouse/clickstack-browser: init failed", error);
  });
}

// Reported once the SDK has installed the diagnostics logger
function optionWarnings(options: ClickStackBrowserOptions): string[] {
  const warnings: string[] = [];
  const unknown = Object.keys(options).filter(
    (name) => !OPTION_NAMES.has(name),
  );

  if (unknown.length > 0) {
    warnings.push(`unknown init options are ignored: ${unknown.join(", ")}`);
  }

  if (
    (!options.tracesEndpoint || !options.logsEndpoint) &&
    hasSignalPath(options.endpoint)
  ) {
    warnings.push(
      "endpoint is the collector base URL; its trailing /v1/traces or /v1/logs is dropped",
    );
  }

  return warnings;
}

async function start(
  options: ClickStackBrowserOptions,
  tracesUrl: string,
  logsUrl: string,
  warnings: string[],
): Promise<void> {
  const sessionManager = createSessionManager({
    sessionIdGenerator: createDefaultSessionIdGenerator(),
    sessionStore: createLocalStorageSessionStore(),
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

  const resourceAttributes = {
    ...detectResources({ detectors: [browserDetector] }).attributes,
    ...options.resourceAttributes,
    [ATTR_TELEMETRY_DISTRO_NAME]: "clickstack-browser",
    [ATTR_TELEMETRY_DISTRO_VERSION]: VERSION,
    [ATTR_SERVICE_NAME]: options.serviceName,
    ...(options.serviceVersion
      ? { [ATTR_SERVICE_VERSION]: options.serviceVersion }
      : {}),
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
    new ErrorsInstrumentation({
      enabled: false,
      applyCustomAttributes: exceptionAttributes,
    }),
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
            messageSerializer: serializeConsoleArgs,
          }),
        ]
      : []),
  ];

  const documentProvider = createLocationDocumentProvider(sanitize);
  // No exportConfig: batches go through our exporter instead of upstream's, gzip-compressed and
  // with keepalive only while the page is hidden
  run.sdk = startBrowserSdk({
    logLevel: "WARN",
    resourceAttributes,
    logs: {
      processors: [
        createSessionLogRecordProcessor(sessionManager),
        createDocumentLogRecordProcessor(documentProvider),
        userLogRecordProcessor,
        consoleExceptionProcessor,
        ...(sanitizeUrl
          ? [createUrlSanitizerLogRecordProcessor(sanitizeUrl)]
          : []),
        attributesLogRecordProcessor,
        new BatchLogRecordProcessor({
          exporter: new OtlpJsonExporter(
            logsUrl,
            options.apiKey,
            JsonLogsSerializer,
          ),
          ...BATCH_CONFIG,
        }),
      ],
    },
    traces: {
      processors: [
        createSessionSpanProcessor(sessionManager),
        createDocumentSpanProcessor(documentProvider),
        userSpanProcessor,
        attributesSpanProcessor,
        new BatchSpanProcessor({
          exporter: new OtlpJsonExporter(
            tracesUrl,
            options.apiKey,
            JsonTraceSerializer,
          ),
          ...BATCH_CONFIG,
        }),
      ],
    },
    instrumentations,
  });
  run.stopResourceErrors = listenForResourceErrors(sanitizeUrl);
  for (const warning of warnings) {
    diag.warn(`@clickhouse/clickstack-browser: ${warning}`);
  }

  if (options.replay !== false && pageState().recording !== true) {
    run.recorder = new Recorder({
      sessionManager,
      provider: createReplayProvider(
        logsUrl,
        options.apiKey,
        resourceAttributes,
      ),
      maskAllText: options.maskAllText ?? true,
      maskAllInputs: options.maskAllInputs ?? true,
      sanitizeUrl,
    });

    if (run.replayPaused) {
      run.recorder.pause();
    }

    run.recorder.start();
  }
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
 * Ends the current session and starts one with a new `session.id`, for example when the user
 * signs out. Replay continues in the new session from the next user input.
 *
 * @remarks
 * Does nothing before `init` has started or after {@link shutdown}. It keeps the user set with
 * `setUser`; call `setUser(null)` as well on sign-out.
 *
 * @public
 */
export function startNewSession(): void {
  const sessionManager = run.sessionManager;
  if (
    sessionManager === undefined ||
    run.sessionId === null ||
    run.stopping !== undefined
  ) {
    return;
  }

  // Upstream's resetSession ends the session, starts a new one and resets its timers, but it is
  // private. Until it is public, a cleared store at least gives the next page load a new session.
  const { resetSession } = sessionManager as unknown as {
    resetSession?: () => void;
  };
  if (typeof resetSession === "function") {
    resetSession.call(sessionManager);
    return;
  }

  try {
    localStorage.removeItem("opentelemetry-session");
  } catch {
    // Storage is blocked, so the next page load starts a new session anyway
  }

  diag.warn(
    "@clickhouse/clickstack-browser: startNewSession takes effect on the next page load",
  );
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
    run.stopResourceErrors?.();
    await run.sdk?.shutdown();
  } catch (error) {
    diag.warn("@clickhouse/clickstack-browser: shutdown failed", error);
  }

  run.sessionManager?.shutdown();
  run.sessionId = null;
}
