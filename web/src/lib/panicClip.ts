/**
 * The few seconds of audio that go with a call for help: whatever the person
 * says after the hold, which is usually where they are and what is wrong.
 *
 * Recorded after the alert has gone, never before it: the phones are already
 * ringing when the microphone opens, so a permission prompt, a busy
 * microphone or a browser without MediaRecorder costs the clip and nothing
 * else. Null whenever there is no clip to send.
 */
export async function recordClip(ms: number): Promise<File | null> {
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) return null
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    return null
  }
  try {
    const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) =>
      MediaRecorder.isTypeSupported(t)
    )
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
    const chunks: Blob[] = []
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve()
    })
    recorder.start()
    await new Promise((resolve) => setTimeout(resolve, ms))
    recorder.stop()
    await stopped
    if (chunks.length === 0) return null
    const mime = recorder.mimeType || type || 'audio/webm'
    const ext = mime.includes('mp4') ? 'm4a' : 'webm'
    return new File(chunks, `call-for-help.${ext}`, { type: mime.split(';')[0] })
  } catch {
    return null
  } finally {
    for (const track of stream.getTracks()) track.stop()
  }
}

/**
 * Whether this device is the one the panic button was held on, so only it
 * records: every other device signed in as the same person shows the call
 * too, and four microphones opening at once would be four clips of a pocket.
 */
let heldHere = false

export const markHeldHere = (): void => {
  heldHere = true
}

/** True once, on the device it was held on. */
export function takeHeldHere(): boolean {
  const was = heldHere
  heldHere = false
  return was
}
