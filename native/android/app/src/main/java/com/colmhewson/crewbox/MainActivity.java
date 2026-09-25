package com.colmhewson.crewbox;

import android.content.Intent;
import android.os.Bundle;
import android.os.Environment;

import com.getcapacitor.BridgeActivity;

import java.io.File;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    // Before the page loads, so a box kept from last time is reached over
    // its Wi-Fi from the first request.
    SiteWifi.get(this).start("");
    registerPlugin(AlertsPlugin.class);
    registerPlugin(VoicePlugin.class);
    registerPlugin(FilesPlugin.class);
    registerPlugin(DiscoveryPlugin.class);
    registerPlugin(ScannerPlugin.class);
    registerPlugin(WifiPlugin.class);
    registerPlugin(NetworkPlugin.class);
    registerPlugin(SessionsPlugin.class);
    registerPlugin(RecordsPlugin.class);
    registerPlugin(ScreensPlugin.class);
    // Which screens the page loads, before it loads anything: those its
    // event last started with, when this build still runs them.
    bridgeBuilder.setServerPath(ScreensPlugin.choose(this));
    AlertsService.forgetOldToken(this);
    forgetLinkFromRecents(getIntent());
    super.onCreate(savedInstanceState);
    forgetTakenPhotos();
  }

  /**
   * A crewbox://join link is the page's once, when it is tapped.
   *
   * Android starts an activity from Recents, once it has let the process go,
   * with the intent that started it, marked FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY.
   * For an app a link started, that is the link, which Capacitor would hand
   * the page as though it had just been tapped (appUrlOpen, which
   * BridgeActivity fires for the starting intent, and getLaunchUrl): a link
   * from the morning opening Your boxes in the afternoon. So it comes off the
   * intent before Capacitor reads it.
   */
  private static void forgetLinkFromRecents(Intent intent) {
    if (intent != null && (intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) {
      intent.setData(null);
    }
  }

  /**
   * Photos taken for messages, once they are no use to anyone.
   *
   * "Take a photo" in the attach menu has the camera write to a file
   * Capacitor makes for it in this app's Pictures folder
   * (JPEG_date_time_n.jpg, empty if the camera was cancelled), and hands that
   * file to the page. Nothing deletes it afterwards, so every photo sent from
   * the app would stay on the phone as a second copy, a few megabytes at a
   * time, for as long as the app is installed.
   *
   * The page uploads a photo the moment it gets one and keeps nothing that
   * points at the file, so by the time this activity is created again with
   * a fresh page, every photo from before is sent or abandoned. Only files
   * from before this start are deleted, so a photo taken in the next moment
   * is not.
   */
  private void forgetTakenPhotos() {
    final long startedAt = System.currentTimeMillis();
    new Thread(() -> {
      File dir = getExternalFilesDir(Environment.DIRECTORY_PICTURES);
      if (dir == null) return; // no shared storage mounted: nothing was written
      File[] photos = dir.listFiles(
          (parent, name) -> name.startsWith("JPEG_") && name.endsWith(".jpg"));
      if (photos == null) return;
      for (File photo : photos) {
        if (photo.lastModified() < startedAt) {
          photo.delete();
        }
      }
    }, "crewbox-forget-photos").start();
  }
}
