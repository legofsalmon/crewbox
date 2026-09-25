package com.colmhewson.crewbox;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import android.service.notification.StatusBarNotification;

import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.content.pm.ShortcutInfoCompat;
import androidx.core.content.pm.ShortcutManagerCompat;
import androidx.core.graphics.drawable.IconCompat;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import org.json.JSONArray;
import org.json.JSONObject;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Foreground service that keeps its own WebSocket to the crew server and
 * raises local notifications for messages while the app is backgrounded.
 * This is the whole point of Phase 5: offline-LAN lock-screen alerts that
 * web push can never deliver without internet.
 *
 * A box that decides alerts (`alerts` in its /api/config) is spoken to on
 * /ws/alerts (docs/ALERTS.md): it proves which event it is before it sees a
 * token, then says what to post, and takes back what is read or no longer
 * true. An older box gets today's /ws and the service's own rules, checked
 * again at every connection so a box updated mid-show is picked up.
 */
public class AlertsService extends Service {
  public static final String EXTRA_SERVER = "serverUrl";
  public static final String EXTRA_TOKEN = "token";
  public static final String EXTRA_SESSION = "session";
  public static final String EXTRA_MY_NAME = "myName";
  public static final String EXTRA_EVENT_ID = "eventId";
  public static final String EXTRA_EVENT_KEY = "eventKey";
  /** A start with nothing new: carry on with what was kept (BootReceiver). */
  static final String ACTION_RESUME = "com.colmhewson.crewbox.alerts.RESUME";

  private static final String CH_SERVICE = "service";
  private static final String CH_MESSAGES = AlertNotice.CH_MESSAGES;
  private static final String CH_MENTIONS = AlertNotice.CH_MENTIONS;
  private static final int NOTIF_FOREGROUND = 1;
  /** Every alert from the box is posted under this id, with the alert's id as its tag. */
  private static final int NOTIF_ALERT = 2;
  /** The stage countdown the person put on the lock screen. */
  private static final int NOTIF_COUNTDOWN = 3;
  /** Stage countdown: ongoing, low, and promoted to a Live Update where Android can. */
  static final String CH_COUNTDOWN = "countdown";
  /** In an alert notification's extras: its channel and seq, for a `read`. */
  private static final String EXTRA_ALERT_CHANNEL = "crewbox.channelId";
  private static final String EXTRA_ALERT_SEQ = "crewbox.seq";
  private static final long RETRY_MS = 5000;
  /**
   * Longest gap between reconnect attempts.
   *
   * Five seconds for ever is right while a phone is walking past a dead AP
   * and wrong once the box has been off for an hour: every attempt brings the
   * radio up, and a battery is what it costs. (No wake lock is held: while
   * the phone sleeps, attempts wait for it to wake.)
   */
  private static final long MAX_RETRY_MS = 60_000;

  /**
   * Where the last start's arguments live, so a restart can use them.
   *
   * `START_STICKY` brings the service back with a null intent after the OS
   * has killed it. With nothing to read, it posted its foreground
   * notification, found no server address, and sat on "Connecting to crew
   * server…" for the rest of the shift — connected to nothing, alerting
   * nobody, and looking exactly like a service that is working.
   *
   * Not the token itself: the name of the sign-in, which Sessions keeps
   * sealed, so the phone holds one copy of it at rest and not two.
   */
  private static final String PREFS = "crewbox-alerts";
  private static final String PREF_SERVER = "serverUrl";
  private static final String PREF_SESSION = "session";
  private static final String PREF_NAME = "myName";
  private static final String PREF_EVENT_ID = "eventId";
  private static final String PREF_EVENT_KEY = "eventKey";
  /** The largest `t` heard from the box, for the next hello's `since`. */
  private static final String PREF_SINCE = "since";
  /** The stage whose countdown is on the lock screen, or absent. */
  private static final String PREF_COUNTDOWN = "countdown";
  /** Where the token itself was, before Sessions kept it. Only ever removed now. */
  private static final String PREF_OLD_TOKEN = "token";

  /**
   * Set by AlertsPlugin from the activity's life cycle. While the app is on
   * screen the page announces messages itself, so only show stops and
   * changeover calls are posted.
   */
  public static volatile boolean appVisible = false;

  /** The running service, for the plugin to tell about the countdown; null when none runs. */
  private static volatile AlertsService running;

  private final Handler handler = new Handler(Looper.getMainLooper());
  private OkHttpClient http;
  private WebSocket ws;
  private boolean stopped = false;

  /**
   * Which attempt the live socket belongs to.
   *
   * Every socket's listener carries the number it was opened under, and a
   * callback from an older one is dropped. Without it a superseded socket
   * was still a live connection with a live listener: it raised its own
   * notifications, and when it eventually failed it scheduled a reconnect of
   * its own, so a phone that had moved between two APs on a site spent the
   * rest of the show doubling its connections and its buzzes.
   *
   * Written on the main thread and read from OkHttp's, hence volatile. Every
   * callback below hands its work to the handler for the same reason: the
   * maps this service keeps are then touched by one thread only, and a
   * handover between two sockets cannot interleave in them.
   */
  private volatile int generation = 0;

  /**
   * The pending reconnect, held so it can be cancelled.
   *
   * A method reference is a fresh object each time it is written, so
   * `removeCallbacks(this::connect)` cancels nothing — one field, reused.
   */
  private final Runnable reconnect = this::connect;

  /** Current gap before the next reconnect attempt; doubles on each failure. */
  private long retryMs = RETRY_MS;

  /** Whether the live socket has had its welcome, the one proof it works. */
  private boolean welcomed = false;

  /**
   * The app's traffic has moved onto the crew Wi-Fi or off it (SiteWifi).
   * An attempt made the old way would wait out a connect timeout or its
   * backoff, up to a minute, so try again now. A socket that works is left
   * alone: it keeps the network it opened on.
   */
  private final Runnable moved = () -> handler.post(() -> {
    if (stopped || welcomed) return;
    retryMs = RETRY_MS;
    connect();
  });

  /**
   * A read of the token waiting on the Keystore, held so a start can cancel
   * it (see `reconnect` on why it is a field).
   */
  private final Runnable readAgain = this::readToken;

  private String serverUrl = "";
  private String token = "";
  /** The name the app keeps the token under (Sessions). */
  private String session = "";
  private String myName = "";
  private String myId = "";
  /** The event this service signed in to, and the key its box proves itself with. */
  private String eventId = "";
  private String eventKey = "";
  /** The largest `t` heard from the box, or 0 before anything was. */
  private long since = 0;
  /** The box's last word on the followed stages (`stages`), or null before any. */
  private JsonElement stages;
  private Pattern mentionPattern;

  /** channelId → name, for notification titles. */
  private final Map<String, String> channelNames = new HashMap<>();
  /** channelId → kind ('public'/'dm'). */
  private final Map<String, String> channelKinds = new HashMap<>();
  /** channelId → last seq we consider "seen" (welcome baseline, then live). */
  private final Map<String, Long> lastSeq = new HashMap<>();
  /** userId → display name, for notification titles. */
  private final Map<String, String> userNames = new HashMap<>();
  private int nextNotifId = 100;

  @Override
  public void onCreate() {
    super.onCreate();
    http = new OkHttpClient.Builder().pingInterval(15, TimeUnit.SECONDS).build();
    createChannels();
    SiteWifi.get(this).hear(moved);
    running = this;
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    // A start brings what a read still waiting on the Keystore was for.
    handler.removeCallbacks(readAgain);
    if (intent != null && !ACTION_RESUME.equals(intent.getAction())) {
      serverUrl = stringExtra(intent, EXTRA_SERVER);
      token = stringExtra(intent, EXTRA_TOKEN);
      session = stringExtra(intent, EXTRA_SESSION);
      myName = stringExtra(intent, EXTRA_MY_NAME);
      String event = stringExtra(intent, EXTRA_EVENT_ID);
      // Another event's box: nothing heard from the last one counts here.
      if (!event.equals(prefs.getString(PREF_EVENT_ID, ""))) since = 0;
      else since = Math.max(since, prefs.getLong(PREF_SINCE, 0));
      eventId = event;
      eventKey = stringExtra(intent, EXTRA_EVENT_KEY);
      prefs.edit()
          .putString(PREF_SERVER, serverUrl)
          .putString(PREF_SESSION, session)
          .putString(PREF_NAME, myName)
          .putString(PREF_EVENT_ID, eventId)
          .putString(PREF_EVENT_KEY, eventKey)
          .putLong(PREF_SINCE, since)
          .apply();
    } else {
      // A restart the OS asked for, or the boot receiver's. Everything this
      // service needs came in on an intent it no longer has, and the token
      // is where the app keeps it.
      serverUrl = prefs.getString(PREF_SERVER, "");
      session = prefs.getString(PREF_SESSION, "");
      myName = prefs.getString(PREF_NAME, "");
      eventId = prefs.getString(PREF_EVENT_ID, "");
      eventKey = prefs.getString(PREF_EVENT_KEY, "");
      since = prefs.getLong(PREF_SINCE, 0);
      try {
        String kept = serverUrl.isEmpty() ? null : Sessions.get(this, session);
        token = kept == null ? "" : kept;
      } catch (KeystoreCalls.NotNow e) {
        // The Keystore didn't answer, which says nothing about the sign-in.
        // Forgetting it here left alerts off until somebody opened the app.
        waitForToken();
        return START_STICKY;
      }
    }
    if (serverUrl.isEmpty() || token.isEmpty()) {
      // Nothing to connect to: a restart before anybody has ever signed in,
      // after a sign-out cleared the credentials, or after the page forgot
      // the event. Stop, rather than holding a foreground notification that
      // says "Connecting" for ever. The app starts the service again with a
      // fresh token when somebody signs in.
      forgetCredentials(this);
      stopSelf();
      return START_NOT_STICKY;
    }
    begin();
    return START_STICKY;
  }

  /** Connect with the credentials in hand. */
  private void begin() {
    mentionPattern = Mentions.forName(myName);
    stopped = false;
    retryMs = RETRY_MS;
    startForeground(NOTIF_FOREGROUND, serviceNotification("Connecting to crew server…"));
    // Every start is a fresh attempt, including the redeliveries START_STICKY
    // brings after the OS has killed us, and the plugin's own restart when
    // the crew member signs in again with a new token. Once the app's traffic
    // for the box is on its Wi-Fi: a restart Android makes on its own has no
    // page to say so, and a first attempt over mobile data would only fail
    // and wait out a retry.
    SiteWifi siteWifi = SiteWifi.get(this);
    siteWifi.start(serverUrl);
    siteWifi.whenSettled(onWifi -> handler.post(this::connect));
  }

  /**
   * A restart found the Keystore not answering. The service says it is
   * connecting, which it will be, and reads the token again, backing off as
   * a reconnect does.
   */
  private void waitForToken() {
    token = "";
    stopped = false;
    retryMs = RETRY_MS;
    startForeground(NOTIF_FOREGROUND, serviceNotification("Connecting to crew server…"));
    handler.postDelayed(readAgain, retryMs);
  }

  private void readToken() {
    if (stopped) return;
    String kept;
    try {
      kept = Sessions.get(this, session);
    } catch (KeystoreCalls.NotNow e) {
      retryMs = Math.min(MAX_RETRY_MS, retryMs * 2);
      handler.postDelayed(readAgain, retryMs);
      return;
    }
    if (kept == null) {
      // Gone while it waited: the page forgot the event, or the Keystore
      // lost its key. The app starts the service again at the next sign-in.
      forgetCredentials(this);
      stopForeground(STOP_FOREGROUND_REMOVE);
      stopSelf();
      return;
    }
    token = kept;
    begin();
  }

  /** Forget the credentials, so a sticky restart does not use a dead token. */
  private static void forgetCredentials(Context ctx) {
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
        .remove(PREF_SERVER)
        .remove(PREF_SESSION)
        .remove(PREF_NAME)
        .remove(PREF_EVENT_ID)
        .remove(PREF_EVENT_KEY)
        .remove(PREF_SINCE)
        .remove(PREF_COUNTDOWN)
        .remove(PREF_OLD_TOKEN)
        .apply();
  }

  /**
   * The token as this service kept it before Sessions did, from a version of
   * the app before this. MainActivity drops it at every start: the page's
   * first start in this version moves its sign-ins across, and starts this
   * service again with the name.
   */
  static void forgetOldToken(Context ctx) {
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(PREF_OLD_TOKEN).apply();
  }

  @Override
  public void onDestroy() {
    SiteWifi.get(this).stopHearing(moved);
    if (running == this) running = null;
    // Nothing keeps it current now. A restart brings it back.
    getSystemService(NotificationManager.class).cancel(NOTIF_COUNTDOWN);
    stopped = true;
    generation++;
    closeCurrent("service stopped");
    // And every socket that is not the current one.
    //
    // `generation` stops a superseded socket's callbacks from *acting*, but
    // the socket itself stays open — so after a sign-out the service was
    // gone while its abandoned connections were still on the box's presence
    // list, and still receiving the previous crew member's messages. This is
    // the only call that reaches them.
    http.dispatcher().cancelAll();
    handler.removeCallbacksAndMessages(null);
    super.onDestroy();
  }

  /**
   * The box has refused this token, and no amount of retrying will help.
   *
   * A deleted account, an expired session, a box restored from a backup
   * taken before this crew member joined. The service used to reconnect
   * every five seconds for the rest of the shift, showing "Reconnecting to
   * crew server…" — a notification that reads like a network problem and is
   * not one. Stop, clear the notification, and let the app start us again
   * with a fresh token when somebody signs in.
   */
  private void authRejected() {
    stopped = true;
    generation++;
    handler.removeCallbacks(reconnect);
    closeCurrent("auth rejected");
    forgetCredentials(this);
    stopForeground(true);
    stopSelf();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  // -- connection -----------------------------------------------------------

  /** Drop whatever socket we currently hold, if any. */
  private void closeCurrent(String why) {
    WebSocket previous = ws;
    ws = null;
    if (previous != null) previous.close(1000, why);
  }

  private void connect() {
    // No token while it waits on the Keystore (waitForToken), when a move to
    // or from the Wi-Fi can still call this: a hello without one would have
    // the box refuse it, and the service forget the sign-in it waits for.
    if (stopped || serverUrl.isEmpty() || token.isEmpty()) return;
    // Anything already open, and any reconnect already queued, belongs to a
    // previous attempt and is abandoned here — one socket at a time is the
    // whole invariant.
    handler.removeCallbacks(reconnect);
    generation++;
    final int mine = generation;
    closeCurrent("replaced");
    welcomed = false;

    // Which socket: the box's /api/config says whether it decides alerts.
    // An older box has no /ws/alerts and drops the upgrade without a word,
    // which looks like a network fault, so this is asked first, every time.
    Request config = new Request.Builder().url(serverUrl + "/api/config").build();
    http.newCall(config).enqueue(new okhttp3.Callback() {
      @Override
      public void onFailure(okhttp3.Call call, java.io.IOException e) {
        handler.post(() -> scheduleReconnect(mine));
      }

      @Override
      public void onResponse(okhttp3.Call call, Response response) {
        boolean decides = false;
        boolean answered = response.isSuccessful();
        try (Response closing = response) {
          if (answered && closing.body() != null) {
            JsonObject body = JsonParser.parseString(closing.body().string()).getAsJsonObject();
            decides = body.has("alerts") && body.get("alerts").getAsInt() >= 1;
          }
        } catch (Exception e) {
          answered = false;
        }
        final boolean alerts = decides;
        final boolean ok = answered;
        handler.post(() -> {
          if (mine != generation || stopped) return;
          if (!ok) scheduleReconnect(mine);
          // Without the event it signed in to (a page older than this build)
          // there is nothing for a box to prove, so the old rules stand.
          else if (alerts && !eventId.isEmpty()) openAlerts(mine);
          else openChat(mine);
        });
      }
    });
  }

  /** Today's /ws, for a box that doesn't decide alerts. The service's own rules. */
  private void openChat(final int mine) {
    String wsBase = serverUrl.replaceFirst("^http", "ws");
    Request request = new Request.Builder().url(wsBase + "/ws").build();
    ws = http.newWebSocket(request, new WebSocketListener() {
      @Override
      public void onOpen(WebSocket socket, Response response) {
        if (mine != generation) {
          socket.close(1000, "superseded");
          return;
        }
        try {
          JSONObject hello = new JSONObject();
          hello.put("type", "hello");
          hello.put("token", token);
          // The cursors this service already has.
          //
          // It sent `{}` while tracking `lastSeq` per channel, so every
          // reconnect asked the box for the maximal welcome — up to a couple
          // of hundred kilobytes of messages it deliberately throws away
          // (see the baseline in `handleMessage`). A phone at the edge of an
          // access point does that every few seconds, and the box builds and
          // serialises every one of them.
          JSONObject cursors = new JSONObject();
          for (Map.Entry<String, Long> entry : lastSeq.entrySet()) {
            cursors.put(entry.getKey(), entry.getValue());
          }
          hello.put("cursors", cursors);
          socket.send(hello.toString());
        } catch (Exception ignored) {
        }
      }

      @Override
      public void onMessage(WebSocket socket, String text) {
        // A superseded socket must not raise notifications: its frames are
        // the same messages the live one is already delivering.
        handler.post(() -> {
          if (mine != generation) return;
          handleMessage(text);
        });
      }

      @Override
      public void onFailure(WebSocket socket, Throwable t, Response response) {
        handler.post(() -> scheduleReconnect(mine));
      }

      @Override
      public void onClosed(WebSocket socket, int code, String reason) {
        handler.post(() -> {
          if (mine != generation) return;
          // 4001 is the box saying this token is finished — see the hub's
          // `disconnectUser` and its auth error. Retrying is pointless and
          // the notification saying we are trying is worse than pointless.
          if (code == 4001) {
            authRejected();
            return;
          }
          scheduleReconnect(mine);
        });
      }
    });
  }

  /**
   * /ws/alerts: the box proves which event it is, then says what to post
   * (docs/ALERTS.md).
   */
  private void openAlerts(final int mine) {
    byte[] challenge = new byte[16];
    new SecureRandom().nextBytes(challenge);
    final String nonce = Base64.getUrlEncoder().withoutPadding().encodeToString(challenge);
    final String host = BoxProof.hostOf(serverUrl);
    String wsBase = serverUrl.replaceFirst("^http", "ws");
    Request request = new Request.Builder().url(wsBase + "/ws/alerts?nonce=" + nonce).build();
    ws = http.newWebSocket(request, new WebSocketListener() {
      /** Whether the box has proved itself on this socket, so the token has gone. */
      private boolean proven = false;

      @Override
      public void onMessage(WebSocket socket, String text) {
        handler.post(() -> {
          if (mine != generation) return;
          JsonObject frame;
          try {
            frame = JsonParser.parseString(text).getAsJsonObject();
          } catch (RuntimeException e) {
            return;
          }
          if (!proven) {
            if (!"box".equals(textOf(frame, "type"))) return;
            BoxProof.Verdict verdict = BoxProof.check(
                eventId, eventKey, host, nonce, textOf(frame, "eventId"), textOf(frame, "signature"));
            if (verdict != BoxProof.Verdict.PROVEN && verdict != BoxProof.Verdict.SAME_EVENT) {
              // Not this event's box, or it wouldn't prove it: it never sees
              // the token. Tried again later, since the right box may come
              // back to the address.
              socket.close(1000, "not this event's box");
              updateServiceNotification("Waiting for this event's crew box…");
              return;
            }
            proven = true;
            socket.send(hello());
            return;
          }
          onAlertsFrame(socket, frame);
        });
      }

      @Override
      public void onFailure(WebSocket socket, Throwable t, Response response) {
        handler.post(() -> scheduleReconnect(mine));
      }

      @Override
      public void onClosed(WebSocket socket, int code, String reason) {
        handler.post(() -> {
          if (mine != generation) return;
          if (code == 4001) {
            authRejected();
            return;
          }
          scheduleReconnect(mine);
        });
      }
    });
  }

  private String hello() {
    JsonObject hello = new JsonObject();
    hello.addProperty("type", "hello");
    hello.addProperty("token", token);
    if (since > 0) hello.addProperty("since", since);
    else hello.add("since", com.google.gson.JsonNull.INSTANCE);
    hello.addProperty("timeZone", TimeZone.getDefault().getID());
    return hello.toString();
  }

  private void onAlertsFrame(WebSocket socket, JsonObject frame) {
    heard(frame);
    switch (textOf(frame, "type")) {
      case "welcome": {
        updateServiceNotification("Connected to crew server");
        retryMs = RETRY_MS;
        welcomed = true;
        stages = frame.get("stages");
        showCountdown();
        JsonElement catchUp = frame.get("catchUp");
        if (catchUp != null && catchUp.isJsonArray()) {
          for (JsonElement alert : catchUp.getAsJsonArray()) {
            if (alert.isJsonObject()) post(alert.getAsJsonObject());
          }
        }
        break;
      }
      case "alert":
        if (frame.has("alert") && frame.get("alert").isJsonObject()) {
          post(frame.getAsJsonObject("alert"));
        }
        break;
      case "read":
        takeBackRead(textOf(frame, "channelId"), longOf(frame, "seq"));
        break;
      case "withdraw": {
        JsonElement ids = frame.get("ids");
        if (ids != null && ids.isJsonArray()) {
          NotificationManager nm = getSystemService(NotificationManager.class);
          for (JsonElement id : ids.getAsJsonArray()) {
            if (id.isJsonPrimitive()) nm.cancel(id.getAsString(), NOTIF_ALERT);
          }
        }
        break;
      }
      case "stages":
        stages = frame.get("stages");
        showCountdown();
        break;
      case "beat": {
        JsonObject answer = new JsonObject();
        answer.addProperty("type", "beat");
        answer.add("t", frame.get("t"));
        socket.send(answer.toString());
        break;
      }
      default:
        // `settings`, and whatever a newer box sends: nothing to
        // post. A frame this build doesn't know is skipped, never an error.
    }
  }

  /**
   * The stage countdown, posted again from the box's latest `stages`.
   *
   * One ongoing notification that counts by itself: a chronometer to the
   * next change, from API 24. On Android 16 QPR2 and later it asks to be a
   * Live Update, and the status bar chip counts too; elsewhere, or with the
   * person's promotion turned off, it is an ordinary ongoing notification.
   * It goes when its stage has nothing on and nothing next, or is no longer
   * followed.
   */
  private void showCountdown() {
    NotificationManager nm = getSystemService(NotificationManager.class);
    String stage = getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(PREF_COUNTDOWN, "");
    if (stage.isEmpty()) {
      nm.cancel(NOTIF_COUNTDOWN);
      return;
    }
    // Before the box has said anything: leave the choice alone.
    if (stages == null) return;
    Countdown countdown = Countdown.of(stages, stage, TimeZone.getDefault());
    if (countdown == null) {
      nm.cancel(NOTIF_COUNTDOWN);
      getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(PREF_COUNTDOWN).apply();
      return;
    }
    String link = AlertNotice.stageLink(eventId, stage);
    NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CH_COUNTDOWN)
        .setSmallIcon(R.drawable.ic_stat_crewbox)
        .setContentTitle(countdown.title)
        .setContentText(countdown.text)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setSilent(true)
        .setCategory(NotificationCompat.CATEGORY_EVENT)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .setContentIntent(openIntent(link))
        .setRequestPromotedOngoing(true);
    if (countdown.target > 0) {
      builder.setWhen(countdown.target)
          .setShowWhen(true)
          .setUsesChronometer(true)
          .setChronometerCountDown(true);
    }
    nm.notify(NOTIF_COUNTDOWN, builder.build());
  }

  /** The stage whose countdown is on the lock screen, or "" for none. */
  static String countdownStage(Context ctx) {
    return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(PREF_COUNTDOWN, "");
  }

  /** Put a stage's countdown on the lock screen, or take it off with "". */
  static void setCountdownStage(Context ctx, String stage) {
    SharedPreferences.Editor prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
    if (stage.isEmpty()) prefs.remove(PREF_COUNTDOWN);
    else prefs.putString(PREF_COUNTDOWN, stage);
    prefs.commit();
    AlertsService service = running;
    if (service != null) service.handler.post(service::showCountdown);
    else if (stage.isEmpty()) {
      ctx.getSystemService(NotificationManager.class).cancel(NOTIF_COUNTDOWN);
    }
  }

  /** Every frame carries the box's clock; the largest is the next hello's `since`. */
  private void heard(JsonObject frame) {
    long t = longOf(frame, "t");
    if (t <= since) return;
    since = t;
    getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong(PREF_SINCE, since).apply();
  }

  /** The person read the channel somewhere: take back what that covers. */
  private void takeBackRead(String channelId, long seq) {
    NotificationManager nm = getSystemService(NotificationManager.class);
    for (StatusBarNotification posted : nm.getActiveNotifications()) {
      if (posted.getId() != NOTIF_ALERT || posted.getTag() == null) continue;
      Bundle extras = posted.getNotification().extras;
      String channel = extras.getString(EXTRA_ALERT_CHANNEL, "");
      long at = extras.getLong(EXTRA_ALERT_SEQ, 0);
      if (AlertNotice.readCovers(channel, at, channelId, seq)) nm.cancel(posted.getTag(), NOTIF_ALERT);
    }
  }

  /** Post one alert the box sent. The alert's id is the tag, so a repeat replaces it. */
  private void post(JsonObject alert) {
    AlertNotice notice = AlertNotice.from(alert, eventId);
    if (notice == null) return;
    if (appVisible && !notice.postWhileVisible()) return;
    PendingIntent tap = openIntent(notice.link);
    NotificationCompat.Builder builder = new NotificationCompat.Builder(this, notice.channel)
        .setSmallIcon(R.drawable.ic_stat_crewbox)
        .setContentTitle(notice.title)
        .setContentText(notice.body)
        .setWhen(notice.at > 0 ? notice.at : System.currentTimeMillis())
        .setShowWhen(true)
        .setAutoCancel(true)
        .setContentIntent(tap)
        .setSilent(notice.silent)
        .setOnlyAlertOnce(true);
    // Android 7 has no channels: without a priority a mention doesn't pop up.
    switch (notice.channel) {
      case AlertNotice.CH_SHOW_STOP:
        builder.setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(notice.body));
        break;
      case AlertNotice.CH_CHANGEOVER:
        builder.setCategory(NotificationCompat.CATEGORY_EVENT)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(notice.body));
        break;
      default:
        builder.setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(AlertNotice.CH_MENTIONS.equals(notice.channel)
                ? NotificationCompat.PRIORITY_HIGH
                : NotificationCompat.PRIORITY_DEFAULT);
    }
    if (notice.conversation) asConversation(builder, notice);
    Bundle extras = new Bundle();
    extras.putString(EXTRA_ALERT_CHANNEL, notice.channelId);
    extras.putLong(EXTRA_ALERT_SEQ, notice.seq);
    builder.addExtras(extras);
    getSystemService(NotificationManager.class).notify(notice.id, NOTIF_ALERT, builder.build());
  }

  /**
   * A message, as a conversation: MessagingStyle with the sender, tied to a
   * long-lived shortcut for its channel or DM. On Android 11 and later that
   * puts it in the conversation section, where a person can mark it
   * Priority, which is what lets it through Do Not Disturb.
   */
  private void asConversation(NotificationCompat.Builder builder, AlertNotice notice) {
    Person me = new Person.Builder().setName(myName.isEmpty() ? "You" : myName).setKey(myId).build();
    Person sender = new Person.Builder()
        .setName(notice.sender.isEmpty() ? notice.conversationTitle() : notice.sender)
        .setKey(notice.sender)
        .build();
    NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(me)
        .setGroupConversation(notice.group)
        .addMessage(notice.body, notice.at > 0 ? notice.at : System.currentTimeMillis(), sender);
    if (notice.group) style.setConversationTitle(notice.conversationTitle());
    builder.setStyle(style);
    try {
      ShortcutInfoCompat.Builder shortcut = new ShortcutInfoCompat.Builder(this, notice.shortcutId)
          .setLongLived(true)
          .setShortLabel(notice.conversationTitle())
          .setIcon(IconCompat.createWithResource(this, R.mipmap.ic_launcher))
          .setIntent(openLink(notice.link));
      if (!notice.group) shortcut.setPerson(sender);
      ShortcutManagerCompat.pushDynamicShortcut(this, shortcut.build());
      builder.setShortcutId(notice.shortcutId);
    } catch (RuntimeException e) {
      // A launcher that refuses shortcuts still gets the notification.
    }
  }

  /** A tap opens the app at the link; each destination its own PendingIntent. */
  private PendingIntent openIntent(String link) {
    return PendingIntent.getActivity(
        this, link.hashCode(), openLink(link),
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  /**
   * Straight to the activity, never through this service (Android 12 blocks
   * that), with the link as the intent's data, which Capacitor's App plugin
   * hands the page as `appUrlOpen` (lib/appLinks.ts).
   */
  private Intent openLink(String link) {
    Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(link), this, MainActivity.class);
    intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
    return intent;
  }

  /** The shortcuts this event's conversations left, gone with its sign-in. */
  private static void forgetShortcuts(Context ctx, String event) {
    if (event.isEmpty()) return;
    try {
      List<String> ids = new ArrayList<>();
      for (ShortcutInfoCompat shortcut
          : ShortcutManagerCompat.getShortcuts(ctx, ShortcutManagerCompat.FLAG_MATCH_DYNAMIC)) {
        if (shortcut.getId().startsWith(event + "/")) ids.add(shortcut.getId());
      }
      if (!ids.isEmpty()) ShortcutManagerCompat.removeLongLivedShortcuts(ctx, ids);
    } catch (RuntimeException ignored) {
    }
  }

  private static String textOf(JsonObject object, String key) {
    JsonElement value = object.get(key);
    return value == null || !value.isJsonPrimitive() ? "" : value.getAsString();
  }

  private static long longOf(JsonObject object, String key) {
    JsonElement value = object.get(key);
    try {
      return value == null || !value.isJsonPrimitive() ? 0 : value.getAsLong();
    } catch (RuntimeException e) {
      return 0;
    }
  }

  private void scheduleReconnect(int from) {
    // Only the socket we are actually using gets to ask for a reconnect. An
    // older one closing is the expected end of its life, not a fault.
    if (stopped || from != generation) return;
    ws = null;
    welcomed = false;
    updateServiceNotification("Reconnecting to crew server…");
    handler.removeCallbacks(reconnect);
    handler.postDelayed(reconnect, retryMs);
    // Backing off. Five seconds for ever is right while somebody walks past
    // a dead access point and wrong once the box has been off for an hour —
    // the radio comes up for every attempt, on a phone that has to last the
    // shift. Reset by a welcome, which is the only proof of a live socket.
    retryMs = Math.min(MAX_RETRY_MS, retryMs * 2);
  }

  // -- protocol -------------------------------------------------------------

  private void handleMessage(String text) {
    try {
      JSONObject msg = new JSONObject(text);
      String type = msg.optString("type");
      if ("welcome".equals(type)) {
        myId = msg.getJSONObject("me").optString("id");
        JSONArray users = msg.getJSONArray("users");
        for (int i = 0; i < users.length(); i++) {
          JSONObject u = users.getJSONObject(i);
          userNames.put(u.optString("id"), u.optString("name"));
        }
        // Baseline from the channel list; deliberately ignore `missed` so a
        // reconnect never floods the tray with old messages.
        JSONArray channels = msg.getJSONArray("channels");
        for (int i = 0; i < channels.length(); i++) {
          JSONObject ch = channels.getJSONObject(i);
          rememberChannel(ch);
          lastSeq.put(ch.optString("id"), ch.optLong("lastSeq", 0));
        }
        updateServiceNotification("Connected to crew server");
        // A welcome is the only proof the socket works, so it is the only
        // thing that gets to say the backoff has done its job.
        retryMs = RETRY_MS;
        welcomed = true;
      } else if ("error".equals(type) && "auth".equals(msg.optString("code"))) {
        // The box refusing the token, said as a frame rather than a close.
        authRejected();
      } else if ("channel".equals(type)) {
        rememberChannel(msg.getJSONObject("channel"));
      } else if ("user".equals(type)) {
        JSONObject u = msg.getJSONObject("user");
        userNames.put(u.optString("id"), u.optString("name"));
      } else if ("msg".equals(type)) {
        onChatMessage(msg.getJSONObject("message"));
      }
    } catch (Exception ignored) {
      // Unparseable frames are someone else's problem; alerts must not crash.
    }
  }

  private void rememberChannel(JSONObject ch) {
    String id = ch.optString("id");
    channelNames.put(id, ch.optString("name"));
    channelKinds.put(id, ch.optString("kind", "public"));
  }

  private void onChatMessage(JSONObject message) {
    String channelId = message.optString("channelId");
    long seq = message.optLong("seq", 0);
    Long known = lastSeq.get(channelId);
    if (known != null && seq <= known) return;
    lastSeq.put(channelId, seq);

    String kind = message.optString("kind");
    String authorId = message.isNull("authorId") ? null : message.optString("authorId");
    if ("system".equals(kind) || authorId == null) return; // joins/renames: no buzz
    if (authorId.equals(myId)) return; // my own message from another device
    if (appVisible) return; // the app itself plays sounds while open

    String body = message.optString("body", "");
    JSONObject file = message.optJSONObject("file");
    if (body.isEmpty() && file != null) body = "📎 " + file.optString("name", "file");

    String author = userNames.get(authorId);
    if (author == null || author.isEmpty()) author = "New message";
    String channelName = channelNames.get(channelId);
    boolean dm = "dm".equals(channelKinds.get(channelId));
    String title = dm || channelName == null || channelName.isEmpty()
        ? author
        : "#" + channelName + " — " + author;

    boolean mention = Mentions.isMentioned(body, mentionPattern);
    notifyMessage(title, body, mention || dm);
  }

  // -- notifications --------------------------------------------------------

  private void createChannels() {
    NotificationManager nm = getSystemService(NotificationManager.class);
    NotificationChannel service = new NotificationChannel(
        CH_SERVICE, "Connection", NotificationManager.IMPORTANCE_MIN);
    service.setShowBadge(false);
    NotificationChannel messages = new NotificationChannel(
        CH_MESSAGES, "Messages", NotificationManager.IMPORTANCE_DEFAULT);
    NotificationChannel mentions = new NotificationChannel(
        CH_MENTIONS, "Mentions & DMs", NotificationManager.IMPORTANCE_HIGH);
    mentions.enableVibration(true);
    // Show stops ring on the alarm stream: through vibrate and silent, and
    // default Do Not Disturb. Once, not on a loop: every phone on site hears
    // it, including those of the people already dealing with it.
    NotificationChannel showStop = new NotificationChannel(
        AlertNotice.CH_SHOW_STOP, "Show stops", NotificationManager.IMPORTANCE_HIGH);
    showStop.setDescription("Show stops and holds, as they are logged. Rings on silent.");
    showStop.setSound(
        RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
        new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build());
    showStop.enableVibration(true);
    showStop.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
    NotificationChannel changeover = new NotificationChannel(
        AlertNotice.CH_CHANGEOVER, "Changeover calls", NotificationManager.IMPORTANCE_HIGH);
    changeover.setDescription("Changeovers on the stages you follow.");
    changeover.enableVibration(true);
    // Low, not Min: a promoted Live Update needs a channel above Min, and
    // the connection's channel is Min and can't be raised.
    NotificationChannel countdown = new NotificationChannel(
        CH_COUNTDOWN, "Stage countdown", NotificationManager.IMPORTANCE_LOW);
    countdown.setDescription("Who is on and who is next, on a stage you put on the lock screen.");
    countdown.setShowBadge(false);
    nm.createNotificationChannel(service);
    nm.createNotificationChannel(messages);
    nm.createNotificationChannel(mentions);
    nm.createNotificationChannel(showStop);
    nm.createNotificationChannel(changeover);
    nm.createNotificationChannel(countdown);
  }

  private PendingIntent openAppIntent() {
    Intent intent = new Intent(this, MainActivity.class);
    intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
    return PendingIntent.getActivity(
        this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  private Notification serviceNotification(String text) {
    return new NotificationCompat.Builder(this, CH_SERVICE)
        .setSmallIcon(R.drawable.ic_stat_crewbox)
        .setContentTitle("Crewbox")
        .setContentText(text)
        .setOngoing(true)
        .setContentIntent(openAppIntent())
        .build();
  }

  private void updateServiceNotification(String text) {
    NotificationManager nm = getSystemService(NotificationManager.class);
    nm.notify(NOTIF_FOREGROUND, serviceNotification(text));
  }

  private void notifyMessage(String title, String body, boolean urgent) {
    NotificationManager nm = getSystemService(NotificationManager.class);
    Notification n = new NotificationCompat.Builder(this, urgent ? CH_MENTIONS : CH_MESSAGES)
        .setSmallIcon(R.drawable.ic_stat_crewbox)
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
        .setAutoCancel(true)
        .setContentIntent(openAppIntent())
        .build();
    nm.notify(nextNotifId++, n);
  }

  private static String stringExtra(Intent intent, String key) {
    String v = intent.getStringExtra(key);
    return v == null ? "" : v;
  }

  static void start(
      Context ctx,
      String serverUrl,
      String token,
      String session,
      String myName,
      String eventId,
      String eventKey) {
    Intent intent = new Intent(ctx, AlertsService.class);
    intent.putExtra(EXTRA_EVENT_ID, eventId);
    intent.putExtra(EXTRA_EVENT_KEY, eventKey);
    intent.putExtra(EXTRA_SERVER, serverUrl);
    intent.putExtra(EXTRA_TOKEN, token);
    intent.putExtra(EXTRA_SESSION, session);
    intent.putExtra(EXTRA_MY_NAME, myName);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent);
    else ctx.startService(intent);
  }

  /**
   * Whether alerts were on when the phone went down: a sign-in the service
   * was given and has not been told to forget.
   */
  static boolean wasOn(Context ctx) {
    SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    return BootReceiver.shouldResume(
        prefs.getString(PREF_SERVER, ""), prefs.getString(PREF_SESSION, ""));
  }

  /** Carry on with the kept sign-in, after a reboot or an update. */
  static void resume(Context ctx) {
    Intent intent = new Intent(ctx, AlertsService.class).setAction(ACTION_RESUME);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent);
    else ctx.startService(intent);
  }

  static void stop(Context ctx) {
    // Signing out ends the token, so the copy kept for sticky restarts goes
    // with it — a phone handed to the next shift should not still hold the
    // last person's session. Here rather than in `onDestroy`, which also
    // runs when the OS kills a service it intends to bring back, and that is
    // the case the stored copy exists for.
    forgetShortcuts(
        ctx, ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(PREF_EVENT_ID, ""));
    forgetCredentials(ctx);
    ctx.stopService(new Intent(ctx, AlertsService.class));
  }
}
