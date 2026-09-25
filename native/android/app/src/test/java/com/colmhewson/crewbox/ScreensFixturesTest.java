package com.colmhewson.crewbox;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;

import org.junit.BeforeClass;
import org.junit.Test;

/**
 * The cases in screens-fixtures.json, which scripts/screens-fixtures.mjs
 * writes and the release's own rules are held to as well
 * (server/test/screensFixtures.test.mjs). A case the phone answers
 * differently is screens a release signs and a phone refuses, or the reverse.
 */
public class ScreensFixturesTest {

  private static JsonObject fixtures;

  @BeforeClass
  public static void read() throws IOException {
    try (InputStream in = ScreensFixturesTest.class.getResourceAsStream("/screens-fixtures.json")) {
      assertNotNull("screens-fixtures.json is on the test classpath", in);
      fixtures =
          JsonParser.parseReader(new InputStreamReader(in, StandardCharsets.UTF_8))
              .getAsJsonObject();
    }
  }

  private static List<JsonObject> cases(String section) {
    List<JsonObject> cases = new ArrayList<>();
    for (JsonElement each : fixtures.getAsJsonArray(section)) cases.add(each.getAsJsonObject());
    assertTrue(section + " has cases", cases.size() > 0);
    return cases;
  }

  private static byte[] utf8(JsonObject each, String name) {
    return each.get(name).getAsString().getBytes(StandardCharsets.UTF_8);
  }

  private static String name(JsonObject each) {
    return each.has("name") ? each.get("name").getAsString() : each.toString();
  }

  private static boolean refused(JsonObject each) {
    return each.has("refused") && each.get("refused").getAsBoolean();
  }

  @Test
  public void findsWhichKeySignedAList() {
    for (JsonObject each : cases("signatures")) {
      JsonArray raw = each.getAsJsonArray("keys");
      byte[][] keys = new byte[raw.size()][];
      for (int i = 0; i < keys.length; i++) {
        keys[i] = Base64.getDecoder().decode(raw.get(i).getAsString());
      }
      assertEquals(
          name(each),
          each.get("keyIndex").getAsInt(),
          Screens.signedBy(utf8(each, "sums"), each.get("signature").getAsString(), keys));
    }
  }

  @Test
  public void readsListsAsTheReleaseWritesThem() throws Screens.Refused {
    for (JsonObject each : cases("lists")) {
      byte[] sums = utf8(each, "sums");
      if (refused(each)) {
        assertThrows(name(each), Screens.Refused.class, () -> Screens.parseSums(sums));
        continue;
      }
      List<String> expected = new ArrayList<>();
      for (Map.Entry<String, JsonElement> file : each.getAsJsonObject("files").entrySet()) {
        expected.add(file.getKey() + " " + file.getValue().getAsString());
      }
      List<String> actual = new ArrayList<>();
      for (Map.Entry<String, String> file : Screens.parseSums(sums).entrySet()) {
        actual.add(file.getKey() + " " + file.getValue());
      }
      assertEquals(name(each), expected, actual);
    }
  }

  @Test
  public void readsWhatScreensSayTheyAre() throws Screens.Refused {
    for (JsonObject each : cases("infos")) {
      byte[] text = utf8(each, "text");
      if (refused(each)) {
        assertThrows(name(each), Screens.Refused.class, () -> Screens.readInfo(text));
        continue;
      }
      JsonObject expected = each.getAsJsonObject("info");
      Screens.Info info = Screens.readInfo(text);
      assertEquals(name(each), expected.get("version").getAsString(), info.version);
      assertEquals(name(each), expected.get("protocol").getAsDouble(), info.protocol, 0);
      assertEquals(name(each), expected.get("needs").getAsDouble(), info.needs, 0);
      assertEquals(name(each), expected.get("builtFor").getAsDouble(), info.builtFor, 0);
    }
  }

  @Test
  public void readsWhatABoxOffers() throws Screens.Refused {
    for (JsonObject each : cases("offers")) {
      byte[] text = utf8(each, "text");
      if (refused(each)) {
        assertThrows(name(each), Screens.Refused.class, () -> Screens.readOffer(text));
        continue;
      }
      JsonObject expected = each.getAsJsonObject("offer");
      Screens.Offer offer = Screens.readOffer(text);
      assertEquals(name(each), expected.get("version").getAsString(), offer.version);
      assertEquals(name(each), expected.get("sums").getAsString(), offer.sums);
      assertEquals(name(each), expected.get("signature").getAsString(), offer.signature);
    }
  }

  @Test
  public void knowsAVersionWhenItSeesOne() {
    for (JsonObject each : cases("versions")) {
      String version = each.get("version").getAsString();
      assertEquals(version, each.get("valid").getAsBoolean(), Screens.isVersion(version));
    }
  }

  @Test
  public void comparesAVersionWithTheFloor() {
    for (JsonObject each : cases("floors")) {
      String version = each.get("version").getAsString();
      String floor = each.get("floor").getAsString();
      assertEquals(
          version + " against " + floor,
          each.get("atOrAbove").getAsBoolean(),
          Screens.atOrAbove(version, floor));
    }
  }

  @Test
  public void judgesScreensAsTheReleaseDoes() {
    for (JsonObject each : cases("judgements")) {
      JsonObject said = each.getAsJsonObject("info");
      JsonObject app = each.getAsJsonObject("app");
      Screens.Info info =
          new Screens.Info(
              said.get("version").getAsString(),
              1,
              said.get("needs").getAsDouble(),
              said.get("builtFor").getAsDouble());
      Screens.Answer answer =
          Screens.judge(
              info,
              each.get("version").getAsString(),
              new Screens.App(
                  new byte[0][],
                  app.get("nativeApi").getAsInt(),
                  app.get("oldestScreensApi").getAsInt(),
                  app.get("floor").getAsString(),
                  null));
      String expected = each.get("answer").getAsString();
      if (expected.equals("ready")) {
        assertNull(name(each), answer);
        continue;
      }
      assertNotNull(name(each), answer);
      assertEquals(name(each), expected, answer.result);
      String update = each.has("update") ? each.get("update").getAsString() : null;
      assertEquals(name(each), update, answer.update);
    }
  }

  @Test
  public void decodesOnlyStrictBase64() {
    for (JsonObject each : cases("base64")) {
      String text = each.get("text").getAsString();
      JsonElement hex = each.get("hex");
      byte[] bytes = Screens.base64(text);
      if (hex.isJsonNull()) {
        assertNull("\"" + text + "\"", bytes);
        continue;
      }
      assertArrayEquals("\"" + text + "\"", bytesOf(hex.getAsString()), bytes);
    }
  }

  private static byte[] bytesOf(String hex) {
    byte[] bytes = new byte[hex.length() / 2];
    for (int i = 0; i < bytes.length; i++) {
      bytes[i] = (byte) Integer.parseInt(hex.substring(2 * i, 2 * i + 2), 16);
    }
    return bytes;
  }
}
