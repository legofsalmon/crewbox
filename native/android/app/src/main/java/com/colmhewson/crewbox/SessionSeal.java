package com.colmhewson.crewbox;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;

import javax.crypto.BadPaddingException;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * A sign-in's token as the app stores it (Sessions): encrypted and
 * authenticated with AES-GCM under a key the Keystore holds, and bound to the
 * sign-in's name, so a stored token opens only under the name it was stored
 * under.
 *
 * Plain Java, with the key handed in, so the JVM tests run it with a key of
 * their own. Written as hex, not Base64: java.util.Base64 arrived in Android 8
 * and the app runs on 7, and android.util.Base64 isn't there in a JVM test.
 */
final class SessionSeal {
  private SessionSeal() {}

  /** A stored token that will never open: another key's, another name's, or not one at all. */
  static final class Unreadable extends GeneralSecurityException {
    Unreadable(String why, Throwable cause) {
      super(why, cause);
    }
  }

  static final String TRANSFORMATION = "AES/GCM/NoPadding";
  private static final int TAG_BITS = 128;

  /**
   * The token, sealed: the IV's length, the IV, then the ciphertext with its
   * tag. The cipher picks the IV. A Keystore key insists on that, and a new
   * one each time is what GCM needs.
   */
  static String seal(SecretKey key, String name, String token) throws GeneralSecurityException {
    Cipher cipher = Cipher.getInstance(TRANSFORMATION);
    cipher.init(Cipher.ENCRYPT_MODE, key);
    cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
    byte[] sealed = cipher.doFinal(token.getBytes(StandardCharsets.UTF_8));
    byte[] iv = cipher.getIV();
    byte[] out = new byte[1 + iv.length + sealed.length];
    out[0] = (byte) iv.length;
    System.arraycopy(iv, 0, out, 1, iv.length);
    System.arraycopy(sealed, 0, out, 1 + iv.length, sealed.length);
    return hex(out);
  }

  /**
   * The token a sealed one holds.
   *
   * @throws Unreadable when it never will: the caller drops it
   * @throws GeneralSecurityException when the key can't be used now, which
   *     says nothing about the token
   */
  static String open(SecretKey key, String name, String sealed) throws GeneralSecurityException {
    byte[] bytes = unhex(sealed);
    int ivLength = bytes.length > 0 ? bytes[0] & 0xff : 0;
    if (ivLength == 0 || bytes.length < 1 + ivLength + TAG_BITS / 8) {
      throw new Unreadable("Not a sealed token", null);
    }
    Cipher cipher = Cipher.getInstance(TRANSFORMATION);
    cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, bytes, 1, ivLength));
    cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
    try {
      byte[] token = cipher.doFinal(bytes, 1 + ivLength, bytes.length - 1 - ivLength);
      return new String(token, StandardCharsets.UTF_8);
    } catch (BadPaddingException e) {
      // AEADBadTagException among them: the tag doesn't match this key, this
      // name and these bytes.
      throw new Unreadable("Sealed under another key or name", e);
    }
  }

  private static final char[] DIGITS = "0123456789abcdef".toCharArray();

  static String hex(byte[] bytes) {
    char[] out = new char[bytes.length * 2];
    for (int i = 0; i < bytes.length; i++) {
      out[2 * i] = DIGITS[(bytes[i] >> 4) & 0xf];
      out[2 * i + 1] = DIGITS[bytes[i] & 0xf];
    }
    return new String(out);
  }

  static byte[] unhex(String text) throws Unreadable {
    if (text.length() % 2 != 0) throw new Unreadable("Not hex", null);
    byte[] out = new byte[text.length() / 2];
    for (int i = 0; i < out.length; i++) {
      int high = Character.digit(text.charAt(2 * i), 16);
      int low = Character.digit(text.charAt(2 * i + 1), 16);
      if (high < 0 || low < 0) throw new Unreadable("Not hex", null);
      out[i] = (byte) ((high << 4) | low);
    }
    return out;
  }
}
