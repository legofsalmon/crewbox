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
 */
@CapacitorPlugin(name = "CrewboxNetwork")
public class NetworkPlugin extends Plugin {

  @PluginMethod
  public void useBox(PluginCall call) {
    SiteWifi.get(getContext()).use(call.getString("origin", ""), onWifi -> {
      JSObject result = new JSObject();
      result.put("onWifi", onWifi);
      call.resolve(result);
    });
  }
}
