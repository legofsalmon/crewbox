package com.colmhewson.crewbox;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

import org.junit.Test;

/**
 * A sign-in's token as the app stores it (SessionSeal), with a key of the
 * test's own where the app has one the Keystore holds.
 */
public class SessionSealTest {

  /** A box's session token: 32 random bytes as base64url (server/src/auth.ts). */
  private static final String TOKEN = "q5vX0TRw2mJ9cYh4Kz7LbN1uEoPsFgHiAjKlMnOpQrS";

  private static SecretKey newKey() throws Exception {
    KeyGenerator generator = KeyGenerator.getInstance("AES");
    generator.init(256);
    return generator.generateKey();
  }

  @Test
  public void opensToTheTokenItSealed() throws Exception {
    SecretKey key = newKey();
    String sealed = SessionSeal.seal(key, "crewbox:token", TOKEN);
    assertEquals(TOKEN, SessionSeal.open(key, "crewbox:token", sealed));
  }

  @Test
  public void keepsNoTokenInTheClear() throws Exception {
    String sealed = SessionSeal.seal(newKey(), "crewbox:token", TOKEN);
    assertFalse(sealed.contains(TOKEN));
    assertFalse(sealed.contains(SessionSeal.hex(TOKEN.getBytes("UTF-8"))));
    // A 12-byte IV, the token, and a 16-byte tag: nothing else to store.
    assertEquals(2 * (1 + 12 + TOKEN.length() + 16), sealed.length());
  }

  @Test
  public void sealsTheSameTokenDifferentlyEachTime() throws Exception {
    // A new IV each time, as GCM needs: the same one twice under a key gives
    // away both tokens and the key's authentication.
    SecretKey key = newKey();
    String first = SessionSeal.seal(key, "crewbox:token", TOKEN);
    String second = SessionSeal.seal(key, "crewbox:token", TOKEN);
    assertNotEquals(first, second);
    assertNotEquals(first.substring(2, 26), second.substring(2, 26));
  }

  @Test
  public void opensOnlyUnderTheNameItWasSealedUnder() throws Exception {
    // So one event's token copied under another's is refused, not used.
    SecretKey key = newKey();
    String sealed = SessionSeal.seal(key, "crewbox@saturday:token", TOKEN);
    assertThrows(SessionSeal.Unreadable.class,
        () -> SessionSeal.open(key, "crewbox:token", sealed));
    assertEquals(TOKEN, SessionSeal.open(key, "crewbox@saturday:token", sealed));
  }

  @Test
  public void opensOnlyWithTheKeyThatSealedIt() throws Exception {
    // A key the Keystore made again, after losing the one before: what it
    // sealed is dropped, and that event signs in again.
    String sealed = SessionSeal.seal(newKey(), "crewbox:token", TOKEN);
    assertThrows(SessionSeal.Unreadable.class,
        () -> SessionSeal.open(newKey(), "crewbox:token", sealed));
  }

  @Test
  public void refusesATokenChangedAtRest() throws Exception {
    SecretKey key = newKey();
    String sealed = SessionSeal.seal(key, "crewbox:token", TOKEN);
    int at = sealed.length() - 40;
    char flipped = sealed.charAt(at) == '0' ? '1' : '0';
    String changed = sealed.substring(0, at) + flipped + sealed.substring(at + 1);
    assertThrows(SessionSeal.Unreadable.class,
        () -> SessionSeal.open(key, "crewbox:token", changed));
  }

  @Test
  public void refusesWhatWasNeverSealed() throws Exception {
    SecretKey key = newKey();
    String[] neverSealed = {"", TOKEN, "0", "zz", "00", "0c000000000000000000000000", "ff00"};
    for (String stored : neverSealed) {
      assertThrows(stored, SessionSeal.Unreadable.class,
          () -> SessionSeal.open(key, "crewbox:token", stored));
    }
  }

  @Test
  public void hexGoesBothWays() throws Exception {
    byte[] bytes = {0, 1, 0x7f, (byte) 0x80, (byte) 0xff, 0x3c};
    assertEquals("00017f80ff3c", SessionSeal.hex(bytes));
    byte[] back = SessionSeal.unhex("00017F80ff3c");
    assertEquals(bytes.length, back.length);
    for (int i = 0; i < bytes.length; i++) assertEquals(bytes[i], back[i]);
    assertTrue(SessionSeal.unhex("").length == 0);
  }
}
