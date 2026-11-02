---
name: browser-network
description: Capture and inspect website or Chrome extension network traffic with browser-network CLI using an existing Chrome session. Use for request/response analysis, WebSocket capture, and explicitly requested replay.
---

# Browser Network CLI

Check `browser-network --help` for current flags. If missing, install the precompiled [release archive](https://github.com/fcakyon/browser-network-cli/releases/latest/download/fcakyon-browser-network-cli.tgz) with `npm install -g <archive-url>` (Node.js 22.12+). No browser download is needed.

## Connect and capture

1. Check `browser-network status`. Reuse a running capture only when its scope and data mode fit the task and its owner agrees. Repeated `start` calls reuse the same endpoint across state paths only when all capture settings match. Mismatches fail without another connection. Use the reported owner state and its settings. Another state path does not create an independent capture on that endpoint. Older daemons without this feature must be coordinated with their owner before replacement.
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

For startup evidence, use `--pause-workers` before loading the extension in a dedicated test browser. Use `media --target PAGE_ID` to inspect video without screen capture, which can disturb protected playback. Keep login, license and decoded-output checks separate.

Use the daemon for page CDP too. Never open your own WebSocket to `DevToolsActivePort` or a separate recorder to avoid a scope mismatch, since each browser connection can trigger another Allow prompt. With a sensitive daemon:

```sh
browser-network cdp Runtime.evaluate --target PAGE_ID \
  --params '{"expression":"document.title","returnByValue":true}'
```

The local equivalent is `POST /cdp` with `{method, params, targetId?}` and `Authorization: Bearer TOKEN` from the state file. Browser origins are denied. Results are unredacted and commands can change page state, so use only task-authorized commands and private output. Target selection uses the current capture scope. Without a target only `Browser.getVersion` is supported. Use `targets` for discovery and let the daemon own attachment and routing. CDP is a command API, not an event stream or a sandbox for arbitrary scripts.

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
