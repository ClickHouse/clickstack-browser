import { context, diag, propagation, trace } from "@opentelemetry/api";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { logs } from "../logs-api.ts";
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

function isReplay(request: Request): boolean {
  return new Headers(request.init?.headers).get("content-encoding") === "gzip";
}

// The upstream RUM exporters send uncompressed OTLP/JSON as bytes.
function jsonBodies(path: string): string {
  return sentTo(path)
    .filter((r) => !isReplay(r))
    .map((r) => new TextDecoder().decode(r.init?.body as Uint8Array))
    .join("\n");
}

async function gunzip(body: unknown): Promise<string> {
  const stream = new Blob([body as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));

  return new Response(stream).text();
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
  const body = jsonBodies("/otel/v1/traces");
  expect(body).toContain(
    '"key":"session.id","value":{"stringValue":"' + sessionId + '"}',
  );
  expect(body).toContain('"key":"user.id","value":{"stringValue":"user-1"}');
  expect(body).toContain(
    '"key":"service.name","value":{"stringValue":"web-app"}',
  );
  expect(body).toContain(
    '"key":"telemetry.distro.name","value":{"stringValue":"clickstack-browser"}',
  );
  expect(sentTo("/otel/v1/logs").some(isReplay)).toBe(false);
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

  const rum = jsonBodies("/otel/v1/traces") + jsonBodies("/otel/v1/logs");
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

  const replay = await gunzip(
    sentTo("/otel/v1/logs").find(isReplay)?.init?.body,
  );
  expect(replay).toContain(
    '"key":"deployment.environment.name","value":{"stringValue":"staging"}',
  );
  expect(replay).toContain(String.raw`\"href\":\"https://sanitized.example/`);
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

  expect(jsonBodies("/otel/v1/logs")).toContain("warn-message");
  expect(jsonBodies("/otel/v1/logs")).not.toContain("info-message");
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

  const body = jsonBodies("/otel/v1/logs");
  expect(body).toContain(String.raw`failed: Error: boom\n    at `);
  expect(body).toContain(String.raw`{\"id\":1}`);
  expect(body).toContain(String.raw`Error: bad\nhandler@app.js:1:2`);
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

  expect(jsonBodies("/otel/v1/logs")).not.toContain("error-message");
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

  const replay = sentTo("/otel/v1/logs").filter(isReplay);
  expect(replay.length).toBeGreaterThan(0);
  const json = await gunzip(replay[0]?.init?.body);
  expect(json).toContain('"name":"rum.rr-web"');
  expect(json).toContain(
    '"key":"session.id","value":{"stringValue":"' + sessionId + '"}',
  );
});

test("pauseReplay before init sends no replay", async () => {
  const module = await load();
  module.pauseReplay();
  module.init({ endpoint: "/otel", serviceName: "web-app" });
  await started(module);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await module.shutdown();

  expect(sentTo("/otel/v1/logs").some(isReplay)).toBe(false);
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
