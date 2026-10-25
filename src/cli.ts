#!/usr/bin/env node
import { createServer, type ServerResponse } from "node:http";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import CDP from "chrome-remote-interface";
import { Capture, type Entry } from "./capture.js";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    host: { type: "string", multiple: true, default: [] },
    extension: { type: "string", multiple: true, default: [] },
    target: { type: "string", multiple: true, default: [] },
    "pause-workers": { type: "boolean", default: false },
    method: { type: "string" },
    status: { type: "string" },
    after: { type: "string", default: "0" },
    timeout: { type: "string", default: "10000" },
    duration: { type: "string", default: "1000" },
    output: { type: "string" },
    cdp: { type: "string" },
    profile: { type: "string" },
    sensitive: { type: "boolean", default: false },
    state: {
      type: "string",
      default: join(
        tmpdir(),
        `browser-network-${userInfo().username}`,
        "state.json",
      ),
    },
    limit: { type: "string", default: "500" },
    "body-limit": { type: "string", default: "262144" },
    contains: { type: "string", default: "" },
    execute: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean" },
  },
});
const [command = "help", id] = positionals;
type State = { pid: number; url: string; token: string };
const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };
const help = `browser-network ${version}: shared local Chrome network capture

  start --cdp URL --host example.com [--extension ID] [--sensitive]
  start --profile '/path/to/Chrome/profile-root' --host example.com
  status | targets | stop | requests [--contains TEXT] | show ID | tail
  wait --contains TEXT [--method POST] [--status 200] [--after ID] [--timeout MS]
  export --output PRIVATE_FILE.json
  media --target PAGE_ID [--duration MS]
  replay ID --execute

INSTALL
  npm install -g ./fcakyon-browser-network-cli-${version}.tgz
  Node.js 22.12 or newer is required. Chrome is not installed or restarted.

CONNECT
  Enable Chrome's remote debugging first. --cdp accepts a browser WebSocket URL
  or an HTTP discovery endpoint. --profile reads only DevToolsActivePort from
  an explicit profile root, preserving existing Chrome logins. A browser consent
  prompt may need approval. This CLI does not change Chrome security settings.

SCOPE
  Repeat --host for each permitted destination (host plus its subdomains).
  Only matching page/iframe/worker targets and explicit --extension IDs attach.
  Requests from extension background workers must also match a permitted host.
  Add API/CDN hosts explicitly. No system-wide capture or public tunnel.
  --target ID restricts target selection in addition to host/extension scope.
  --pause-workers opts into pausing new service workers until capture is enabled. Use it
  only with a dedicated test browser: it briefly pauses all new service workers,
  immediately resumes out-of-scope workers, and never restarts existing workers.
  Capture begins after target attachment. The first requests of a newly created
  worker may precede attachment. Content-script requests may appear on the page
  target. Chrome-target coverage does not imply all operating-system traffic.

DATA
  Default mode hides query values, allowlists headers, and omits bodies.
  URL paths remain visible and can contain private data. --sensitive retains raw
  URLs, headers, cookies, authorization, and bounded bodies for this capture.
  Limit scope to data you intend to share with your local agents.
  --limit bounds retained requests (500). --body-limit bounds bodies (256 KiB).
  A 64 MiB serialized-data budget also evicts oldest requests. Response bodies
  may be unavailable from Chrome. WebSockets retain the latest 100 frames each.
  droppedFrames counts older ones. No media decryption is performed.

SHARING
  All local Claude/Codex sessions can use the same daemon. --state selects its
  state file (default: ${args.state}). The file is mode 0600 and contains the
  local API bearer token. Capture data stays in memory and is cleared on stop.
  tail streams request summaries as JSON lines. show returns full retained data.
  The localhost API: GET /status, /requests, /requests/ID, /events (SSE), POST /stop.
  Send Authorization: Bearer TOKEN from the state file. Browser origins are denied.

REPLAY
  --execute explicitly authorizes a real request with captured credentials.
  Requires sensitive capture, complete wire headers and an intact request body.
  Redirect chains, multipart bodies, WebSockets and failed requests are rejected.
  Redirects are not followed. Expired signatures and browser-only state may fail.
  Transport-managed headers are regenerated. Response output is capped at 1 MiB.

stop disconnects capture, leaves Chrome running, and removes state and lock files.
`;

async function endpoint(): Promise<string> {
  if (!!args.cdp === !!args.profile)
    throw new Error("Choose exactly one of --cdp or --profile");
  let endpoint = args.cdp;
  if (args.profile) {
    const [port, path] = (
      await readFile(join(args.profile, "DevToolsActivePort"), "utf8")
    )
      .trim()
      .split(/\r?\n/);
    endpoint = `ws://127.0.0.1:${port}${path}`;
  }
  const url = new URL(endpoint!);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("Only local Chrome debugging endpoints are supported");
  if (url.protocol === "http:") {
    const response = await fetch(new URL("/json/version", url), {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      throw new Error(
        `Chrome discovery returned ${response.status}. Try --profile or a browser WebSocket URL.`,
      );
    endpoint = ((await response.json()) as { webSocketDebuggerUrl: string })
      .webSocketDebuggerUrl;
  }
  const socket = new URL(endpoint!);
  if (
    socket.protocol !== "ws:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(socket.hostname)
  )
    throw new Error("Expected a local ws:// browser endpoint");
  return socket.href;
}

async function serve(): Promise<void> {
  if (!args.host.length) throw new Error("At least one --host is required");
  const limit = Number(args.limit),
    bodyLimit = Number(args["body-limit"]);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 10000 ||
    !Number.isInteger(bodyLimit) ||
    bodyLimit < 1 ||
    bodyLimit > 8 * 1024 * 1024
  )
    throw new Error("Invalid request or body limit");
  for (const host of args.host)
    if (!/^(localhost|[a-z0-9]+(?:[.-][a-z0-9]+)*)$/.test(host))
      throw new Error(
        "Use lowercase hostnames without wildcards, ports, or paths",
      );
  for (const extension of args.extension)
    if (!/^[a-p]{32}$/.test(extension))
      throw new Error("Invalid Chrome extension ID");
  await mkdir(dirname(args.state), { recursive: true, mode: 0o700 });
  const lock = await open(`${args.state}.lock`, "wx", 0o600);
  await lock.writeFile(String(process.pid));
  await lock.close();
  let capture: Capture | undefined;
  let stopping = false,
    stateWritten = false;
  const clients = new Set<ServerResponse>();
  const token = randomBytes(32).toString("hex");
  const server = createServer((request, response) => {
    if (
      request.headers.authorization !== `Bearer ${token}` ||
      request.headers.origin
    ) {
      response.writeHead(403).end();
      return;
    }
    const url = new URL(request.url!, "http://127.0.0.1");
    const path = url.pathname;
    if (request.method === "GET" && path === "/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
      });
      response.write(": connected\n\n");
      clients.add(response);
      response.on("close", () => clients.delete(response));
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "GET" && path === "/wait") {
      const timeout = Number(url.searchParams.get("timeout"));
      const after = Number(url.searchParams.get("after") || 0);
      if (
        !Number.isInteger(timeout) ||
        timeout < 1 ||
        timeout > 120000 ||
        !Number.isInteger(after) ||
        after < 0
      ) {
        response.writeHead(400).end("{}");
        return;
      }
      const contains = url.searchParams.get("contains") || "";
      const method = url.searchParams.get("method");
      const status = url.searchParams.get("status");
      const matches = (item: Entry) =>
        Number(item.id) > after &&
        item.complete &&
        item.url.includes(contains) &&
        (!method || item.method === method) &&
        (!status || String(item.status) === status);
      const check = ({ id }: { id: string }) => {
        const entry = capture!.entries.get(id);
        if (entry && matches(entry)) {
          cleanup();
          response.end(JSON.stringify(entry));
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        return response.writeHead(408).end(
          JSON.stringify({
            error: "No matching completed request before deadline",
          }),
        );
      }, timeout);
      const cleanup = () => {
        clearTimeout(timer);
        capture!.off("request", check);
      };
      capture!.on("request", check);
      response.on("close", cleanup);
      const existing = [...capture!.entries.values()].find(matches);
      if (existing) check(existing);
    } else if (request.method === "GET" && path === "/targets") {
      void capture!
        .listTargets()
        .then((value) => response.end(JSON.stringify(value)))
        .catch((error) =>
          response.writeHead(502).end(JSON.stringify({ error: error.message })),
        );
    } else if (request.method === "GET" && path === "/media") {
      const duration = Number(url.searchParams.get("duration"));
      if (!Number.isInteger(duration) || duration < 1 || duration > 10000) {
        response.writeHead(400).end("{}");
        return;
      }
      void capture!
        .media(url.searchParams.get("target") || "", duration)
        .then((value) => response.end(JSON.stringify(value)))
        .catch((error) =>
          response.writeHead(400).end(JSON.stringify({ error: error.message })),
        );
    } else if (request.method === "GET" && path === "/export") {
      response.end(
        JSON.stringify({
          schemaVersion: 1,
          capturedAt: new Date().toISOString(),
          ...capture!.status(),
          entries: [...capture!.entries.values()],
        }),
      );
    } else if (request.method === "GET" && path === "/status")
      response.end(JSON.stringify({ pid: process.pid, ...capture!.status() }));
    else if (request.method === "GET" && path === "/requests")
      response.end(
        JSON.stringify(
          [...capture!.entries.values()].map(
            ({ id, method, url, status, target, complete, error }) => ({
              id,
              method,
              url,
              status,
              target,
              complete,
              error,
            }),
          ),
        ),
      );
    else if (
      request.method === "GET" &&
      path.startsWith("/requests/") &&
      capture!.entries.has(path.split("/")[2])
    )
      response.end(JSON.stringify(capture!.entries.get(path.split("/")[2])));
    else if (request.method === "POST" && path === "/stop") {
      response.end("{}");
      void shutdown();
    } else response.writeHead(404).end("{}");
  });
  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    for (const client of clients) client.end();
    server.close();
    server.closeAllConnections();
    await capture?.close();
    if (stateWritten) await unlink(args.state);
    await unlink(`${args.state}.lock`);
  }
  process.once("SIGTERM", () => {
    void shutdown().then(() => process.exit(0));
  });
  process.once("SIGINT", () => {
    void shutdown().then(() => process.exit(0));
  });
  try {
    const client = await CDP({ target: await endpoint(), local: true });
    capture = new Capture(client, {
      hosts: args.host,
      extensions: args.extension,
      targetIds: args.target,
      pauseWorkers: args["pause-workers"],
      sensitive: args.sensitive,
      limit,
      bodyLimit,
    });
    client.on("disconnect", () => {
      void shutdown();
    });
    await capture.start();
    capture.on("request", (data) => {
      const event = `data: ${JSON.stringify(data)}\n\n`;
      for (const client of clients) if (!client.write(event)) client.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as { port: number };
    const state: State = {
      pid: process.pid,
      url: `http://127.0.0.1:${address.port}`,
      token,
    };
    await writeFile(`${args.state}.tmp`, JSON.stringify(state), {
      mode: 0o600,
    });
    await rename(`${args.state}.tmp`, args.state);
    stateWritten = true;
    process.send?.({ ready: true });
    process.disconnect?.();
  } catch (error) {
    await shutdown();
    throw error;
  }
}

async function api(path: string, method = "GET"): Promise<Response> {
  const state = JSON.parse(await readFile(args.state, "utf8")) as State;
  const response = await fetch(`${state.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${state.token}` },
    signal:
      path === "/events"
        ? undefined
        : AbortSignal.timeout(
            path.startsWith("/wait?")
              ? Number(args.timeout) + 5000
              : path.startsWith("/media?")
                ? Number(args.duration) + 5000
                : 5000,
          ),
  });
  if (!response.ok)
    throw new Error(
      `Local API returned ${response.status}: ${await response.text()}`,
    );
  return response;
}

async function start(): Promise<void> {
  await mkdir(dirname(args.state), { recursive: true, mode: 0o700 });
  const log = await open(`${args.state}.log`, "w", 0o600);
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "serve", ...process.argv.slice(3)],
    { detached: true, stdio: ["ignore", log.fd, log.fd, "ipc"] },
  );
  await log.close();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Chrome connection timed out. Check ${args.state}.log`));
    }, 30000);
    child.once("message", () => {
      clearTimeout(timer);
      child.unref();
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", async () => {
      clearTimeout(timer);
      reject(new Error(await readFile(`${args.state}.log`, "utf8")));
    });
  });
  console.log(await (await api("/status")).text());
}

async function replay(): Promise<void> {
  if (!args.execute)
    throw new Error(
      "Replay sends a real request. Pass --execute to authorize it.",
    );
  const entry = (await (await api(`/requests/${id}`)).json()) as Entry;
  if (
    !entry.sensitive ||
    !entry.complete ||
    !entry.wireHeaders ||
    entry.redirected ||
    entry.error ||
    entry.method === "WEBSOCKET" ||
    entry.requestBody?.unavailable ||
    entry.requestBody?.truncated
  )
    throw new Error(
      "Replay requires a complete sensitive capture, wire headers, and an intact body without redirects.",
    );
  const headers = Object.fromEntries(
    Object.entries(entry.requestHeaders).filter(
      ([key]) =>
        !/^(:|host$|content-length$|connection$|transfer-encoding$|accept-encoding$)/i.test(
          key,
        ),
    ),
  );
  const response = await fetch(entry.url, {
    method: entry.method,
    headers,
    body: entry.requestBody?.data
      ? Buffer.from(entry.requestBody.data, "base64")
      : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  });
  const chunks: Buffer[] = [];
  let bytes = 0,
    truncated = false;
  if (response.body)
    for await (const chunk of response.body) {
      const remaining = 1048576 - bytes;
      chunks.push(Buffer.from(chunk).subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > 1048576) {
        truncated = true;
        break;
      }
    }
  console.log(
    JSON.stringify({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.concat(chunks).toString("base64"),
      encoding: "base64",
      truncated,
    }),
  );
}

async function main(): Promise<void> {
  if (args.version) {
    console.log(version);
    return;
  }
  if (args.help || command === "help") {
    console.log(help);
    return;
  }
  if (command === "serve") return serve();
  if (command === "start") return start();
  if (command === "replay") return replay();
  if (command === "wait") {
    const query = new URLSearchParams({
      contains: args.contains,
      after: args.after,
      timeout: args.timeout,
    });
    if (args.method) query.set("method", args.method);
    if (args.status) query.set("status", args.status);
    console.log(await (await api("/wait?" + query)).text());
    return;
  }
  if (command === "media") {
    if (args.target.length !== 1)
      throw new Error("media requires exactly one --target page ID");
    console.log(
      await (
        await api(
          "/media?" +
            new URLSearchParams({
              target: args.target[0],
              duration: args.duration,
            }),
        )
      ).text(),
    );
    return;
  }
  if (command === "export") {
    if (!args.output)
      throw new Error("export requires --output PRIVATE_FILE.json");
    const data = await (await api("/export")).text();
    await writeFile(args.output, data + "\n", { mode: 0o600, flag: "wx" });
    console.log(
      JSON.stringify({ path: args.output, bytes: Buffer.byteLength(data) }),
    );
    return;
  }
  if (command === "tail") {
    const response = await api("/events");
    let pending = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body!) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines)
        if (line.startsWith("data: ")) console.log(line.slice(6));
    }
    return;
  }
  const routes: Record<string, string> = {
    status: "/status",
    targets: "/targets",
    stop: "/stop",
    requests: "/requests",
    show: `/requests/${id}`,
  };
  if (!routes[command]) throw new Error(`Unknown command: ${command}`);
  const response = await api(
    routes[command],
    command === "stop" ? "POST" : "GET",
  );
  const data = await response.json();
  console.log(
    JSON.stringify(
      command === "requests"
        ? (data as Entry[]).filter((entry) => entry.url.includes(args.contains))
        : data,
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
