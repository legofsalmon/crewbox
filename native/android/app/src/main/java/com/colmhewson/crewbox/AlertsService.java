package com.colmhewson.crewbox;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;
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
 */
public class AlertsService extends Service {
  public static final String EXTRA_SERVER = "serverUrl";
  public static final String EXTRA_TOKEN = "token";
  public static final String EXTRA_MY_NAME = "myName";

  private static final String CH_SERVICE = "service";
  private static final String CH_MESSAGES = "messages";
  private static final String CH_MENTIONS = "mentions";
  private static final int NOTIF_FOREGROUND = 1;
  private static final long RETRY_MS = 5000;

  /** Set by AlertsPlugin from activity lifecycle — no alerts while visible. */
  public static volatile boolean appVisible = false;

  private final Handler handler = new Handler(Looper.getMainLooper());
  private OkHttpClient http;
  private WebSocket ws;
  private boolean stopped = false;

  private String serverUrl = "";
  private String token = "";
  private String myName = "";
  private String myId = "";
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
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null) {
      serverUrl = stringExtra(intent, EXTRA_SERVER);
      token = stringExtra(intent, EXTRA_TOKEN);
      myName = stringExtra(intent, EXTRA_MY_NAME);
      mentionPattern = Pattern.compile(
          "@(" + Pattern.quote(myName) + "|all|everyone|channel)", Pattern.CASE_INSENSITIVE);
    }
    startForeground(NOTIF_FOREGROUND, serviceNotification("Connecting to crew server…"));
    connect();
    return START_STICKY;
  }

  @Override
  public void onDestroy() {
    stopped = true;
    if (ws != null) ws.close(1000, "service stopped");
    handler.removeCallbacksAndMessages(null);
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  // -- connection -----------------------------------------------------------

  private void connect() {
    if (stopped || serverUrl.isEmpty()) return;
    String wsBase = serverUrl.replaceFirst("^http", "ws");
    Request request = new Request.Builder().url(wsBase + "/ws").build();
    ws = http.newWebSocket(request, new WebSocketListener() {
      @Override
      public void onOpen(WebSocket socket, Response response) {
        try {
          JSONObject hello = new JSONObject();
          hello.put("type", "hello");
          hello.put("token", token);
          hello.put("cursors", new JSONObject());
          socket.send(hello.toString());
        } catch (Exception ignored) {
        }
      }

      @Override
      public void onMessage(WebSocket socket, String text) {
        handleMessage(text);
      }

      @Override
      public void onFailure(WebSocket socket, Throwable t, Response response) {
        scheduleReconnect();
      }

      @Override
      public void onClosed(WebSocket socket, int code, String reason) {
        scheduleReconnect();
      }
    });
  }

  private void scheduleReconnect() {
    if (stopped) return;
    ws = null;
    updateServiceNotification("Reconnecting to crew server…");
    handler.postDelayed(this::connect, RETRY_MS);
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

    boolean mention = mentionPattern != null && mentionPattern.matcher(body).find();
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
    nm.createNotificationChannel(service);
    nm.createNotificationChannel(messages);
    nm.createNotificationChannel(mentions);
  }

  private PendingIntent openAppIntent() {
    Intent intent = new Intent(this, MainActivity.class);
    intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
    return PendingIntent.getActivity(
        this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  private Notification serviceNotification(String text) {
    return new NotificationCompat.Builder(this, CH_SERVICE)
        .setSmallIcon(R.mipmap.ic_launcher)
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
        .setSmallIcon(R.mipmap.ic_launcher)
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

  static void start(Context ctx, String serverUrl, String token, String myName) {
    Intent intent = new Intent(ctx, AlertsService.class);
    intent.putExtra(EXTRA_SERVER, serverUrl);
    intent.putExtra(EXTRA_TOKEN, token);
    intent.putExtra(EXTRA_MY_NAME, myName);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent);
    else ctx.startService(intent);
  }

  static void stop(Context ctx) {
    ctx.stopService(new Intent(ctx, AlertsService.class));
  }
}
