package com.colmhewson.crewbox;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.wifi.WifiNetworkSuggestion;
import android.os.Build;
import android.provider.Settings;

import androidx.activity.result.ActivityResult;
import androidx.annotation.RequiresApi;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;

/**
 * Joins the Wi-Fi network in a {@code WIFI:} code the scanner read, for the
 * join screen (web/src/components/Join.tsx), as CrewboxWifi.
 *
 * <p>On Android 11 and later the phone's own settings do it. The app hands
 * {@link Settings#ACTION_WIFI_ADD_NETWORKS} the network, and Settings asks
 * whether to save it, naming the app. Saved, it is one of the phone's own
 * networks, as if typed into its Wi-Fi settings, and Settings joins it: its
 * AddAppNetworksFragment connects a single network once it has saved it. The
 * app needs no permission for any of this, and learns nothing of the phone's
 * Wi-Fi beyond the answer.
 *
 * <p>{@code join} resolves with what happened: {@code saved}; {@code known}
 * when the phone has the network saved already, name and password as the
 * code gives them, when Settings shows nothing and joins nothing; {@code
 * declined} when the crew member says no, closes the screen after Settings
 * couldn't save the network, or Settings won't offer (a guest user, or a
 * work profile that bars adding networks), which the app can't tell apart;
 * {@code invalid} for a name or password Android won't
 * take; and {@code unavailable} on Android 10 and older, and where there is
 * no such screen. Before Android 11 an app could add a network only with
 * CHANGE_WIFI_STATE, as a suggestion the phone joins when it chooses (10), or
 * with API since deprecated (9 and older), so those phones join from the
 * camera or their Wi-Fi settings, as before.
 *
 * <p>A network the code says is WPA3 alone ({@code T:SAE}, or WPA3's
 * transition disable bit) goes to Settings as WPA3, as Android's own scanner
 * sends it. A phone without WPA3 saves it and can't join it (Android 16's
 * Wi-Fi service checks the feature when connecting, not when saving).
 * {@code WifiManager.isWpa3SaeSupported()} would tell, but it needs
 * ACCESS_WIFI_STATE, which the app doesn't hold.
 */
@CapacitorPlugin(name = "CrewboxWifi")
public class WifiPlugin extends Plugin {

  @PluginMethod
  public void join(PluginCall call) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      answer(call, "unavailable");
      return;
    }
    ArrayList<WifiNetworkSuggestion> networks = new ArrayList<>();
    try {
      networks.add(network(call));
    } catch (IllegalArgumentException | IllegalStateException e) {
      // Not valid Unicode, a password that isn't ASCII, or no name at all.
      answer(call, "invalid");
      return;
    }
    Intent intent = new Intent(Settings.ACTION_WIFI_ADD_NETWORKS);
    intent.putParcelableArrayListExtra(Settings.EXTRA_WIFI_NETWORK_LIST, networks);
    try {
      startActivityForResult(call, intent, "onAnswered");
    } catch (ActivityNotFoundException e) {
      getBridge().releaseCall(call);
      answer(call, "unavailable");
    }
  }

  /**
   * The network as the code gives it. WPA2 is also how WPA2/WPA3 networks take a password, and
   * where the phone can, Android tries it with WPA3 too.
   */
  @RequiresApi(api = Build.VERSION_CODES.R)
  private static WifiNetworkSuggestion network(PluginCall call) {
    WifiNetworkSuggestion.Builder builder =
        new WifiNetworkSuggestion.Builder().setSsid(call.getString("ssid", ""));
    String password = call.getString("password", "");
    if (!password.isEmpty()) {
      if (call.getBoolean("wpa3", false)) {
        builder.setWpa3Passphrase(password);
      } else {
        builder.setWpa2Passphrase(password);
      }
    }
    return builder.setIsHiddenSsid(call.getBoolean("hidden", false)).build();
  }

  @ActivityCallback
  @RequiresApi(api = Build.VERSION_CODES.R)
  private void onAnswered(PluginCall call, ActivityResult result) {
    if (call == null) return;
    getBridge().releaseCall(call);
    Intent data = result.getData();
    answer(call, outcome(result.getResultCode(),
        data == null ? null : data.getIntegerArrayListExtra(Settings.EXTRA_WIFI_NETWORK_RESULT_LIST)));
  }

  /**
   * What Settings' answer comes to, for the page. Its screen finishes with
   * RESULT_OK and a code for each network it was given, one here, and with
   * RESULT_CANCELED and no codes for a no, or when it won't show at all.
   */
  static String outcome(int resultCode, List<Integer> codes) {
    if (resultCode != Activity.RESULT_OK) return "declined";
    Integer code = codes == null || codes.isEmpty() ? null : codes.get(0);
    if (code == null) return "saved";
    switch (code) {
      case Settings.ADD_WIFI_RESULT_ALREADY_EXISTS:
        return "known";
      case Settings.ADD_WIFI_RESULT_ADD_OR_UPDATE_FAILED:
        // Settings keeps its screen up when a save fails, so a phone whose
        // Settings answers this way has done something else again.
        return "unavailable";
      default:
        return "saved";
    }
  }

  private static void answer(PluginCall call, String outcome) {
    JSObject result = new JSObject();
    result.put("result", outcome);
    call.resolve(result);
  }
}
