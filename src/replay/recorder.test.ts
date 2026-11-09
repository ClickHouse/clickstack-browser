import { diag } from "@opentelemetry/api";
import type {
  Session,
  SessionObserver,
} from "@opentelemetry/browser-sdk/session";
import {
  LoggerProvider,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import { record } from "@rrweb/record";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { pageState } from "../internal/global.ts";
import { Recorder } from "./recorder.ts";

interface Harness {
  recorder: Recorder;
  records: ReadableLogRecord[];
  getSessionId: ReturnType<typeof vi.fn<() => string>>;
  rotate: (session: Session) => void;
  provider: LoggerProvider;
}

let harness: Harness | undefined;

function setup(
  options: {
    maskAllText?: boolean;
    maskAllInputs?: boolean;
    startTimestamp?: number;
    sanitizeUrl?: (url: string) => string;
  } = {},
): Harness {
  const records: ReadableLogRecord[] = [];
  const observers: SessionObserver[] = [];
  const getSessionId = vi.fn(() => "session-a");

  const provider = new LoggerProvider({
    processors: [
      {
        onEmit: (r) => records.push(r),
        forceFlush: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
      },
    ],
  });

  const recorder = new Recorder({
    sessionManager: {
      getSessionId,
      addObserver: (observer: SessionObserver) => observers.push(observer),
      getSession: () => ({
        id: "session-a",
        startTimestamp: options.startTimestamp ?? Date.now(),
      }),
    } as never,
    provider,
    maskAllText: options.maskAllText ?? true,
    maskAllInputs: options.maskAllInputs ?? true,
    sanitizeUrl: options.sanitizeUrl,
  });

  harness = {
    recorder,
    records,
    getSessionId,
    provider,
    rotate: (session) => {
      for (const observer of observers) {
        observer.onSessionStarted(session);
      }
    },
  };

  return harness;
}

async function started(
  options?: Parameters<typeof setup>[0],
): Promise<Harness> {
  const h = setup(options);

  h.recorder.start();

  await vi.waitFor(() => {
    expect(h.records.length).toBeGreaterThanOrEqual(2);
  });

  return h;
}

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));
const eventNumber = (record: ReadableLogRecord | undefined): number =>
  record?.attributes["rr-web.event"] as number;
const types = (records: ReadableLogRecord[]): number[] =>
  records.map((r) => (JSON.parse(r.body as string) as { type: number }).type);
const bodies = (records: ReadableLogRecord[]): string =>
  records.map((r) => r.body as string).join("");

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

async function mutate(): Promise<void> {
  document.querySelector("p")?.setAttribute("data-n", String(Math.random()));

  await tick();
}

function click(): void {
  document
    .querySelector("button")
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML =
    '<p>secret text</p><button>Go</button><input value="typed-secret">' +
    '<input type="hidden" value="csrf-secret"><input type="password" value="pw-secret">';
});

afterEach(async () => {
  await harness?.recorder.shutdown();

  harness = undefined;
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });

  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("opens the session with a meta event and a full snapshot, numbered in order, all masked", async () => {
  const h = await started();
  await mutate();

  expect(types(h.records).slice(0, 3)).toEqual([4, 2, 3]);

  const first = eventNumber(h.records[0]);
  h.records.forEach((r, i) => {
    expect(r.attributes).toEqual({
      "session.id": "session-a",
      "rr-web.event": first + i,
      "rr-web.chunk": 1,
      "rr-web.total-chunks": 1,
      "rr-web.offset": first + i,
    });
  });

  for (const secret of [
    "secret text",
    "typed-secret",
    "csrf-secret",
    "pw-secret",
  ]) {
    expect(bodies(h.records)).not.toContain(secret);
  }

  expect(pageState().recording).toBe(true);
});

test("with masking turned off only passwords stay masked", async () => {
  const h = await started({ maskAllInputs: false, maskAllText: false });

  expect(bodies(h.records)).toContain("typed-secret");
  expect(bodies(h.records)).toContain("secret text");
  expect(bodies(h.records)).not.toContain("pw-secret");
});

test("passes the page URL in the meta event through sanitizeUrl", async () => {
  const h = await started({
    sanitizeUrl: () => "https://example.clickhouse.com/sanitized",
  });

  expect(JSON.parse(h.records[0]?.body as string)).toMatchObject({
    type: 4,
    data: { href: "https://example.clickhouse.com/sanitized" },
  });
  expect(bodies(h.records)).not.toContain(location.href);
});

test("splits a large event into chunks that share its number and timestamp", async () => {
  const h = await started();
  const before = h.records.length;
  const first = eventNumber(h.records[0]);

  document
    .querySelector("p")
    ?.setAttribute("data-big", String.fromCodePoint(0xe9).repeat(600_000));
  await tick();

  const chunks = h.records.slice(before);

  expect(chunks.length).toBeGreaterThanOrEqual(2);

  chunks.forEach((r, i) => {
    expect(r.attributes).toMatchObject({
      "rr-web.event": first + before,
      "rr-web.chunk": i + 1,
      "rr-web.total-chunks": chunks.length,
      "rr-web.offset": first + before + i,
    });

    expect(r.hrTime).toEqual(chunks[0]?.hrTime);
  });

  expect((JSON.parse(bodies(chunks)) as { type: number }).type).toBe(3);
});

test("a new session in a visible tab starts at the first user input, numbered above the last", async () => {
  const h = await started();
  const before = h.records.length;
  const last = eventNumber(h.records.at(-1));

  h.rotate({ id: "session-b", startTimestamp: Date.now() });

  await mutate();

  expect(h.records).toHaveLength(before);

  click();
  await tick();

  const fresh = h.records.slice(before);

  expect(types(fresh).slice(0, 2)).toEqual([4, 2]);
  expect(fresh[0]?.attributes["session.id"]).toBe("session-b");
  expect(eventNumber(fresh[0])).toBeGreaterThan(last);
  expect(fresh[0]?.attributes["rr-web.offset"]).toBe(eventNumber(fresh[0]));
});

test("a later page load in the same session numbers its events above the earlier one's", async () => {
  const earlier = await started();
  await mutate();
  const last = eventNumber(earlier.records.at(-1));
  await earlier.recorder.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 2));

  const later = await started();

  expect(eventNumber(later.records[0])).toBeGreaterThan(last);
});

test("a new session in a hidden tab starts once the tab is visible", async () => {
  const h = await started();
  const before = h.records.length;

  setVisibility("hidden");
  h.rotate({ id: "session-b", startTimestamp: Date.now() });

  await mutate();
  click();
  await tick();
  expect(h.records).toHaveLength(before);

  setVisibility("visible");
  await tick();
  expect(types(h.records.slice(before)).slice(0, 2)).toEqual([4, 2]);
});

test("counts only user input as session activity", async () => {
  const h = await started();
  h.getSessionId.mockClear();

  await mutate();
  await mutate();

  expect(h.getSessionId).not.toHaveBeenCalled();
  click();
  await tick();
  expect(h.getSessionId).toHaveBeenCalled();
});

test("typing and scrolling count as activity, values written by scripts do not", async () => {
  const h = await started();
  const input = document.querySelector("input");

  if (input === null) {
    throw new Error("the fixture has no input");
  }

  h.getSessionId.mockClear();
  input.value = "written-by-script";

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(h.getSessionId).not.toHaveBeenCalled();

  input.dispatchEvent(new Event("input", { bubbles: true }));
  document.dispatchEvent(new Event("scroll"));

  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(h.getSessionId).toHaveBeenCalled();
});

test("a shutdown before recording starts leaves rrweb off", async () => {
  const h = setup();
  h.recorder.start();

  await h.recorder.shutdown();
  await tick();

  expect(h.records).toHaveLength(0);
  expect(() => {
    record.takeFullSnapshot();
  }).toThrow();
});

test("pause drops events and resume starts again with a full snapshot", async () => {
  const h = await started();
  const before = h.records.length;

  h.recorder.pause();
  await mutate();
  expect(h.records).toHaveLength(before);

  h.recorder.resume();
  await tick();
  expect(types(h.records.slice(before)).slice(0, 2)).toEqual([4, 2]);
});

test("stops recording a session 4 hours after it started", async () => {
  const h = await started({
    startTimestamp: Date.now() - 4 * 60 * 60 * 1000 + 100,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));

  await mutate();

  const capped = h.records.length;
  await mutate();

  expect(h.records).toHaveLength(capped);
  expect(() => {
    record.takeFullSnapshot();
  }).toThrow();
});

test("throttled attribute changes give one warning and a full snapshot a second later", async () => {
  const warn = vi.spyOn(diag, "warn");
  const h = await started();

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

  const paragraph = document.querySelector("p");
  for (let i = 0; i < 150; i++) {
    paragraph?.setAttribute("data-step", String(i));
    await Promise.resolve();
  }

  const before = h.records.length;
  await vi.advanceTimersByTimeAsync(1000);
  await Promise.resolve();

  expect(types(h.records.slice(before))).toContain(2);
  expect(warn).toHaveBeenCalledOnce();
});

test("waits for DOMContentLoaded on a loading document", async () => {
  Object.defineProperty(document, "readyState", {
    configurable: true,
    value: "loading",
  });
  const h = setup();
  h.recorder.start();

  await tick();
  expect(h.records).toHaveLength(0);

  Object.defineProperty(document, "readyState", {
    configurable: true,
    value: "complete",
  });
  document.dispatchEvent(new Event("DOMContentLoaded"));
  expect(types(h.records)).toEqual([4, 2]);
});

test("leaves out the content of a blocked iframe", async () => {
  document.body.innerHTML =
    '<iframe class="rr-block" srcdoc="<p>inside-frame</p>"></iframe><p>outside</p>';
  await new Promise((resolve) => {
    document.querySelector("iframe")?.addEventListener("load", resolve);
  });
  const h = await started();

  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(bodies(h.records)).not.toContain("inside-frame");
});

test("shutdown stops rrweb, its listener and the page flag, and shuts the provider down", async () => {
  const h = await started();
  const shutdown = vi.spyOn(h.provider, "shutdown");

  await h.recorder.shutdown();
  const after = h.records.length;

  await mutate();
  setVisibility("visible");

  expect(h.records).toHaveLength(after);
  expect(pageState().recording).toBe(false);
  expect(shutdown).toHaveBeenCalledOnce();
});
