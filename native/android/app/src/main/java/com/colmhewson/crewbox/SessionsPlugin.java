package com.colmhewson.crewbox;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Map;

/**
 * The app's sign-ins for the page (web/src/lib/sessions.ts), kept by
 * Sessions rather than in the web view's storage.
 */
@CapacitorPlugin(name = "CrewboxSessions")
public class SessionsPlugin extends Plugin {

  /** Every sign-in, by name. Rejects, and the page deletes nothing, when the Keystore won't say. */
  @PluginMethod
  public void load(PluginCall call) {
    try {
      JSObject sessions = new JSObject();
      for (Map.Entry<String, String> session : Sessions.all(getContext()).entrySet()) {
        sessions.put(session.getKey(), session.getValue());
      }
      JSObject result = new JSObject();
      result.put("sessions", sessions);
      call.resolve(result);
    } catch (Exception e) {
      call.reject("The Keystore answered " + e);
    }
  }

  @PluginMethod
  public void save(PluginCall call) {
    String name = call.getString("name", "");
    String token = call.getString("token", "");
    if (name == null || name.isEmpty() || token == null || token.isEmpty()) {
      call.reject("A name and a token are needed");
      return;
    }
    try {
      Sessions.put(getContext(), name, token);
      call.resolve();
    } catch (Exception e) {
      call.reject("The Keystore answered " + e);
    }
  }

  @PluginMethod
  public void forget(PluginCall call) {
    String name = call.getString("name", "");
    if (name == null || name.isEmpty()) {
      call.reject("A name is needed");
      return;
    }
    Sessions.remove(getContext(), name);
    call.resolve();
  }
}
