---
name: browser-network
description: Capture and inspect website or Chrome extension network traffic with browser-network CLI using an existing Chrome session. Use for request/response analysis, WebSocket capture, and explicitly requested replay.
---

# Browser Network CLI

Check `browser-network --help` for current flags. If missing, install the precompiled [release archive](https://github.com/fcakyon/browser-network-cli/releases/latest/download/fcakyon-browser-network-cli.tgz) with `npm install -g <archive-url>` (Node.js 22.12+). No browser download is needed.

## Connect and capture

1. Check `browser-network status`. Reuse a running capture only when its scope and data mode fit the task and its owner agrees. For an independent capture, use a unique `--state PATH` on every command.
2. In existing Chrome 144+, enable Remote Debugging at `chrome://inspect/#remote-debugging`. The user approves Chrome's connection prompt if shown. Do not restart Chrome or copy its profile to attach.
3. Start with the profile root containing `DevToolsActivePort`, not its `Default` or `Profile 1` subdirectory. On macOS:

```sh
browser-network start \
  --profile "$HOME/Library/Application Support/Google/Chrome" \
  --host example.com --host api.example.net
browser-network status
```

`--profile` only reads the endpoint file. It does not launch Chrome or enable debugging. Alternatively use `--cdp ws://127.0.0.1:PORT/devtools/browser/ID` with Chrome's actual endpoint. Do not guess the port or browser ID. `--cdp http://127.0.0.1:PORT` works only when HTTP discovery is available.

4. Use `browser-network targets` and status to verify the intended hosts, exact extension/target IDs and attachment status. Reproduce the browser action after attachment, then inspect requests:

```sh
browser-network requests --contains /api/
browser-network show REQUEST_ID
browser-network wait --contains /api/ --method POST --status 200 --after LAST_REQUEST_ID --timeout 10000
```

For bodies, cookies, authorization values or WebSocket payloads, choose `--sensitive` when starting capture. Default mode omits them. Repeat `--host` for separate API/CDN hosts. Each host includes its subdomains. Add `--extension ID` for extension background workers. Their destinations must also match the host scope.

For startup failures, use `--pause-workers` only in a dedicated test browser, before loading/restarting the extension. This briefly pauses new service workers until observation is ready. It cannot recover earlier requests. Keep provider sessions, permission failures and playback outcomes separate. Use `media --target PAGE_ID` for read-only frame/time/dimension evidence before considering screenshots, since screen capture can disturb protected playback.

5. Save needed evidence with `export --output /private/path/capture.json` before stopping. Exports preserve the selected sensitive/redacted mode, refuse overwrite and include evicted-request counts. Sensitive `show` output belongs in an ignored private directory with `umask 077`, not shared terminal output or tracked files. Inspect field names, byte counts and redacted summaries instead of secrets. Use `browser-network stop` only for a capture you own. It clears in-memory evidence and leaves Chrome running. Close only temporary tabs and servers created for the task.

## Diagnose failures

- Failed `/json/version` is not proof debugging is off. Chrome's consent-based mode can expose the browser WebSocket without HTTP discovery. Try `--profile` or the actual WebSocket URL. Raw `chrome-remote-interface` clients need `local: true` to avoid fetching the protocol through that unavailable HTTP endpoint. The CLI already does this.
- Missing `DevToolsActivePort`: confirm the profile root and Remote Debugging toggle. A stale endpoint or refused connection requires checking Chrome's current debugging state, not changing credentials or restarting unrelated sessions.
- No requests: check scope and attached targets, then repeat the action after capture starts. Normal attachment can miss worker startup requests. Only the explicit service-worker startup mode changes that ordering. A valid connection with zero targets is not capture proof.
- Missing bodies or frames: check sensitive mode, Chrome's body availability and [retention limits](https://github.com/fcakyon/browser-network-cli/blob/main/docs/usage.md#coverage-and-limits). `droppedFrames` indicates frame loss. Export needed evidence promptly.
- Missing state file from `status` means no recorder at that path, not an incompatible browser. Check owner and PID before removing stale state or locks.

Replay is separate: `browser-network replay REQUEST_ID --execute` sends a real request with captured credentials. Use it only when that request is authorized, not as a connectivity test.

## Verification scope

On 2026-10-24, installed CLI 0.1.1 captured a localhost page fetch from Chrome 155.0.8059.86 through both isolated-profile HTTP discovery and the existing signed-in profile's WebSocket endpoint. The latter used `--profile`, without restarting Chrome. Temporary tabs, recorder and server were removed afterward. This check did not retest extension-worker capture, sensitive bodies or replay.

See [usage and limits](https://github.com/fcakyon/browser-network-cli/blob/main/docs/usage.md) and [Chrome's existing-session setup](https://developer.chrome.com/docs/devtools/agents/get-started/configuration#connect-to-an-existing-browser-session).
