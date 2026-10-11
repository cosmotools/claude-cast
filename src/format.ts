import { browserName } from './browsers.js';
import type { WindowLook } from './chrome.js';
import type { Profile } from './registry.js';

/** Each window restores the person's tabs, so Claude must not load a site over the current one. */
const TABS_RULE = 'Each window reopens the person\'s own tabs. To open a site there, select a tab that already shows it, reuse a tab marked '
  + '"(opened by Claude)" or open a new tab (browser_tabs "new" with url); browser_navigate replaces the current tab, which is theirs unless so marked.';

/** A denied call is explained to the person by what it does, not by Claude Code's internal tool name. */
const BLOCKED_RULE = 'If Claude Code denies a browser action, tell the user in plain words what it would do on the site, '
  + 'and offer that they do it in the window themselves or approve this one action; do not show tool names (mcp__…).';

/** Compact block for the SessionStart hook; a hint on how to add people when there are none. */
export function briefList(profiles: Profile[]): string {
  if (!profiles.length) return 'cast: no browser users yet. When a task needs a logged-in browser, ask the user to add each person with /cast:add <name>.';
  const lines = profiles.map(p => {
    if (!p.ready) {
      const desc = p.description ? ` — ${p.description}.` : '';
      return `- ${p.name} (project)${desc} NOT set up on this machine: ask the user to run /cast:add ${p.name}`;
    }
    let line = `- ${p.name} (${p.scope})`;
    if (p.email) line += ` ${p.email}`;
    line += p.description ? ` — ${p.description}.` : ' — role unknown (no description).';
    if (p.sites.length) line += ` Sites: ${p.sites.join(', ')}`;
    if (p.browser && p.browser !== 'chrome') line += ` Browser: ${browserName(p.browser)}.`;
    return line;
  });
  return ['cast: browser users available (open with cast_open / browser_* tools with profile=<name>):', ...lines, TABS_RULE, BLOCKED_RULE].join('\n');
}

/** "Sam (vendor, Acme org) · your window · cast": the window title people see in the title bar and taskbar. */
export function windowLook(p: Profile, what?: string): WindowLook {
  const d = p.description && p.description.length > 40 ? `${p.description.slice(0, 39)}…` : p.description;
  return { title: [d ? `${p.name} (${d})` : p.name, what, 'cast'].filter(Boolean).join(' · '), color: p.color };
}
