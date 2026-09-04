# Working on crewbox

## Pull requests

**Always raise a PR when work is ready — don't wait to be asked.** Colm
reviews and merges from the PR, so finished work sitting on a branch with no
PR is finished work he can't see.

Push the branch, then open the PR against `main`. If a PR is already open for
the branch, push to it rather than opening a second one.

A useful PR body for this repo covers:

- What's in it, commit by commit, in review order
- Anything a reviewer would want flagged: behaviour changes, changed defaults,
  new dependencies, fixes to already-shipped bugs
- Design decisions that aren't obvious from the diff
- What was actually verified — test counts, and anything checked by hand

## Before opening a PR

```bash
npm run lint
npm run format:check
npm run build                               # typechecks both workspaces
npm test                                    # server + web unit tests
npm run build -w web && npx playwright test # e2e (needs the built web app)
```

`npm run build` is the typecheck, and nothing else here covers it: vitest
transpiles without checking types, so a type error in a _test_ file passes
lint, format and the whole suite and then fails CI. It has.

In this sandbox Playwright needs `PW_CHROMIUM=/opt/pw-browsers/chromium`.

## Things that bite

- **Storage names reach real devices.** IndexedDB databases, relay room names
  and localStorage keys are derived from module ids (see `docs/MODULES.md`).
  Renaming one strands data on phones already in the field.
- **Both themes have to work.** Crew use this outdoors in daylight and in a
  dark FOH tent. Use the CSS custom properties from `web/src/app.css`, never
  literal colours. `e2e/theme.spec.ts` guards the contrast ratios.
- **Every module view needs the shell's `<DrawerButton />`.** Navigating to a
  module closes the sidebar, so a pane without one strands a phone user.
- **Offline is the default, not a mode.** Don't block rendering on the
  network, don't treat "not synced" as an error, and use `newId()` from
  `@crewbox/shared` rather than `crypto.randomUUID` (the Android webview
  isn't always a secure context).

## Releases

Tag pushes are blocked for the session's git credentials. Cut releases with
the **Release** workflow's `workflow_dispatch`: pick the branch, type the
version (`v0.3.0`). It creates the tag at that commit.
