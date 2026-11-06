# Changelog

## 1.2.0

### Changed

- Traces and logs are sent gzip-compressed, as replay already was, so several times more telemetry
  fits in what a closing page can still send. A collector on another origin must allow the
  `Content-Encoding` request header: for the OpenTelemetry Collector, list `content-encoding` in
  `cors.allowed_headers`, or use `"*"`. Otherwise the browser blocks every trace and log export.
  ClickStack's collector allows all headers. A proxy in front of the collector must forward the
  body and its `Content-Encoding` header unchanged.
- Logs and replay are sent every 5 seconds, as spans already were, instead of every second, so an
  active page sends fewer requests. In exchange, logs and replay arrive up to 5 seconds later, a
  request lost when the tab closes can carry up to 5 seconds of logs, and logs resume up to about
  15 seconds after a collector that stopped answering is back (the 10-second request timeout plus
  the 5-second delay). A visit shorter than that keeps its replay through the final flush when the
  page is hidden, unless the replay's full snapshot is over 32 KiB compressed.
- Failed trace and log exports are not retried, as for replay. Each exporter logs one warning.

### Fixed

- Traces and logs lost when the user reloaded, closed the tab or navigated away after a burst of
  telemetry, such as a page load with many requests. Upstream sent batches of up to 512 records,
  which grew past what a closing page can send with `keepalive` (64 KiB, shared by traces and
  logs) and were then lost whole. Traces and logs now go through this package's own exporter, built
  on the upstream OTLP/JSON serializers: batches of up to 64 records, gzip-compressed, and every
  response read, so `keepalive` is released quickly. All exporters share one budget, replay
  included. While the page is visible, requests use `keepalive` only within 16 KiB and 3 requests
  of it, so one in flight when the tab closes still arrives and the rest is left to the final
  flush. Everything pending when the page is hidden, traces, logs and replay together, must fit
  in what is left, about 60 KiB compressed in total. While the page is hidden, a trace or log batch
  over 16 KiB compressed is split into parts of at most 16 KiB, and replay into parts of up to 32
  KiB; a single record larger than a part is sent as one. The parts beyond the budget are sent
  without keepalive and are lost if the page closes.
- Replay requests give up after 10 seconds, as trace and log requests already did. A collector
  that accepted the connection and never answered held replay requests open, which stopped replay
  export and, with a same-origin endpoint, stalled the page's own requests to its server.
- Replay requests showed as failed in DevTools, because the replay exporter cancelled each
  response body. It now reads it.

### Docs

- The README says near the Quick start that replays mask all text and form values by default.

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
