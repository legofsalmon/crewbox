import { describe, expect, it } from 'vitest'
import { describeFile, fileCategory, formatBytes } from '../src/lib/files.ts'

describe('formatBytes', () => {
  it('covers the B / KB / MB boundaries', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(345_000)).toBe('337 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(24.6 * 1024 * 1024)).toBe('24.6 MB')
  })
})

describe('fileCategory', () => {
  it('maps mime families', () => {
    expect(fileCategory('image/png')).toBe('image')
    expect(fileCategory('video/mp4')).toBe('video')
    expect(fileCategory('audio/mpeg')).toBe('audio')
    expect(fileCategory('application/pdf')).toBe('pdf')
    expect(fileCategory('application/zip')).toBe('archive')
    expect(fileCategory('text/plain')).toBe('text')
    expect(fileCategory('application/json')).toBe('text')
    expect(fileCategory('application/octet-stream')).toBe('other')
    expect(fileCategory('')).toBe('other')
  })
})

describe('describeFile', () => {
  it('labels common types and falls back honestly', () => {
    expect(describeFile('image/png')).toBe('Image · PNG')
    expect(describeFile('video/mp4')).toBe('Video · MP4')
    expect(describeFile('audio/mpeg')).toBe('Audio · MPEG')
    expect(describeFile('application/pdf')).toBe('PDF document')
    expect(describeFile('application/zip')).toBe('ZIP archive')
    expect(describeFile('application/json')).toBe('JSON file')
    expect(describeFile('text/csv')).toBe('Text · CSV')
    expect(describeFile('application/octet-stream')).toBe('application/octet-stream')
    expect(describeFile('')).toBe('File')
  })
})
