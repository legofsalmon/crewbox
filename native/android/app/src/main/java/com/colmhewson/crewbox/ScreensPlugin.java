package com.colmhewson.crewbox;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;

import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * The screens a box serves, fetched and checked by Screens before the app
 * runs any of them.
 *
 * A download runs on a thread of its own, one at a time. Capacitor calls every
 * plugin's methods in turn on one thread, so a download there would hold up
 * every other plugin until it was done.
 */
@CapacitorPlugin(name = "CrewboxScreens")
public class ScreensPlugin extends Plugin {

  private final ExecutorService worker =
      Executors.newSingleThreadExecutor(run -> new Thread(run, "crewbox-screens"));

  /**
   * A client of its own: nothing cached, and no redirects, since a box has no
   * reason to send the phone anywhere else. Its traffic goes over the crew
   * Wi-Fi like the rest of the app's (SiteWifi binds the whole process). It
   * takes the gzip copies a box offers and decodes them, and Screens checks
   * what they decode to.
   */
  private final OkHttpClient http =
      new OkHttpClient.Builder()
          .followRedirects(false)
          .followSslRedirects(false)
          .connectTimeout(10, TimeUnit.SECONDS)
          .readTimeout(20, TimeUnit.SECONDS)
          .build();

  private File root() {
    return new File(getContext().getNoBackupFilesDir(), Screens.FOLDER);
  }

  @Override
  public void load() {
    worker.execute(() -> Screens.sweep(root()));
  }

  @Override
  protected void handleOnDestroy() {
    worker.shutdownNow();
  }

  /**
   * Ask the box at `origin` for its screens, and have them on the phone if
   * this app runs them. Resolves with the answer, and never rejects for
   * anything the box or the network does.
   */
  @PluginMethod
  public void prepare(PluginCall call) {
    String origin = call.getString("origin");
    HttpUrl base = Screens.isOrigin(origin) ? HttpUrl.parse(origin + "/") : null;
    if (base == null) {
      call.reject("A box's address is needed");
      return;
    }
    try {
      worker.execute(() -> call.resolve(answer(prepare(base))));
    } catch (RejectedExecutionException e) {
      call.reject("The app is closing");
    }
  }

  private Screens.Answer prepare(HttpUrl base) {
    File files = getContext().getNoBackupFilesDir();
    try {
      return Screens.prepare(
          path -> open(base, path),
          root(),
          Screens.App.thisBuild(builtIn()),
          files::getUsableSpace);
    } catch (RuntimeException e) {
      // Whatever went wrong, the page gets an answer: an unanswered call
      // would leave it waiting for good.
      return Screens.Answer.failed(String.valueOf(e));
    }
  }

  private static JSObject answer(Screens.Answer answer) {
    JSObject result = new JSObject();
    result.put("result", answer.result);
    if (answer.version != null) result.put("version", answer.version);
    if (answer.update != null) result.put("update", answer.update);
    if (answer.reason != null) result.put("reason", answer.reason);
    return result;
  }

  private InputStream open(HttpUrl base, String path) throws IOException {
    HttpUrl url = base.resolve(path);
    if (url == null) throw new IOException("no address for " + path);
    Response response = http.newCall(new Request.Builder().url(url).build()).execute();
    ResponseBody body = response.body();
    int code = response.code();
    if (code == 200 && body != null) return body.byteStream();
    response.close();
    if (code == 404) return null;
    throw new IOException("the box answered " + code);
  }

  /** The version the app's own screens were built as, from the crewbox-web.json they came with. */
  private String builtIn() {
    try (InputStream in = getContext().getAssets().open("public/" + Screens.INFO)) {
      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      byte[] buffer = new byte[4096];
      for (int n = in.read(buffer); n != -1; n = in.read(buffer)) bytes.write(buffer, 0, n);
      return Screens.readInfo(bytes.toByteArray()).version;
    } catch (IOException | Screens.Refused e) {
      return null;
    }
  }
}
