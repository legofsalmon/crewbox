const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/**
 * Time-sortable unique id: 9 chars of base-36 milliseconds (sortable until
 * year 5188) followed by 12 chars of crypto randomness. Works in both the
 * browser and Node via globalThis.crypto.
 */
export function newId(): string {
  const time = Date.now().toString(36).padStart(9, '0')
  const bytes = new Uint8Array(12)
  globalThis.crypto.getRandomValues(bytes)
  let rand = ''
  for (const b of bytes) rand += ALPHABET[b % 36]
  return time + rand
}
