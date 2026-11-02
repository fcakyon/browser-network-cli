---
name: release
description: Prepare Browser Network CLI releases or revise their notes, including installed-package checks, commit ranges, contributors, and downloadable assets.
---

# Release Browser Network CLI

Use gh for GitHub operations. Keep release notes short and useful to someone installing the CLI. Updating notes alone does not require a version bump or rebuilt assets.

## Prepare a version

1. Inspect the working tree, package versions in history, tags, and GitHub releases. Identify missing releases, the previous version tag, and each intended commit. Preserve unrelated changes.
2. Review every commit in the previous-tag-to-new-tag range. For the first release, review history through its tag. Use git log for subjects and authors, and gh commit metadata for verified GitHub handles. Describe the final user-visible result, not abandoned implementation attempts.
3. Keep package.json and package-lock.json versions equal. Build historical versions in temporary detached worktrees at their exact commits. Never rebuild an old version from current main.
4. Run npm ci, npm audit and the integration suite with CHROME_PATH set to Chrome for Testing. On macOS, set CHROME_APP to its app bundle. Require zero failed or skipped browser tests and inspect the target commit's CI results.
5. Run npm pack, inspect its file list, and install the archive into a temporary prefix. Set BROWSER_NETWORK_CLI to the installed dist/cli.js and rerun that version's integration suite. Confirm help and version. Keep real browsing data out of the archive.
6. Review and simplify the staged diff before committing. Push only within the user's authorization, then verify the remote commit. Tag the exact tested commit and push that tag. Never move an existing release tag.

## Notes

Start with one sentence explaining the change. Include a short Changes list with commit links and verified author handles, then a full comparison link from the previous version tag. Deduplicate contributors when several commits share an author. For a first release, link its commit history instead.

Include the one-command install block below. Pin historical release instructions to releases/download/vX.Y.Z rather than latest. Keep runtime requirements to one line. Avoid packaging narration, repeated feature lists, and long test reports. Mention a limitation only when it affects this release.

```sh
npm install -g https://github.com/fcakyon/browser-network-cli/releases/latest/download/fcakyon-browser-network-cli.tgz
```

Use a notes file with gh release create or gh release edit --notes-file. GitHub-generated notes can help, but check direct commits too because this repo may release without pull requests.

## Publish and verify

Stage the compiled archive as fcakyon-browser-network-cli.tgz in a temporary directory. Run shasum -a 256 there to create browser-network-cli-<version>-SHA256SUMS containing the archive's relative filename. Never upload capture data or local state.

Create releases with --verify-tag and both assets. Backfill missing versions oldest first with --latest=false, then publish the newest version with --latest. Preserve existing assets and links when adding stable filenames to older releases. An archive alias must contain the same bytes, with checksums naming each retained archive.

After publication, download every uploaded asset and check its digest with shasum -a 256 -c. Install the newest archive from the public latest URL into a temporary prefix and check the installed version and CLI help. Verify every remote tag points to its intended commit, notes cover the exact ranges and authors, and GitHub marks the intended version as Latest.

Remove only your temporary worktrees, install prefixes, test browsers and staging files after verification. Confirm no test processes remain.

Report release URLs, checks performed and any failed or unverified checks. Do not claim npm publication unless it actually happened. npm publishing requires user authorization separately from a GitHub release.
