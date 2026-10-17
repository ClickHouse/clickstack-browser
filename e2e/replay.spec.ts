import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface KeyValue {
  key: string;
  value: { stringValue?: string; intValue?: string };
}

interface OtlpLogRecord {
  body?: { stringValue?: string };
  attributes?: KeyValue[];
}

interface ExportRequest {
  resourceLogs?: {
    resource?: { attributes?: KeyValue[] };
    scopeLogs?: { scope?: { name?: string }; logRecords?: OtlpLogRecord[] }[];
  }[];
}

// What the page callbacks read from the page's global scope (this file has no DOM types).
interface PageGlobal {
  ClickStack: { getSessionId(): string | null };
  localStorage: { getItem(key: string): string | null };
  violations: string[];
}

function attribute(
  attributes: KeyValue[] | undefined,
  key: string,
): string | undefined {
  const value = attributes?.find((a) => a.key === key)?.value;
  return value?.stringValue ?? value?.intValue;
}

async function received(
  service: string,
): Promise<{ replay: OtlpLogRecord[]; rum: OtlpLogRecord[] }> {
  const output = process.env["E2E_COLLECTOR_OUTPUT"] ?? "";
  const text = await readFile(join(output, "logs.jsonl"), "utf8").catch(
    () => "",
  );
  const replay: OtlpLogRecord[] = [];
  const rum: OtlpLogRecord[] = [];

  for (const line of text.split("\n").filter(Boolean)) {
    let request: ExportRequest;

    try {
      request = JSON.parse(line) as ExportRequest;
    } catch {
      // The collector may be writing this line right now.
      continue;
    }

    for (const resourceLogs of request.resourceLogs ?? []) {
      if (
        attribute(resourceLogs.resource?.attributes, "service.name") !== service
      ) {
        continue;
      }

      for (const scopeLogs of resourceLogs.scopeLogs ?? []) {
        (scopeLogs.scope?.name === "rum.rr-web" ? replay : rum).push(
          ...(scopeLogs.logRecords ?? []),
        );
      }
    }
  }

  return { replay, rum };
}

test("records a small page and sends decodable rr-web records under the page session", async ({
  page,
}) => {
  const service = `e2e-${String(Date.now())}`;
  const errors: string[] = [];

  page.on("pageerror", (error) => errors.push(error.message));

  const replayContentTypes: (string | undefined)[] = [];

  page.on("request", (request) => {
    if (
      request.url().endsWith("/v1/logs") &&
      request.headers()["content-encoding"] === "gzip"
    ) {
      replayContentTypes.push(request.headers()["content-type"]);
    }
  });

  // Runs in the page before its scripts; init scripts are not subject to the page's CSP.
  await page.addInitScript({
    content:
      'window.violations = []; document.addEventListener("securitypolicyviolation", ' +
      "(event) => window.violations.push(event.violatedDirective));",
  });

  await page.goto(
    `${process.env["E2E_PAGE_ORIGIN"] ?? ""}/?service=${service}`,
  );
  await page.waitForFunction(
    () =>
      (globalThis as unknown as PageGlobal).ClickStack.getSessionId() !== null,
  );

  // Past the batch delay, so the input below is left for the final flush on leaving the page.
  await page.waitForTimeout(2500);
  await page.fill("input", "typed-secret");
  await page.click("button");

  const { sessionId, stored, violations } = await page.evaluate(() => {
    const page = globalThis as unknown as PageGlobal;
    const storedSession = JSON.parse(
      page.localStorage.getItem("opentelemetry-session") ?? "{}",
    ) as { id?: string };

    return {
      sessionId: page.ClickStack.getSessionId(),
      stored: storedSession.id,
      violations: page.violations,
    };
  });

  await page.goto("about:blank");

  let records = await received(service);
  await expect
    .poll(
      async () => {
        records = await received(service);
        return records.replay.some(
          (record) =>
            (record.body?.stringValue ?? "").includes('"source":2') &&
            (record.body?.stringValue ?? "").includes('"type":2'),
        );
      },
      { timeout: 20_000 },
    )
    .toBe(true);

  expect(sessionId).toBe(stored);
  expect(replayContentTypes.length).toBeGreaterThan(0);
  expect(new Set(replayContentTypes)).toEqual(new Set(["application/json"]));
  expect(records.rum.length).toBeGreaterThan(0);

  for (const record of [...records.replay, ...records.rum]) {
    expect(attribute(record.attributes, "session.id")).toBe(sessionId);
  }

  const replay = records.replay
    .map((record) => ({
      body: record.body?.stringValue ?? "",
      event: Number(attribute(record.attributes, "rr-web.event")),
      chunk: Number(attribute(record.attributes, "rr-web.chunk")),
      total: Number(attribute(record.attributes, "rr-web.total-chunks")),
      offset: Number(attribute(record.attributes, "rr-web.offset")),
    }))
    .sort((a, b) => a.offset - b.offset);

  expect(replay.map((r) => r.offset)).toEqual(replay.map((_, i) => i + 1));

  const events = new Map<number, typeof replay>();
  for (const record of replay) {
    events.set(record.event, [...(events.get(record.event) ?? []), record]);
  }

  const decoded = [...events.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, chunks]) => {
      expect(chunks.map((c) => c.chunk)).toEqual(chunks.map((_, i) => i + 1));
      expect(chunks.every((c) => c.total === chunks.length)).toBe(true);
      return JSON.parse(chunks.map((c) => c.body).join("")) as { type: number };
    });

  expect(decoded.slice(0, 2).map((event) => event.type)).toEqual([4, 2]);

  const bodies = replay.map((r) => r.body).join("");
  expect(bodies).not.toContain("secret text");
  expect(bodies).not.toContain("typed-secret");

  expect(violations).toEqual([]);
  expect(errors).toEqual([]);
});
