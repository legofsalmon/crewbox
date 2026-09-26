package com.colmhewson.crewbox;

import java.math.BigInteger;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;
import java.util.Locale;

/**
 * Whether the box at the other end of /ws/alerts is this event's, before the
 * service sends it a token (docs/ALERTS.md, "The box proves itself first").
 *
 * The box signs exactly what `GET /api/identity` signs: P-256 ECDSA with
 * SHA-256, IEEE P1363 (r then s, 32 bytes each), base64url, over
 * "crewbox-identity-v1\n" + event id + "\n" + host + "\n" + nonce. Java's
 * verifier takes DER, and the event's key is kept as a raw uncompressed
 * point, so both are converted here. No Android classes, so the JVM tests
 * check it against the fixtures the box's own tests are held to.
 */
final class BoxProof {
  private BoxProof() {}

  enum Verdict {
    /** Signed for this address by the key kept for the event. */
    PROVEN,
    /** No key kept (an event joined before boxes had keys): its id matches. */
    SAME_EVENT,
    /** Another event's box, or one that wouldn't say. */
    ANOTHER_EVENT,
    /** Not signed, or not by this event's key, or not for this address. */
    REFUSED,
  }

  /** The start of an X.509 SubjectPublicKeyInfo for a P-256 key, before its 65-byte point. */
  private static final byte[] P256_SPKI_PREFIX = {
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, (byte) 0x86, 0x48, (byte) 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, (byte) 0x86, 0x48, (byte) 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
  };

  static String statement(String eventId, String host, String nonce) {
    return "crewbox-identity-v1\n" + eventId + "\n" + host + "\n" + nonce;
  }

  /**
   * The Host header a request to `serverUrl` carries, as the box signs it:
   * lower case, with the port only when it isn't the scheme's own. The same
   * rule OkHttp follows when it writes the header.
   */
  static String hostOf(String serverUrl) {
    URI uri = URI.create(serverUrl);
    String host = uri.getHost();
    if (host == null) return "";
    host = host.toLowerCase(Locale.ROOT);
    if (host.contains(":") && !host.startsWith("[")) host = "[" + host + "]";
    String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
    int port = uri.getPort();
    boolean secure = scheme.equals("https") || scheme.equals("wss");
    int standard = secure ? 443 : 80;
    return port == -1 || port == standard ? host : host + ":" + port;
  }

  /**
   * What the box's first frame proves.
   *
   * @param keptEventId the event the phone signed in to
   * @param keptKey the key kept for it, base64url raw point, or empty
   */
  static Verdict check(
      String keptEventId,
      String keptKey,
      String host,
      String nonce,
      String frameEventId,
      String signature) {
    if (frameEventId == null || frameEventId.isEmpty() || !frameEventId.equals(keptEventId)) {
      return Verdict.ANOTHER_EVENT;
    }
    if (keptKey == null || keptKey.isEmpty()) return Verdict.SAME_EVENT;
    if (signature == null || signature.isEmpty()) return Verdict.REFUSED;
    return verify(keptKey, statement(frameEventId, host, nonce), signature)
        ? Verdict.PROVEN
        : Verdict.REFUSED;
  }

  /** Whether `signature` (P1363, base64url) is `key`'s over `statement`. Never throws. */
  static boolean verify(String key, String statement, String signature) {
    try {
      byte[] point = Base64.getUrlDecoder().decode(key);
      if (point.length != 65 || point[0] != 0x04) return false;
      byte[] spki = new byte[P256_SPKI_PREFIX.length + point.length];
      System.arraycopy(P256_SPKI_PREFIX, 0, spki, 0, P256_SPKI_PREFIX.length);
      System.arraycopy(point, 0, spki, P256_SPKI_PREFIX.length, point.length);
      PublicKey publicKey = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(spki));
      byte[] p1363 = Base64.getUrlDecoder().decode(signature);
      if (p1363.length != 64) return false;
      Signature verifier = Signature.getInstance("SHA256withECDSA");
      verifier.initVerify(publicKey);
      verifier.update(statement.getBytes(StandardCharsets.UTF_8));
      return verifier.verify(toDer(p1363));
    } catch (Exception e) {
      return false;
    }
  }

  /** IEEE P1363 (r ‖ s) to the DER SEQUENCE { INTEGER r, INTEGER s } Java verifies. */
  static byte[] toDer(byte[] p1363) {
    byte[] r = integer(p1363, 0);
    byte[] s = integer(p1363, 32);
    int length = r.length + s.length;
    byte[] der = new byte[2 + length];
    der[0] = 0x30;
    der[1] = (byte) length;
    System.arraycopy(r, 0, der, 2, r.length);
    System.arraycopy(s, 0, der, 2 + r.length, s.length);
    return der;
  }

  private static byte[] integer(byte[] from, int offset) {
    byte[] half = new byte[32];
    System.arraycopy(from, offset, half, 0, 32);
    // BigInteger gives the minimal two's-complement form DER wants.
    byte[] value = new BigInteger(1, half).toByteArray();
    byte[] out = new byte[2 + value.length];
    out[0] = 0x02;
    out[1] = (byte) value.length;
    System.arraycopy(value, 0, out, 2, value.length);
    return out;
  }
}
