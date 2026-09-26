import type { ChannelAlertLevel } from '@crewbox/shared'

/** What each level does, in the words the menu and the settings screen use. */
export const LEVEL_TEXT: Record<ChannelAlertLevel, { label: string; hint: string }> = {
  all: { label: 'All messages', hint: 'Every message buzzes' },
  mentions: { label: 'Mentions', hint: 'Your name, @channel and the desk' },
  muted: { label: 'Muted', hint: 'Only your name gets through' },
}

export const CHANNEL_LEVELS: ChannelAlertLevel[] = ['all', 'mentions', 'muted']

/** A DM buzzes for every message unless muted, so it has two settings, not three. */
export const DM_LEVELS: ChannelAlertLevel[] = ['mentions', 'muted']

export function dmText(level: ChannelAlertLevel): { label: string; hint: string } {
  return level === 'muted'
    ? { label: 'Muted', hint: 'Nothing from this DM buzzes' }
    : { label: 'Every message', hint: 'A DM always buzzes' }
}
