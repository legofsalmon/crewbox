package com.colmhewson.crewbox;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.provider.Settings;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * The join poster's QR, read with the camera, for the join screen
 * (web/src/components/Join.tsx), as CrewboxScanner.
 *
 * {@link ScannerActivity} does the reading, on the phone. What comes back is
 * the code's text and no more, and the page decides what that is, because a
 * QR is anybody's to print.
 *
 * {@code scan} resolves with what happened, for anything a crew member can
 * do: {@code scanned} with the text, {@code cancelled} when they back out,
 * {@code denied} when the camera isn't allowed, and {@code unavailable} when
 * the phone has no camera to use. It rejects only when the camera fails,
 * which the page words as the camera not starting.
 *
 * The camera is asked for here, the first time somebody scans. Once they
 * have said no twice Android stops asking and answers no at once, and the
 * page offers {@code openSettings}, the app's own page in Settings.
 *
 * Capacitor's own {@code checkPermissions} answers for the same "camera",
 * which "Take a photo" in the attach menu needs too: the message box asks it
 * when a photo comes back with nothing (web/src/components/Composer.tsx).
 */
@CapacitorPlugin(
    name = "CrewboxScanner",
    permissions = {@Permission(alias = "camera", strings = {Manifest.permission.CAMERA})})
public class ScannerPlugin extends Plugin {

  @PluginMethod
  public void scan(PluginCall call) {
    if (!getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)) {
      answer(call, "unavailable");
      return;
    }
    if (getPermissionState("camera") == PermissionState.GRANTED) {
      open(call);
      return;
    }
    requestPermissionForAlias("camera", call, "onCameraAnswer");
  }

  @PermissionCallback
  private void onCameraAnswer(PluginCall call) {
    if (getPermissionState("camera") == PermissionState.GRANTED) {
      open(call);
    } else {
      answer(call, "denied");
    }
  }

  private void open(PluginCall call) {
    startActivityForResult(call, new Intent(getContext(), ScannerActivity.class), "onScanned");
  }

  @ActivityCallback
  private void onScanned(PluginCall call, ActivityResult result) {
    if (call == null) return;
    getBridge().releaseCall(call);
    Intent data = result.getData();
    String text = data == null ? null : data.getStringExtra(ScannerActivity.EXTRA_TEXT);
    switch (result.getResultCode()) {
      case Activity.RESULT_OK:
        if (text == null) {
          answer(call, "cancelled");
          return;
        }
        JSObject scanned = new JSObject();
        scanned.put("result", "scanned");
        scanned.put("text", text);
        call.resolve(scanned);
        return;
      case ScannerActivity.RESULT_DENIED:
        answer(call, "denied");
        return;
      case ScannerActivity.RESULT_UNAVAILABLE:
        answer(call, "unavailable");
        return;
      case ScannerActivity.RESULT_FAILED:
        call.reject("The camera didn't start");
        return;
      default:
        answer(call, "cancelled");
    }
  }

  /** The app's own page in Settings, where the camera is allowed again. */
  @PluginMethod
  public void openSettings(PluginCall call) {
    Intent settings = new Intent(
        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
        Uri.fromParts("package", getContext().getPackageName(), null));
    settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    try {
      getContext().startActivity(settings);
      call.resolve();
    } catch (ActivityNotFoundException e) {
      call.reject("This phone has no settings page for the app");
    }
  }

  private static void answer(PluginCall call, String outcome) {
    JSObject result = new JSObject();
    result.put("result", outcome);
    call.resolve(result);
  }
}
