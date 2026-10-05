# cast

Claude Code plugin: one persistent Chrome profile per person, several logged-in browsers driven by Claude through Playwright MCP.

## Why

Developers test apps where several people interact (Sam sends a chat message, Elon must receive it), often behind corporate SSO (Microsoft Entra, Okta, GoDaddy). Claude needs a browser per person, each already logged in, open at the same time.

Core ideas:
- **A profile is a person, not a site.** One Chrome profile holds all of that person's logins (app, SSO, mail).
- **A human logs in, Claude never does.** `/cast:add` and `/cast:open` open a plain Chrome for the human; when a session expires Claude asks for `/cast:open <name>`.
- **Two modes of one profile:** the user window (plain Chrome, no control port, so SSO bot checks pass) and Claude's window (the same Chrome with a DevTools port, Playwright MCP attached).
- **Claude knows who is who:** a `SessionStart` hook lists profiles (name, email, role, sites) in every session.
- Scopes like Claude's own: `local` (this project), `project` (team slot in `.claude/claude-cast.yaml`, no credentials), `user` (all projects).
- **Uninstall removes everything except snap profiles.** All cast files live in `${CLAUDE_PLUGIN_DATA}`, which `/plugin uninstall` deletes, so profiles belong to one Claude Code account. A snap browser's profiles must stay in `~/snap/`.

Status: Linux, macOS and Windows (Windows tested in CI only). Installed as `/plugin marketplace add cosmotools/claude-cast`, `/plugin install cast@cosmotools`. Planned work is under "Not done yet" in `CONTRIBUTING.md`.

@../CONTRIBUTING.md

## Commands

- `npm test` — build + unit + integration tests (real Chrome, headless)
- `CAST_TEST_HEADED=1 npm test` — the same with visible windows; run it after touching Chrome launch or login code
- `claude plugin validate --strict .`

## Rules

- Everything in the repository is in English.
- After changing `src/`, rebuild and commit `dist/src` in the same commit: users run `dist/` without a build step.
- All changes go through a pull request into `develop`: branch from `develop`, push the branch, open a PR with base `develop`. Never push to `main` or `develop` directly. `main` holds only releases: the Claude directory and `/plugin marketplace add` install from it.
- Releasing: bump the version in `package.json` and `.claude-plugin/plugin.json`, run `npm install` (updates `package-lock.json`), add a `CHANGELOG.md` entry. Then open a PR from `develop` into `main`. Users get updates only when the version changes and that PR is merged; the GitHub release is then published by `.github/workflows/release.yml`.
- Every bug fix and every feature comes with tests in the same pull request (see "Tests" in `CONTRIBUTING.md`).
- Never make cast type passwords, log in by itself, or print cookies or tokens.

## Easy to break

The reasons are in "Why it is built this way" in `CONTRIBUTING.md`.

- The user window (`/cast:add`, `/cast:open`) must have no DevTools port: a port makes SSO bot checks refuse the login.
- Stop Chrome through `Chrome.close()` (`SIGINT`; on Windows CDP `Browser.close` or `taskkill` without `/F`), never `SIGTERM` or a forced kill: they lose cookies and history not flushed yet.
- Closing a profile: stop Chrome first, then disconnect Playwright, or the saved session loses its tabs.
- After Playwright attaches, wait for the tab list to settle before selecting a tab (session restore races).
- Keep `--password-store=basic` on every Chrome cast starts, so all windows read the same cookies.
- Write cast files only under `resolvePaths()` (`${CLAUDE_PLUGIN_DATA}`, or the snap folder for a snap browser): anything elsewhere survives uninstall.
