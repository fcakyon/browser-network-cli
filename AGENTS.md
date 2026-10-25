# Browser Network CLI

## Purpose

Give any shell-enabled coding agent a reusable view of website and Chrome extension network traffic. Attach to existing Chrome sessions, inspect captured requests, and explicitly replay them. Keep the CLI independent of any model, MCP client, or companion extension.

## Scope and implementation

- Reuse chrome-remote-interface. Keep runtime dependencies small. This is a Chrome recorder, not an operating-system proxy or video decryptor.
- Extension service-worker capture is a core requirement. Verify it with a real extension, not only page traffic or mocked protocol events.
- Cookies, authorization, bodies, and frame payloads require opt-in sensitive capture. Never commit real captures, credentials, browser profiles, or state files.
- Replay sends real requests and requires an explicit execute flag. Preserve host and extension scope.
- Prefer deleting duplication over adding wrappers or frameworks. Keep tests focused on observable failures and actual CLI behavior.
- Keep dependencies current within the supported Node API surface. Do not move Node type definitions beyond the minimum runtime just to chase a version number.

## Evidence and documentation

- A failed local connection is not evidence that another tool lacks the feature. Verify setup and primary documentation before making comparisons.
- Separate tested behavior, documented capabilities, and unknown coverage. Never turn “not verified” into “unsupported”.
- Keep Markdown concise and free of semicolons. Put limits in docs/usage.md and describe concrete behavior.
- Keep visuals simple and readable in both GitHub themes. Avoid oversized banners, decorative gradients, and low-contrast arrows.

## Verification and releases

- Run the integration suite with CHROME_PATH pointing to Chrome for Testing. A skipped browser test does not verify a release. Test the installed archive through BROWSER_NETWORK_CLI too.
- Use synthetic credentials and isolated test profiles with `--use-mock-keychain`, so cookie setup never requests personal Chromium Safe Storage access. Load the fixture with `Extensions.loadUnpacked` and select its exact worker URL from the returned extension ID. Stop only processes and tabs created for the test.
- Follow [.agents/skills/release/SKILL.md](.agents/skills/release/SKILL.md) when preparing a release or editing release notes. Keep one-command installation working.
- Review and simplify changes before committing. Use short conventional commit subjects. Publish to npm only when authorized.
