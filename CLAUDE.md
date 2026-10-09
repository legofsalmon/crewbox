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
npm run docs:test && npm run docs:build     # then commit any change it makes
npm run build -w web && npx playwright test # e2e (needs the built web app)
```

The docs site is committed as built HTML, and CI rebuilds it and fails on
any difference. An edit to `site/docs-src` without its rebuilt page in the
same push turns CI red with every test passing.

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

## Design

This app follows the shared design system in
[legofsalmon/design-system](https://github.com/legofsalmon/design-system),
checked out beside this repository as `../design-system`. Before changing
anything a person sees or touches, read its `docs/designing.md` and answer its
questions, then the pages it points to: `principles.md` (who uses these tools
and where, the colour grammar, type, space and the behaviour rules),
`behavioural.md` (how crew behave while getting a job done), `navigation.md`,
`states.md`, `components.md` and `motion.md`.

- **Write the reasoning down.** A PR that changes what a person sees or
  touches has a short **Design** section: the one job of the view, the
  behaviour it designs for with the effect named (Default Effect, Loss
  Aversion, Time Scarcity…), and any departure from the system and why. A
  bug fix that changes no design says so.
- **Use the system's parts first.** Its roles rather than literal colours,
  and a shared component's states, keys and wording before drawing a new one.
- **Send back what you learn.** A gap in the system, a departure that was
  right, something crew did that the rules did not predict, or a meaning of
  this app's that another app now needs: add it to the design system's
  `docs/learnings.md` in a PR there, or list it under **Learnings** in this
  PR's Design section so it can be carried across.
- **What stays this app's own:** storage and wire names, layout and flow,
  content, and meanings only this app has.

crewbox takes the colour tokens (`npm run ds:sync`, and `npm run ds:check` to
see whether the copy is behind). Buttons and selection are cyan; amber is
attention; the brand amber stays on the icon, splash and site. Density, fonts,
corners and the shared components come later.
