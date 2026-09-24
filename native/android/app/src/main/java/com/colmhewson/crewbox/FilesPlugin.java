package com.colmhewson.crewbox;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.MimeTypeMap;

import androidx.activity.result.ActivityResult;
import androidx.annotation.RequiresApi;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Files leaving the app: saved to the phone's Downloads, or handed to the
 * share sheet.
 *
 * The web view has no download handler, so a Download link does nothing in
 * it, and Chromium leaves the Web Share API out of the Android web view, so
 * every export in the app reported that it could not save. This is both
 * halves, for a file the page has built (`data`, base64) or one on the box
 * (`url`, fetched here rather than through the page, so a 100 MB video never
 * crosses the bridge).
 *
 * Neither method needs a permission. Android 10 and later save through
 * MediaStore's Downloads collection, which any app may add to. Android 7 to
 * 9 have no such collection, and writing to Downloads there needs the storage
 * permission, so the system's own "save as" screen asks where instead.
 * Sharing goes through the FileProvider the manifest already declares.
 */
@CapacitorPlugin(name = "CrewboxFiles")
public class FilesPlugin extends Plugin {

  /** Shared files older than this are deleted when the next one is shared. */
  private static final long SHARE_KEEP_MS = 60 * 60 * 1000;

  // One file at a time, off the thread every plugin call arrives on: a long
  // download there would hold up voice and alerts behind it.
  private final ExecutorService io = Executors.newSingleThreadExecutor();

  /** What to write, and the name to write it under. */
  private static final class Payload {
    final String name;
    final String givenType;
    final String data;
    final String url;

    Payload(String name, String givenType, String data, String url) {
      this.name = name;
      this.givenType = givenType;
      this.data = data;
      this.url = url;
    }

    /** Read from a call, or reject it and return null. */
    static Payload from(PluginCall call) {
      String data = call.getString("data");
      String url = call.getString("url");
      if ((data == null) == (url == null)) {
        call.reject("Give either data or url");
        return null;
      }
      if (url != null) {
        String scheme = Uri.parse(url).getScheme();
        // Only the network: a file: or content: address would let a page
        // share out this app's own private files.
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) {
          call.reject("Only http and https addresses can be saved");
          return null;
        }
      }
      return new Payload(
          safeName(call.getString("filename", "")), call.getString("mime", ""), data, url);
    }

    InputStream open() throws IOException {
      if (data != null) return new ByteArrayInputStream(Base64.decode(data, Base64.DEFAULT));
      HttpURLConnection connection = (HttpURLConnection) URI.create(url).toURL().openConnection();
      connection.setConnectTimeout(15_000);
      connection.setReadTimeout(30_000);
      int status = connection.getResponseCode();
      if (status < 200 || status > 299) {
        connection.disconnect();
        throw new IOException("The box answered " + status);
      }
      return connection.getInputStream();
    }
  }

  @PluginMethod
  public void save(PluginCall call) {
    Payload payload = Payload.from(call);
    if (payload == null) return;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      io.execute(() -> saveToDownloads(call, payload));
      return;
    }
    Intent pick = new Intent(Intent.ACTION_CREATE_DOCUMENT)
        .addCategory(Intent.CATEGORY_OPENABLE)
        .setType(storedType(payload.name))
        .putExtra(Intent.EXTRA_TITLE, payload.name);
    startActivityForResult(call, pick, "onSaveLocationChosen");
  }

  /**
   * Android 10 and later: straight into Downloads.
   *
   * The entry stays pending, invisible to other apps, until it is written,
   * so a half-saved file never shows up in Files; and it is removed if the
   * write fails. MediaStore renames on a clash ("report (1).csv"), so the
   * name reported back is read from it rather than assumed.
   */
  @RequiresApi(Build.VERSION_CODES.Q)
  private void saveToDownloads(PluginCall call, Payload payload) {
    ContentResolver resolver = getContext().getContentResolver();
    ContentValues values = new ContentValues();
    values.put(MediaStore.MediaColumns.DISPLAY_NAME, payload.name);
    values.put(MediaStore.MediaColumns.MIME_TYPE, storedType(payload.name));
    values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
    values.put(MediaStore.MediaColumns.IS_PENDING, 1);
    Uri item = null;
    try {
      item = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
      if (item == null) throw new IOException("Downloads would not take the file");
      write(payload, resolver.openOutputStream(item, "w"));
      values.clear();
      values.put(MediaStore.MediaColumns.IS_PENDING, 0);
      resolver.update(item, values, null, null);
      call.resolve(saved(nameOf(item, payload.name), "Downloads"));
    } catch (IOException | RuntimeException e) {
      Uri unfinished = item;
      if (unfinished != null) forget(() -> resolver.delete(unfinished, null, null));
      call.reject(e.getMessage() == null ? "Could not save the file" : e.getMessage());
    }
  }

  /** Android 7 to 9: wherever the "save as" screen was pointed, or nowhere. */
  @ActivityCallback
  private void onSaveLocationChosen(PluginCall call, ActivityResult result) {
    if (call == null) return;
    getBridge().releaseCall(call);
    Intent data = result.getData();
    Uri target = data == null ? null : data.getData();
    if (result.getResultCode() != Activity.RESULT_OK || target == null) {
      JSObject cancelled = new JSObject();
      cancelled.put("saved", false);
      call.resolve(cancelled);
      return;
    }
    Payload payload = Payload.from(call);
    if (payload == null) return;
    io.execute(() -> {
      ContentResolver resolver = getContext().getContentResolver();
      try {
        // "wt": a file picked to be replaced is cut to the new length.
        write(payload, resolver.openOutputStream(target, "wt"));
        call.resolve(saved(nameOf(target, payload.name), null));
      } catch (IOException | RuntimeException e) {
        // The screen made the file before anything was written to it; an
        // empty one left behind would pass for the export.
        forget(() -> DocumentsContract.deleteDocument(resolver, target));
        call.reject(e.getMessage() == null ? "Could not save the file" : e.getMessage());
      }
    });
  }

  /**
   * The share sheet, with the file attached.
   *
   * Resolves once the sheet is up; which app it goes to, if any, is the
   * other app's business. Each file gets a folder of its own so it keeps its
   * exact name, which is the name the receiving app shows.
   */
  @PluginMethod
  public void share(PluginCall call) {
    Payload payload = Payload.from(call);
    if (payload == null) return;
    io.execute(() -> {
      try {
        File shared = new File(getContext().getCacheDir(), "shared");
        forgetOldShares(shared);
        File folder = new File(shared, Long.toString(System.nanoTime()));
        if (!folder.mkdirs() && !folder.isDirectory()) {
          throw new IOException("No room to share the file");
        }
        File file = new File(folder, payload.name);
        write(payload, new FileOutputStream(file));
        Uri uri = FileProvider.getUriForFile(
            getContext(), getContext().getPackageName() + ".fileprovider", file);
        Intent send = new Intent(Intent.ACTION_SEND)
            .setType(sharedType(payload))
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        // The clip carries the grant to whichever app is picked, and gives
        // the sheet its preview.
        send.setClipData(ClipData.newRawUri(payload.name, uri));
        Intent chooser = Intent.createChooser(send, payload.name);
        getActivity().runOnUiThread(() -> {
          try {
            getActivity().startActivity(chooser);
            call.resolve();
          } catch (ActivityNotFoundException e) {
            call.reject("Nothing on this phone can take the file");
          }
        });
      } catch (IOException | RuntimeException e) {
        call.reject(e.getMessage() == null ? "Could not share the file" : e.getMessage());
      }
    });
  }

  @Override
  protected void handleOnDestroy() {
    io.shutdown();
  }

  /** Tidying up after a failure, which must not become a failure of its own. */
  private interface Tidy {
    void run() throws Exception;
  }

  private static void forget(Tidy tidy) {
    try {
      tidy.run();
    } catch (Exception ignored) {
      // Already reporting the failure that mattered.
    }
  }

  private static JSObject saved(String name, String folder) {
    JSObject result = new JSObject();
    result.put("saved", true);
    result.put("name", name);
    if (folder != null) result.put("folder", folder);
    return result;
  }

  private static void write(Payload payload, OutputStream target) throws IOException {
    if (target == null) throw new IOException("Could not open the file to write");
    try (OutputStream out = target; InputStream in = payload.open()) {
      byte[] buffer = new byte[64 * 1024];
      for (int n; (n = in.read(buffer)) != -1; ) out.write(buffer, 0, n);
    }
  }

  /** The name a content address ended up with, or the one asked for. */
  private String nameOf(Uri uri, String fallback) {
    String[] column = {OpenableColumns.DISPLAY_NAME};
    try (Cursor cursor = getContext().getContentResolver().query(uri, column, null, null, null)) {
      if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getString(0);
    } catch (RuntimeException ignored) {
      // The file is saved; only its final name is unknown.
    }
    return fallback;
  }

  /**
   * Shares are read by the other app when it takes them, so anything from
   * an hour ago has been read or never will be. Cleared on the next share
   * rather than on a timer; the system may also clear the cache itself.
   */
  private static void forgetOldShares(File shared) {
    File[] folders = shared.listFiles();
    if (folders == null) return;
    long cutoff = System.currentTimeMillis() - SHARE_KEEP_MS;
    for (File folder : folders) {
      if (folder.lastModified() >= cutoff) continue;
      File[] files = folder.listFiles();
      if (files != null) {
        for (File file : files) file.delete();
      }
      folder.delete();
    }
  }

  /**
   * The type to store a file as: whatever its extension says, else a byte
   * stream.
   *
   * Not the type the page gave. MediaStore gives a file whose extension
   * does not match its type the type's own extension, so the DNS config
   * sent as text/plain would land in Downloads as "crewbox-dns.conf.txt".
   * A type read from the extension always matches it, and a byte stream is
   * the one type MediaStore leaves any name alone for.
   */
  static String storedType(String name) {
    String byExtension = typeOfExtension(name);
    return byExtension != null ? byExtension : "application/octet-stream";
  }

  /** The type the share sheet sees: the more specific of the two, for picking apps. */
  private static String sharedType(Payload payload) {
    String byExtension = typeOfExtension(payload.name);
    if (byExtension != null) return byExtension;
    String given = payload.givenType == null ? "" : payload.givenType.split(";", 2)[0].trim();
    return given.matches("[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+")
        ? given.toLowerCase(Locale.ROOT)
        : "application/octet-stream";
  }

  private static String typeOfExtension(String name) {
    int dot = name.lastIndexOf('.');
    if (dot < 0 || dot == name.length() - 1) return null;
    String extension = name.substring(dot + 1).toLowerCase(Locale.ROOT);
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
  }

  /**
   * A name any file system here will take, as close to the given one as
   * possible: no path separators or characters Windows refuses (these files
   * go on to laptops), and, extension kept, short enough that the " (1)" a
   * clash adds still fits in a file system's 255 bytes.
   */
  static String safeName(String given) {
    String name = given == null ? "" : given;
    name = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
    // Not hidden, and nothing Windows would trim off the end.
    name = name.replaceAll("^\\.+|[. ]+$", "");
    if (name.isEmpty()) return "crewbox-file";
    int dot = name.lastIndexOf('.');
    String extension = dot > 0 && name.length() - dot <= 12 ? name.substring(dot) : "";
    String base = name.substring(0, name.length() - extension.length());
    while (utf8Length(base + extension) > 200 && !base.isEmpty()) {
      base = base.substring(0, base.offsetByCodePoints(base.length(), -1));
    }
    return base.isEmpty() ? "crewbox-file" + extension : base + extension;
  }

  private static int utf8Length(String text) {
    return text.getBytes(StandardCharsets.UTF_8).length;
  }
}
