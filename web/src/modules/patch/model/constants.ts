import type { PatchField } from './types'

export const DEFAULT_CHANNEL_COUNT = 10

export const STAGE_POSITIONS = [
  'USC',
  'USL',
  'USR',
  'MSC',
  'MSL',
  'MSR',
  'DSC',
  'DSL',
  'DSR',
] as const

/** Autocomplete suggestions per patch field (carried over from v1). */
export const FIELD_SUGGESTIONS: Partial<Record<PatchField, readonly string[]>> = {
  input: ['Guitar', 'Bass', 'Vocals', 'Drums', 'Keys', 'Synth', 'Saxophone', 'Trumpet', 'Violin'],
  description: [
    'Lead Vocals',
    'Backing Vocals',
    'Electric Guitar',
    'Acoustic Guitar',
    'Bass Guitar',
    'Kick Drum',
    'Snare Drum',
    'Hi-Hat',
    'Keyboard',
    'Piano',
  ],
  micDi: [
    'SM58',
    'SM57',
    'Beta 58A',
    'Beta 87A',
    'KSM8',
    'DI Box',
    'Active DI',
    'Passive DI',
    'Countryman',
    'Radial',
  ],
  stand: [
    'Boom Stand',
    'Straight Stand',
    'Desktop Stand',
    'Clip-on',
    'Overhead',
    'Floor Stand',
    'Short Boom',
    'Tall Stand',
  ],
}

/** Sub-box column fallback suggestions when no sub-boxes are defined yet. */
export const SUB_BOX_FALLBACK_SUGGESTIONS = [
  'DI',
  'Amp',
  'Cabinet',
  'Monitor',
  'Fold-back',
  'Sub',
  'Main',
  'Side-fill',
] as const

export const SUB_BOX_COLORS = [
  '#ff0000',
  '#00ff00',
  '#0000ff',
  '#ffff00',
  '#ff00ff',
  '#00ffff',
] as const
