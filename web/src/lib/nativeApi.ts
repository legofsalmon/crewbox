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
 * this file. Contract 2 adds `CrewboxAlerts.setCountdown` and `getCountdown`,
 * the stage countdown on the lock screen, and the iPhone's `CrewboxAlerts`
 * (Phase 4). Only ever
 * raised; a number once shipped keeps its meaning.
 *
 * Every plugin and method the screens call is declared in lib/server.ts, and
 * held there to the Java and Swift the apps are built from
 * (server/test/nativeContract.test.mjs). A method added after contract 1
 * goes into the apps that can have it, and both apps raise their
 * `NATIVE_API`, with `builtFor` here. It is declared with a tag,
 * `@since native contract N`, and as optional (`name?()`) until `needs`
 * reaches N, so the typecheck makes each call check for it first. That check
 * is all an app without it needs: its plugin's object on the bridge has one
 * function per method the app has, and nothing for the rest (Capacitor's
 * JSExport). A control that needs a method the app lacks says so where it
 * would be, for example "Update the app for voice with the phone locked.",
 * and the rest of the screen carries on.
 *
 * The screens can check only that a method is there, not what it does. So a
 * change in what a method does is a new method when screens can do without
 * it, and otherwise raises `needs` in the screens that count on it. Nor do
 * the screens ever call a method by its name (`Capacitor.nativePromise` and
 * the like, which lint refuses): in either app, a call to a method the app
 * lacks is dropped, and never settles.
 */
export const SCREENS_NATIVE_API = { needs: 1, builtFor: 2 } as const
