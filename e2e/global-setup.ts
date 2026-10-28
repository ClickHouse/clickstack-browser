import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("..", import.meta.url));

const COLLECTOR_IMAGE =
  "otel/opentelemetry-collector-contrib:0.163.1@sha256:1175b03003053962012f5a231f5567f66a3e8fdb960c7835c0e48f7aa1555806";
export const API_KEY = "e2e-ingestion-key";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("the fixture server has no port");
  }

  return `http://127.0.0.1:${String(address.port)}`;
}

/**
 * Starts the collector in Docker and a server for the fixture page, which loads the script-tag
 * build under a strict CSP (no inline scripts, no eval). Publishes the page origin and the
 * collector's output directory to the test through the environment.
 *
 * @returns A function that stops both.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  // A throwaway server finds a free port for the collector.
  const probe = createServer();
  const collectorPort = new URL(await listen(probe)).port;
  await new Promise((resolve) => probe.close(resolve));
  const collectorOrigin = `http://127.0.0.1:${collectorPort}`;

  const page = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://x").pathname;
    if (path === "/") {
      response.writeHead(200, {
        "content-type": "text/html",
        "content-security-policy": `default-src 'self'; connect-src 'self' ${collectorOrigin}`,
      });
      response.end(
        "<!doctype html><p>secret text</p><button>Go</button><input>" +
          '<script src="/dist/clickstack.iife.js"></script><script src="/start.js"></script>',
      );
    } else if (path === "/start.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(
        `ClickStack.init({ endpoint: '${collectorOrigin}', apiKey: '${API_KEY}', ` +
          `serviceName: new URLSearchParams(location.search).get('service') });`,
      );
    } else if (path === "/dist/clickstack.iife.js") {
      void readFile(join(repo, "dist", "clickstack.iife.js")).then(
        (script) => {
          response.writeHead(200, { "content-type": "text/javascript" });
          response.end(script);
        },
        () => {
          response.writeHead(500).end("run npm run build first");
        },
      );
    } else {
      response.writeHead(404).end();
    }
  });

  const pageOrigin = await listen(page);
  const output = await mkdtemp(join(tmpdir(), "clickstack-e2e-"));
  const user = process.getuid ? ["--user", String(process.getuid())] : [];

  const { stdout } = await run("docker", [
    "run",
    "--detach",
    "--rm",
    ...user,
    "--publish",
    `127.0.0.1:${collectorPort}:4318`,
    "--volume",
    `${join(repo, "e2e", "collector", "config.yaml")}:/etc/collector.yaml:ro`,
    "--volume",
    `${output}:/output`,
    "--env",
    `E2E_PAGE_ORIGIN=${pageOrigin}`,
    "--env",
    `E2E_API_KEY=${API_KEY}`,
    COLLECTOR_IMAGE,
    "--config",
    "/etc/collector.yaml",
  ]);

  const container = stdout.trim();
  const stop = async (): Promise<void> => {
    page.close();
    await run("docker", ["stop", container]).catch(() => undefined);
  };

  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await fetch(`${collectorOrigin}/v1/logs`, {
          signal: AbortSignal.timeout(2000),
        });
        break;
      } catch (error) {
        if (Date.now() > deadline) {
          throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  } catch (error) {
    await stop();

    throw new Error(`the collector did not start on ${collectorOrigin}`, {
      cause: error,
    });
  }

  process.env["E2E_PAGE_ORIGIN"] = pageOrigin;
  process.env["E2E_COLLECTOR_OUTPUT"] = output;

  return stop;
}
