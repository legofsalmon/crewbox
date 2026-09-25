import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * What the screens may call in the apps' native code, held to the code each
 * app is built from (web/src/lib/nativeApi.ts).
 *
 * The screens and the native code used to reach a phone together, in one
 * app build. Now the apps run the screens their box serves when they can
 * (web/src/lib/appScreens.ts), and those may be older or newer than the app.
 * The page declares every plugin it reads off the bridge, and every method
 * it calls on each (web/src/lib/server.ts). The bridge gives it one object
 * per plugin the app has, with one function per method the plugin has, and
 * nothing for anything else (Capacitor 8.4.2, JSExport.java and
 * JSExport.swift). A declared method the app lacks is a TypeError where it
 * is called, and nothing but these checks would show it before a phone did.
 *
 * So each declared method is held here to the Java and the Swift that build
 * each app, Capacitor's own plugins included, and to the contract it came
 * in. Contract 1 is what the first app release to keep a contract ships
 * with, so no method added before that release needs a `@since`.
 */

const ROOT = join(import.meta.dirname, '..', '..')
const read = (path) => readFileSync(join(ROOT, path), 'utf8')

/** Code with its comments taken out, and its strings left as they are. */
const withoutComments = (code) =>
  code.replace(/("(?:[^"\\\n]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, string) => string ?? '')

/** Every file under `dir` whose name ends in `ending`: none for a package with no such side. */
const filesIn = (dir, ending) =>
  existsSync(join(ROOT, dir))
    ? readdirSync(join(ROOT, dir), { recursive: true })
        .filter((file) => file.endsWith(ending))
        .map((file) => join(dir, file))
    : []

const CAPACITOR = {
  android: 'node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor',
  ios: 'node_modules/@capacitor/ios/Capacitor/Capacitor',
}

/** The Capacitor plugins the apps take from npm: every one `cap sync` finds is registered. */
const fromNpm = Object.keys(JSON.parse(read('native/package.json')).dependencies).filter(
  (name) =>
    !['@capacitor/android', '@capacitor/ios', '@capacitor/cli', '@capacitor/core'].includes(name)
)

/**
 * Where each app's plugins come from: the app's own source, the npm plugins,
 * and the ones Capacitor builds in (SystemBars and its like).
 */
const SOURCES = {
  android: {
    own: ['native/android/app/src/main/java'],
    other: [
      ...fromNpm.map((name) => `node_modules/${name}/android/src/main/java`),
      `${CAPACITOR.android}/plugin`,
    ],
  },
  ios: {
    own: ['native/ios/App/App'],
    other: [
      ...fromNpm.map((name) => `node_modules/${name}/ios/Sources`),
      `${CAPACITOR.ios}/Plugins`,
    ],
  },
}

/** An Android plugin: its name on the bridge, and the methods it gives the page. */
function javaPlugins(dirs, own) {
  return dirs
    .flatMap((dir) => filesIn(dir, '.java'))
    .flatMap((path) => {
      const code = withoutComments(read(path))
      const found =
        /@CapacitorPlugin\b(?:\(([\s\S]*?)\))?\s*public\s+class\s+(\w+)\s+extends\s+Plugin\b/.exec(
          code
        )
      if (!found) return []
      // With no name, Capacitor goes by the class's own (PluginHandle.java).
      const name = /\bname\s*=\s*"([^"]+)"/.exec(found[1] ?? '')?.[1] ?? found[2]
      return [{ name, cls: found[2], path, code, own, methods: javaMethods(code) }]
    })
}

const javaMethods = (code) =>
  [
    ...code.matchAll(
      /@PluginMethod\b(?:\([^)]*\))?\s+(?:@\w+(?:\([^)]*\))?\s+)*public\s+void\s+(\w+)\s*\(/g
    ),
  ].map(([, name]) => name)

/** An iPhone plugin: its name on the bridge, and the methods it gives the page. */
function swiftPlugins(dirs, own) {
  return dirs
    .flatMap((dir) => filesIn(dir, '.swift'))
    .flatMap((path) => {
      const code = withoutComments(read(path))
      const name = /\bjsName\s*=\s*"([^"]+)"/.exec(code)?.[1]
      if (!name) return []
      const cls = /\bclass\s+(\w+)\s*:\s*CAPPlugin\b/.exec(code)?.[1]
      const methods = [...code.matchAll(/CAPPluginMethod\(\s*name:\s*"(\w+)"/g)].map(
        ([, method]) => method
      )
      return [{ name, cls, path, code, own, methods }]
    })
}

const APPS = {
  android: [
    ...javaPlugins(SOURCES.android.own, true),
    ...javaPlugins(SOURCES.android.other, false),
  ],
  ios: [...swiftPlugins(SOURCES.ios.own, true), ...swiftPlugins(SOURCES.ios.other, false)],
}

/**
 * What every plugin object has besides its own methods. Both apps write
 * `addListener` into each, and the iPhone `removeAllListeners` too
 * (JSExport's template). Android also exports each method its base class
 * marks for the page, except the two listener methods it writes itself.
 */
const templated = (path) =>
  [...read(path).matchAll(/\bt\.(\w+) = function/g)].map(([, name]) => name)
const EVERY_PLUGIN = {
  android: [
    ...templated(`${CAPACITOR.android}/JSExport.java`),
    ...javaMethods(withoutComments(read(`${CAPACITOR.android}/Plugin.java`))).filter(
      (name) => name !== 'addListener' && name !== 'removeListener'
    ),
  ],
  ios: templated(`${CAPACITOR.ios}/JSExport.swift`),
}

/** The page's side: each plugin it reads off the bridge, and each method it declares. */
function declared() {
  const path = 'web/src/lib/server.ts'
  const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)
  const interfaces = new Map()
  let window
  source.forEachChild(function visit(node) {
    if (ts.isInterfaceDeclaration(node)) {
      if (node.name.text === 'Window') window = node
      else interfaces.set(node.name.text, node)
    }
    node.forEachChild(visit)
  })
  const member = (node, name) => node.members.find((each) => each.name?.getText(source) === name)
  const entries = member(member(window, 'Capacitor').type, 'Plugins').type.members
  return entries.map((entry) => {
    const face = interfaces.get(entry.type.typeName.text)
    const methods = new Map()
    for (const each of face.members) {
      const name = each.name.getText(source)
      const since = ts.getJSDocTags(each).find((tag) => tag.tagName.text === 'since')
      const said = since && ts.getTextOfJSDocComment(since.comment)?.trim()
      const event = name === 'addListener' ? each.parameters[0].type.literal?.text : undefined
      const seen = methods.get(name)
      methods.set(name, {
        name,
        method: ts.isMethodSignature(each),
        optional: !!each.questionToken,
        // No tag: contract 1, the plugins of the first app release to read one.
        contract: since ? Number(/^native contract ([1-9][0-9]*)$/.exec(said ?? '')?.[1]) : 1,
        said,
        events: [...(seen?.events ?? []), ...(event ? [event] : [])],
      })
    }
    return {
      plugin: entry.name.getText(source),
      face: face.name.text,
      extends: !!face.heritageClauses?.length,
      methods: [...methods.values()],
    }
  })
}

const PAGE = declared()
const PLATFORMS = ['android', 'ios']
const on = (platform, plugin) => APPS[platform].find((each) => each.name === plugin)
const platformsOf = (plugin) => PLATFORMS.filter((platform) => on(platform, plugin))
const has = (platform, plugin, method) => {
  const app = on(platform, plugin)
  return !!app && (app.methods.includes(method) || EVERY_PLUGIN[platform].includes(method))
}
const everyMethod = PAGE.flatMap(({ plugin, methods }) =>
  methods.map((method) => ({ plugin, ...method }))
)

const [, needs, builtFor] = /SCREENS_NATIVE_API = \{ needs: (\d+), builtFor: (\d+) \}/
  .exec(read('web/src/lib/nativeApi.ts'))
  .map(Number)

describe('the native methods the page declares', () => {
  it('are found here, with what the bridge adds, so the checks below check something', () => {
    expect(PAGE.map(({ plugin }) => plugin).sort()).toEqual([
      'App',
      'CrewboxAlerts',
      'CrewboxDiscovery',
      'CrewboxFiles',
      'CrewboxNetwork',
      'CrewboxRecords',
      'CrewboxScanner',
      'CrewboxScreens',
      'CrewboxSessions',
      'CrewboxVoice',
      'CrewboxWifi',
      'Haptics',
      'SystemBars',
    ])
    for (const { plugin, methods } of PAGE) expect(methods.length, plugin).toBeGreaterThan(0)
    const own = (platform) =>
      APPS[platform]
        .filter((each) => each.own)
        .map(({ name }) => name)
        .sort()
    expect(own('android')).toEqual([
      'CrewboxAlerts',
      'CrewboxDiscovery',
      'CrewboxFiles',
      'CrewboxNetwork',
      'CrewboxRecords',
      'CrewboxScanner',
      'CrewboxScreens',
      'CrewboxSessions',
      'CrewboxVoice',
      'CrewboxWifi',
    ])
    expect(own('ios')).toEqual([
      'CrewboxAlerts',
      'CrewboxDiscovery',
      'CrewboxRecords',
      'CrewboxScanner',
      'CrewboxScreens',
      'CrewboxSessions',
      'CrewboxWifi',
    ])
    for (const plugin of ['App', 'Haptics', 'SystemBars']) {
      expect(platformsOf(plugin), plugin).toEqual(PLATFORMS)
    }
    expect([...EVERY_PLUGIN.android].sort()).toEqual([
      'addListener',
      'checkPermissions',
      'removeAllListeners',
      'requestPermissions',
    ])
    expect(EVERY_PLUGIN.ios).toEqual(['addListener', 'removeAllListeners'])
  })

  it('are declared as methods, each in a plugin’s own interface', () => {
    for (const { face, extends: inherits, methods } of PAGE) {
      // An inherited method would escape every check here.
      expect(inherits, face).toBe(false)
      for (const { name, method } of methods) expect(method, `${face}.${name}`).toBe(true)
    }
  })

  it('are on plugins at least one app has', () => {
    for (const { plugin } of PAGE) expect(platformsOf(plugin), plugin).not.toEqual([])
  })

  it('are each in at least one app that has the plugin', () => {
    for (const { plugin, name } of everyMethod) {
      const where = platformsOf(plugin).filter((platform) => has(platform, plugin, name))
      expect(where, `${plugin}.${name} is in neither app`).not.toEqual([])
    }
  })

  it('are called without a check only where every app with the plugin has them', () => {
    // Optional ones (`name?(`) make the typecheck insist on a check first.
    for (const { plugin, name, optional } of everyMethod) {
      if (optional) continue
      const lacking = platformsOf(plugin).filter((platform) => !has(platform, plugin, name))
      expect(lacking, `${plugin}.${name} is missing on ${lacking}, so make it optional`).toEqual([])
    }
  })

  it('listen only for events the plugin sends', () => {
    for (const { plugin, events } of everyMethod) {
      for (const event of events) {
        const senders = platformsOf(plugin).filter((platform) =>
          on(platform, plugin).code.includes(`"${event}"`)
        )
        expect(senders, `nothing sends ${plugin} "${event}"`).not.toEqual([])
      }
    }
  })
})

describe('each native contract', () => {
  it('is named plainly on each method a later one added', () => {
    for (const { plugin, name, contract, said } of everyMethod) {
      expect(contract, `${plugin}.${name}: @since ${said}`).toBeGreaterThanOrEqual(1)
    }
  })

  it('leaves a method optional until the screens can’t run without its contract', () => {
    // An app before that contract lacks the method, and still runs these
    // screens while their needs are older.
    for (const { plugin, name, contract, optional } of everyMethod) {
      if (contract > needs) expect(optional, `${plugin}.${name}`).toBe(true)
    }
  })

  it('has no method newer than the contract these screens were built for', () => {
    // The screens a build carries are built for the contract its apps keep,
    // which screensFixtures.test.mjs holds to NATIVE_API in both.
    for (const { plugin, name, contract } of everyMethod) {
      expect(contract, `${plugin}.${name}`).toBeLessThanOrEqual(builtFor)
    }
  })
})

describe('the apps’ own plugins', () => {
  it('declare each of their methods for the page, so each has its contract', () => {
    for (const platform of PLATFORMS) {
      for (const { name, methods, path } of APPS[platform].filter(({ own }) => own)) {
        const page = PAGE.find(({ plugin }) => plugin === name)
        expect(page, `${path}: ${name} is not declared in web/src/lib/server.ts`).toBeDefined()
        for (const method of methods) {
          expect(
            page.methods.map(({ name: each }) => each),
            `${path}: ${name}.${method} is not declared in web/src/lib/server.ts`
          ).toContain(method)
        }
      }
    }
  })

  it('on the iPhone, are each built and registered on the bridge', () => {
    // Capacitor registers the npm plugins from the list `cap sync` writes;
    // the app's own are there only if its view controller registers them.
    const controller = withoutComments(read('native/ios/App/App/CrewboxViewController.swift'))
    const project = read('native/ios/App/App.xcodeproj/project.pbxproj')
    for (const { cls, path } of APPS.ios.filter(({ own }) => own)) {
      expect(project, path).toContain(`/* ${basename(path)} in Sources */,`)
      const named = new RegExp(`\\blet (\\w+) = ${cls}\\(\\)`).exec(controller)?.[1]
      expect(controller, `${cls} is not registered`).toContain(
        `bridge?.registerPluginInstance(${named ?? `${cls}()`})`
      )
    }
  })
})
