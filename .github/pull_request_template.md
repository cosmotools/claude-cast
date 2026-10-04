## What and why



## Checklist

- [ ] `npm test` passes; after touching Chrome launch or login code, `CAST_TEST_HEADED=1 npm test` too
- [ ] A bug fix has a test that fails without it; each behavior of a feature has a test that fails when that behavior is broken, or the description says how it was checked (screenshots looked at, steps by hand)
- [ ] `dist/src` rebuilt and committed with `src/` changes
- [ ] For a release: version bumped in `package.json`, `package-lock.json` and `.claude-plugin/plugin.json`, `CHANGELOG.md` entry added
