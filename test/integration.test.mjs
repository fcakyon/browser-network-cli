import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import CDP from "chrome-remote-interface";
import { WebSocketServer } from "ws";

const exec = promisify(execFile);
const executable = process.env.CHROME_PATH;
const cli = process.env.BROWSER_NETWORK_CLI || resolve("dist/cli.js");

async function until(check) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for observable capture state");
}

test(
  "real extension capture, replay, redaction, scoping and shared daemon lifecycle",
  {
    timeout: 90000,
    skip:
      !executable &&
      "Set CHROME_PATH to Chrome for Testing for the extension integration test",
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "browser-network-test-"));
    const extension = join(root, "extension");
    const state = join(root, "state.json");
    await mkdir(extension);
    const received = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received.push({
        url: req.url,
        authorization: req.headers.authorization,
        cookie: req.headers.cookie,
        body: Buffer.concat(chunks).toString(),
      });
      if (req.url === "/video") {
        res
          .writeHead(200, { "Content-Type": "text/html" })
          .end(
            '<video autoplay muted></video><script>const c=document.createElement("canvas");c.width=64;c.height=48;const ctx=c.getContext("2d");setInterval(()=>{ctx.fillStyle="rgb("+(Date.now()%255)+",0,0)";ctx.fillRect(0,0,64,48)},33);document.querySelector("video").srcObject=c.captureStream(30);</script>',
          );
        return;
      }
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/echo" }).end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": "response_cookie=fixture; HttpOnly; Path=/",
      });
      res.end(
        JSON.stringify({
          ok: true,
          received: received.at(-1),
          ...(req.url === "/large" ? { padding: "a".repeat(2048) } : {}),
        }),
      );
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const websocket = new WebSocketServer({ server });
    websocket.on("connection", (socket) =>
      socket.on("message", (data, binary) => socket.send(data, { binary })),
    );
    const base = `http://127.0.0.1:${server.address().port}`;
    await writeFile(
      join(extension, "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "Network integration fixture",
        version: "1.0",
        permissions: ["cookies"],
        host_permissions: ["http://127.0.0.1/*", "http://localhost/*"],
        background: { service_worker: "worker.js" },
      }),
    );
    await writeFile(
      join(extension, "worker.js"),
      `fetch(${JSON.stringify(base + "/startup")}); chrome.runtime.onMessage.addListener(()=>{}); self.probe = async (url) => {await chrome.cookies.set({url:${JSON.stringify(base)}, name:'fixture_cookie', value:'cookie-secret', httpOnly:true}); return await (await fetch(url, {method:'POST', credentials:'include', headers:{Authorization:'Bearer auth-secret', 'Content-Type':'application/json'}, body:'{"fixture":"extension-worker"}'})).text();};`,
    );
    const chrome = spawn(
      executable,
      [
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--use-mock-keychain",
        `--user-data-dir=${join(root, "profile")}`,
        "--remote-debugging-port=0",
        "--enable-unsafe-extension-debugging",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let cdp,
      daemon = false;
    t.after(async () => {
      if (daemon)
        await exec(process.execPath, [cli, "stop", "--state", state]).catch(
          () => {},
        );
      await cdp?.close();
      if (chrome.exitCode === null) {
        chrome.kill("SIGTERM");
        await once(chrome, "exit");
      }
      for (const client of websocket.clients) client.terminate();
      websocket.close();
      server.close();
      server.closeAllConnections();
      await rm(root, { recursive: true, force: true });
    });
    const socket = await new Promise((resolve, reject) => {
      let logs = "";
      const timer = setTimeout(
        () => reject(new Error("Chrome startup failed: " + logs)),
        15000,
      );
      chrome.stderr.on("data", (chunk) => {
        logs += chunk.toString();
        const match = logs.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      chrome.once("error", reject);
    });
    cdp = await CDP({ target: socket, local: true });
    const { id: extensionId } = await cdp.send("Extensions.loadUnpacked", {
      path: extension,
    });
    const worker = await until(async () =>
      (await cdp.Target.getTargets()).targetInfos.find(
        (info) =>
          info.type === "service_worker" &&
          info.url === `chrome-extension://${extensionId}/worker.js`,
      ),
    );
    const { sessionId } = await cdp.Target.attachToTarget({
      targetId: worker.targetId,
      flatten: true,
    });
    const call = async (...args) =>
      JSON.parse(
        (
          await exec(process.execPath, [cli, ...args, "--state", state], {
            maxBuffer: 4 * 1024 * 1024,
          })
        ).stdout,
      );
    const stopRecorder = async () => {
      await call("stop");
      daemon = false;
      await until(async () => {
        try {
          await stat(`${state}.lock`);
          return false;
        } catch (error) {
          return error.code === "ENOENT";
        }
      });
    };
    const probe = async (url) => {
      const result = await cdp.send(
        "Runtime.evaluate",
        {
          expression: `self.probe(${JSON.stringify(url)})`,
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
      );
      assert.equal(
        result.exceptionDetails,
        undefined,
        JSON.stringify(result.exceptionDetails),
      );
    };
    const completed = async (url) =>
      until(async () => {
        const rows = await call("requests");
        const row = rows.findLast((row) => row.url === url && row.complete);
        return row && (await call("show", row.id));
      });

    const started = await call(
      "start",
      "--cdp",
      socket,
      "--host",
      "127.0.0.1",
      "--extension",
      extensionId,
      "--sensitive",
    );
    daemon = true;
    assert.ok(
      started.targets.some((target) => target.type === "service_worker"),
    );
    assert.equal((await stat(state)).mode & 0o777, 0o600);
    const connection = JSON.parse(await readFile(state, "utf8"));
    assert.equal((await fetch(`${connection.url}/requests`)).status, 403);
    assert.equal(
      (
        await fetch(`${connection.url}/requests`, {
          headers: {
            Authorization: `Bearer ${connection.token}`,
            Origin: "https://unrelated.test",
          },
        })
      ).status,
      403,
    );
    const streamAbort = new AbortController();
    const stream = await fetch(`${connection.url}/events`, {
      headers: { Authorization: `Bearer ${connection.token}` },
      signal: streamAbort.signal,
    });
    const reader = stream.body.getReader();
    await reader.read();
    await probe(`${base}/echo?token=query-secret`);
    const event = await reader.read();
    assert.match(new TextDecoder().decode(event.value), /data: /);
    streamAbort.abort();
    const captured = await completed(`${base}/echo?token=query-secret`);
    assert.equal(captured.target.type, "service_worker");
    const headers = Object.fromEntries(
      Object.entries(captured.requestHeaders).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
    assert.equal(headers.authorization, "Bearer auth-secret");
    assert.match(headers.cookie, /fixture_cookie=cookie-secret/);
    assert.equal(
      Buffer.from(captured.requestBody.data, "base64").toString(),
      '{"fixture":"extension-worker"}',
    );
    assert.equal(
      JSON.parse(Buffer.from(captured.responseBody.data, "base64").toString())
        .ok,
      true,
    );
    assert.ok(
      Object.entries(captured.responseHeaders).some(
        ([key, value]) =>
          key.toLowerCase() === "set-cookie" &&
          value.includes("response_cookie"),
      ),
    );
    await assert.rejects(call("replay", captured.id), /--execute/);
    const count = received.length;
    const replay = await call("replay", captured.id, "--execute");
    assert.equal(replay.status, 200);
    assert.equal(received.length, count + 1);
    assert.equal(received.at(-1).authorization, headers.authorization);
    assert.equal(received.at(-1).cookie, headers.cookie);
    assert.equal(received.at(-1).body, '{"fixture":"extension-worker"}');

    const wsUrl = base.replace("http:", "ws:") + "/socket";
    const wsStarted = Date.now();
    const wsResult = await cdp.send(
      "Runtime.evaluate",
      {
        expression: `new Promise((resolve,reject)=>{const ws=new WebSocket(${JSON.stringify(wsUrl)});ws.binaryType='arraybuffer';let i=0;ws.onopen=()=>ws.send('worker-frame-0');ws.onmessage=e=>{if(++i<51)ws.send('worker-frame-'+i);else if(i===51)ws.send(new Uint8Array([1,2,3,4]));else{ws.close();resolve(new Uint8Array(e.data).join())}};ws.onerror=()=>reject(new Error('WebSocket failed'))})`,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );
    assert.equal(wsResult.result.value, "1,2,3,4");
    const { status, frames, droppedFrames, startedAt } = await completed(wsUrl);
    assert.ok(
      Date.parse(startedAt) >= wsStarted && Date.parse(startedAt) <= Date.now(),
    );
    assert.equal(status, 101);
    assert.equal(droppedFrames, 4);
    assert.deepEqual(
      frames.map((frame) => frame.direction),
      Array.from({ length: 100 }, (_, i) => (i % 2 ? "received" : "sent")),
    );
    assert.equal(
      Buffer.from(frames[1].body.data, "base64").toString(),
      "worker-frame-2",
    );
    assert.deepEqual(
      frames
        .slice(-2)
        .map(({ opcode, bytes, body }) => [opcode, bytes, body.data]),
      Array(2).fill([2, 4, "AQIDBA=="]),
    );
    await assert.rejects(
      call("start", "--cdp", socket, "--host", "127.0.0.1"),
      /EEXIST/,
    );
    assert.equal((await call("status")).pid, started.pid);
    const anotherClient = await call("requests");
    assert.ok(anotherClient.some((row) => row.id === captured.id));
    await probe(`${base.replace("127.0.0.1", "localhost")}/outside`);
    assert.ok(
      !(await call("requests")).some((row) => row.url.includes("/outside")),
    );
    await probe(`${base}/redirect`);
    const redirect = await completed(`${base}/echo`);
    await assert.rejects(
      call("replay", redirect.id, "--execute"),
      /without redirects/,
    );
    await stopRecorder();
    assert.equal(
      (await cdp.Browser.getVersion()).product.startsWith("Chrome"),
      true,
    );

    await call(
      "start",
      "--cdp",
      socket,
      "--host",
      "127.0.0.1",
      "--extension",
      extensionId,
      "--limit",
      "2",
    );
    daemon = true;
    await probe(`${base}/echo?token=query-secret`);
    const redacted = await until(async () => {
      const rows = await call("requests");
      return rows[0]?.complete && (await call("show", rows[0].id));
    });
    const text = JSON.stringify(redacted);
    for (const secret of [
      "cookie-secret",
      "auth-secret",
      "query-secret",
      "response_cookie",
    ])
      assert.ok(!text.includes(secret), secret);
    assert.equal(redacted.requestBody, undefined);
    assert.equal(redacted.responseBody, undefined);
    await assert.rejects(
      call("replay", redacted.id, "--execute"),
      /sensitive capture/,
    );
    await probe(`${base}/second`);
    await probe(`${base}/third`);
    await until(async () => (await call("requests")).length === 2);
    assert.ok(!(await call("requests")).some((row) => row.id === redacted.id));
    const snapshot = await call("status");
    assert.ok(snapshot.evictedRequests > 0);
    const exported = join(root, "capture.json");
    await call("export", "--output", exported);
    assert.equal((await stat(exported)).mode & 0o777, 0o600);
    const report = JSON.parse(await readFile(exported, "utf8"));
    assert.equal(report.entries.length, 2);
    assert.ok(!JSON.stringify(report).includes("cookie-secret"));
    await assert.rejects(call("export", "--output", exported), /EEXIST/);
    await assert.rejects(
      call("wait", "--contains", "/missing", "--timeout", "100"),
      /408/,
    );
    const waiting = call(
      "wait",
      "--contains",
      "/fresh",
      "--method",
      "POST",
      "--status",
      "200",
      "--after",
      snapshot.lastRequestId,
    );
    await probe(base + "/fresh");
    assert.equal((await waiting).url, base + "/fresh");
    await stopRecorder();

    await call(
      "start",
      "--cdp",
      socket,
      "--host",
      "127.0.0.1",
      "--extension",
      extensionId,
      "--pause-workers",
    );
    daemon = true;
    for (let run = 0; run < 2; run++) {
      const after = (await call("status")).lastRequestId;
      await cdp.send("Extensions.uninstall", { id: extensionId });
      await cdp.send("Extensions.loadUnpacked", { path: extension });
      const startup = await call(
        "wait",
        "--contains",
        "/startup",
        "--after",
        after,
        "--status",
        "200",
      );
      assert.equal(
        startup.target.url,
        "chrome-extension://" + extensionId + "/worker.js",
      );
    }
    const other = join(root, "other-extension");
    await mkdir(other);
    await writeFile(
      join(other, "manifest.json"),
      await readFile(join(extension, "manifest.json")),
    );
    await writeFile(
      join(other, "worker.js"),
      "fetch(" + JSON.stringify(base + "/unselected-startup") + ")",
    );
    await cdp.send("Extensions.loadUnpacked", { path: other });
    await until(() =>
      received.some((item) => item.url === "/unselected-startup"),
    );
    assert.ok(
      !(await call("requests")).some((row) =>
        row.url.endsWith("/unselected-startup"),
      ),
    );

    const { targetId } = await cdp.Target.createTarget({
      url: base + "/video",
      background: true,
    });
    await until(async () =>
      (await call("targets")).some(
        (target) => target.id === targetId && target.attached,
      ),
    );
    const { sessionId: pageSession } = await cdp.Target.attachToTarget({
      targetId,
      flatten: true,
    });
    await until(
      async () =>
        (
          await cdp.send(
            "Runtime.evaluate",
            {
              expression: 'document.querySelector("video")?.videoWidth',
              returnByValue: true,
            },
            pageSession,
          )
        ).result.value === 64,
    );
    const play = await cdp.send(
      "Runtime.evaluate",
      {
        expression: 'document.querySelector("video").play()',
        awaitPromise: true,
        userGesture: true,
      },
      pageSession,
    );
    assert.equal(play.exceptionDetails, undefined);
    const media = await call(
      "media",
      "--target",
      targetId,
      "--duration",
      "1500",
    );
    assert.equal(media.after[0].width, 64);
    assert.equal(media.after[0].height, 48);
    assert.ok(media.after[0].frames > media.before[0].frames);
    assert.ok(media.after[0].time > media.before[0].time);
    assert.equal(media.after[0].mediaKeysAttached, false);
    await cdp.send(
      "Runtime.evaluate",
      { expression: 'document.querySelector("video").pause()' },
      pageSession,
    );
    const paused = await call(
      "media",
      "--target",
      targetId,
      "--duration",
      "100",
    );
    assert.equal(paused.after[0].paused, true);
    assert.equal(paused.before[0].time, paused.after[0].time);
    await stopRecorder();
    await call(
      "start",
      "--cdp",
      socket,
      "--host",
      "127.0.0.1",
      "--target",
      targetId,
      "--pause-workers",
    );
    daemon = true;
    assert.deepEqual(
      (await call("targets")).map((target) => target.id),
      [targetId],
    );
    await cdp.send(
      "Runtime.evaluate",
      { expression: 'fetch("/selected")', awaitPromise: true },
      pageSession,
    );
    assert.equal(
      (await call("wait", "--contains", "/selected")).target.id,
      targetId,
    );
    const { targetId: excluded } = await cdp.Target.createTarget({
      url: base + "/excluded",
      background: true,
    });
    await until(() => received.some((item) => item.url === "/excluded"));
    assert.ok(
      !(await call("requests")).some((row) => row.url.endsWith("/excluded")),
    );
    await assert.rejects(call("media", "--target", excluded), /attached page/);
    await cdp.Target.closeTarget({ targetId: excluded });
    await cdp.Target.closeTarget({ targetId });
    const exited = once(chrome, "exit");
    await cdp.Browser.close();
    await exited;
    await until(async () => {
      try {
        await stat(state + ".lock");
        return false;
      } catch (e) {
        return e.code === "ENOENT";
      }
    });
    await assert.rejects(stat(state), { code: "ENOENT" });
    daemon = false;
  },
);

test("CLI help and unknown command are usable without a browser", async () => {
  assert.match(
    (await exec(process.execPath, [cli, "--help"])).stdout,
    /extension background workers/,
  );
  await assert.rejects(
    exec(process.execPath, [cli, "unknown-command"]),
    /Unknown command/,
  );
});
