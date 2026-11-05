import { context, diag, propagation, trace } from "@opentelemetry/api";
import { SessionManager } from "@opentelemetry/browser-sdk/session";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { logs } from "../logs-api.ts";
import { setAttributes } from "../rum/attributes.ts";
import { recordException } from "../rum/exceptions.ts";
import { setUser } from "../rum/user.ts";

type InitModule = typeof import("./init.ts");

interface Request {
  url: string;
  init: RequestInit | undefined;
}

let copy = 0;
let requests: Request[] = [];
let api: InitModule | undefined;

// Each test gets its own copy of the module since init() runs once per module and page
async function load(): Promise<InitModule> {
  copy += 1;

  const url = `./init.ts?copy=${String(copy)}`;
  api = (await import(/* @vite-ignore */ url)) as InitModule;

  return api;
}

async function started(module: InitModule): Promise<string> {
  await vi.waitFor(() => {
    expect(module.getSessionId()).not.toBeNull();
  });

  return module.getSessionId() ?? "";
}

function storedSessionId(): string | undefined {
  const stored = localStorage.getItem("opentelemetry-session");
  return stored === null
    ? undefined
    : (JSON.parse(stored) as { id: string }).id;
}

function sentTo(path: string): Request[] {
  return requests.filter((r) => r.url.endsWith(path));
}

async function gunzip(body: unknown): Promise<string> {
  const stream = new Blob([body as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));

  return new Response(stream).text();
}

// Every exporter sends gzip-compressed OTLP/JSON
function bodiesSentTo(path: string): Promise<string[]> {
  return Promise.all(sentTo(path).map((r) => gunzip(r.init?.body)));
}

function isReplay(body: string): boolean {
  return body.includes('"name":"rum.rr-web"');
}

async function rumBodies(path: string): Promise<string> {
  return (await bodiesSentTo(path)).filter((b) => !isReplay(b)).join("\n");
}

async function replayBodies(): Promise<string[]> {
  return (await bodiesSentTo("/otel/v1/logs")).filter(isReplay);
}

interface OtlpJson {
  resourceSpans?: { scopeSpans: { spans: unknown[] }[] }[];
  resourceLogs?: { scopeLogs: { logRecords: unknown[] }[] }[];
}

// The number of spans or log records in one OTLP/JSON request body
function recordCount(body: string | undefined): number {
  const json = JSON.parse(body ?? "{}") as OtlpJson;
  const spans = (json.resourceSpans ?? []).flatMap((r) =>
    r.scopeSpans.flatMap((s) => s.spans),
  );
  const records = (json.resourceLogs ?? []).flatMap((r) =>
    r.scopeLogs.flatMap((s) => s.logRecords),
  );

  return spans.length + records.length;
}

beforeEach(() => {
  requests = [];
  localStorage.clear();
  Reflect.deleteProperty(
    globalThis,
    Symbol.for("@clickhouse/clickstack-browser"),
  );

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: input instanceof Request ? input.url : String(input),
        init,
      });
      return Promise.resolve(new Response("ok"));
    }),
  );
});

afterEach(async () => {
  await api?.shutdown();

  api = undefined;
  setUser(null);
  setAttributes(null);

  vi.unstubAllGlobals();
  vi.restoreAllMocks();

  trace.disable();
  context.disable();
  propagation.disable();
  logs.disable();
  diag.disable();
});

test("sends spans with the session, the user and the resource to the endpoint", async () => {
  setUser({ id: "user-1" });
  const module = await load();
  module.init({
    endpoint: "/otel",
    apiKey: "key-1",
    serviceName: "web-app",
    serviceVersion: "2.0.0",
    replay: false,
  });
  const sessionId = await started(module);
  expect(sessionId).toBe(storedSessionId());

  // The fetch span ends once the instrumentation has read the response body.
  await (await fetch("/api/items")).text();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await module.shutdown();

  const [traces] = sentTo("/otel/v1/traces");
  expect(traces?.url).toBe(`${location.origin}/otel/v1/traces`);
  expect(new Headers(traces?.init?.headers).get("authorization")).toBe("key-1");
  const body = await rumBodies("/otel/v1/traces");
  expect(body).toContain(
    '"key":"session.id","value":{"stringValue":"' + sessionId + '"}',
  );
  expect(body).toContain('"key":"user.id","value":{"stringValue":"user-1"}');
  expect(body).toContain(
    '"key":"service.name","value":{"stringValue":"web-app"}',
  );
  expect(body).toContain(
    '"key":"service.version","value":{"stringValue":"2.0.0"}',
  );
  expect(body).toContain(
    '"key":"telemetry.distro.name","value":{"stringValue":"clickstack-browser"}',
  );
  expect(await replayBodies()).toEqual([]);
  expect(module.getSessionId()).toBeNull();
});

test("adds trace headers to requests to the listed origins only", async () => {
  const module = await load();
  module.init({
    endpoint: "/otel",
    serviceName: "web-app",
    replay: false,
    traceOrigins: ["https://example-api.clickhouse.com"],
  });

  await started(module);

  await fetch("https://example-api.clickhouse.com/users?id=1");
  await fetch("https://other-example-api.clickhouse.com/users");

  const headerOf = (url: string): string | null =>
    new Headers(requests.find((r) => r.url === url)?.init?.headers).get(
      "traceparent",
    );
  expect(headerOf("https://example-api.clickhouse.com/users?id=1")).toMatch(
    /^00-[0-9a-f]{32}-/,
  );
  expect(headerOf("https://other-example-api.clickhouse.com/users")).toBeNull();
});

test("records the environment, and passes every URL through sanitizeUrl", async () => {
  const module = await load();
  module.init({
    endpoint: "/otel",
    serviceName: "web-app",
    environment: "staging",
    sanitizeUrl: (url) =>
      url.replace(location.origin, "https://sanitized.example"),
  });
  await started(module);

  await (await fetch("/api/items?token=1")).text();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await module.shutdown();

  const rum =
    (await rumBodies("/otel/v1/traces")) + (await rumBodies("/otel/v1/logs"));
  expect(rum).toContain(
    '"key":"deployment.environment.name","value":{"stringValue":"staging"}',
  );
  expect(rum).toContain(
    '"key":"url.full","value":{"stringValue":"https://sanitized.example/api/items?token=1"}',
  );
  expect(rum).toContain(
    '"key":"browser.document.url.full","value":{"stringValue":"https://sanitized.example/',
  );
  // The timing events have no upstream hook, so this package rewrites their URL.
  expect(rum).toContain('"eventName":"browser.resource_timing"');
  expect(rum).toContain('"eventName":"browser.navigation_timing"');
  expect(rum).not.toContain(location.origin);

  const [replay] = await replayBodies();
  expect(replay).toContain(
    '"key":"deployment.environment.name","value":{"stringValue":"staging"}',
  );
  expect(replay).toContain(String.raw`\"href\":\"https://sanitized.example/`);
});

test("sends traces and logs to their own endpoints, replay included", async () => {
  const module = await load();
  module.init({
    tracesEndpoint:
      "https://traces.example-collector.clickhouse.com/custom/traces",
    logsEndpoint: "/collector/logs",
    serviceName: "web-app",
  });
  await started(module);

  await (await fetch("/api/items")).text();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await module.shutdown();

  const logsUrl = `${location.origin}/collector/logs`;

  expect(
    requests.some(
      (r) =>
        r.url ===
        "https://traces.example-collector.clickhouse.com/custom/traces",
    ),
  ).toBe(true);
  const logs = await bodiesSentTo("/collector/logs");
  expect(sentTo("/collector/logs").every((r) => r.url === logsUrl)).toBe(true);
  expect(logs.some(isReplay)).toBe(true);
  expect(logs.some((b) => !isReplay(b))).toBe(true);
});

test("a signal endpoint replaces only its own URL", async () => {
  const module = await load();
  module.init({
    endpoint: "/otel",
    tracesEndpoint: "https://traces.example-collector.clickhouse.com/v1/traces",
    serviceName: "web-app",
    replay: false,
  });
  await started(module);

  await (await fetch("/api/items")).text();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await module.shutdown();

  expect(
    requests.some(
      (r) =>
        r.url === "https://traces.example-collector.clickhouse.com/v1/traces",
    ),
  ).toBe(true);
  expect(sentTo("/otel/v1/logs").length).toBeGreaterThan(0);
  expect(sentTo("/otel/v1/traces")).toEqual([]);
});

test("records resource attributes, which explicit options win over", async () => {
  const module = await load();
  module.init({
    endpoint: "/otel",
    serviceName: "web-app",
    serviceVersion: "2.0.0",
    resourceAttributes: {
      "service.namespace": "shop",
      "service.name": "ignored",
      "service.version": "ignored",
    },
  });
  await started(module);

  await (await fetch("/api/items")).text();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await module.shutdown();

  const traces = await rumBodies("/otel/v1/traces");

  expect(traces).toContain(
    '"key":"service.namespace","value":{"stringValue":"shop"}',
  );
  expect(traces).toContain(
    '"key":"service.name","value":{"stringValue":"web-app"}',
  );
  expect(traces).not.toContain("ignored");

  const [replay] = await replayBodies();
  expect(replay).toContain(
    '"key":"service.namespace","value":{"stringValue":"shop"}',
  );
});

test("setAttributes adds its attributes to later telemetry, and SDK and user keys win", async () => {
  setAttributes({
    "app.team.name": "core",
    "user.id": "custom",
    "session.id": "custom",
  });
  setUser({ id: "user-1" });
  const module = await load();
  module.init({ endpoint: "/otel", serviceName: "web-app", replay: false });
  const sessionId = await started(module);

  await (await fetch("/api/items")).text();
  recordException(new Error("caught"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await module.shutdown();

  const body =
    (await rumBodies("/otel/v1/traces")) + (await rumBodies("/otel/v1/logs"));

  expect(body).toContain(
    '"key":"app.team.name","value":{"stringValue":"core"}',
  );
  expect(body).toContain('"key":"user.id","value":{"stringValue":"user-1"}');
  expect(body).toContain(
    '"key":"session.id","value":{"stringValue":"' + sessionId + '"}',
  );
  expect(body).not.toContain('"stringValue":"custom"');
});

test("warns about unknown options and drops a signal path from the endpoint", async () => {
  const warn = vi.spyOn(diag, "warn");
  const options = {
    endpoint: "/otel/v1/traces",
    serviceName: "web-app",
    replay: false,
    disableReplay: true,
  };
  const module = await load();
  module.init(options);
  await started(module);

  await (await fetch("/api/items")).text();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await module.shutdown();

  expect(sentTo("/otel/v1/traces").length).toBeGreaterThan(0);
  expect(requests.some((r) => r.url.includes("/v1/traces/v1/"))).toBe(false);

  const messages = warn.mock.calls.map((call) => call[0]);

  expect(messages.some((m) => m.includes("disableReplay"))).toBe(true);
  expect(messages.some((m) => m.includes("/v1/traces"))).toBe(true);
});

test("an init without an endpoint does not block a later valid one", async () => {
  vi.spyOn(diag, "error").mockImplementation(() => undefined);
  const module = await load();
  module.init({ serviceName: "web-app" });
  module.init({ endpoint: "/otel", serviceName: "web-app", replay: false });

  expect(await started(module)).toMatch(/^[0-9a-f]{32}$/);
});

test("sends a full batch of 16 records at once instead of waiting for the timer", async () => {
  const module = await load();
  module.init({ endpoint: "/otel", serviceName: "web-app", replay: false });
  await started(module);

  for (let i = 0; i < 17; i++) {
    await (await fetch("/api/items")).text();
    recordException(new Error(`caught-${String(i)}`));
  }

  // Upstream's timer waits 5 seconds; vi.waitFor gives up after 1
  await vi.waitFor(() => {
    expect(sentTo("/otel/v1/traces").length).toBeGreaterThan(0);
    expect(sentTo("/otel/v1/logs").length).toBeGreaterThan(0);
  });
  expect(recordCount((await bodiesSentTo("/otel/v1/traces"))[0])).toBe(16);
  expect(recordCount((await bodiesSentTo("/otel/v1/logs"))[0])).toBe(16);
});

test("captures the console methods of the chosen level", async () => {
  const module = await load();
  module.init({
    endpoint: "/otel",
    serviceName: "web-app",
    replay: false,
    console: "warn",
  });
  await started(module);

  // eslint-disable-next-line no-console -- The test checks which console calls are captured.
  console.warn("warn-message");
  // eslint-disable-next-line no-console -- The test checks which console calls are captured.
  console.info("info-message");
  await module.shutdown();

  expect(await rumBodies("/otel/v1/logs")).toContain("warn-message");
  expect(await rumBodies("/otel/v1/logs")).not.toContain("info-message");
  expect(await rumBodies("/otel/v1/logs")).not.toContain('"key":"exception.');
});

test("records errors passed to the console with their message and stack", async () => {
  const module = await load();
  module.init({ endpoint: "/otel", serviceName: "web-app", replay: false });
  await started(module);

  // Firefox and Safari stacks hold only the frames.
  const framesOnly = new Error("bad");
  framesOnly.stack = "handler@app.js:1:2";
  // eslint-disable-next-line no-console -- The test checks how console arguments are recorded.
  console.error("failed:", new Error("boom"), { id: 1 });
  // eslint-disable-next-line no-console -- The test checks how console arguments are recorded.
  console.error(framesOnly);
  await module.shutdown();

  const body = await rumBodies("/otel/v1/logs");
  expect(body).toContain(String.raw`failed: Error: boom\n    at `);
  expect(body).toContain(String.raw`{\"id\":1}`);
  expect(body).toContain(String.raw`Error: bad\nhandler@app.js:1:2`);
  expect(body).toContain(
    '"key":"exception.message","value":{"stringValue":"boom"}',
  );
  expect(body).toContain(
    '"key":"exception.message","value":{"stringValue":"bad"}',
  );
});

test("recordException sends an exception event under the session", async () => {
  const module = await load();
  module.init({ endpoint: "/otel", serviceName: "web-app", replay: false });
  const sessionId = await started(module);

  recordException(new Error("caught"), { "app.operation": "checkout" });
  await module.shutdown();

  const body = await rumBodies("/otel/v1/logs");

  expect(body).toContain(
    '"key":"exception.message","value":{"stringValue":"caught"}',
  );
  expect(body).toContain(
    '"key":"app.operation","value":{"stringValue":"checkout"}',
  );
  expect(body).toContain(
    '"key":"session.id","value":{"stringValue":"' + sessionId + '"}',
  );
});

test("captures no console calls with console false, and matches origins given as RegExp", async () => {
  const module = await load();
  module.init({
    endpoint: "/otel",
    serviceName: "web-app",
    replay: false,
    console: false,
    traceOrigins: [/^https:\/\/example-api[.]clickhouse[.]com\//],
  });
  await started(module);

  // eslint-disable-next-line no-console -- The test checks that console calls are not captured.
  console.error("error-message");
  await fetch("https://example-api.clickhouse.com/users");
  await module.shutdown();

  expect(await rumBodies("/otel/v1/logs")).not.toContain("error-message");
  const request = requests.find(
    (r) => r.url === "https://example-api.clickhouse.com/users",
  );
  expect(new Headers(request?.init?.headers).get("traceparent")).not.toBeNull();
});

test("shutdown during start leaves nothing running", async () => {
  const module = await load();
  module.init({ endpoint: "/otel", serviceName: "web-app" });
  await module.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(module.getSessionId()).toBeNull();
  expect(requests).toEqual([]);
});

test("records the replay under the same session", async () => {
  const module = await load();
  module.init({ endpoint: "/otel", serviceName: "web-app" });
  const sessionId = await started(module);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await module.shutdown();

  const replay = await replayBodies();
  expect(replay.length).toBeGreaterThan(0);
  const json = replay[0];
  expect(json).toContain('"name":"rum.rr-web"');
  expect(json).toContain(
    '"key":"session.id","value":{"stringValue":"' + sessionId + '"}',
  );
});

test("records text and input values when masking is turned off, except rr-mask elements", async () => {
  document.body.innerHTML =
    '<p>visible-text</p><input value="typed-value"><span class="rr-mask">hidden-text</span>';
  const module = await load();
  module.init({
    endpoint: "/otel",
    serviceName: "web-app",
    maskAllText: false,
    maskAllInputs: false,
  });

  await started(module);
  await new Promise((resolve) => setTimeout(resolve, 50));

  await module.shutdown();
  document.body.innerHTML = "";

  const json = (await replayBodies()).join("");

  expect(json).toContain("visible-text");
  expect(json).toContain("typed-value");
  expect(json).not.toContain("hidden-text");
});

test("pauseReplay before init sends no replay", async () => {
  const module = await load();
  module.pauseReplay();
  module.init({ endpoint: "/otel", serviceName: "web-app" });
  await started(module);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await module.shutdown();

  expect(await replayBodies()).toEqual([]);
});

test("starts nothing without an endpoint or a service name", async () => {
  const error = vi.spyOn(diag, "error");
  const module = await load();
  module.init({ endpoint: "", serviceName: "web-app" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(error).toHaveBeenCalledOnce();
  expect(module.getSessionId()).toBeNull();
  expect(requests).toEqual([]);
});

test("ignores a second init on the page, and an init after shutdown", async () => {
  const warn = vi.spyOn(diag, "warn");
  const first = await load();
  first.init({ endpoint: "/otel", serviceName: "web-app", replay: false });
  const second = await load();
  second.init({ endpoint: "/otel", serviceName: "other" });
  expect(warn).toHaveBeenCalledOnce();
  await first.shutdown();

  Reflect.deleteProperty(
    globalThis,
    Symbol.for("@clickhouse/clickstack-browser"),
  );
  const third = await load();
  await third.shutdown();
  third.init({ endpoint: "/otel", serviceName: "web-app" });
  expect(third.getSessionId()).toBeNull();
});

test("keeps working when localStorage refuses to store the session", async () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  const module = await load();
  module.init({ endpoint: "/otel", serviceName: "web-app", replay: false });
  expect(await started(module)).toMatch(/^[0-9a-f]{32}$/);
});

test("startNewSession gives later telemetry a new session id", async () => {
  const module = await load();
  module.startNewSession();
  module.init({ endpoint: "/otel", serviceName: "web-app", replay: false });
  const first = await started(module);

  module.startNewSession();
  const second = module.getSessionId();

  expect(second).toMatch(/^[0-9a-f]{32}$/);
  expect(second).not.toBe(first);
  expect(storedSessionId()).toBe(second);

  await (await fetch("/api/items")).text();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await module.shutdown();

  expect(await rumBodies("/otel/v1/traces")).toContain(
    '"key":"session.id","value":{"stringValue":"' + (second ?? "") + '"}',
  );
});

test("without upstream's resetSession, startNewSession clears the stored session and warns", async () => {
  const prototype = SessionManager.prototype as unknown as object;
  const resetSession = Object.getOwnPropertyDescriptor(
    prototype,
    "resetSession",
  );
  const module = await load();

  module.init({ endpoint: "/otel", serviceName: "web-app", replay: false });
  const first = await started(module);

  const warn = vi.spyOn(diag, "warn");
  Reflect.deleteProperty(prototype, "resetSession");
  try {
    module.startNewSession();
  } finally {
    if (resetSession) {
      Object.defineProperty(prototype, "resetSession", resetSession);
    }
  }

  expect(module.getSessionId()).toBe(first);
  expect(storedSessionId()).toBeUndefined();
  expect(warn).toHaveBeenCalledOnce();
});
