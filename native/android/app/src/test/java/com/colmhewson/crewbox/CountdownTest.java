package com.colmhewson.crewbox;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.TimeZone;

import org.junit.BeforeClass;
import org.junit.Test;

/** The lock-screen countdown, from the box's `stages` frame in alerts-fixtures.json. */
public class CountdownTest {

  private static JsonElement stages;
  private static final TimeZone LONDON = TimeZone.getTimeZone("Europe/London");

  @BeforeClass
  public static void read() throws IOException {
    try (InputStream in = CountdownTest.class.getResourceAsStream("/alerts-fixtures.json")) {
      assertNotNull(in);
      stages = JsonParser.parseReader(new InputStreamReader(in, StandardCharsets.UTF_8))
          .getAsJsonObject()
          .getAsJsonObject("frames")
          .getAsJsonObject("stages")
          .get("stages");
    }
  }

  @Test
  public void countsToTheEndOfTheSetOnNow() {
    Countdown c = Countdown.of(stages, "Main Stage", LONDON);
    assertNotNull(c);
    assertEquals("Night Bus on Main Stage", c.title);
    // 1780003600000 and 1780005400000 in London, in summer time.
    assertEquals("Off at 22:26 · The Hollows next at 22:56", c.text);
    assertEquals(1780003600000L, c.target);
  }

  @Test
  public void countsToTheNextStartBetweenSets() {
    JsonArray between = stages.deepCopy().getAsJsonArray();
    between.get(0).getAsJsonObject().add("onNow", com.google.gson.JsonNull.INSTANCE);
    Countdown c = Countdown.of(between, "Main Stage", LONDON);
    assertEquals("Main Stage", c.title);
    assertEquals("The Hollows next at 22:56", c.text);
    assertEquals(1780005400000L, c.target);
  }

  @Test
  public void aSetWithNoEndSaysSoAndCountsToTheNext() {
    JsonArray open = stages.deepCopy().getAsJsonArray();
    JsonObject onNow = open.get(0).getAsJsonObject().getAsJsonObject("onNow");
    onNow.add("end", com.google.gson.JsonNull.INSTANCE);
    Countdown c = Countdown.of(open, "Main Stage", LONDON);
    assertEquals("On now · The Hollows next at 22:56", c.text);
    assertEquals(1780005400000L, c.target);
  }

  @Test
  public void aStageWithNothingLeftOrNotFollowedHasNone() {
    JsonArray over = stages.deepCopy().getAsJsonArray();
    over.get(0).getAsJsonObject().add("onNow", com.google.gson.JsonNull.INSTANCE);
    over.get(0).getAsJsonObject().add("next", com.google.gson.JsonNull.INSTANCE);
    assertNull(Countdown.of(over, "Main Stage", LONDON));
    assertNull(Countdown.of(stages, "Tent", LONDON));
    assertNull(Countdown.of(new JsonArray(), "Main Stage", LONDON));
    assertNull(Countdown.of(null, "Main Stage", LONDON));
  }
}
