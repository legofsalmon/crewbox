import { describe, expect, it } from 'vitest'
import { safeContentType } from '../src/app.ts'

/**
 * The file route serves attacker-controlled bytes from the app's own origin,
 * so which content types a browser is allowed to render inline is a security
 * decision, not a cosmetic one. This pins the allowlist.
 */
describe('what a browser may render inline from a crew upload', () => {
  it('lets real media through unchanged', () => {
    expect(safeContentType('image/png')).toBe('image/png')
    expect(safeContentType('image/jpeg')).toBe('image/jpeg')
    expect(safeContentType('image/webp')).toBe('image/webp')
    expect(safeContentType('video/mp4')).toBe('video/mp4')
    expect(safeContentType('audio/mpeg')).toBe('audio/mpeg')
    expect(safeContentType('application/pdf')).toBe('application/pdf')
  })

  it('downgrades anything a browser would execute to an opaque download', () => {
    // HTML runs JS; SVG carries script; these are the stored-XSS vectors.
    expect(safeContentType('text/html')).toBe('application/octet-stream')
    expect(safeContentType('image/svg+xml')).toBe('application/octet-stream')
    expect(safeContentType('application/xhtml+xml')).toBe('application/octet-stream')
    expect(safeContentType('text/javascript')).toBe('application/octet-stream')
    expect(safeContentType('application/octet-stream')).toBe('application/octet-stream')
  })

  it('is case-insensitive, so a MiXeD-case svg cannot slip through', () => {
    expect(safeContentType('Image/SVG+XML')).toBe('application/octet-stream')
    expect(safeContentType('IMAGE/PNG')).toBe('IMAGE/PNG')
  })
})
