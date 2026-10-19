---
name: release
description: Prepare Browser Network CLI releases or revise their notes, including installed-package checks, commit ranges, contributors, and downloadable assets.
---

# Release Browser Network CLI

Use gh for GitHub operations. Keep release notes short and useful to someone installing the CLI. Updating notes alone does not require a version bump or rebuilt assets.

## Prepare a version

1. Inspect the working tree, package version, tags, and GitHub releases. Identify the previous release tag and intended commit. Preserve unrelated changes.
2. Review every commit in the previous-tag-to-new-tag range. For the first release, review history through its tag. Use git log for subjects and authors, and gh commit metadata for verified GitHub handles. Describe the final user-visible result, not abandoned implementation attempts.
3. For package changes, update package.json and package-lock.json together. Run npm audit and the integration suite with CHROME_PATH set to Chrome for Testing. Require zero failed or skipped browser tests.
4. Run npm pack, inspect its file list, and install the archive into a temporary prefix. Set BROWSER_NETWORK_CLI to the installed dist/cli.js and rerun the integration suite. Confirm help and version. Keep real browsing data out of the archive.
5. Review and simplify the diff before committing. Push and publish only within the user's authorization. Do not move an existing release tag.

## Notes

Start with one sentence explaining the change. Include a short Changes list with commit links and verified author handles, then a full comparison link from the previous tag. Deduplicate contributors when several commits share an author. For a first release, link its commit history instead.

Include the one-command install block below. Keep runtime requirements to one line. Avoid packaging narration, repeated feature lists, and long test reports. Mention a limitation only when it affects this release.

```sh
npm install -g https://github.com/fcakyon/browser-network-cli/releases/latest/download/fcakyon-browser-network-cli.tgz
```

Use a notes file with gh release create or gh release edit --notes-file. GitHub-generated notes can help, but check direct commits too because this repo may release without pull requests.

## Publish and verify

Upload the compiled archive as fcakyon-browser-network-cli.tgz plus a versioned SHA256SUMS file containing its relative filename. Use a temporary directory for staging. Never upload capture data or local state.

After publication, download the asset, compare its digest, and install from the public release URL. Check the installed version and CLI help. Verify the tag points to the intended commit and the notes cover the exact range and authors. Clean up only your temporary test resources.

Report the release URL and checks performed. Do not claim npm publication unless it actually happened. npm publishing requires user authorization separately from a GitHub release.
