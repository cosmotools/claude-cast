# Changelog

## 0.13.2 — 2026-10-03

### Fixed
- A profile no longer opens with an empty tab after Chrome crashed once (or was stopped by force). Chrome then waits for an answer to "Restore pages?" and, until it gets one, neither restores the last session nor saves the new one, so every tab opened afterwards was lost too. cast now marks the crashed exit as normal before starting Chrome, so the tabs saved before the crash come back and new ones are saved again.

## 0.13.1 — 2026-10-02

### Fixed
- Windows: closing a profile while a page shows a dialog (`alert`, `confirm`) no longer loses its tabs and recent cookies. The dialog kept Chrome from closing, and the forced stop that followed lost what Chrome had not saved yet. cast now cancels the dialog first.

## 0.13.0 — 2026-10-02

### Changed
- Profiles live in the plugin's data folder, `~/.claude/plugins/data/cast-<marketplace>/` (`config/` for the lists, `data/` for Chrome), instead of `~/.config/claude-cast/` and `~/.local/share/claude-cast/` (on Windows `%APPDATA%` and `%LOCALAPPDATA%`). `/plugin uninstall` now deletes them (`--keep-data` keeps them), and each Claude Code account (`CLAUDE_CONFIG_DIR`) has its own profiles. New profiles of a snap browser live in `~/snap/<browser>/common/claude-cast/<account>/`, where `<account>` is the Claude Code config folder's name without the dot (`claude` for `~/.claude`).
- Existing profiles are not moved: after the update the list is empty until you move them. Close all cast windows, then move the contents of each old folder into the new one (`~/.claude/plugins/data/cast-<marketplace>/`, or under `CLAUDE_CONFIG_DIR`):
  - profile lists: `~/.config/claude-cast/` (or `$XDG_CONFIG_HOME/claude-cast/`; Windows `%APPDATA%\claude-cast\`) → `config/`;
  - Chrome data: `~/.local/share/claude-cast/` (or `$XDG_DATA_HOME/claude-cast/`; Windows `%LOCALAPPDATA%\claude-cast\`) → `data/`;
  - a snap browser's profiles: `user/` and `projects/` in `~/snap/<browser>/common/claude-cast/` → into its `<account>/` folder.

  With several Claude Code accounts, give each one only the profiles it uses.
- cast stops with an error when `CLAUDE_PLUGIN_DATA` is not set and `CAST_CONFIG_DIR`/`CAST_DATA_DIR` are not given, instead of choosing a folder itself.

### Fixed
- Claude no longer opens a site over a tab the person left open. A cast window restores the person's tabs, and `browser_navigate` replaced the current one: the `SessionStart` hook, the `cast` skill and `browser_navigate`'s description now tell Claude to select a tab that already shows the site or open a new one, and `cast_open` with a `url` opens it in a new tab.
- `cast_open` with a `url` on a new profile opens it in the empty new tab, instead of leaving that tab next to it.
- Reopening a profile brings back the tab the person had in front. cast selected the first tab in Playwright's list, whose order changes from run to run, so a random tab came to the front.
- A profile whose restored tab shows a dialog as it loads (`alert`, `confirm`) opens again. Playwright waited for that tab and gave up after 30 s. cast now reloads such a tab and answers the dialog: an alert is closed, `confirm` and `prompt` are cancelled.

## 0.12.2 — 2026-10-02

### Changed
- `/cast:add` takes the description before the optional email: `/cast:add <name> <description> [email]`. An email is still recognized in any position after the name.
- The MCP server is declared in `.claude-plugin/plugin.json`, not in a root `.mcp.json`. In a clone of the cast repository Claude Code read that file as the project's own server, which failed to start next to the plugin's.

### Fixed
- README: standard command syntax with a legend, the profile name rule, data paths and site examples.

## 0.12.1 — 2026-10-01

### Fixed
- Opening a profile no longer makes the cast server use about 600 MB of memory: looking for a snap launcher read the whole browser executable instead of its first bytes.

## 0.12.0 — 2026-10-01

### Changed
- cast's folders are named `claude-cast`, not `cast`, so they cannot be mistaken for another tool's: `~/.config/claude-cast/`, `~/.local/share/claude-cast/`, `~/snap/<browser>/common/claude-cast/`; on Windows `%APPDATA%\claude-cast\` and `%LOCALAPPDATA%\claude-cast\`. Team slots move from `.claude/cast.yaml` to `.claude/claude-cast.yaml`. Existing profiles are not moved: close all cast windows and rename the old `cast` folders and `.claude/cast.yaml` to keep them.

## 0.11.0 — 2026-10-01

### Changed
- `/cast:login` is now `/cast:open`: it opens a person's browser for you, without Claude's control, to log in again, add sites or work by hand. The window title says `your window` instead of `log in`.

## 0.10.1 — 2026-10-01

### Added
- cast tools carry MCP annotations (a title and whether a tool only reads, or changes or deletes something), so Claude Code can tell them apart when asking for permission.
- The plugin has a display name, and the README says where cast works (Claude Code on your computer, not claude.ai chat).

## 0.10.0 — 2026-10-01

### Changed
- A description is required in `/cast:add`: Claude picks profiles by it. Leave it out and Claude asks for it before the login window opens; a team slot that already has one needs none. A description can be replaced with `/cast:edit` but not cleared. Profiles made earlier without one keep working, and Claude still suggests one after their next `/cast:login`.

## 0.9.0 — 2026-10-01

### Added
- Windows support (tested in CI; please report what you see on a real desktop). cast finds Google Chrome, Microsoft Edge, Brave, Chromium or Vivaldi under Program Files or `AppData\Local`; Edge comes with Windows. Profile lists are kept in `%APPDATA%\cast`, browser data in `%LOCALAPPDATA%\cast`. A cast window is closed the way its close button does, so cookies and history are saved.

## 0.8.0 — 2026-10-01

### Added
- Other Chromium browsers: when Google Chrome is not installed, cast uses Microsoft Edge, Brave, Chromium or Vivaldi, found in their usual places and in `PATH`. Snap browsers work too (Ubuntu's Chromium); their profiles live in `~/snap/<browser>/common/cast/`, the only place a snap can write.
- Each profile keeps the browser it was made with; the session start names it when it is not Google Chrome.

### Changed
- When no browser fits, the error says what was found and what to do: a Flatpak browser cannot be used, Firefox is not supported, install Google Chrome or set `CAST_CHROME`.

## 0.7.0 — 2026-10-01

### Added
- macOS support. cast finds Google Chrome in `/Applications` or `~/Applications` (`CAST_CHROME` still overrides it). Closing a cast window quits that Chrome, as on Linux, so a closed login window is noticed and its sites are saved; a minimized window counts as open.

### Fixed
- `npm test` runs on Node.js 22 and newer.

## 0.6.3 — 2026-09-30

### Changed
- With no profiles yet, the session start tells Claude how people are added, so it suggests `/cast:add <name>` from its first answer.

## 0.6.2 — 2026-09-30

### Fixed
- The person's name in the window title now shows in restored windows too: profiles made before 0.5.0 showed the page title, and a profile first opened for login kept "· log in ·" in Claude's window.
- No more "You are using an unsupported command-line flag" bar at the top of cast windows.

## 0.6.1 — 2026-09-30

### Changed
- Clear errors when Chrome cannot start, each with what to do: Chrome not installed, no display (e.g. plain SSH), display not reachable, profile already open, not Linux. Otherwise the error quotes Chrome's last message; its full output is in `cast-chrome.log` in the profile folder.
- A login window whose Chrome exits right away is reported as an error instead of an empty login.

## 0.6.0 — 2026-09-30

### Changed
- `/cast:add` and `/cast:login` no longer keep Claude waiting while the login window is open. Log in, close the window and tell Claude; you may also leave the Claude Code session meanwhile. cast saves the visited sites when the window closes, or at the next session start.
- While a profile's login window is open, Claude does not use that profile and says so.

### Added
- The `cast_login_result` tool: whether the login window is closed, and what was saved from it.

## 0.5.0 — 2026-09-30

### Added
- Each profile's Chrome window has its own theme color and shows the person in the title bar, e.g. `Sam (sends messages) · cast` (`· log in ·` in the login window). New profiles get a color no other profile uses; existing ones get one the next time they open.

## 0.4.0 — 2026-09-30

### Changed
- `/cast:add` and `/cast:login` save the sites where you landed without asking; Claude says in one line what was saved. It asks for the app's address only when you visited nothing but sign-in pages.
- `/cast:edit <name> +site -site` adds or removes sites.

## 0.3.1 — 2026-09-30

### Changed
- Examples in the skills and tool descriptions use neutral names (`alex-qa`, `app.example.com`).
- README says what cast reads from a profile's browser history after login: URLs and page titles of that profile only.

## 0.3.0 — 2026-09-30

### Added
- `/cast:edit <name>` and the `cast_update` tool change a profile's email or description without deleting it or logging in again.
- After `/cast:add` and `/cast:login`, cast reports the last page you saw on each site (path and title, no query string). If the profile has no description, Claude suggests one from it (e.g. "vendor on app.example.com (/vendor)") and saves it only when you confirm.

### Changed
- Claude picks profiles by their description and no longer guesses a role from a profile name, email or sites. When no profile or several match, it asks once and saves your answer in the description.
- `/cast:add` asks who the person is in your tests instead of offering to skip the description.
- The session start list marks profiles without a description as "role unknown".

## 0.2.1 — 2026-09-30

### Changed
- Chrome is started with `--disable-blink-features=AutomationControlled`, the same default as Playwright MCP, so pages see `navigator.webdriver = false` while Claude works on the user's behalf. Nothing else is masked.

### Fixed
- Actions could hang when Chrome activated another tab while restoring the session; cast now waits for the restore to finish and brings the working tab to the front.
- The login instruction tab no longer turns into an error page after restore, and it is closed when Claude opens the profile.
- Background tabs keep rendering in Claude's window.

## 0.2.0 — 2026-09-30

### Changed
- Claude works in a regular Chrome that cast starts itself; Playwright MCP attaches to it over a local DevTools port instead of launching its own browser. Windows reopen the tabs from last time and behave like the person's normal Chrome; the user can take over or close them, and the next call reopens the window.
- `/cast:login` also reopens the previous session's tabs.

### Security
- While Claude works in a profile, its Chrome listens on a DevTools port on 127.0.0.1 (see SECURITY.md).

## 0.1.2 — 2026-09-30

### Changed
- After login, cast suggests the sites where you landed and lists sign-in pages and redirect hops (`login.microsoftonline.com`, `sso.…`, Okta, Google…) separately instead of suggesting them.
- `cast_list` shows each profile's Chrome folder.
- `/cast:add` hint shows the name rule; invalid names get a suggested valid one.
- README: keywords and a comparison with similar tools.

## 0.1.1 — 2026-09-30

### Fixed
- `/cast:add` and `/cast:login` open a plain Chrome instead of a Playwright-controlled one. Corporate SSO with bot checks (e.g. GoDaddy-federated Microsoft 365) refused to log in because the window reported `navigator.webdriver = true`.
- Visited domains are read from the profile's History after the window closes (no DevTools connection while you log in).
- A login window that times out is closed with a clean shutdown, so cookies are not lost.

### Added
- Clear error when a profile is already open in another Chrome window.
- `SECURITY.md`; README troubleshooting for SSO bot checks.

## 0.1.0 — 2026-09-30

First version: persistent Chrome profile per person, `/cast:add`, `/cast:login`, `/cast:list`, `/cast:remove`, local/project/user scopes, gateway over `@playwright/mcp`.
