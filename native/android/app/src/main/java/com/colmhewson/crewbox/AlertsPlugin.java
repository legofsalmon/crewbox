package com.colmhewson.crewbox;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

/**
 * JS bridge for the background-alerts foreground service. The web app calls
 * CrewboxAlerts.start after a successful welcome (native builds only) and
 * CrewboxAlerts.stop on logout.
 */
@CapacitorPlugin(
    name = "CrewboxAlerts",
    permissions = {
      @Permission(alias = "notifications", strings = {Manifest.permission.POST_NOTIFICATIONS})
    })
public class AlertsPlugin extends Plugin {

  @PluginMethod
  public void start(PluginCall call) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
        && getPermissionState("notifications") != PermissionState.GRANTED) {
      requestPermissionForAlias("notifications", call, "onNotificationPermission");
      return;
    }
    startService(call);
  }

  @PermissionCallback
  private void onNotificationPermission(PluginCall call) {
    // Start either way — denied notifications just mean a silent service.
    startService(call);
  }

  private void startService(PluginCall call) {
    String serverUrl = call.getString("serverUrl", "");
    String token = call.getString("token", "");
    // The name the app keeps the token under (Sessions), for a restart.
    String session = call.getString("session", "");
    String myName = call.getString("myName", "");
    // The event it signs in to, and the key its box proves itself with
    // before it sees the token (docs/ALERTS.md). Absent from a page older
    // than this build: the event is then whatever the box says it is not,
    // so such a service stays on the chat socket's own rules.
    String eventId = call.getString("eventId", "");
    String eventKey = call.getString("eventKey", "");
    if (serverUrl == null || serverUrl.isEmpty() || token == null || token.isEmpty()) {
      call.reject("serverUrl and token are required");
      return;
    }
    AlertsService.start(getContext(), serverUrl, token, session, myName, eventId, eventKey);
    requestBatteryExemptionOnce();
    call.resolve();
  }

  /**
   * Put a followed stage's countdown on the lock screen, or take it off with
   * no stage (docs/ALERTS.md). The service keeps it current from the box's
   * `stages` frames; it shows once the box has sent them.
   */
  @PluginMethod
  public void setCountdown(PluginCall call) {
    String stage = call.getString("stage", "");
    AlertsService.setCountdownStage(getContext(), stage == null ? "" : stage.trim());
    getCountdown(call);
  }

  /** The stage whose countdown is on the lock screen, or null. */
  @PluginMethod
  public void getCountdown(PluginCall call) {
    String stage = AlertsService.countdownStage(getContext());
    JSObject result = new JSObject();
    result.put("stage", stage.isEmpty() ? JSONObject.NULL : stage);
    call.resolve(result);
  }

  @PluginMethod
  public void stop(PluginCall call) {
    AlertsService.stop(getContext());
    call.resolve();
  }

  /** Ask once to be excluded from battery optimisation, or alerts die with Doze. */
  private void requestBatteryExemptionOnce() {
    PowerManager pm = getContext().getSystemService(PowerManager.class);
    String pkg = getContext().getPackageName();
    if (pm.isIgnoringBatteryOptimizations(pkg)) return;
    var prefs = getContext().getSharedPreferences("crewbox-alerts", 0);
    if (prefs.getBoolean("battery-asked", false)) return;
    prefs.edit().putBoolean("battery-asked", true).apply();
    try {
      Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
      intent.setData(Uri.parse("package:" + pkg));
      getActivity().startActivity(intent);
    } catch (Exception ignored) {
      // Some OEMs block the dialog; the service still runs, just Doze-throttled.
    }
  }

  @Override
  protected void handleOnResume() {
    AlertsService.appVisible = true;
  }

  @Override
  protected void handleOnPause() {
    AlertsService.appVisible = false;
  }
}
