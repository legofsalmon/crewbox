package com.colmhewson.crewbox;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The app's copy of what the page keeps for each event (web/src/lib/appCopy.ts),
 * in files of the app's own: a folder per event, by its ID, and a file per
 * slot, each replaced whole. RecordsPlugin hands it to the page.
 *
 * The web view's storage can go without anyone asking. Chromium remakes an
 * app's localStorage after more than 8 failed writes in a row, and deletes all
 * of its IndexedDB when free space dips into a narrow band, open page or not.
 * These files aren't the web view's, so they stay.
 *
 * They are kept in getNoBackupFilesDir(), which Auto Backup and a transfer to
 * a new phone always leave out, as the sign-ins are left out (Sessions): what
 * they hold is one phone's. The folder's name and each slot's reach phones:
 * renaming one strands every copy on them.
 *
 * Synchronized, though the plugin only calls it from Capacitor's one thread.
 */
final class Records {
  private Records() {}

  /** The folder every event's is in, in getNoBackupFilesDir(). */
  static final String FOLDER = "crewbox-records";

  /** An event ID as the page files data under (eventScope.ts eventIdFrom). */
  private static final Pattern EVENT = Pattern.compile("[0-9A-Za-z_]{1,64}");

  /** A slot: nothing that climbs out of its folder, or starts with the dot a file being written has. */
  private static final Pattern SLOT = Pattern.compile("[0-9A-Za-z_][0-9A-Za-z_-]{0,63}");

  static boolean isEvent(String value) {
    return value != null && EVENT.matcher(value).matches();
  }

  static boolean isSlot(String value) {
    return value != null && SLOT.matcher(value).matches();
  }

  /**
   * Every event's copy of one slot, by event ID. Throws rather than leaving one
   * out when a file won't read: the page takes a copy with an event missing as
   * that event forgotten, and signs the phone out of it.
   */
  static synchronized Map<String, String> readAll(File root, String slot) throws IOException {
    if (!isSlot(slot)) throw new IllegalArgumentException("Not a slot: " + slot);
    Map<String, String> values = new HashMap<>();
    String[] events = root.list();
    if (events == null) {
      if (root.exists()) throw new IOException("Couldn't list " + root);
      return values;
    }
    for (String event : events) {
      if (!isEvent(event)) continue;
      File file = new File(new File(root, event), slot);
      if (file.isFile()) values.put(event, new String(read(file), StandardCharsets.UTF_8));
    }
    return values;
  }

  /**
   * Keep one slot of an event's, in place of what was there. Written beside it
   * and renamed over it, so a phone that dies halfway has the old copy or the
   * new one, never half of one.
   */
  static synchronized void write(File root, String event, String slot, String value)
      throws IOException {
    if (!isEvent(event)) throw new IllegalArgumentException("Not an event: " + event);
    if (!isSlot(slot)) throw new IllegalArgumentException("Not a slot: " + slot);
    File folder = new File(root, event);
    if (!folder.isDirectory() && !folder.mkdirs() && !folder.isDirectory()) {
      throw new IOException("Couldn't make " + folder);
    }
    File file = new File(folder, slot);
    File partial = new File(folder, "." + slot);
    try {
      try (FileOutputStream out = new FileOutputStream(partial)) {
        out.write(value.getBytes(StandardCharsets.UTF_8));
        out.getFD().sync();
      }
      if (!partial.renameTo(file)) throw new IOException("Couldn't replace " + file);
    } catch (IOException e) {
      //noinspection ResultOfMethodCallIgnored
      partial.delete();
      throw e;
    }
  }

  /** Forget one slot of an event's, or everything of the event's when slot is null. */
  static synchronized void remove(File root, String event, String slot) throws IOException {
    if (!isEvent(event)) throw new IllegalArgumentException("Not an event: " + event);
    File folder = new File(root, event);
    if (slot != null) {
      if (!isSlot(slot)) throw new IllegalArgumentException("Not a slot: " + slot);
      delete(new File(folder, slot));
      return;
    }
    File[] files = folder.listFiles();
    if (files != null) {
      for (File file : files) delete(file);
    }
    delete(folder);
  }

  private static void delete(File file) throws IOException {
    if (!file.delete() && file.exists()) throw new IOException("Couldn't delete " + file);
  }

  private static byte[] read(File file) throws IOException {
    try (InputStream in = new FileInputStream(file)) {
      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      byte[] buffer = new byte[8192];
      for (int n = in.read(buffer); n != -1; n = in.read(buffer)) bytes.write(buffer, 0, n);
      return bytes.toByteArray();
    }
  }
}
