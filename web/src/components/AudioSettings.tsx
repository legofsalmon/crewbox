import { useStore } from '../store.ts'

/** Mic/speaker selection + live mic meter. Opened from the voice bar gear. */
export default function AudioSettings() {
  const voice = useStore((s) => s.voice)
  const setAudioSettingsOpen = useStore((s) => s.setAudioSettingsOpen)
  const setAudioDevice = useStore((s) => s.setAudioDevice)

  const { inputs, outputs, canSelectOutput } = voice.devices

  return (
    <div
      className="search-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) setAudioSettingsOpen(false)
      }}
      onKeyDown={(e) => e.key === 'Escape' && setAudioSettingsOpen(false)}
    >
      <div className="audio-panel" role="dialog" aria-label="Audio settings">
        <h3>Audio settings</h3>

        <label className="audio-field">
          Microphone (send)
          <select
            value={voice.selectedInput ?? ''}
            onChange={(e) => setAudioDevice('audioinput', e.target.value || null)}
            disabled={inputs.length === 0}
          >
            <option value="">System default</option>
            {inputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        </label>

        <div className="mic-meter-row">
          <span className="mic-meter-label">Mic level</span>
          <div
            className="mic-meter"
            role="meter"
            aria-label="Microphone level"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((voice.micLevel ?? 0) * 100)}
          >
            <div
              className="mic-meter-fill"
              style={{ width: `${Math.min(100, (voice.micLevel ?? 0) * 140)}%` }}
            />
          </div>
        </div>
        <p className="audio-hint">
          {voice.micLevel === null
            ? voice.micReady
              ? 'Testing microphone…'
              : 'Microphone unavailable — you are listen-only.'
            : 'Say something — the bar should move. If not, pick another mic.'}
        </p>

        <label className="audio-field">
          Speaker (receive)
          {canSelectOutput ? (
            <select
              value={voice.selectedOutput ?? ''}
              onChange={(e) => setAudioDevice('audiooutput', e.target.value || null)}
              disabled={outputs.length === 0}
            >
              <option value="">System default</option>
              {outputs.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          ) : (
            <p className="audio-hint">
              This device routes sound through the system — switch outputs in
              Control Centre / your Bluetooth settings.
            </p>
          )}
        </label>

        {voice.error && <p className="audio-error">{voice.error}</p>}

        <button className="audio-done" onClick={() => setAudioSettingsOpen(false)}>
          Done
        </button>
      </div>
    </div>
  )
}
