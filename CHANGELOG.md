# Changelog

## 1.1.1

### Fixed

- Traces and logs lost when the user reloaded, closed the tab or navigated away after a burst of
  telemetry, such as a page load with many requests. Upstream's exporter sent every request with
  `keepalive`, and Chromium counts a keepalive request against the page's 64 KiB budget until its
  response is read, so exports during the burst used up the budget, were rejected and retried with
  backoff, and the final flush found no room. Traces and logs now use `keepalive` only while the
  page is hidden, through this package's own exporter built on the upstream OTLP/JSON serializers.
- Traces and logs are sent in batches of up to 16 records instead of upstream's 512, so a burst no
  longer leaves one batch larger than the limit pending. Very large records can still exceed it.

### Changed

- Failed trace and log exports are not retried, as for replay. One warning is logged.

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
