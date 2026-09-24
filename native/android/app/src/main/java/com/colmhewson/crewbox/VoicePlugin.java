package com.colmhewson.crewbox;

import android.Manifest;
import android.content.SharedPreferences;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;

import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * What voice needs from Android before the web view opens any audio. The web
 * app calls CrewboxVoice.prepare at the start of every join (native builds
 * only).
 *
 * The web view picks the call's audio device itself: wired, then USB, then
 * Bluetooth, then the loudspeaker (Chromium's CommunicationDeviceSelector).
 * On Android 12 and later it already uses a Bluetooth headset that is
 * connected when voice starts. What it needs BLUETOOTH_CONNECT for is noticing
 * a headset that connects during a call, including one coming back after it
 * dropped out of range, and moving the call onto it. Without the permission
 * the call stays on the phone until the crew member leaves voice and joins
 * again.
 *
 * So this asks once, and only someone with a Bluetooth headset connected as
 * they join: a prompt about "nearby devices" means nothing to anyone else. The
 * web view reads the permission once per process, when its audio first
 * starts, which is why this runs before the join opens anything. If the app
 * has already made a sound, say an alert chirp, a yes takes effect the next
 * time Android starts the app afresh.
 *
 * Android 11 and older need no prompt: they use BLUETOOTH, which the manifest
 * declares and the system grants at install.
 */
@CapacitorPlugin(
    name = "CrewboxVoice",
    permissions = {
      @Permission(alias = "bluetooth", strings = {Manifest.permission.BLUETOOTH_CONNECT})
    })
public class VoicePlugin extends Plugin {

  private static final String PREFS = "crewbox-voice";
  private static final String BLUETOOTH_ASKED = "bluetooth-asked";

  @PluginMethod
  public void prepare(PluginCall call) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S
        || getPermissionState("bluetooth") == PermissionState.GRANTED
        || !bluetoothHeadsetConnected()) {
      call.resolve();
      return;
    }
    SharedPreferences prefs = getContext().getSharedPreferences(PREFS, 0);
    if (prefs.getBoolean(BLUETOOTH_ASKED, false)) {
      // Once. A no stays a no; Settings is where to change it.
      call.resolve();
      return;
    }
    prefs.edit().putBoolean(BLUETOOTH_ASKED, true).apply();
    requestPermissionForAlias("bluetooth", call, "onBluetoothPermission");
  }

  @PermissionCallback
  private void onBluetoothPermission(PluginCall call) {
    // Either answer: voice works without it, on whatever device it starts on.
    call.resolve();
  }

  /** A Bluetooth headset or speaker connected right now. Asking needs no permission. */
  private boolean bluetoothHeadsetConnected() {
    AudioManager audio = getContext().getSystemService(AudioManager.class);
    if (audio == null) return false;
    for (AudioDeviceInfo device : audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
      switch (device.getType()) {
        case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
        case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
        case AudioDeviceInfo.TYPE_BLE_HEADSET:
        case AudioDeviceInfo.TYPE_BLE_SPEAKER:
          return true;
        default:
          break;
      }
    }
    return false;
  }
}
