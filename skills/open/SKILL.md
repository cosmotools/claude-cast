---
description: Open a person's browser profile for the user, without Claude acting in it until they are done, to log in again (expired session), add sites or work by hand
argument-hint: <name>
disable-model-invocation: true
allowed-tools: mcp__plugin_cast_cast__cast_open_for_user, mcp__plugin_cast_cast__cast_user_window_result, mcp__plugin_cast_cast__cast_set_sites, mcp__plugin_cast_cast__cast_list, mcp__plugin_cast_cast__cast_update
---

The user wants to open cast profile `$0` in their own window: to log in again, add sites, or do something by hand.

1. If no name was given, call `cast_list`, show the profile names and ask which one.
2. Call `cast_open_for_user` with `name`. It opens the profile's Chrome with its known sites and returns at once.
3. Tell the user: do what you need (log in where a session expired, open new sites) and **tell you when done**; they can keep the window open (you then work in it) or close it. They may also leave this session: cast saves the visited sites when the window closes. Then stop and wait for their answer. Do not act in that profile meanwhile.
4. When the user says they are done, call `cast_user_window_result` with `name`. Then say in one line which sites were added, if any, and that `/cast:edit <name>` changes them. Do not ask about the sites. If the profile has no saved sites at all, ask for the app's address and call `cast_set_sites` with it.
5. If the profile has no description, ask in the same message who this person is in the tests, suggesting one from the last pages the user saw (e.g. "Looks like a vendor on app.example.com (/vendor). Save that as the description?"). Call `cast_update` only with what the user gave or confirmed.
6. If there is nothing to ask, just say the profile is updated.

Never type or ask for passwords.
