# @clickhouse/clickstack-browser

Browser RUM and session replay for ClickStack,
built on the upstream OpenTelemetry browser SDK. `init` sets up the SDK with a fixed set of
instrumentations and records a session replay. Apps that set up the SDK themselves use only
`startReplay` ([Using the upstream SDK directly](#using-the-upstream-sdk-directly)).

If you're migrating from `@hyperdx/browser` please follow the [migration guide](docs/migration.md).

## Install

```sh
npm install @clickhouse/clickstack-browser
```

The package is ESM only. `@opentelemetry/api` and `@opentelemetry/browser-sdk` are peer
dependencies, which npm installs automatically.

### Script tag

Pages without a bundler load `dist/clickstack.iife.js`, which defines the global `ClickStack`. Call
`ClickStack.init` from a file of its own, so a Content Security Policy without `'unsafe-inline'`
allows it:

```html
<script
  src="https://cdn.jsdelivr.net/npm/@clickhouse/clickstack-browser@1.0.0/dist/clickstack.iife.js"
  integrity="sha384-HASH_FROM_THE_RELEASE_NOTES"
  crossorigin="anonymous"
></script>
<script src="/telemetry.js"></script>
```

```js
// telemetry.js
ClickStack.init({
  endpoint: "https://example-collector.clickhouse.com:4318",
  apiKey: "<YOUR_INGESTION_API_KEY>",
  serviceName: "example-app",
});
```

Use an exact version with the `integrity` hash from that version's release notes. The global also
has `ClickStack.otel` (`trace`, `context`, `logs`) for your own spans and log records.

## Quick start

```ts
import { init } from "@clickhouse/clickstack-browser";

init({
  endpoint: "https://example-collector.clickhouse.com:4318",
  apiKey: "<YOUR_INGESTION_API_KEY>",
  serviceName: "example-app",
  traceOrigins: ["https://example-api.clickhouse.com"],
});
```

`endpoint` is the OTLP HTTP address of your OpenTelemetry collector (port 4318), the same value as
`OTEL_EXPORTER_OTLP_ENDPOINT`, without `/v1/traces`. With ClickStack, it is your service's collector URL.

Call `init` once per page load, at the top level of your entry module (`instrumentation-client.ts`
in Next.js, `src/main.ts` in Vite), not in a component effect.

| Option         | Default   | Meaning                                                                                                                                                                                                   |
| -------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`     | Required  | OTLP/HTTP base URL of the collector, or a same-origin path such as `/otel` that your server forwards. `/v1/traces` and `/v1/logs` are appended.                                                           |
| `serviceName`  | Required  | `service.name` of all telemetry.                                                                                                                                                                          |
| `environment`  | None      | `deployment.environment.name`, such as `production` or `staging`.                                                                                                                                         |
| `apiKey`       | None      | Ingestion key, sent as the `authorization` header. Anyone who loads the page can read it; to keep it private, send to a same-origin path whose server adds the header.                                    |
| `traceOrigins` | None      | Backends whose fetch and XHR requests carry trace context ([Trace propagation and CORS](#trace-propagation-and-cors)). A string matches every URL under that origin; a RegExp is matched against the URL. |
| `replay`       | `true`    | `false` turns session replay off.                                                                                                                                                                         |
| `console`      | `'error'` | Console level recorded as log events: `'error'`, `'warn'`, `'info'` (with `console.log`), `'debug'`, or `false`.                                                                                          |
| `sanitizeUrl`  | None      | Rewrites URLs before they are recorded, for example to drop tokens from query strings ([Privacy](#privacy)).                                                                                              |

Without an http(s) `endpoint` or a `serviceName`, `init` logs an error and starts nothing. The rest
is fixed:

- Instrumentations: fetch, XHR, errors, navigation, user action, web vitals, navigation timing,
  resource timing, long task and console.
- Sessions last at most 4 hours and end after 15 minutes without telemetry. They are stored in
  `localStorage` and shared by the tabs of the origin.
- Replay masks all text and form values. Nothing is sampled.
- Diagnostics go to the browser console at WARN level.

Other functions:

- `getSessionId()` returns the current `session.id`, or `null` before `init` has started.
- `pauseReplay()` and `resumeReplay()` stop and restart replay. RUM continues.
- `setUser(user)` adds `user.id`, `user.email`, `user.name`, `user.full_name` and `user.roles` to
  later spans and log records; `setUser(null)` removes them. Set only what your privacy policy
  allows.
- `shutdown()` sends what is buffered and stops everything for the rest of the page.

## Caught errors

Uncaught errors and unhandled rejections are recorded as `exception` log events, and
`console.error(error)` as a console event with the stack in its body. Errors your code catches,
such as in a React error boundary, need a call of their own. Add `@opentelemetry/api-logs` to your
dependencies:

```ts
import { logs, SeverityNumber } from "@opentelemetry/api-logs";

export function recordException(error: unknown): void {
  logs.getLogger("example-app").emit({
    eventName: "exception",
    severityNumber: SeverityNumber.ERROR,
    exception: error,
  });
}
```

- The SDK sets `exception.type`, `exception.message` and `exception.stacktrace` from the error.
- With the script tag, the same API is `ClickStack.otel.logs`, and `SeverityNumber.ERROR` is `17`.
- To link the record to a span, pass `context: trace.setSpan(context.active(), span)`. Browsers
  lose the active span after an `await`.

## Privacy

Replay masks all text and the values of every `input` (hidden inputs included), `textarea` and
`select`.

- Not masked: checkbox and radio state, and attributes such as `placeholder`, `title`, `alt`,
  `aria-label` and link URLs. Give sensitive elements rrweb's `rr-block` class to record them as
  empty boxes.
- Not recorded: canvas contents, web fonts and image data.
- URLs keep their query strings unless `sanitizeUrl` rewrites them. It applies to every URL this
  package records, except URLs inside the replayed page content, stack traces and console
  messages. If it throws or returns a non-string, the URL is recorded as empty.

## Trace propagation and CORS

Requests to the page's origin and to `traceOrigins` carry the `traceparent`, `tracestate` and
`baggage` headers, so backend traces join the browser's. Each backend in `traceOrigins` must allow
these headers in CORS (`Access-Control-Allow-Headers`), or its requests fail.

A collector that the page sends to directly must allow the page's origin. ClickStack's collector
allows all origins; your own collector needs:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
        cors:
          allowed_origins: ["https://example-app.clickhouse.com"]
          allowed_headers: ["*"]
```

## Using the upstream SDK directly

```ts
import { startReplay } from "@clickhouse/clickstack-browser/replay";
import { FetchInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/fetch";
import { startBrowserSdk } from "@opentelemetry/browser-sdk";
import {
  createDefaultSessionIdGenerator,
  createLocalStorageSessionStore,
  createSessionLogRecordProcessor,
  createSessionManager,
  createSessionSpanProcessor,
} from "@opentelemetry/browser-sdk/session";

const endpoint = "https://example-collector.clickhouse.com:4318";
const tracesUrl = `${endpoint}/v1/traces`;
const logsUrl = `${endpoint}/v1/logs`;

const sessionManager = createSessionManager({
  sessionIdGenerator: createDefaultSessionIdGenerator(),
  sessionStore: createLocalStorageSessionStore(),
  maxDuration: 4 * 60 * 60,
  inactivityTimeout: 15 * 60,
});
await sessionManager.start(); // before anything emits, or a second session is created

startBrowserSdk({
  serviceName: "example-app",
  // A signal with its own processors ignores the root exportConfig.
  logs: {
    processors: [createSessionLogRecordProcessor(sessionManager)],
    exportConfig: { url: logsUrl },
  },
  traces: {
    processors: [createSessionSpanProcessor(sessionManager)],
    exportConfig: { url: tracesUrl },
  },
  // enabled: false lets the SDK enable them once its providers exist.
  instrumentations: [
    new FetchInstrumentation({
      ignoreUrls: [tracesUrl, logsUrl],
      enabled: false,
    }),
  ],
});

const replay = startReplay({
  sessionManager,
  endpoint,
  serviceName: "example-app",
});
```

- `serviceName` and `resourceAttributes` must match the SDK's, because ClickStack finds a session's
  replay by its `service.name`.
- Add the logs URL to the `ignoreUrls` of the fetch, XHR and resource timing instrumentations, or
  every replay export is recorded as telemetry.
- `maskAllText` and `maskAllInputs` default to `true`. With `maskAllInputs: false`, only passwords
  are masked.
- Pass `sanitizeUrl` to `startReplay` too, for the page URL in the replay. The navigation timing
  and resource timing instrumentations have no `sanitizeUrl`; rewrite their `url.full` in a log
  record processor.
- `startReplay` returns `{ pause, resume, shutdown }`. `setUser` works with `init` only.

## What is emitted

- Resource: `service.name`, `deployment.environment.name`, `telemetry.sdk.*`,
  `telemetry.distro.name` (`clickstack-browser`), `telemetry.distro.version`, `user_agent.original`
  and `browser.*`.
- Every span and log record: `session.id`, `browser.document.url.full`, and `user.*` after
  `setUser`.
- Log events: `browser.navigation`, `browser.user_action.click`, `browser.web_vital`,
  `browser.console`, `exception`, `browser.navigation_timing` and `browser.resource_timing`. Fetch
  and XHR requests and long tasks are spans.
- Replay: gzip-compressed log records with the scope `rum.rr-web`, sent to `/v1/logs`. A collector
  between the page and ClickStack must keep their attributes unchanged.

## Lifecycle

- `init` returns at once and starts in the background, so telemetry from the same tick, such as an
  immediate `fetch`, is not captured. Calls to `setUser`, `pauseReplay` and `resumeReplay` before
  `init` are kept. Only the first `init` on a page counts.
- Telemetry is sent in batches, and when the page is hidden. Browsers limit what a closing page
  can still send to 64 KiB in total, so the last part of a long replay can be lost when the user
  leaves.
- `shutdown()` is final: a later `init` on the page is ignored. In React StrictMode, an `init` in
  an effect with `shutdown` in its cleanup ends telemetry for the page.

## Compatibility

- Browsers: Baseline Widely available (ES2022). No `eval`, so a strict
  Content Security Policy works; `connect-src` must allow the endpoint.
- OpenTelemetry: `@opentelemetry/api` `>=1.9.1 <1.10.0` and `@opentelemetry/browser-sdk`
  `^0.5.0`.

## License

[Apache-2.0](LICENSE)
