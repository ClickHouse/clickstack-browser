# Changelog

## 1.2.1

### Fixed

- A replay could fail to show a page in ClickStack after an earlier page in the same session was
  left before its large snapshot was fully sent. ClickStack reported
  `SyntaxError: Unexpected non-whitespace character after JSON`. Replay event numbers no longer
  restart at 1 on every page load, so ClickStack no longer joins a leftover piece of an earlier
  page's snapshot into a later event, across tabs too.
- Browsers without `CompressionStream` (Safari before 16.4, Firefox before 113) sent no telemetry
  since 1.2.0, and no replay before it. They now send uncompressed OTLP/JSON.

## 1.2.0

### Upgrade notes

- Traces and logs are now sent gzip-compressed, like replay. A collector on another origin must
  allow the `Content-Encoding` request header, or the browser blocks every export. With the
  OpenTelemetry Collector, set `cors.allowed_headers` to `["*"]`, or list `content-type`,
  `content-encoding` and, if you set `apiKey`, `authorization`. ClickStack's collector already
  allows all headers.
- A proxy in front of the collector must forward the request body and its `Content-Encoding`
  header unchanged.

### Changed

- Logs and replay are sent every 5 seconds, like spans, instead of every second. Active pages send
  fewer requests, and logs and replay arrive up to 5 seconds later. A page with a large replay
  snapshot that is left within 5 seconds can lose its replay.
- Failed trace and log exports are no longer retried, like replay. Each exporter logs one warning.

### Fixed

- With `init`, traces and logs were lost when the user left soon after a burst of activity, such
  as a page load with many requests. Batches now hold at most 64 records and use `keepalive` only
  while the page is hidden, so the last batch fits in what a closing page can still send. That is
  about 64 KiB for traces, logs and replay together, so some loss on leaving is still possible.
- Replay requests now give up after 10 seconds, like trace and log requests. A collector that
  never answered could stop replay and, with a same-origin endpoint, block the page's own requests.
- Replay requests no longer show as failed in DevTools.

## 1.1.0

### Added

- `resourceAttributes` option: further resource attributes for all telemetry, replay records
  included.
- `tracesEndpoint` and `logsEndpoint` options: full URLs that replace the URL built from
  `endpoint` for one signal. `endpoint` is not needed when both are set.
- `setAttributes()`: attributes for every later span and log record, such as a tenant or a plan.
- `init` warns about unknown options, such as those of `@hyperdx/browser`.

### Fixed

- An `init` call without a valid endpoint or service name no longer blocks a later valid call.
- An `endpoint` that already ends with `/v1/traces` or `/v1/logs` no longer gets the path twice.

## 1.0.0

First release of `@clickhouse/clickstack-browser`, browser RUM and session replay for ClickStack on
the upstream OpenTelemetry browser SDK. It replaces `@hyperdx/browser`; see the
[migration guide](docs/migration.md).

- `init` starts the OpenTelemetry browser SDK with sessions and the fetch, XHR, errors, navigation,
  user action, web vitals, navigation timing, resource timing, long task and console
  instrumentations, plus failed resource loads, and records a session replay with all text and
  form values masked by default.
- `startReplay` records the replay for apps that set up the upstream SDK themselves.
- `setUser`, `getSessionId`, `startNewSession`, `recordException`, `pauseReplay`, `resumeReplay`
  and `shutdown`.
- A script-tag build that defines the `ClickStack` global.
- The 1.x line supports OpenTelemetry JS 2.x: `@opentelemetry/api` 1.9 and
  `@opentelemetry/browser-sdk` 0.6.
