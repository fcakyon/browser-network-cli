<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo-light.svg" alt="Browser Network CLI capture mark" width="64" height="64" />
  </picture>
</p>
<h1 align="center">Browser Network CLI</h1>

Record and inspect network requests from websites and Chrome extensions, then replay them from your terminal. Use your existing Chrome login from Claude, Codex, or a shell.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/flow-dark.svg" />
  <img src="assets/flow-light.svg" alt="Website tabs and extension workers → Chrome DevTools → browser-network → Claude, Codex, or shell" width="980" />
</picture>

## Compare

A network recorder for any shell-enabled agent. No MCP setup, companion extension, or model subscription required.

| Tool | Interface | Existing Chrome | Network detail | Extension background traffic |
|---|---|---|---|---|
| <picture><source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg"><img src="assets/logo-light.svg" width="24" height="24" alt=""></picture> **Browser Network CLI** | **CLI + local API** | **Yes** | **Cookies, auth, bodies, WebSocket frames + replay** (opt-in) | **Tested with a real MV3 worker** |
| agent-browser | CLI | Yes, via CDP | HAR with cookies and bodies | Not verified here |
| Chrome DevTools | MCP + experimental CLI | Yes | Page requests, cookies and bodies | Network tools target pages |
| REA | CLI + MCP | Yes | Metadata and body shapes, credentials removed | Page-scoped worker metadata |
| browser-harness-js | CLI + Bun | Yes | Raw CDP primitives | Requires a custom collector |
| Claude in Chrome | Extension + Claude | Yes | Network inspection | Not verified here |
| ChatGPT in Chrome | Extension + desktop app | Yes | Network inspection in developer mode | Not verified here |

“Not verified” does not mean unsupported. Other tools also automate browser interactions. [Sources and coverage](docs/usage.md#comparison-sources).

## Install

Requires **Node.js 22.12+** and Chrome. Install the precompiled release in one command:

```sh
npm install -g https://github.com/fcakyon/browser-network-cli/releases/latest/download/fcakyon-browser-network-cli.tgz
```

## Use

Enable remote debugging at `chrome://inspect/#remote-debugging`. On macOS:

```sh
browser-network start \
  --profile "$HOME/Library/Application Support/Google/Chrome" \
  --host example.com

browser-network tail        # Follow live requests
browser-network requests    # Find a request ID
browser-network show 12     # Inspect its details
browser-network stop        # Leave Chrome running
```

Add `--extension ID` to capture an extension's background requests. Add `--sensitive` to retain cookies, authorization headers, and bodies. Replay requires `browser-network replay ID --execute` and sends a real request.

Capture is scoped to the hosts you select. Data stays in memory until stopped.

[Usage and limitations](docs/usage.md) · [Releases](https://github.com/fcakyon/browser-network-cli/releases) · [MIT license](LICENSE)

Built on [chrome-remote-interface](https://github.com/cyrus-and/chrome-remote-interface).
