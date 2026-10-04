---
description: Use when a task needs a real browser logged in as a specific person, or several people at once (e.g. Sam sends a chat message and Elon must receive it, checking a user's email or Teams). Explains cast profiles and the browser_* tools with a profile parameter.
---

# Working with cast browser profiles

cast gives you several visible Chrome windows, one per person, each already logged in to that person's accounts (the app, SSO, email…). The session start message and `cast_list` show the available profiles: name, email, description (role) and known sites.

## Choosing and opening profiles
- Pick a profile by the name the user says ("Sam") or by its description, which says who the person is in tests ("the sender", "vendor", "PM"). If unsure, call `cast_list`.
- Do not guess a role from a profile name, email or sites: `alex-qa` does not tell you whether this is a vendor or an admin.
- If the task names a role or a person and no profile's description matches, or several do, ask the user once which profile it is. Then save their answer in that profile's description with `cast_update`, so nobody has to ask again. Save only what the user said, never your guess.
- To change a profile's email or description later, the user can run `/cast:edit <name>`.
- Open profiles without asking: `cast_open {profile, url?}` (a `url` opens in a new tab, or in an empty one), or just call any `browser_*` tool with `profile` — the profile opens automatically.
- Every `browser_*` tool takes a required `profile`. Calls for different profiles go to different browsers and can be interleaved freely.
- The user can use the window too. If they close it, the next `browser_*` call opens it again.
- A profile marked not ready is a team slot not set up on this machine: ask the user to run `/cast:add <name>`.

## Tabs: never overwrite the person's tabs
Each window is the person's regular Chrome: it reopens their tabs from last time, and the current tab is one of them. `browser_navigate` loads the URL into the current tab and replaces what was there.
1. Before the first action in a profile, call `browser_tabs {profile, action: "list"}`.
2. If a tab already shows the site you need, `select` it and work there. Do not reload it unless the task needs a fresh page.
3. Otherwise open a new tab: `browser_tabs {profile, action: "new", url}`.
4. Use `browser_navigate` only in a tab you opened or selected for this task.

## Reading pages
- Action tools (`browser_navigate`, `browser_click`, `browser_type`…) return a link `[Snapshot](/abs/path.yml)` instead of the page. Call `browser_snapshot {profile}` to get the page with element refs, or read that file.
- Use refs from the latest snapshot of the **same profile** as `target` in `browser_click`/`browser_type`.

## Multi-person scenario
1. Open both profiles (e.g. Sam and Elon) on the relevant site.
2. Act in one (Sam sends a message).
3. Verify in the other (Elon's chat shows it; use `browser_wait_for {profile, text}` for real-time updates). Check email the same way in the person's mail site.
4. Report what each person saw.

## Showing the person where to look
When you point the user to something in a cast window (a wrong value, the button to press, where an error shows), draw on the page instead of describing where it is: `cast_draw {profile, marks: [{target, shape?, note?}]}`.
- `target` is a ref from the latest `browser_snapshot` of that profile; `shape` is `circle` (default), `box`, `underline` or `arrow`; `note` is a few words in the user's language. Up to 8 marks; a new call replaces them.
- cast brings that tab to the front. Tell the user which window to look at (the person's name is in its title).
- The person erases the marks by clicking the page, Esc or the "Clear marks" button; the next call tells you. cast also erases them before your own clicks, typing and navigation. `cast_erase {profile}` removes them.
- Marks are for the person watching, not part of a test: do not draw while checking an app.

## Dialogs
If a response contains `### Modal state` (e.g. a `confirm` dialog), other tools will fail until you call `browser_handle_dialog {profile, accept: true|false}`.

## Expired sessions — do not log in yourself
If a site shows a login page instead of the app, stop working with that profile and ask the user to run `/cast:open <name>` and log in again there. If a tool says the user's window for that profile is still open, ask the user to finish and close it; after they say so, `cast_user_window_result {name}` shows what was saved. Never type passwords, never fill login forms, never call `cast_add` or `cast_open_for_user` on your own.

## Privacy
Profiles hold real sessions (mail included). Look only at what the task needs. Never print cookies, tokens or storage contents.

## Finishing
When the task is done, close the profiles you opened with `cast_close {profile}`. Logins are kept.
