# Changelog

## 1.2.0

### Changed

- Traces and logs are sent gzip-compressed, as replay already was, so several times more telemetry
  fits in what a closing page can still send. A proxy in front of the collector must forward the
  body and its `Content-Encoding` header unchanged. The OpenTelemetry Collector and ClickStack
  accept gzip.
- Failed trace and log exports are not retried, as for replay. Each exporter logs one warning.

### Fixed

- Traces and logs lost when the user reloaded, closed the tab or navigated away after a burst of
  telemetry, such as a page load with many requests. Upstream sent batches of up to 512 records,
  which grew past what a closing page can send with `keepalive` (64 KiB, shared by traces and
  logs) and were then lost whole. Traces and logs now go through this package's own exporter, built
  on the upstream OTLP/JSON serializers: batches of up to 16 records, gzip-compressed, with
  `keepalive` only while the page is hidden, so exports during the burst leave the budget to the
  final flush. All exporters share one budget, replay included. A batch still exceeds it when its
  records average more than about 3.8 KB compressed.
- Export requests, replay included, give up after 10 seconds. A collector that accepted the
  connection and never answered kept them open, which stopped log export, and with a same-origin
  endpoint they could take up the browser's connections to the page's own server.
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
