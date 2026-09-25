package com.colmhewson.crewbox;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Which box the page uses, for {@link SiteWifi}, as CrewboxNetwork
 * (web/src/lib/server.ts).
 *
 * <p>{@code useBox({origin})} resolves with {@code onWifi}, whether the app's
 * traffic now goes over the Wi-Fi, once that is settled or after a moment,
 * so a join can wait for its requests to go the right way.
 *
 * <p>Each time the app's traffic moves onto the Wi-Fi or off it, the page
 * gets an {@code online} event, as a browser does when its network comes
 * back: the web view never sends one of its own, since the app can't read
 * the phone's networks (no ACCESS_NETWORK_STATE). The chat socket, the
 * documents and voice each try again at once, rather than after a connect
 * timeout or their backoff.
 */
@CapacitorPlugin(name = "CrewboxNetwork")
public class NetworkPlugin extends Plugin {

  private final Runnable moved = () -> getBridge().triggerWindowJSEvent("online");

  @Override
  public void load() {
    SiteWifi.get(getContext()).hear(moved);
  }

  @Override
  protected void handleOnDestroy() {
    SiteWifi.get(getContext()).stopHearing(moved);
  }

  @PluginMethod
  public void useBox(PluginCall call) {
    SiteWifi.get(getContext()).use(call.getString("origin", ""), onWifi -> {
      JSObject result = new JSObject();
      result.put("onWifi", onWifi);
      call.resolve(result);
    });
  }
}
