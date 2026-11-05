# Changelog

## 1.1.1

### Fixed

- Traces and logs are sent in batches of up to 16 records instead of upstream's 512. A burst of
  telemetry, such as a page load with many requests, could leave one batch larger than the 60 KiB
  a closing page can still send, and the whole batch was lost when the user reloaded, closed the
  tab or navigated away.

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
