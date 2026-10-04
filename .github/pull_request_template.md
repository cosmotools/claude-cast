## What and why



## Checklist

- [ ] `npm test` passes; after touching Chrome launch or login code, `CAST_TEST_HEADED=1 npm test` too
- [ ] A bug fix has a test that fails without it; a feature has tests (or the description says why not and how it was checked)
- [ ] `dist/src` rebuilt and committed with `src/` changes
- [ ] For a release: version bumped in `package.json`, `package-lock.json` and `.claude-plugin/plugin.json`, `CHANGELOG.md` entry added
