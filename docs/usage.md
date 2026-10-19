# Usage

GitHub installation builds the CLI automatically using temporary development dependencies. For a precompiled package, install a `.tgz` from [Releases](https://github.com/fcakyon/browser-network-cli/releases). npmjs publication is pending.

## Connect to Chrome

Enable remote debugging at `chrome://inspect/#remote-debugging` and approve Chrome's connection prompt if shown.

`--profile PATH` reads `DevToolsActivePort` from a profile root. On macOS, the usual root is `$HOME/Library/Application Support/Google/Chrome`. If file access is blocked, use `--cdp` with a browser WebSocket URL. An HTTP debugging endpoint works when Chrome exposes `/json/version`.

```sh
browser-network start --cdp ws://127.0.0.1:9222/devtools/browser/ID \
  --host example.com --host api.example.net \
  --extension EXTENSION_ID --sensitive
```

Find extension IDs in `chrome://extensions`. Repeat `--host` and `--extension` as needed. Each host includes its subdomains and limits request destinations, including extension requests. Add API/CDN hosts explicitly.

Capture uses existing Chrome sessions. It does not install Chrome, copy your profile, or change browser security settings.

## Capture modes

| | Default | `--sensitive` |
|---|---|---|
| URLs | Query values hidden | Full URLs |
| Headers | Small allowlist | Full headers, including cookies and authorization |
| Request and response bodies | Omitted | Captured up to the size limit |
| WebSocket frames | Direction and size | Payload included |
| Replay | Disabled | Requires `--execute` |

URL paths remain visible in both modes and may contain private data. Sensitive captures can contain account credentials. Scope them to sites you intend to inspect.

```sh
browser-network requests --contains /api/
browser-network show 12
browser-network replay 12 --execute
```

Replay makes a **real request** with captured credentials. It does not follow redirects. Transport headers such as Host and Content-Length are regenerated. Expired signatures and browser-dependent requests may fail. Redirect chains, multipart uploads, failed requests, incomplete wire headers, and WebSockets are not replayed. Replay response output is limited to 1 MiB.

## Coverage and limits

- Capture covers selected Chrome targets, including extension service workers. It does not capture all traffic on your computer or inbound server traffic.
- Capture starts after attachment. A new worker's earliest requests can be missed. Content-script requests may appear under the page target.
- Header events arriving before a permitted request URL is known are discarded. Such requests may lack full wire headers and cannot be replayed.
- Chrome may discard response bodies, serve cached responses without all events, or omit upload data. Missing bodies are reported explicitly.
- No media decryption is performed.

Default limits: **500 requests**, **256 KiB per body**, and **64 MiB of serialized capture data**. WebSockets retain their latest 100 frames. Old requests are evicted when limits are reached. Use `--limit` and `--body-limit` to adjust the first two limits.

## Share with agents

Start capture once and query it from any terminal, Claude session, or Codex session on the same machine. Data stays in memory and is cleared on `stop`. Chrome remains open.

`--state PATH` selects a capture session. Without it, sessions use a per-user state file under the operating system's temporary directory. `browser-network --help` prints the path.

The state file has owner-only permissions and contains the localhost API URL and bearer token. Treat that token as access to the current capture. API routes:

| Method | Path | Result |
|---|---|---|
| GET | `/status` | Scope, attached targets, and errors |
| GET | `/requests` | Request summaries |
| GET | `/requests/ID` | Full retained request |
| GET | `/events` | Live summaries through SSE |
| POST | `/stop` | Stop capture and clear memory |

Send `Authorization: Bearer TOKEN`. Requests with a browser Origin header are denied. There is no public tunnel or remote bind option.

If the process is forcibly killed, a stale state or lock file may remain. Check the recorded PID before removing those files. Do not remove another running capture's lock.

## Development

```sh
npm ci
npm run build
CHROME_PATH="/path/to/Chrome for Testing" npm test
```

The integration test uses an isolated Manifest V3 extension and a local server with synthetic credentials. It checks worker capture, Cookie/Authorization and body retention, replay, WebSockets, redaction, host scope, API authentication, eviction, and daemon lifecycle. It never uses your browsing profile.

Without `CHROME_PATH`, the browser test is skipped and the CLI smoke test still runs. To test an installed package with the same suite, set `BROWSER_NETWORK_CLI` to its `dist/cli.js` path.

The only runtime dependency is `chrome-remote-interface`. TypeScript, type declarations, formatting, and the WebSocket fixture are development-only. Node types follow the supported Node 22 API surface.
