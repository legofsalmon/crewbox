package com.colmhewson.crewbox;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;

/**
 * How one alert from the box is posted on Android (docs/ALERTS.md): which
 * notification channel, under which tag, whether it sounds, and where a tap
 * goes. The box has already decided that it should be posted at all.
 *
 * No Android classes, so the JVM tests hold it to the same fixtures as the
 * box. The notification channel ids and the shortcut ids are storage names:
 * a person's sound and importance for a channel, and their Priority mark on
 * a conversation, hang on them, so they never change.
 */
final class AlertNotice {
  /** Mentions & DMs: kept from before the box decided. */
  static final String CH_MENTIONS = "mentions";
  /** Messages, for a channel set to All messages: kept. */
  static final String CH_MESSAGES = "messages";
  /** Show stops and holds, on the alarm stream. */
  static final String CH_SHOW_STOP = "showstop";
  /** Changeover calls for the stages a person follows. */
  static final String CH_CHANGEOVER = "changeover";
  /** Cue lights: standby and GO, felt rather than heard. */
  static final String CH_CUES = "cues";
  /** Somebody held the panic button: the alarm stream, as a show stop. */
  static final String CH_PANIC = "panic";

  final String id;
  final String kind;
  final String title;
  final String body;
  final String channel;
  final boolean silent;
  /** A message in a channel or DM: posted as a conversation. */
  final boolean conversation;
  /** A channel with several people, rather than a DM. */
  final boolean group;
  /** Who sent it, for a conversation: the person, or "Production desk". */
  final String sender;
  /** The channel's id, for a message; else empty. */
  final String channelId;
  /** The channel's name, without "#", when the box sent one. */
  final String channelName;
  final long seq;
  final long at;
  /** `<event id>/<channel id>`, for a message; else empty. */
  final String shortcutId;
  /** `crewbox://open?…`: where a tap goes. */
  final String link;

  private AlertNotice(JsonObject alert, String eventId) {
    id = text(alert, "id");
    kind = text(alert, "kind");
    title = text(alert, "title");
    body = text(alert, "body");
    silent = alert.has("quiet") && alert.get("quiet").getAsBoolean();
    at = number(alert, "at");
    seq = number(alert, "seq");
    channelName = text(alert, "channelName");

    JsonObject target = alert.has("target") && alert.get("target").isJsonObject()
        ? alert.getAsJsonObject("target")
        : new JsonObject();
    String to = text(target, "kind");
    boolean panic = "panic".equals(kind);
    // A call for help opens #general, where its record and clip are, but it
    // is not a message in it: never a conversation, and nothing a read of
    // #general should take back.
    String opens = "channel".equals(to) ? text(target, "channelId") : "";
    channelId = panic ? "" : opens;

    switch (kind) {
      case "showStop":
        channel = CH_SHOW_STOP;
        break;
      case "changeover":
        channel = CH_CHANGEOVER;
        break;
      case "cue":
        channel = CH_CUES;
        break;
      case "panic":
        channel = CH_PANIC;
        break;
      case "message":
        channel = CH_MESSAGES;
        break;
      default:
        channel = CH_MENTIONS;
    }

    conversation = !channelId.isEmpty();
    group = conversation && !"dm".equals(kind);
    JsonObject from = alert.has("from") && alert.get("from").isJsonObject()
        ? alert.getAsJsonObject("from")
        : null;
    sender = from != null ? text(from, "name") : "desk".equals(kind) ? "Production desk" : "";
    shortcutId = conversation ? eventId + "/" + channelId : "";

    StringBuilder open = new StringBuilder("crewbox://open?event=").append(encode(eventId));
    if (!opens.isEmpty()) open.append("&channel=").append(encode(opens));
    else if ("showlog".equals(to)) open.append("&to=showlog");
    else if ("cues".equals(to)) open.append("&to=cues");
    else if ("stage".equals(to)) open.append("&stage=").append(encode(text(target, "stage")));
    link = open.toString();
  }

  /** Where a tap on a stage's countdown goes: the running order, at that stage. */
  static String stageLink(String eventId, String stage) {
    return "crewbox://open?event=" + encode(eventId) + "&stage=" + encode(stage);
  }

  /** The alert as posted, or null for one this build can't read. */
  static AlertNotice from(JsonObject alert, String eventId) {
    if (alert == null || text(alert, "id").isEmpty()) return null;
    return new AlertNotice(alert, eventId);
  }

  /**
   * Whether it is posted while the app is on screen. The page announces
   * messages there with its own banner and chirp; a show stop, a
   * changeover call or a call for help is worth the system's own alert even
   * so. A cue light is not: the page lights the whole screen for it.
   */
  boolean postWhileVisible() {
    return CH_SHOW_STOP.equals(channel)
        || CH_CHANGEOVER.equals(channel)
        || CH_PANIC.equals(channel);
  }

  /** What a conversation is called: "#foh", or the other person in a DM. */
  String conversationTitle() {
    if (!group) return sender.isEmpty() ? title : sender;
    return channelName.isEmpty() ? title : "#" + channelName;
  }

  /** Whether a `read` of `readChannel` up to `readSeq` takes back a notification. */
  static boolean readCovers(String channelId, long seq, String readChannel, long readSeq) {
    return !channelId.isEmpty() && channelId.equals(readChannel) && seq > 0 && seq <= readSeq;
  }

  private static String text(JsonObject object, String key) {
    JsonElement value = object.get(key);
    return value == null || value.isJsonNull() || !value.isJsonPrimitive() ? "" : value.getAsString();
  }

  private static long number(JsonObject object, String key) {
    JsonElement value = object.get(key);
    try {
      return value == null || value.isJsonNull() ? 0 : value.getAsLong();
    } catch (RuntimeException e) {
      return 0;
    }
  }

  private static String encode(String value) {
    try {
      return URLEncoder.encode(value, "UTF-8").replace("+", "%20");
    } catch (UnsupportedEncodingException e) {
      return "";
    }
  }
}
