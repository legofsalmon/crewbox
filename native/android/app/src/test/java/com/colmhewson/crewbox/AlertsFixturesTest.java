package com.colmhewson.crewbox;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

import org.junit.BeforeClass;
import org.junit.Test;

/**
 * The service against alerts-fixtures.json, which scripts/alerts-fixtures.mjs
 * writes and the box's own tests are held to (server/test/alerts.test.ts).
 * A box whose signature the phone refuses, or an alert it posts in the wrong
 * place, is a lock screen that stays quiet at a show stop.
 */
public class AlertsFixturesTest {

  private static JsonObject fixtures;

  @BeforeClass
  public static void read() throws IOException {
    try (InputStream in = AlertsFixturesTest.class.getResourceAsStream("/alerts-fixtures.json")) {
      assertNotNull("alerts-fixtures.json is on the test classpath", in);
      fixtures = JsonParser.parseReader(new InputStreamReader(in, StandardCharsets.UTF_8))
          .getAsJsonObject();
    }
  }

  private static JsonObject signed() {
    return fixtures.getAsJsonObject("signed");
  }

  private static JsonObject frame(String name) {
    return fixtures.getAsJsonObject("frames").getAsJsonObject(name);
  }

  private static AlertNotice notice(String frame) {
    return AlertNotice.from(frame(frame).getAsJsonObject("alert"), "evt-3f9c2a");
  }

  // -- the box proves itself --------------------------------------------------

  @Test
  public void theStatementIsTheBoxs() {
    JsonObject s = signed();
    assertEquals(
        s.get("statement").getAsString(),
        BoxProof.statement(
            s.get("eventId").getAsString(), s.get("host").getAsString(), s.get("nonce").getAsString()));
  }

  @Test
  public void aSignatureFromTheBoxVerifies() {
    JsonObject s = signed();
    assertTrue(BoxProof.verify(
        s.get("key").getAsString(), s.get("statement").getAsString(), s.get("signature").getAsString()));
  }

  @Test
  public void theFirstFrameIsProvenForTheAddressAskedAt() {
    JsonObject s = signed();
    JsonObject box = frame("box");
    assertEquals(
        BoxProof.Verdict.PROVEN,
        BoxProof.check(
            s.get("eventId").getAsString(),
            s.get("key").getAsString(),
            s.get("host").getAsString(),
            s.get("nonce").getAsString(),
            box.get("eventId").getAsString(),
            box.get("signature").getAsString()));
  }

  @Test
  public void anotherAddressAnotherNonceOrAnotherKeyIsRefused() {
    JsonObject s = signed();
    String key = s.get("key").getAsString();
    String event = s.get("eventId").getAsString();
    String signature = s.get("signature").getAsString();
    String nonce = s.get("nonce").getAsString();
    assertEquals(BoxProof.Verdict.REFUSED,
        BoxProof.check(event, key, s.get("wrongHost").getAsString(), nonce, event, signature));
    assertEquals(BoxProof.Verdict.REFUSED,
        BoxProof.check(event, key, s.get("host").getAsString(), nonce + "x", event, signature));
    // The same statement, signed by nobody: a flipped byte.
    String flipped = (signature.charAt(0) == 'A' ? "B" : "A") + signature.substring(1);
    assertEquals(BoxProof.Verdict.REFUSED,
        BoxProof.check(event, key, s.get("host").getAsString(), nonce, event, flipped));
    // Unsigned, to a phone that kept a key.
    assertEquals(BoxProof.Verdict.REFUSED,
        BoxProof.check(event, key, s.get("host").getAsString(), nonce, event, ""));
  }

  @Test
  public void anotherEventsBoxNeverSeesTheToken() {
    JsonObject s = signed();
    assertEquals(BoxProof.Verdict.ANOTHER_EVENT,
        BoxProof.check("evt-other", s.get("key").getAsString(), s.get("host").getAsString(),
            s.get("nonce").getAsString(), s.get("eventId").getAsString(),
            s.get("signature").getAsString()));
    assertEquals(BoxProof.Verdict.ANOTHER_EVENT,
        BoxProof.check("evt-3f9c2a", "", "h", "n", "", ""));
  }

  @Test
  public void withNoKeyKeptTheEventIdAloneIsChecked() {
    assertEquals(BoxProof.Verdict.SAME_EVENT,
        BoxProof.check("evt-3f9c2a", "", "10.20.0.1:3000", "n", "evt-3f9c2a", ""));
  }

  @Test
  public void aBrokenKeyOrSignatureIsARefusalNotACrash() {
    assertFalse(BoxProof.verify("not-a-key", "x", "y"));
    assertFalse(BoxProof.verify(signed().get("key").getAsString(), "x", "@@@"));
  }

  @Test
  public void theHostIsWhatTheHostHeaderSays() {
    assertEquals("10.20.0.1:3000", BoxProof.hostOf("http://10.20.0.1:3000"));
    assertEquals("crewbox.local", BoxProof.hostOf("http://CrewBox.local"));
    assertEquals("crewbox.local", BoxProof.hostOf("http://crewbox.local:80"));
    assertEquals("crewbox.local", BoxProof.hostOf("https://crewbox.local:443"));
    assertEquals("crewbox.local:80", BoxProof.hostOf("https://crewbox.local:80"));
    assertEquals("[fd00::1]:3000", BoxProof.hostOf("http://[fd00::1]:3000"));
  }

  // -- what is posted, and where ---------------------------------------------

  @Test
  public void aMentionIsAGroupConversationInMentions() {
    AlertNotice n = notice("alertMention");
    assertEquals("m:m-7", n.id);
    assertEquals(AlertNotice.CH_MENTIONS, n.channel);
    assertTrue(n.conversation);
    assertTrue(n.group);
    assertEquals("Jo", n.sender);
    assertEquals("#foh", n.conversationTitle());
    assertEquals("evt-3f9c2a/c-foh", n.shortcutId);
    assertEquals("crewbox://open?event=evt-3f9c2a&channel=c-foh", n.link);
    assertEquals(12, n.seq);
    assertFalse(n.silent);
    assertFalse(n.postWhileVisible());
  }

  @Test
  public void aDmIsTheOtherPersonsConversationAndQuietWhenTheBoxSaysSo() {
    AlertNotice n = notice("alertDm");
    assertEquals(AlertNotice.CH_MENTIONS, n.channel);
    assertTrue(n.conversation);
    assertFalse(n.group);
    assertEquals("Jo", n.conversationTitle());
    assertTrue(n.silent);
    assertEquals("evt-3f9c2a/c-dm", n.shortcutId);
  }

  @Test
  public void theDeskSpeaksAsTheProductionDesk() {
    AlertNotice n = notice("alertDesk");
    assertEquals(AlertNotice.CH_MENTIONS, n.channel);
    assertEquals("Production desk", n.sender);
    assertTrue(n.group);
  }

  @Test
  public void aShowStopRingsOnItsOwnChannelAndOpensTheShowLog() {
    AlertNotice n = notice("alertShowStop");
    assertEquals(AlertNotice.CH_SHOW_STOP, n.channel);
    assertFalse(n.conversation);
    assertEquals("", n.shortcutId);
    assertEquals("crewbox://open?event=evt-3f9c2a&to=showlog", n.link);
    assertTrue(n.postWhileVisible());
  }

  @Test
  public void aChangeoverCallOpensItsStage() {
    AlertNotice n = notice("alertChangeover");
    assertEquals(AlertNotice.CH_CHANGEOVER, n.channel);
    assertEquals("c:a-2:changeover:2026-07-10:1290", n.id);
    assertEquals("crewbox://open?event=evt-3f9c2a&stage=Main%20Stage", n.link);
    assertTrue(n.postWhileVisible());
  }

  @Test
  public void everyCatchUpAlertCanBePosted() {
    for (com.google.gson.JsonElement alert : frame("welcome").getAsJsonArray("catchUp")) {
      assertNotNull(AlertNotice.from(alert.getAsJsonObject(), "evt-3f9c2a"));
    }
  }

  @Test
  public void anAlertWithNoIdIsSkipped() {
    assertNull(AlertNotice.from(new JsonObject(), "evt-3f9c2a"));
  }

  @Test
  public void aReadTakesBackWhatItCovers() {
    JsonObject read = frame("read");
    String channel = read.get("channelId").getAsString();
    long seq = read.get("seq").getAsLong();
    AlertNotice mention = notice("alertMention");
    assertTrue(AlertNotice.readCovers(mention.channelId, mention.seq, channel, seq));
    assertFalse(AlertNotice.readCovers(mention.channelId, seq + 1, channel, seq));
    assertFalse(AlertNotice.readCovers("c-dm", 3, channel, seq));
    // A show stop has no channel to be read in.
    assertFalse(AlertNotice.readCovers("", 0, channel, seq));
  }
}
