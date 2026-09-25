package com.colmhewson.crewbox;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.util.Map;

/**
 * The app's copy of what the page keeps for each event (web/src/lib/appCopy.ts),
 * kept by Records rather than in the web view's storage.
 */
@CapacitorPlugin(name = "CrewboxRecords")
public class RecordsPlugin extends Plugin {

  private File root() {
    return new File(getContext().getNoBackupFilesDir(), Records.FOLDER);
  }

  /** Every event's copy of one slot, by event ID. Rejects when any of it won't read. */
  @PluginMethod
  public void readAll(PluginCall call) {
    String slot = call.getString("slot");
    if (!Records.isSlot(slot)) {
      call.reject("A slot is needed");
      return;
    }
    try {
      JSObject values = new JSObject();
      for (Map.Entry<String, String> value : Records.readAll(root(), slot).entrySet()) {
        values.put(value.getKey(), value.getValue());
      }
      JSObject result = new JSObject();
      result.put("values", values);
      call.resolve(result);
    } catch (Exception e) {
      call.reject("The app's files answered " + e);
    }
  }

  @PluginMethod
  public void write(PluginCall call) {
    String event = call.getString("event");
    String slot = call.getString("slot");
    String value = call.getString("value");
    if (!Records.isEvent(event) || !Records.isSlot(slot) || value == null) {
      call.reject("An event, a slot and a value are needed");
      return;
    }
    try {
      Records.write(root(), event, slot, value);
      call.resolve();
    } catch (Exception e) {
      call.reject("The app's files answered " + e);
    }
  }

  @PluginMethod
  public void remove(PluginCall call) {
    String event = call.getString("event");
    String slot = call.getString("slot");
    if (!Records.isEvent(event) || (slot != null && !Records.isSlot(slot))) {
      call.reject("An event is needed");
      return;
    }
    try {
      Records.remove(root(), event, slot);
      call.resolve();
    } catch (Exception e) {
      call.reject("The app's files answered " + e);
    }
  }
}
