import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  WEB_DIST_DIR,
  extractWebDist,
  pruneWebDists,
  webDistName,
  type WebBundle,
} from '../src/box.ts'

/**
 * Which client a box serves, when two builds share a disk.
 *
 * An update launches the new box while the old process is still alive and
 * still able to put itself back, and `@fastify/static` reads from disk on
 * every request. So a single shared `web-dist` was not a cache — it was the
 * one file both builds wrote to, and the last writer decided what a phone
 * downloaded. A rollback left the old server handing out the new build's
 * JavaScript on the one path where everything else was reversible.
 */

let dir: string

const bundleOf = (files: Record<string, string>): WebBundle => ({
  manifest: () => Object.keys(files),
  file: (rel) => Uint8Array.from(Buffer.from(files[rel] ?? '')).buffer as ArrayBuffer,
})

const OLD = bundleOf({
  'index.html': '<script src="/assets/app-aaa.js">',
  'assets/app-aaa.js': 'the 0.18.0 client',
})
const NEW = bundleOf({
  'index.html': '<script src="/assets/app-bbb.js">',
  'assets/app-bbb.js': 'the 0.19.0 client',
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crewbox-webdist-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('extracting the embedded web bundle', () => {
  it('writes every file in the manifest', () => {
    const root = extractWebDist(dir, '0.18.0+abc1234', OLD)
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe('<script src="/assets/app-aaa.js">')
    expect(readFileSync(join(root, 'assets/app-aaa.js'), 'utf8')).toBe('the 0.18.0 client')
  })

  it('gives each version its own directory', () => {
    const oldRoot = extractWebDist(dir, '0.18.0+abc1234', OLD)
    const newRoot = extractWebDist(dir, '0.19.0+def5678', NEW)
    expect(oldRoot).not.toBe(newRoot)
    // The whole point: the new box extracting does not change what the old
    // one is serving.
    expect(readFileSync(join(oldRoot, 'index.html'), 'utf8')).toBe(
      '<script src="/assets/app-aaa.js">'
    )
    expect(existsSync(join(oldRoot, 'assets/app-aaa.js'))).toBe(true)
    expect(existsSync(join(newRoot, 'assets/app-bbb.js'))).toBe(true)
  })

  it('does not write again when the version is already extracted', () => {
    const root = extractWebDist(dir, '0.18.0+abc1234', OLD)
    // Something a second extraction would clobber, if it ran.
    writeFileSync(join(root, 'index.html'), 'left alone')
    expect(extractWebDist(dir, '0.18.0+abc1234', OLD)).toBe(root)
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toBe('left alone')
  })

  it('leaves nothing servable behind when it fails halfway', () => {
    // Disk full, or a power cut. Half a client is worse than none: index.html
    // would name assets that were never written.
    const broken: WebBundle = {
      manifest: () => ['assets/app-bbb.js', 'index.html'],
      file: (rel) => {
        if (rel === 'index.html') throw new Error('no space left on device')
        return Uint8Array.from(Buffer.from('half a client')).buffer as ArrayBuffer
      },
    }
    expect(() => extractWebDist(dir, '0.19.0+def5678', broken)).toThrow('no space left')
    expect(existsSync(join(dir, WEB_DIST_DIR, '0.19.0+def5678'))).toBe(false)
    // And what it did write is off the disk — which is very likely the thing
    // that ran out.
    expect(existsSync(join(dir, WEB_DIST_DIR, '0.19.0+def5678.partial'))).toBe(false)
    expect(existsSync(join(dir, WEB_DIST_DIR, 'assets/app-bbb.js'))).toBe(false)
  })

  it('clears a previous failure rather than building on it', () => {
    const partial = join(dir, WEB_DIST_DIR, '0.19.0+def5678.partial')
    mkdirSync(join(partial, 'assets'), { recursive: true })
    writeFileSync(join(partial, 'assets/stale-ccc.js'), 'from an install that died')
    const root = extractWebDist(dir, '0.19.0+def5678', NEW)
    expect(existsSync(join(root, 'assets/stale-ccc.js'))).toBe(false)
    expect(existsSync(join(root, 'assets/app-bbb.js'))).toBe(true)
  })

  it('never lets a version string address anything above its own directory', () => {
    // DEPLOY_VERSION is an environment variable, so this is somebody's input.
    expect(webDistName('..')).toBe('v..')
    expect(webDistName('../../etc')).toBe('v.._.._etc')
    expect(webDistName('0.19.0+def5678')).toBe('0.19.0+def5678')
  })
})

describe('pruning the bundles other builds left', () => {
  it('keeps the running version and removes the rest', () => {
    extractWebDist(dir, '0.18.0+abc1234', OLD)
    extractWebDist(dir, '0.19.0+def5678', NEW)
    expect(pruneWebDists(dir, '0.19.0+def5678')).toEqual(['0.18.0+abc1234'])
    expect(existsSync(join(dir, WEB_DIST_DIR, '0.18.0+abc1234'))).toBe(false)
    expect(existsSync(join(dir, WEB_DIST_DIR, '0.19.0+def5678', 'index.html'))).toBe(true)
  })

  it('clears the flat layout older boxes left behind', () => {
    // Boxes before this change extracted straight into web-dist/, so an
    // upgraded box has a whole stale client sitting beside the versions.
    mkdirSync(join(dir, WEB_DIST_DIR, 'assets'), { recursive: true })
    writeFileSync(join(dir, WEB_DIST_DIR, 'index.html'), 'the old flat layout')
    writeFileSync(join(dir, WEB_DIST_DIR, 'assets/app-aaa.js'), 'and its assets')
    extractWebDist(dir, '0.19.0+def5678', NEW)
    expect(pruneWebDists(dir, '0.19.0+def5678').sort()).toEqual(['assets', 'index.html'])
    expect(existsSync(join(dir, WEB_DIST_DIR, 'index.html'))).toBe(false)
  })

  it('says nothing went when there is nothing to prune', () => {
    expect(pruneWebDists(dir, '0.19.0+def5678')).toEqual([])
    extractWebDist(dir, '0.19.0+def5678', NEW)
    expect(pruneWebDists(dir, '0.19.0+def5678')).toEqual([])
  })
})
