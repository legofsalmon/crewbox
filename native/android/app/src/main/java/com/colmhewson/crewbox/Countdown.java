package com.colmhewson.crewbox;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * What the stage countdown on the lock screen says (docs/ALERTS.md, "The
 * countdown"), from one stage of the box's `stages` frame.
 *
 * The box sends instants worked out in this phone's own zone; the phone
 * counts to them with its own clock, and the two clocks are never compared.
 * The notification's chronometer counts to `target`: the end of the set on
 * now while there is one, else the next set's start. Past it, Android shows
 * how far over it is, as the iPhone's Live Activity does.
 *
 * No Android classes, so the JVM tests hold it to the box's fixtures.
 */
final class Countdown {
  final String stage;
  final String title;
  final String text;
  /** The instant the chronometer counts to (epoch ms), or 0 with nothing to count to. */
  final long target;

  private Countdown(String stage, String title, String text, long target) {
    this.stage = stage;
    this.title = title;
    this.text = text;
    this.target = target;
  }

  /**
   * The countdown for `stage`, or null when it has nothing on and nothing
   * next: its show day is over, or the person stopped following it.
   */
  static Countdown of(JsonElement stages, String stage, TimeZone zone) {
    if (stages == null || !stages.isJsonArray()) return null;
    for (JsonElement entry : stages.getAsJsonArray()) {
      if (!entry.isJsonObject()) continue;
      JsonObject countdown = entry.getAsJsonObject();
      if (!stage.equals(text(countdown, "stage"))) continue;
      JsonObject onNow = object(countdown, "onNow");
      JsonObject next = object(countdown, "next");
      if (onNow == null && next == null) return null;
      SimpleDateFormat clock = new SimpleDateFormat("HH:mm", Locale.ROOT);
      clock.setTimeZone(zone);

      String title = onNow != null ? text(onNow, "name") + " on " + stage : stage;
      StringBuilder body = new StringBuilder();
      long target = 0;
      if (onNow != null) {
        long end = number(onNow, "end");
        if (end > 0) {
          body.append("Off at ").append(clock.format(new Date(end)));
          target = end;
        } else {
          body.append("On now");
        }
      }
      if (next != null) {
        long start = number(next, "start");
        if (body.length() > 0) body.append(" · ");
        body.append(text(next, "name")).append(" next at ").append(clock.format(new Date(start)));
        if (target == 0) target = start;
      }
      return new Countdown(stage, title, body.toString(), target);
    }
    return null;
  }

  private static JsonObject object(JsonObject from, String key) {
    JsonElement value = from.get(key);
    return value != null && value.isJsonObject() ? value.getAsJsonObject() : null;
  }

  private static String text(JsonObject from, String key) {
    JsonElement value = from.get(key);
    return value == null || !value.isJsonPrimitive() ? "" : value.getAsString();
  }

  private static long number(JsonObject from, String key) {
    JsonElement value = from.get(key);
    try {
      return value == null || !value.isJsonPrimitive() ? 0 : value.getAsLong();
    } catch (RuntimeException e) {
      return 0;
    }
  }
}
