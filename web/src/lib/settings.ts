const BUILD_SSID = import.meta.env.VITE_WIFI_SSID as string | undefined

/**
 * The Wi-Fi SSID to show as join guidance. Precedence: the live runtime
 * setting (admin-editable) → the build-time default → nothing (callers show
 * generic "the crew Wi-Fi" copy). Empty strings count as unset.
 */
export function effectiveSsid(configSsid: string | undefined): string | undefined {
  return configSsid?.trim() || BUILD_SSID?.trim() || undefined
}

/**
 * What to call this box on screen. An admin who set an event name during
 * first-run setup wants to see it; everyone else gets the product name. One
 * helper so the join screen, sidebar and tab title can't disagree.
 */
export function displayName(eventName: string | undefined): string {
  return eventName?.trim() || 'Crewbox'
}
