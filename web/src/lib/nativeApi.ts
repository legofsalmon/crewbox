/**
 * Which contract with the apps' native code these screens keep.
 *
 * The apps are to run the screens their box serves, not only the ones built
 * into them. The plugins those screens call are fixed by the app build on the
 * phone, so each build of the screens says what it needs, in the
 * `crewbox-web.json` the release signs with it (web/vite.config.ts,
 * scripts/web-sums.mjs), and an app runs only screens it can serve:
 *
 * - `needs`: the oldest contract these screens can work with. Raise it when
 *   they can't run at all without a plugin or method a contract added.
 * - `builtFor`: the contract they were written against. Raise it when they
 *   start to use anything a newer contract added, checking for it before
 *   each use, so an older app still runs them without that one thing.
 *
 * Contract 1 is the plugins the apps have from the release that first carries
 * this file. Only ever raised; a number once shipped keeps its meaning.
 */
export const SCREENS_NATIVE_API = { needs: 1, builtFor: 1 } as const
