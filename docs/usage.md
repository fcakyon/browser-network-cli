# Usage

The [release archive](https://github.com/fcakyon/browser-network-cli/releases/latest/download/fcakyon-browser-network-cli.tgz) contains compiled JavaScript. Installation requires no Git authentication, TypeScript build, or browser download. npmjs publication is pending.

## Connect to Chrome

Enable remote debugging at `chrome://inspect/#remote-debugging` and approve Chrome's connection prompt if shown.

`--profile PATH` reads `DevToolsActivePort` from a profile root. On macOS, the usual root is `$HOME/Library/Application Support/Google/Chrome`. If file access is blocked, use `--cdp` with a browser WebSocket URL. An HTTP debugging endpoint works when Chrome exposes `/json/version`.

```sh
browser-network start --cdp ws://127.0.0.1:9222/devtools/browser/ID \
  --host example.com --host api.example.net \
  --extension EXTENSION_ID --sensitive
```

Use `browser-network targets` to list targets within the capture scope and their attachment status. Add `--target ID` when starting a recorder to restrict it to a specific target. Find extension IDs in `chrome://extensions`. Repeat `--host` and `--extension` as needed. Each host includes its subdomains and limits request destinations, including extension requests. Add API/CDN hosts explicitly.

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
- Normal capture starts after attachment. A new worker's earliest requests can be missed. Content-script requests may appear under the page target.
- Header events arriving before a permitted request URL is known are discarded. Such requests may lack full wire headers and cannot be replayed.
- Chrome may discard response bodies, serve cached responses without all events, or omit upload data. Missing bodies are reported explicitly.
- No media decryption is performed.

Default limits: **500 requests**, **256 KiB per body**, and **64 MiB of serialized capture data**. WebSockets retain their latest 100 frames, and `droppedFrames` counts older ones. Old requests are evicted when limits are reached. Use `--limit` and `--body-limit` to adjust the first two limits.

## Scripted checks

Use completed requests as bounded checkpoints instead of sleeping or repeatedly listing traffic:

```sh
browser-network status  # lastRequestId is a checkpoint for the next action
browser-network wait --contains /connect --method POST --status 200 --after 12 --timeout 10000
browser-network export --output /private/path/capture.json
browser-network media --target PAGE_ID --duration 1000
```

Wait matches retained completed requests newer than `--after`, including requests completed before the wait command starts. Timeout fails with HTTP 408. A failed network request can match when no status filter is given; inspect its `error`. Each recorder has its own ID sequence. Exports retain the capture's redaction mode, loss counters and bounded entries, use owner-only permissions, and refuse to overwrite a file. Sensitive captures produce sensitive exports. Old evicted requests cannot be recovered.

The media command reads video dimensions, timestamps, frames, dropped frames, errors and whether media keys are attached, twice. It does not play, seek, capture the screen or decrypt video. Compare the samples to verify advancement; attached keys alone do not prove licensed playback. Choose an iframe target when the video lives there. Replaced video elements and navigation require a fresh observation.

For immediate service-worker requests, start with `--pause-workers` in a dedicated test browser **before** loading or restarting the extension. Keep `--extension` and destination hosts explicit. New service workers pause until network observation is enabled, then resume. Out-of-scope service workers are resumed and detached immediately. This option briefly affects every new service worker in that browser, so do not use it on a shared personal browser. It cannot recover requests from workers already running, and does not promise startup coverage for dedicated/shared workers. Stopping the recorder removes its auto-attachment.

Network evidence does not prove provider login, title access, a license or decoded HD output. Verify those separately. For protected-media debugging, start with network and media metadata: screen-capture software can itself trigger output-protection failures. Never stop shared capture services or change browser identity as a generic workaround.

## Share with agents

Start capture once and query it from any terminal, Claude session, or Codex session on the same machine. The daemon owns one persistent Chrome connection. Commands such as status, requests, show, and tail query its local API without opening another Chrome connection. Chrome may request approval again after the daemon or browser restarts. Data stays in memory and is cleared on `stop`. Chrome remains open.

`--state PATH` selects a capture session. Without it, sessions use a per-user state file under the operating system's temporary directory. `browser-network --help` prints the path.

The state file has owner-only permissions and contains the localhost API URL and bearer token. Treat that token as access to the current capture. API routes:

| Method | Path | Result |
|---|---|---|
| GET | `/status` | Scope, attached targets, and errors |
| GET | `/requests` | Request summaries |
| GET | `/requests/ID` | Full retained request |
| GET | `/events` | Live summaries through SSE |
| GET | `/targets` | Scoped targets and attachment status |
| GET | `/wait?contains=TEXT&after=ID&timeout=MS` | Completed match, optional method/status filters |
| GET | `/export` | Capture snapshot with loss metadata |
| GET | `/media?target=ID&duration=MS` | Read-only video samples, 1–10,000 ms apart |
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

## Comparison

| Feature | Browser Network CLI | agent-browser | Chrome DevTools | REA | browser-harness-js | Claude / ChatGPT in Chrome |
|---|---|---|---|---|---|---|
| Standalone CLI | ✓ | ✓ | Preview | ✓ | ✓ | Extension |
| Cookies / auth | ✓ | ✓ | ✓ | Removed | DIY | - |
| Extension workers | ✓ | - | - | Page-scoped | DIY | - |
| Replay by request ID | ✓ | - | - | - | DIY | - |

✓ Supported, DIY requires custom code, - unverified here. Unknown does not mean unsupported. Chrome DevTools CLI is experimental. Harness exposes credentials and workers through raw CDP, but its request store and replay workflow require custom code. REA's worker observation is page-scoped. The assistant column refers to their Chrome integrations, not their separate coding CLIs.

All listed tools can connect to existing Chrome. Our tool requires Chrome debugging access too. Our extension test covers capture after attachment.

## Comparison sources

Reviewed October 19, 2026. These are documented capabilities unless marked as tested.

- [agent-browser network](https://github.com/vercel-labs/agent-browser/blob/main/docs/content/docs/network.mdx) and [CDP connection](https://github.com/vercel-labs/agent-browser/blob/main/docs/content/docs/cdp-mode.mdx): existing Chrome attachment and HAR capture with cookies and bodies.
- [Chrome DevTools network tools](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md#network) and [CLI](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/cli.md): page request inspection includes cookies and bodies. The CLI is experimental.
- [REA observation](https://github.com/morluto/rea/blob/main/docs/browser-observation.md): strips credentials and retains body shapes. Worker observation is scoped to the page.
- [browser-harness-js network primitives](https://github.com/browser-use/browser-harness-js/blob/main/interaction-skills/network-requests.md): raw CDP supports capture. Our probe captured extension credentials and bodies through those primitives, but a retained request store and replay-by-ID need application code.
- [Claude in Chrome](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome): documents network inspection. Raw credential export and extension-worker recording were not verified here.
- [ChatGPT browser developer mode](https://learn.chatgpt.com/docs/browser#developer-mode): enables full CDP access with site approval. Extension-worker recording was not verified here.

Our integration test checks extension-worker HTTP credentials, bodies, WebSocket frames, and replay after attachment. It does not prove capture of every worker startup request. See [coverage and limits](#coverage-and-limits).
