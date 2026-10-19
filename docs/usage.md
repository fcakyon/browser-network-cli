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

Start capture once and query it from any terminal, Claude session, or Codex session on the same machine. The daemon owns one persistent Chrome connection. Commands such as status, requests, show, and tail query its local API without opening another Chrome connection. Chrome may request approval again after the daemon or browser restarts. Data stays in memory and is cleared on `stop`. Chrome remains open.

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

## Comparison

| Tool | Network debugging workflow |
|---|---|
| **Browser&nbsp;Network&nbsp;CLI** | **Ready-made extension-worker capture, opt-in cookies/auth/bodies, live queries, and replay by ID. One CLI install.** |
| agent-browser | Browser automation with HAR export. Existing Chrome, cookies, and bodies are supported. Extension-worker coverage is unverified here. |
| Chrome DevTools | Page-oriented network tools through MCP or an experimental CLI. |
| REA | Records metadata and body shapes. Strips cookies and authorization, so those captures cannot reproduce authenticated requests. |
| browser-harness-js | Supplies CDP primitives. You build the retained request store and replay workflow. |
| Claude / ChatGPT in Chrome | Network inspection inside their assistant integrations. Requires the corresponding extension and assistant setup. |

## Comparison sources

Reviewed October 19, 2026. These are documented capabilities unless marked as tested.

- [agent-browser network](https://github.com/vercel-labs/agent-browser/blob/main/docs/content/docs/network.mdx) and [CDP connection](https://github.com/vercel-labs/agent-browser/blob/main/docs/content/docs/cdp-mode.mdx): existing Chrome attachment and HAR capture with cookies and bodies.
- [Chrome DevTools network tools](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md#network) and [CLI](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/cli.md): page request inspection includes cookies and bodies. The CLI is experimental.
- [REA observation](https://github.com/morluto/rea/blob/main/docs/browser-observation.md): strips credentials and retains body shapes. Worker observation is scoped to the page.
- [browser-harness-js network primitives](https://github.com/browser-use/browser-harness-js/blob/main/interaction-skills/network-requests.md): raw CDP supports capture. Our probe captured extension credentials and bodies through those primitives, but a retained request store and replay-by-ID need application code.
- [Claude in Chrome](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome): documents network inspection. Raw credential export and extension-worker recording were not verified here.
- [ChatGPT browser developer mode](https://learn.chatgpt.com/docs/browser#developer-mode): enables full CDP access with site approval. Extension-worker recording was not verified here.

Our integration test checks extension-worker HTTP credentials, bodies, WebSocket frames, and replay after attachment. It does not prove capture of every worker startup request. See [coverage and limits](#coverage-and-limits).
