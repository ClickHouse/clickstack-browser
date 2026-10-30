# Migrating from `@hyperdx/browser`

`@clickhouse/clickstack-browser` replaces `@hyperdx/browser`, `@hyperdx/otel-web` and
`@hyperdx/otel-web-session-recorder`. It is built on the upstream OpenTelemetry browser SDK, emits
standard attribute keys and has a handful of options. Anything it does not offer is available by
setting up the upstream SDK yourself and adding `startReplay`
([Using the upstream SDK directly](../README.md#using-the-upstream-sdk-directly)).

## Before you upgrade

- **ClickStack version.** Session replay needs ClickStack 2.37.0 or later, and the Sessions page
  lists sessions from this package only in a release that reads `session.id`
  ([ClickStack versions](../README.md#clickstack-versions)). Self-hosted users upgrade ClickStack
  first.
- **Sessions start over.** The old session cookie (`__rum_sid`) does not carry over. Sessions are
  stored in `localStorage` under `opentelemetry-session`; the id format (32 lowercase hexadecimal
  characters) is unchanged.
- **ESM only.** There is no CommonJS build: use `import`, or `await import()` from CommonJS. The
  script-tag build is `dist/clickstack.iife.js` and defines the global `ClickStack` instead of
  `HyperDX`.
- **Asynchronous start.** `init` returns at once and starts in the background, so telemetry from
  the same tick as `init` is not captured ([Lifecycle](../README.md#lifecycle)).

## Before and after

```ts
// Before
import HyperDX from "@hyperdx/browser";

HyperDX.init({
  apiKey: "<ingestion key>",
  service: "example-app",
  url: "https://example-collector.clickhouse.com:4318",
  tracePropagationTargets: [/example-api\.clickhouse\.com/],
  consoleCapture: true,
});
HyperDX.setGlobalAttributes({ userId: user.id, userEmail: user.email });
```

```ts
import { init, setUser } from "@clickhouse/clickstack-browser";

init({
  endpoint: "https://example-collector.clickhouse.com:4318",
  apiKey: "<ingestion key>",
  serviceName: "example-app",
  traceOrigins: ["https://example-api.clickhouse.com"],
  console: "debug",
});
setUser({ id: user.id, email: user.email });
```

With the script tag, load the file as the [README](../README.md#script-tag) shows and call
`ClickStack.init` with the same options.

## Options

| `@hyperdx/browser`                                                                                                    | Now                            | Notes                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`                                                                                                              | `apiKey` (optional)            | Same bare `authorization` header. Leave it out when a proxy adds the key.                                                         |
| `service`                                                                                                             | `serviceName`                  | Required.                                                                                                                         |
| `url` (default `https://in-otel.hyperdx.io`)                                                                          | `endpoint`                     | Required, with no default. `/v1/traces` and `/v1/logs` are appended; a relative value such as `/otel` resolves against the page.  |
| `tracePropagationTargets`                                                                                             | `traceOrigins`                 | A RegExp works as before (matched against the full URL). A string is now an origin or URL prefix that matches every URL under it. |
| `consoleCapture`, `captureConsole`                                                                                    | `console`                      | Default `'error'`. `'debug'` records every method, as `true` did; `false` now turns `console.error` off too.                      |
| `disableReplay: true`                                                                                                 | `replay: false`                |                                                                                                                                   |
| `maskAllInputs`, `maskAllText`                                                                                        | `maskAllInputs`, `maskAllText` | Both default to `true`; `@hyperdx/browser` recorded text in clear by default. Hidden inputs are masked too.                       |
| `maskClass`, `blockClass`, `blockSelector`, `ignoreClass`, `recordCanvas`, `sampling`, `replay` (rrweb options)       | Removed                        | rrweb's default classes (`rr-block`, `rr-ignore`, `rr-mask`) still apply. Canvas is not recorded.                                 |
| `otelResourceAttributes['deployment.environment']`                                                                    | `environment`                  | Recorded as `deployment.environment.name`, the stable semantic convention name.                                                   |
| `otelResourceAttributes['service.version']`                                                                           | `serviceVersion`               | Recorded as `service.version`.                                                                                                    |
| `tracesUrl`, `logsUrl`, `otelResourceAttributes`, `instrumentations`, `ignoreUrls`, `debug`, `advancedNetworkCapture` | Removed                        | See [Not offered](#not-offered).                                                                                                  |
| `disableIntercom`                                                                                                     | Removed                        | The Intercom integration is gone.                                                                                                 |

## Methods

| `@hyperdx/browser`                                                  | Now                                  | Notes                                                                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HyperDX.init(options)`                                             | `init(options)`                      | Named imports instead of a default export.                                                                                                                |
| `setGlobalAttributes(attributes)`                                   | `setUser(user)`                      | `setUser(null)` removes the user. See [User attributes](#user-attributes).                                                                                |
| `addAction(name, attributes)`                                       | Removed                              | Create the span with the OpenTelemetry API: `trace.getTracer('app').startSpan(name, { attributes }).end()` (`ClickStack.otel.trace` with the script tag). |
| `recordException(error, attributes)`                                | `recordException(error, attributes)` | Records an `exception` log event instead of a span. See [Exceptions](#exceptions).                                                                        |
| `attachToReactErrorBoundary(ErrorBoundary)`                         | Removed                              | Not needed: React reports errors caught by boundaries with `console.error`, which is recorded with the error. See [Exceptions](#exceptions).              |
| `getSessionId()`                                                    | `getSessionId()`                     | Returns `string \| null`: `null` until the session is restored or created, shortly after `init`.                                                          |
| `stopSessionRecorder()`, `resumeSessionRecorder()`                  | `pauseReplay()`, `resumeReplay()`    | Resuming starts with a full snapshot.                                                                                                                     |
| `enableAdvancedNetworkCapture()`, `disableAdvancedNetworkCapture()` | Removed                              | See [Not offered](#not-offered).                                                                                                                          |
| `getSessionUrl()`                                                   | Removed                              | Build the link to your ClickStack instance yourself.                                                                                                      |

## Not offered

`init` has no further options. These need the upstream SDK, set up as in
[Using the upstream SDK directly](../README.md#using-the-upstream-sdk-directly), with `startReplay`
for the replay:

| Need                                                    | Upstream alternative                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Separate traces and logs URLs, or extra request headers | `exportConfig.url` and `exportConfig.headers` per signal in `startBrowserSdk`                                |
| Other resource attributes                               | `resourceAttributes` in `startBrowserSdk`, and the same in `startReplay`                                     |
| Instrumentation settings, or other instrumentations     | Construct the instrumentations yourself and pass them to `instrumentations` in `startBrowserSdk`             |
| Ignored URLs                                            | `ignoreUrls` of the fetch, XHR and resource timing instrumentations                                          |
| Request and response headers                            | `applyCustomAttributesOnSpan` of the fetch and XHR instrumentations; record an allowlist, never every header |
| Sampling                                                | `traces.sampler` in `startBrowserSdk`; call `startReplay` only in the sessions you want to record            |
| Other session lifetimes                                 | `maxDuration` and `inactivityTimeout` of `createSessionManager` (`init` uses 4 hours and 15 minutes)         |
| Debug diagnostics                                       | `logLevel` in `startBrowserSdk` (`init` uses `'WARN'`)                                                       |

## Behavior changes

### Masking

`@hyperdx/browser` recorded page text in clear unless `maskAllText` was set. `init` masks all
text and all form values by default, hidden inputs included. Pass `maskAllText: false` to record
text in clear as before. What masking does not cover is listed under
[Privacy](../README.md#privacy).

### Console capture

`@hyperdx/browser` recorded `console.error` even with `consoleCapture: false`. The default is still
`'error'`, but `console: false` now turns it off too. Each level includes the more severe ones, and
`'info'` also records `console.log`.

### Exceptions

Errors are `exception` log events instead of spans: uncaught errors and unhandled rejections from
the upstream errors instrumentation, and caught errors from `recordException`. React reports errors
caught by error boundaries with `console.error(error)`, which is recorded with the error's
`exception.*` attributes, so boundaries need no call; adding `recordException` there records each
error twice. Call it where caught errors never reach the console: your own `try`/`catch`,
`app.config.errorHandler` in Vue (setting it replaces Vue's console logging), React's
`onCaughtError` when you override it, or anywhere with `console: false`. See
[Errors](../README.md#errors).

- Failed loads of images, scripts, stylesheets and media are still recorded, as `exception` events
  with the type `ResourceLoadError` and the URL in `url.full`.
- `console.error` with an error argument is a `browser.console` log event that carries the error's
  `exception.*` attributes, where `@hyperdx/browser` recorded an error span.
- Stack traces are the browser's raw stack text in `exception.stacktrace`. `@hyperdx/browser` sent
  parsed frames in `exception.parsed_stacktrace`; parsing frames and looking up source maps are
  left to ClickStack. Set `serviceVersion` to the release id you upload source maps with.

### User attributes

`setGlobalAttributes` merged any keys into every later span. `setUser` sets the standard `user.*`
keys on every later span and log record, and replaces the previous user instead of merging:

| `setGlobalAttributes` key | `setUser` field | Attribute        |
| ------------------------- | --------------- | ---------------- |
| `userId`                  | `id`            | `user.id`        |
| `userEmail`               | `email`         | `user.email`     |
| `userName`                | `name`          | `user.name`      |
| None                      | `fullName`      | `user.full_name` |
| None                      | `roles`         | `user.roles`     |

Keys such as `teamId` have no `setUser` field; they need the upstream SDK with your own span and
log record processors.

### Telemetry shape

Page activity is recorded as upstream log events instead of spans, with semantic convention keys:

| Before                                                                                                     | Now                                                                                                               |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Resource attribute `rum.sessionId`                                                                         | `session.id` on every span and log record                                                                         |
| `location.href` on every span                                                                              | `browser.document.url.full`                                                                                       |
| `http.url`, `http.method`, `http.status_code`                                                              | `url.full`, `http.request.method`, `http.response.status_code`                                                    |
| `userId`, `userEmail`, `userName`                                                                          | `user.id`, `user.email`, `user.name`                                                                              |
| Spans for console messages, errors, route changes, web vitals and clicks                                   | Log events `browser.console`, `exception`, `browser.navigation`, `browser.web_vital`, `browser.user_action.click` |
| `documentLoad`, `documentFetch` and `resourceFetch` spans                                                  | Log events `browser.navigation_timing` and `browser.resource_timing`                                              |
| `component`, `rum.*`, `hyperdx.browser.timezone`, `Synthetics-RunId`, `record init` and `visibility` spans | Not emitted                                                                                                       |

The full list is under [What is emitted](../README.md#what-is-emitted).
