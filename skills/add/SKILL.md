---
description: Create a browser profile for a person and log in to their accounts in a fresh Chrome window
argument-hint: <name: latin letters, digits, - _> <description> [email] [--scope local|project|user]
disable-model-invocation: true
allowed-tools: mcp__plugin_cast_cast__cast_add, mcp__plugin_cast_cast__cast_user_window_result, mcp__plugin_cast_cast__cast_set_sites, mcp__plugin_cast_cast__cast_list
---

The user wants a new cast browser profile. Arguments: `$ARGUMENTS`

1. Parse the arguments: the first word is the profile name (letters, digits, `-`, `_`). Then the description (usually quoted, e.g. "sender"), an optional email (the word with `@`, in any position after the name), and an optional `--scope local|project|user` (default `local`: this project only; `project`: a shared team slot in `.claude/claude-cast.yaml` without credentials; `user`: all projects). If there is no name, ask for it and stop. If the name has other characters (spaces, Cyrillic…), suggest a valid one (e.g. `alex-qa`) instead of calling the tool.
2. The description is required: Claude picks profiles by it. If it is missing, call `cast_list`: when the name is a project slot that is not set up yet and already has a description, go on. Otherwise ask in ONE short question who this person is in the tests (e.g. "sender", "vendor", "approver") and, if missing, their email, then stop and wait. If the user does not know the exact role, a short one is enough (e.g. "second test user"); `/cast:edit <name>` changes it later. Never make one up yourself. Do not ask anything else.
3. Call `cast_add` with `name`, `email`, `description`, `scope`. It opens a clean Chrome window and returns at once.
4. Tell the user: log in everywhere this person needs (the app, email, SSO…), choose "Stay signed in" on MFA prompts, and **tell you when done**; they can keep the window open (you then work in it) or close it. They may also leave this session: cast saves the visited sites when the window closes. Then stop and wait for their answer.
5. When the user says they are done, call `cast_user_window_result` with `name`. cast then saves the sites the user landed on. Say which sites were saved and that `/cast:edit <name>` changes them. Do not ask about the sites. Only if no site was saved (only sign-in pages were visited), ask for the address of the app and call `cast_set_sites` with it.
6. If there was nothing to ask, the message from step 5 is the confirmation: the profile is ready and Claude can now use it by name.

Never type or ask for passwords. If `cast_add` returns an error, show it as is.
