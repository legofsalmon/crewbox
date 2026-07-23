package com.colmhewson.inter;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * JS bridge for the background-alerts foreground service. The web app calls
 * InterAlerts.start after a successful welcome (native builds only) and
 * InterAlerts.stop on logout.
 */
@CapacitorPlugin(
    name = "InterAlerts",
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
    String myName = call.getString("myName", "");
    if (serverUrl == null || serverUrl.isEmpty() || token == null || token.isEmpty()) {
      call.reject("serverUrl and token are required");
      return;
    }
    AlertsService.start(getContext(), serverUrl, token, myName);
    requestBatteryExemptionOnce();
    call.resolve();
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
    var prefs = getContext().getSharedPreferences("inter-alerts", 0);
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
