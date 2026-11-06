# @clickhouse/clickstack-browser

Browser RUM and session replay for ClickStack and ClickHouse Observability,
built on the upstream OpenTelemetry browser SDK. `init` sets up the SDK with a fixed set of
instrumentations and records a session replay. Apps that set up the SDK themselves use only
`startReplay` ([Using the upstream SDK directly](#using-the-upstream-sdk-directly)).

If you're migrating from `@hyperdx/browser` please follow the [migration guide](docs/migration.md).

## Install

```sh
npm install @clickhouse/clickstack-browser
```

The package is ESM only. `@opentelemetry/api` and `@opentelemetry/browser-sdk` are peer
dependencies, which npm and pnpm install automatically. With Yarn, add them yourself:

```sh
yarn add @clickhouse/clickstack-browser @opentelemetry/api@~1.9.1 @opentelemetry/browser-sdk@^0.6.0
```

Keep a single copy of `@opentelemetry/api` at 1.9.x; `npm ls @opentelemetry/api` lists them. A copy
at another version, including 1.10 from OpenTelemetry JS 3.x, makes registration fail silently, so
the SDK's telemetry or the spans from your own `trace.getTracer()` calls go missing.

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
in Next.js, `src/main.ts` in Vite), not in a component effect. Replays mask all text and form values
by default. Set `maskAllText: false` to see the text ([Privacy](#privacy)).

| Option               | Default   | Meaning                                                                                                                                                                                                   |
| -------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`           | Required  | OTLP/HTTP base URL of the collector, or a same-origin path such as `/otel` that your server forwards. `/v1/traces` and `/v1/logs` are appended. Not needed when both signal endpoints are set.            |
| `tracesEndpoint`     | None      | Full URL for traces, used as is, like `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`. Replaces the traces URL built from `endpoint`.                                                                                |
| `logsEndpoint`       | None      | Full URL for logs and replay, used as is, like `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`. Replaces the logs URL built from `endpoint`.                                                                           |
| `serviceName`        | Required  | `service.name` of all telemetry.                                                                                                                                                                          |
| `serviceVersion`     | None      | `service.version`, such as `2.0.0` or a commit SHA, to compare releases.                                                                                                                                  |
| `environment`        | None      | `deployment.environment.name`, such as `production` or `staging`.                                                                                                                                         |
| `resourceAttributes` | None      | Further resource attributes of all telemetry, replay records included, such as `service.namespace`. The options above win over the same keys.                                                             |
| `apiKey`             | None      | Ingestion key, sent as the `authorization` header. Anyone who loads the page can read it; to keep it private, send to a same-origin path whose server adds the header.                                    |
| `traceOrigins`       | None      | Backends whose fetch and XHR requests carry trace context ([Trace propagation and CORS](#trace-propagation-and-cors)). A string matches every URL under that origin; a RegExp is matched against the URL. |
| `replay`             | `true`    | `false` turns session replay off.                                                                                                                                                                         |
| `maskAllText`        | `true`    | Masks all text in the replay. With `false`, elements with the `rr-mask` class stay masked ([Privacy](#privacy)).                                                                                          |
| `maskAllInputs`      | `true`    | Masks the values of all inputs, text areas and selects. With `false`, only passwords are masked.                                                                                                          |     |
| `console`            | `'error'` | Console level recorded as log events: `'error'`, `'warn'`, `'info'` (with `console.log`), `'debug'`, or `false`.                                                                                          |
| `sanitizeUrl`        | None      | Rewrites URLs before they are recorded, for example to drop tokens from query strings ([Privacy](#privacy)).                                                                                              |

Without a `serviceName` and an http(s) `endpoint` (or both signal endpoints), `init` logs an error
and starts nothing, and a later valid call still starts. Unknown options are ignored with a warning.
The rest is fixed:

- Instrumentations: fetch, XHR, errors, failed resource loads, navigation, user action, web vitals,
  navigation timing, resource timing, long task and console.
- Sessions last at most 4 hours and end after 15 minutes without telemetry. They are stored in
  `localStorage` and shared by the tabs of the origin.
- Nothing is sampled.
- Diagnostics go to the browser console at WARN level.

Other functions:

- `getSessionId()` returns the current `session.id`, or `null` before `init` has started.
- `pauseReplay()` and `resumeReplay()` stop and restart replay. RUM continues.
- `setUser(user)` adds `user.id`, `user.email`, `user.name`, `user.full_name` and `user.roles` to
  later spans and log records; `setUser(null)` removes them. Set only what your privacy policy
  allows.
- `setAttributes(attributes)` adds attributes, such as a tenant or a plan, to later spans and log
  records, replacing the previous set; `setAttributes(null)` removes them. Attributes the SDK or
  `setUser` sets win. Prefer namespaced keys, such as `app.team.name`.
- `startNewSession()` ends the current session and starts one with a new `session.id`. On sign-out,
  call it with `setUser(null)`, so the next user on the device gets a session of their own. It does
  nothing before `init` has started.
- `recordException(error, attributes?)` records an error your code caught ([Errors](#errors)).
- `shutdown()` sends what is buffered and stops everything for the rest of the page.

## Errors

Uncaught errors, unhandled rejections, and failed loads of images, scripts, stylesheets and media
are recorded as `exception` log events. `console.error` calls are console events, with bodies
formatted as the browser console shows them. When an argument is an error, the event also carries
its `exception.*` attributes. React reports errors caught by error boundaries this way, with
`console.error(error)`, so a boundary needs no extra call.

Record errors that never reach the console with `recordException`, such as in your own
`try`/`catch`, Vue's `app.config.errorHandler`, a React `onCaughtError` override, or any page with
`console: false`:

```ts
import { recordException } from "@clickhouse/clickstack-browser";

try {
  await checkout();
} catch (error) {
  recordException(error, { "app.operation": "checkout" });
}
```

- Each event has `exception.type`, `exception.message` and `exception.stacktrace`, the browser's
  raw stack text. An error's `cause` chain, up to five deep, follows the stack as `Caused by:`
  sections. A thrown value that is not an error is recorded as JSON text in `exception.message`.
- Failed loads have the type `ResourceLoadError` and the URL in `url.full`.
- Errors thrown by a script from another origin, such as a CDN, arrive as `Script error.` with no
  message or stack, unless its `<script>` tag has `crossorigin="anonymous"` and the server sends
  `Access-Control-Allow-Origin`.
- Calling `recordException` for an error that is also passed to `console.error` records it twice.
- Inside an active span, `recordException` links the event to it. Browsers lose the active span
  after an `await`.

## Privacy

By default, replay masks all text and the values of every `input` (hidden inputs included),
`textarea` and `select`. With `maskAllText: false`, give sensitive elements rrweb's `rr-mask` class
to keep their text masked.

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

A collector that the page sends to directly must allow the page's origin and request headers.
ClickStack's collector allows all of them; your own collector needs:

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
        cors:
          allowed_origins: ["https://example-app.clickhouse.com"]
          # A list instead must include authorization, content-type and content-encoding
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
- `startReplay` takes `maskAllText`, `maskAllInputs` and `sanitizeUrl` as `init` does. The
  navigation timing and resource timing instrumentations have no `sanitizeUrl`; rewrite their
  `url.full` in a log record processor.
- `startReplay` returns `{ pause, resume, shutdown }`. `setUser` works with `init` only.

## What is emitted

- Resource: `service.name`, `service.version`, `deployment.environment.name`,
  `telemetry.sdk.*`, `telemetry.distro.name` (`clickstack-browser`), `telemetry.distro.version`,
  `user_agent.original`, `browser.*`, and `resourceAttributes`.
- Every span and log record: `session.id`, `browser.document.url.full`, `user.*` after `setUser`,
  and the attributes from `setAttributes`.
- Log events: `browser.navigation`, `browser.user_action.click`, `browser.web_vital`,
  `browser.console`, `exception`, `browser.navigation_timing` and `browser.resource_timing`. Fetch
  and XHR requests and long tasks are spans.
- Replay: log records with the scope `rum.rr-web`, sent to the logs URL. A collector between the
  page and ClickStack must keep their attributes unchanged.

## Lifecycle

- `init` returns at once and starts in the background, so telemetry from the same tick, such as an
  immediate `fetch`, is not captured. Calls to `setUser`, `pauseReplay` and `resumeReplay` before
  `init` are kept. Only the first `init` on a page counts. Calling it later, for example after
  fetching runtime configuration, still records the page's navigation, navigation timing and
  resource timing.
- Telemetry is sent as gzip-compressed OTLP/JSON in batches of up to 16 records, and when the page
  is hidden. A proxy in front of the collector must forward the body and its `Content-Encoding`
  header unchanged. Browsers limit what a closing page can still send to 64 KiB in total, so after
  a burst of activity, such as a page load with many requests, or during a long replay, the last
  records can be lost when the user leaves. Failed requests are not retried, and requests give up
  after 10 seconds.
- `shutdown()` is final: a later `init` on the page is ignored. In React StrictMode, an `init` in
  an effect with `shutdown` in its cleanup ends telemetry for the page.

## ClickStack versions

- Traces and logs work with every ClickStack version. Session replay needs ClickStack 2.37.0 or
  later.
- The Sessions list and replay playback need a ClickStack release that reads `session.id`. Earlier
  releases store the data but don't list these sessions.

## Compatibility

- Browsers: Baseline Widely available (ES2022). No `eval`, so a strict Content Security Policy
  works; `connect-src` must allow the endpoint.
- OpenTelemetry: the 1.x line supports OpenTelemetry JS 2.x: `@opentelemetry/api` `>=1.9.1 <1.10.0`
  and `@opentelemetry/browser-sdk` `^0.6.0`.

## Testing

The package is ESM only, like the OpenTelemetry browser packages it uses. Vitest loads it as is while Jest with CommonJS does not, so map the package to a stub in the Jest config:

```js
// jest.config.js
moduleNameMapper: {
  "^@clickhouse/clickstack-browser$": "<rootDir>/test/clickstack-browser.js",
},
```

```js
// test/clickstack-browser.js
const noop = () => undefined;
module.exports = {
  init: noop,
  setUser: noop,
  setAttributes: noop,
  getSessionId: () => null,
  startNewSession: noop,
  recordException: noop,
  pauseReplay: noop,
  resumeReplay: noop,
  shutdown: () => Promise.resolve(),
};
```

## License

[Apache-2.0](LICENSE)
