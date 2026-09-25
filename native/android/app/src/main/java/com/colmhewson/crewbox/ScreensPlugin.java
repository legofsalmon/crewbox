package com.colmhewson.crewbox;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.ServerPath;
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
 * runs any of them, and the screens the app runs.
 *
 * MainActivity chooses what a start runs before the web view loads anything
 * (choose). While the app runs, the page switches only by asking (use), and
 * then reloads itself, which keeps its address. Downloaded screens that
 * don't say they started (ready) within READY_WITHIN_MS of loading, with the
 * app in front, have failed: the app goes back to its own, and reloads. Each
 * time the app comes back in front they have that long again, since out of
 * sight the page may not run at all. The folder of the screens running is
 * never changed until the next start.
 *
 * Everything but the web view's own calls runs on a thread of the plugin's,
 * one thing at a time, and so does its state. Capacitor calls every plugin's
 * methods in turn on one thread, so a download there would hold up every
 * other plugin until it was done.
 */
@CapacitorPlugin(name = "CrewboxScreens")
public class ScreensPlugin extends Plugin {

  /** What this start runs, chosen before the plugin loads (choose). */
  private static volatile Screens.Launch launched;

  private final ExecutorService worker =
      Executors.newSingleThreadExecutor(run -> new Thread(run, "crewbox-screens"));

  private final Handler main = new Handler(Looper.getMainLooper());

  /** This build, as Screens checks against it. On the worker, as is all that follows. */
  private Screens.App app;

  /** The version of the screens running, or null when the app's own can't say. */
  private String running;

  /** The event a switch was for, which starts with the screens it switched to once they say they started. */
  private String switchedFor;

  /** Which wait for ready() is the current one: a timer from any other does nothing. */
  private int waiting;

  /** Whether downloaded screens are loading that haven't said they started. */
  private boolean awaiting;

  /** Whether the app is in front. On the main thread. */
  private boolean inFront = true;

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

  private static File root(Context context) {
    return new File(context.getNoBackupFilesDir(), Screens.FOLDER);
  }

  private static File records(Context context) {
    return new File(context.getNoBackupFilesDir(), Records.FOLDER);
  }

  private File root() {
    return root(getContext());
  }

  /**
   * The screens this start runs, for the web view to load, before it loads
   * anything (Screens.launch). The app's own are named too, so that a path
   * anything else once saved for Capacitor can't take their place. Never
   * throws: the app's own always start.
   */
  static ServerPath choose(Context context) {
    String builtIn = builtIn(context);
    Screens.Launch launch;
    try {
      launch = Screens.launch(root(context), records(context), Screens.App.thisBuild(builtIn));
    } catch (RuntimeException e) {
      launch = new Screens.Launch(null, builtIn, null);
    }
    launched = launch;
    return launch.folder != null
        ? new ServerPath(ServerPath.PathType.BASE_PATH, launch.folder.getAbsolutePath())
        : new ServerPath(ServerPath.PathType.ASSET_PATH, Bridge.DEFAULT_WEB_ASSET_DIR);
  }

  @Override
  public void load() {
    Screens.Launch launch = launched;
    worker.execute(() -> {
      app = Screens.App.thisBuild(builtIn(getContext()));
      running = launch != null ? launch.version : app.builtIn;
      if (launch != null && launch.folder != null) waitForReady();
      try {
        Screens.sweep(root(), Screens.inUse(root(), records(getContext()), app, running));
      } catch (RuntimeException e) {
        // Swept at the next start instead: nothing kept is in this one's way.
      }
    });
  }

  @Override
  protected void handleOnResume() {
    inFront = true;
    onWorker(() -> {
      if (awaiting) waitForReady();
    });
  }

  @Override
  protected void handleOnPause() {
    inFront = false;
  }

  @Override
  protected void handleOnDestroy() {
    main.removeCallbacksAndMessages(null);
    worker.shutdownNow();
  }

  private void onWorker(Runnable run) {
    try {
      worker.execute(run);
    } catch (RejectedExecutionException e) {
      // The app is closing, and nothing more is to be done.
    }
  }

  /**
   * On the worker: give the screens that are loading READY_WITHIN_MS in front
   * to say they started. Out of sight when it runs out, the wait begins again
   * once the app is back (handleOnResume).
   */
  private void waitForReady() {
    int wait = ++waiting;
    awaiting = true;
    main.postDelayed(
        () -> {
          if (inFront) onWorker(() -> waited(wait));
        },
        Screens.READY_WITHIN_MS);
  }

  private void waited(int wait) {
    if (wait == waiting && awaiting) goBack();
  }

  /** Downloaded screens that never said they started: the app's own from now on, at once. */
  private void goBack() {
    String failed = running;
    waiting++;
    awaiting = false;
    switchedFor = null;
    running = app.builtIn;
    try {
      Screens.failed(root(), app, failed);
    } catch (IOException | RuntimeException e) {
      // Their start was counted, so the next start fails them.
    }
    main.post(() -> {
      getBridge().getLocalServer().hostAssets(Bridge.DEFAULT_WEB_ASSET_DIR);
      getBridge().getWebView().reload();
    });
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
      return Screens.prepare(path -> open(base, path), root(), app, files::getUsableSpace, running);
    } catch (RuntimeException e) {
      // Whatever went wrong, the page gets an answer: an unanswered call
      // would leave it waiting for good.
      return Screens.Answer.failed(String.valueOf(e));
    }
  }

  /**
   * Serve `version` for `event` once the page reloads, which it does as soon
   * as this resolves: the app's own screens when they are that version, and
   * otherwise its kept folder, checked again. Rejects, and changes nothing,
   * when this build won't run them. The event starts with them from then on
   * once they say they started.
   */
  @PluginMethod
  public void use(PluginCall call) {
    String event = call.getString("event");
    String version = call.getString("version");
    if (!Records.isEvent(event) || version == null) {
      call.reject("An event and a version are needed");
      return;
    }
    try {
      worker.execute(() -> switchTo(call, event, version));
    } catch (RejectedExecutionException e) {
      call.reject("The app is closing");
    }
  }

  private void switchTo(PluginCall call, String event, String version) {
    File folder;
    try {
      folder = Screens.use(root(), app, version);
    } catch (Screens.Refused | IOException | RuntimeException e) {
      call.reject(e.getMessage());
      return;
    }
    switchedFor = event;
    running = version;
    if (folder != null) {
      waitForReady();
    } else {
      waiting++;
      awaiting = false;
    }
    main.post(() -> {
      if (folder != null) getBridge().getLocalServer().hostFiles(folder.getAbsolutePath());
      else getBridge().getLocalServer().hostAssets(Bridge.DEFAULT_WEB_ASSET_DIR);
      call.resolve();
    });
  }

  /**
   * The page has drawn: screens that say they are `version` started. Ignored
   * unless they are the screens running, since a page on its way out can
   * still call.
   */
  @PluginMethod
  public void ready(PluginCall call) {
    String version = call.getString("version");
    try {
      worker.execute(() -> started(call, version));
    } catch (RejectedExecutionException e) {
      call.resolve();
    }
  }

  private void started(PluginCall call, String version) {
    if (version == null || !version.equals(running)) {
      call.resolve();
      return;
    }
    waiting++;
    awaiting = false;
    String event = switchedFor;
    switchedFor = null;
    try {
      Screens.started(root(), records(getContext()), app, version, event);
    } catch (IOException | RuntimeException e) {
      // Counted again at the next start, which runs what the event started with before.
    }
    // Back from here goes nowhere the screens before the switch were.
    if (event != null) main.post(() -> getBridge().getWebView().clearHistory());
    call.resolve();
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
  private static String builtIn(Context context) {
    try (InputStream in = context.getAssets().open("public/" + Screens.INFO)) {
      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      byte[] buffer = new byte[4096];
      for (int n = in.read(buffer); n != -1; n = in.read(buffer)) bytes.write(buffer, 0, n);
      return Screens.readInfo(bytes.toByteArray()).version;
    } catch (IOException | Screens.Refused e) {
      return null;
    }
  }
}
