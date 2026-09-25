package com.colmhewson.crewbox;

import com.google.crypto.tink.subtle.Ed25519Verify;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.Strictness;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.LongSupplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The screens a box serves, downloaded and checked before the app runs any of
 * them. ScreensPlugin hands this to the page.
 *
 * The app has one origin for every event the phone has been to, so code
 * running in it can read every event's chat, documents and sign-ins. Until
 * now all of that code came in the app. A box's screens are to run there only
 * when a crewbox release signed them: the list of their files, WEBSUMS, is
 * signed with the key that signs the boxes' own updates (scripts/sign-web.mjs),
 * checked here against the public keys this build carries, and every file is
 * checked against the list. Screens from anywhere else, such as a development
 * box or a fork, leave the app on its own. The rules are the release's
 * (scripts/web-sums.mjs), and screens-fixtures.json holds the two to the same
 * answers.
 *
 * Each version's screens are kept in a folder named after it, in
 * getNoBackupFilesDir()/crewbox-screens, which backups leave out: the box has
 * them. A download goes into a folder beside it and is renamed into place
 * once every file has been checked, so a folder with a version's name is a
 * whole set. Its .checked mark is the digest of the list it was checked
 * against. These names reach phones: renaming one strands what is kept.
 */
final class Screens {
  private Screens() {}

  /** The folder every version's screens are kept in, in getNoBackupFilesDir(). */
  static final String FOLDER = "crewbox-screens";

  /** What a release calls them (scripts/web-sums.mjs). */
  static final String SUMS = "WEBSUMS";
  static final String SIGNATURE = "WEBSUMS.sig";
  static final String INFO = "crewbox-web.json";
  static final String KIND = "crewbox-web";

  /** Where a box says what it serves (server/src/screens.ts). */
  static final String OFFER = "api/app/screens";

  /**
   * The contract with the screens this build's native code keeps: the
   * plugins it has and what their methods do (web/src/lib/nativeApi.ts).
   * Raised when a plugin gains a method, or a method changes what it does.
   */
  static final int NATIVE_API = 1;

  /** The oldest contract this build still keeps for screens written against it. */
  static final int OLDEST_SCREENS_API = 1;

  /**
   * The oldest screens this build runs. A release that fixes a hole in the
   * screens raises it, so no box can hand a phone the hole again.
   */
  static final String FLOOR = "1.0.0";

  /**
   * The keys a release signs with, each an Ed25519 public key's 32 bytes in
   * base64: TRUSTED_KEYS in server/src/update/verify.ts, in the same order
   * (a server test holds them to it). A new key reaches phones only with an
   * app update, which has to come before CI signs anything with it.
   */
  static final String[] TRUSTED_KEYS = {
    // crewbox release key 1, minted 2026-08-13.
    "lijcvU5IzE/rENDWR5WEUdAZ6K2EKjLV61vEDzBseuw=",
  };

  /** The most a phone takes from a box: LIMITS in scripts/web-sums.mjs. */
  static final int MAX_SUMS_BYTES = 64 * 1024;
  static final int MAX_FILES = 500;
  static final long MAX_BYTES = 50L * 1024 * 1024;

  /** A box's answer carries the list as JSON; crewbox-web.json is a few lines. */
  private static final int MAX_OFFER_BYTES = 4 * MAX_SUMS_BYTES;
  private static final int MAX_INFO_BYTES = 64 * 1024;

  /** The mark in a version's folder: the digest of the list its files were checked against. */
  static final String CHECKED = ".checked";

  /** A download on its way: no version is called this, since a version starts with a digit. */
  static final String PARTIAL = ".partial-";

  /**
   * A version as crewbox writes one, `1.2.3`, perhaps a pre-release, then `+`
   * and the commit: isVersion in scripts/web-sums.mjs. It names a folder, so
   * nothing else gets in.
   */
  static final String VERSION_PATTERN =
      "(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})"
          + "(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*";
  static final int MAX_VERSION_LENGTH = 64;

  /** A part of a path a phone writes: safePath in scripts/web-sums.mjs. */
  static final String SEGMENT_PATTERN = "[A-Za-z0-9_-][A-Za-z0-9._-]*";

  /** A line of the list, as sha256sum writes it: parseSums in scripts/web-sums.mjs. */
  static final String LINE_PATTERN = "([0-9a-f]{64}) {2}(\\S+)";

  private static final Pattern VERSION = Pattern.compile(VERSION_PATTERN);
  private static final Pattern SEGMENT = Pattern.compile(SEGMENT_PATTERN);
  private static final Pattern LINE = Pattern.compile(LINE_PATTERN);
  private static final Pattern CORE =
      Pattern.compile("([0-9]{1,9})\\.([0-9]{1,9})\\.([0-9]{1,9})(?![0-9])(-)?.*", Pattern.DOTALL);

  /** A box's address as the page gives it: a scheme, a host, perhaps a port, and nothing else. */
  static final String ORIGIN_PATTERN =
      "https?://(\\[[0-9A-Fa-f:.]+\\]|[A-Za-z0-9.-]+)(:[0-9]{1,5})?";
  private static final Pattern ORIGIN = Pattern.compile(ORIGIN_PATTERN);

  /** Why screens weren't taken, in a sentence for the page's log. */
  static final class Refused extends Exception {
    private static final long serialVersionUID = 1L;

    Refused(String why) {
      super(why);
    }
  }

  /** What a box says about the screens it serves. */
  static final class Offer {
    final String version;
    final String sums;
    final String signature;

    Offer(String version, String sums, String signature) {
      this.version = version;
      this.sums = sums;
      this.signature = signature;
    }
  }

  /** What crewbox-web.json says the screens are. */
  static final class Info {
    final String version;
    final double protocol;
    final double needs;
    final double builtFor;

    Info(String version, double protocol, double needs, double builtFor) {
      this.version = version;
      this.protocol = protocol;
      this.needs = needs;
      this.builtFor = builtFor;
    }
  }

  /** What an app build brings to the check. */
  static final class App {
    final byte[][] keys;
    final int nativeApi;
    final int oldestScreensApi;
    final String floor;
    /** The version the app's own screens were built as, or null when it can't be read. */
    final String builtIn;

    App(byte[][] keys, int nativeApi, int oldestScreensApi, String floor, String builtIn) {
      this.keys = keys;
      this.nativeApi = nativeApi;
      this.oldestScreensApi = oldestScreensApi;
      this.floor = floor;
      this.builtIn = builtIn;
    }

    /** This build, whose own screens say they are `builtIn`. */
    static App thisBuild(String builtIn) {
      byte[][] keys = new byte[TRUSTED_KEYS.length][];
      for (int i = 0; i < keys.length; i++) keys[i] = base64(TRUSTED_KEYS[i]);
      return new App(keys, NATIVE_API, OLDEST_SCREENS_API, FLOOR, builtIn);
    }
  }

  /** What the page is told (CrewboxScreens.prepare in web/src/lib/server.ts). */
  static final class Answer {
    /** same, ready, unsigned, incompatible or failed. */
    final String result;
    /** The version the box runs, when it counts. */
    final String version;
    /** What to update, app or box, when the screens are incompatible. */
    final String update;
    /** Why, for the page's log, when the app keeps its own screens. */
    final String reason;

    private Answer(String result, String version, String update, String reason) {
      this.result = result;
      this.version = version;
      this.update = update;
      this.reason = reason;
    }

    /** The box runs the version the app's own screens are: nothing to fetch. */
    static Answer same(String version) {
      return new Answer("same", version, null, null);
    }

    /** The box's screens are on the phone, checked, and this build runs them. */
    static Answer ready(String version) {
      return new Answer("ready", version, null, null);
    }

    /** Nothing a release signed, or not what the box says it runs. */
    static Answer unsigned(String reason) {
      return new Answer("unsigned", null, null, reason);
    }

    /** Signed screens this build won't run, and what to update so it will. */
    static Answer incompatible(String version, String update) {
      return new Answer("incompatible", version, update, null);
    }

    /** The network or the phone's storage let the check down; asking again may work. */
    static Answer failed(String reason) {
      return new Answer("failed", null, null, reason);
    }
  }

  /** A box, asked for one of its files. */
  interface Box {
    /**
     * The file at `path` on the box, as a stream the caller closes, or null
     * when the box answers 404. Throws when the box doesn't answer, or
     * answers anything else but 200.
     */
    InputStream open(String path) throws IOException;
  }

  static boolean isVersion(String value) {
    return value != null
        && value.length() <= MAX_VERSION_LENGTH
        && VERSION.matcher(value).matches();
  }

  static boolean isOrigin(String value) {
    return value != null && ORIGIN.matcher(value).matches();
  }

  static boolean isSafePath(String path) {
    for (String segment : path.split("/", -1)) {
      if (!SEGMENT.matcher(segment).matches()) return false;
    }
    return true;
  }

  /**
   * Whether `version` is at or above `floor`, a plain 1.2.3, in the order
   * semver gives them: a pre-release comes before its release, and the commit
   * after the + counts for nothing.
   */
  static boolean atOrAbove(String version, String floor) {
    Matcher mine = CORE.matcher(version);
    Matcher least = CORE.matcher(floor);
    if (!mine.matches() || !least.matches()) return false;
    for (int i = 1; i <= 3; i++) {
      int difference = Integer.parseInt(mine.group(i)) - Integer.parseInt(least.group(i));
      if (difference != 0) return difference > 0;
    }
    return mine.group(4) == null;
  }

  /**
   * Base64 as the release writes it, padded and with nothing else in it, or
   * null for anything else. Not android.util.Base64, which skips what it
   * doesn't know, nor java.util.Base64, which needs Android 8.
   */
  static byte[] base64(String text) {
    int length = text.length();
    if (length % 4 != 0) return null;
    int padding = 0;
    if (length > 0 && text.charAt(length - 1) == '=') {
      padding = text.charAt(length - 2) == '=' ? 2 : 1;
    }
    byte[] bytes = new byte[length / 4 * 3 - padding];
    int at = 0;
    int buffer = 0;
    int bits = 0;
    for (int i = 0; i < length - padding; i++) {
      int value = sextet(text.charAt(i));
      if (value < 0) return null;
      buffer = (buffer << 6) | value;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes[at++] = (byte) (buffer >> bits);
        buffer &= (1 << bits) - 1;
      }
    }
    return bytes;
  }

  private static int sextet(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
  }

  /** ASCII whitespace off both ends, all a phone trims from a signature. */
  private static String trimAscii(String text) {
    int start = 0;
    int end = text.length();
    while (start < end && isAsciiSpace(text.charAt(start))) start++;
    while (end > start && isAsciiSpace(text.charAt(end - 1))) end--;
    return text.substring(start, end);
  }

  private static boolean isAsciiSpace(char c) {
    return c == ' ' || c == '\t' || c == '\n' || c == 0x0B || c == '\f' || c == '\r';
  }

  /**
   * Which of `keys` signed `message`, or -1 when none did. The signature is
   * the text of WEBSUMS.sig, trimmed, and has to be base64 of 64 bytes. The
   * check is over the exact bytes that came: a list read and written out
   * again could differ by a byte and fail, or worse, pass.
   *
   * Tink's own Ed25519, through its constructor, on every Android version:
   * Android's is there for any key only from Android 17, and Tink's never
   * hands over to it, so a JVM test runs what a phone runs.
   */
  static int signedBy(byte[] message, String signature, byte[][] keys) {
    byte[] bytes = base64(trimAscii(signature));
    if (bytes == null || bytes.length != 64) return -1;
    for (int i = 0; i < keys.length; i++) {
      try {
        new Ed25519Verify(keys[i]).verify(bytes, message);
        return i;
      } catch (GeneralSecurityException | RuntimeException e) {
        // Another key's signature, a bad one, or a key that isn't one: try the next.
      }
    }
    return -1;
  }

  /**
   * The list, read as strictly as the release reads it: a line that isn't
   * what sha256sum writes, or a name a phone won't write, refuses the lot.
   * The files in the order listed, each with its digest.
   */
  static LinkedHashMap<String, String> parseSums(byte[] sums) throws Refused {
    if (sums.length > MAX_SUMS_BYTES) {
      throw new Refused(SUMS + " is over " + MAX_SUMS_BYTES + " bytes");
    }
    if (sums.length == 0 || sums[sums.length - 1] != '\n') {
      throw new Refused(SUMS + " doesn't end in a newline");
    }
    for (byte b : sums) {
      if (b < 0) throw new Refused(SUMS + " isn't ASCII");
    }
    LinkedHashMap<String, String> listed = new LinkedHashMap<>();
    String text = new String(sums, 0, sums.length - 1, StandardCharsets.US_ASCII);
    for (String line : text.split("\n", -1)) {
      Matcher match = LINE.matcher(line);
      if (!match.matches() || !isSafePath(match.group(2))) {
        throw new Refused("unreadable line in " + SUMS);
      }
      String path = match.group(2);
      if (path.equals(SUMS) || path.equals(SIGNATURE)) {
        throw new Refused(SUMS + " lists " + path + ", which is no file of the screens");
      }
      if (listed.containsKey(path)) throw new Refused(path + " is listed twice in " + SUMS);
      if (listed.size() == MAX_FILES) {
        throw new Refused(SUMS + " lists over the " + MAX_FILES + " files a phone takes");
      }
      listed.put(path, match.group(1));
    }
    return listed;
  }

  /** What a box says about its screens, or Refused when it says nothing a phone reads. */
  static Offer readOffer(byte[] json) throws Refused {
    JsonObject offer = object(json, "the box's answer");
    String version = string(offer, "version");
    String sums = string(offer, "sums");
    String signature = string(offer, "signature");
    if (sums == null || signature == null) {
      throw new Refused("the box's answer has no list and signature");
    }
    if (!isVersion(version)) {
      throw new Refused("the box's answer has no version of the form 1.2.3+commit");
    }
    return new Offer(version, sums, signature);
  }

  /** What crewbox-web.json says, checked as the release checks it (readInfo in web-sums.mjs). */
  static Info readInfo(byte[] json) throws Refused {
    JsonObject info = object(json, INFO);
    if (!KIND.equals(string(info, "kind"))) throw new Refused(INFO + " is not a " + KIND + " file");
    String version = string(info, "version");
    if (!isVersion(version)) throw new Refused(INFO + " has no version of the form 1.2.3+commit");
    double protocol = whole(info.get("protocol"));
    if (protocol == 0) throw new Refused(INFO + " has no protocol");
    JsonElement api = info.get("nativeApi");
    JsonObject contract =
        api != null && api.isJsonObject() ? api.getAsJsonObject() : new JsonObject();
    double needs = whole(contract.get("needs"));
    double builtFor = whole(contract.get("builtFor"));
    if (needs == 0 || builtFor == 0 || needs > builtFor) {
      throw new Refused(INFO + " has no nativeApi with needs at or below builtFor");
    }
    return new Info(version, protocol, needs, builtFor);
  }

  /**
   * Whether this build runs screens that say `info`, from a box that says it
   * runs `version`: null when it does, and otherwise what it answers instead.
   * judge in scripts/web-sums.mjs, which says why each.
   */
  static Answer judge(Info info, String version, App app) {
    if (!info.version.equals(version)) {
      return Answer.unsigned("the box runs " + version + " but serves " + info.version);
    }
    if (info.needs > app.nativeApi) return Answer.incompatible(version, "app");
    if (info.builtFor < app.oldestScreensApi || !atOrAbove(info.version, app.floor)) {
      return Answer.incompatible(version, "box");
    }
    return null;
  }

  /**
   * Ask the box for its screens, and have them on the phone, checked, if this
   * build runs them. Nothing it does to the phone's storage is seen unless
   * the whole set checks out.
   *
   * @param usable the room left for the app's files, asked for only when a
   *     download is needed
   */
  static Answer prepare(Box box, File root, App app, LongSupplier usable) {
    Offer offer;
    try {
      byte[] answer = fetch(box, OFFER, MAX_OFFER_BYTES);
      if (answer == null) return Answer.unsigned("the box has no signed screens");
      offer = readOffer(answer);
    } catch (Refused e) {
      return Answer.unsigned(e.getMessage());
    } catch (IOException e) {
      return Answer.failed(e.getMessage());
    }
    // Its own screens, which need no check: the app came with them.
    if (offer.version.equals(app.builtIn)) return Answer.same(offer.version);

    byte[] sums = offer.sums.getBytes(StandardCharsets.UTF_8);
    Map<String, String> listed;
    try {
      if (signedBy(sums, offer.signature, app.keys) < 0) {
        throw new Refused("the screens aren't signed with a key this app trusts");
      }
      listed = parseSums(sums);
      if (!listed.containsKey(INFO)) throw new Refused(SUMS + " doesn't list " + INFO);
    } catch (Refused e) {
      return Answer.unsigned(e.getMessage());
    }

    File folder = new File(root, offer.version);
    Info kept = kept(folder, offer.version, app);
    if (kept != null) {
      Answer refused = judge(kept, offer.version, app);
      return refused != null ? refused : Answer.ready(offer.version);
    }
    try {
      // What the screens are first, so nothing more is fetched for screens
      // this build won't run.
      byte[] info = fetch(box, INFO, MAX_INFO_BYTES);
      if (info == null) return Answer.failed(INFO + ": not on the box");
      if (!sha256(info).equals(listed.get(INFO))) {
        return Answer.failed(INFO + " isn't the file that was signed");
      }
      Answer refused = judge(readInfo(info), offer.version, app);
      if (refused != null) return refused;
      if (usable.getAsLong() < MAX_BYTES) {
        return Answer.failed("the phone has less than " + MAX_BYTES / (1024 * 1024) + " MB free");
      }
      download(box, root, offer, listed, info);
      return Answer.ready(offer.version);
    } catch (Refused e) {
      return Answer.unsigned(e.getMessage());
    } catch (IOException e) {
      return Answer.failed(e.getMessage());
    }
  }

  /**
   * Every file the list names, each checked as it lands, into a folder of its
   * own, and then renamed into place with the list, its signature and the
   * mark. A file already in that folder from an earlier try, and still the
   * one signed, isn't fetched again.
   */
  private static void download(
      Box box, File root, Offer offer, Map<String, String> listed, byte[] info) throws IOException {
    File partial = new File(root, PARTIAL + offer.version);
    long total = 0;
    for (Map.Entry<String, String> file : listed.entrySet()) {
      String path = file.getKey();
      File target = new File(partial, path);
      File parent = target.getParentFile();
      if (!parent.isDirectory() && !parent.mkdirs() && !parent.isDirectory()) {
        throw new IOException("Couldn't make " + parent);
      }
      if (target.isFile() && sha256(target).equals(file.getValue())) {
        total += target.length();
      } else if (path.equals(INFO)) {
        write(target, info);
        total += info.length;
      } else {
        total += fetchInto(box, path, target, file.getValue(), MAX_BYTES - total);
      }
      if (total > MAX_BYTES) throw new IOException("the screens are more than a phone takes");
    }
    byte[] sums = offer.sums.getBytes(StandardCharsets.UTF_8);
    write(new File(partial, SUMS), sums);
    String signature = trimAscii(offer.signature) + "\n";
    write(new File(partial, SIGNATURE), signature.getBytes(StandardCharsets.US_ASCII));
    write(new File(partial, CHECKED), (sha256(sums) + "\n").getBytes(StandardCharsets.US_ASCII));
    File folder = new File(root, offer.version);
    // Only ever a set that didn't check out, or kept() would have taken it.
    deleteTree(folder);
    if (!partial.renameTo(folder)) throw new IOException("Couldn't keep the screens in " + folder);
  }

  /**
   * The screens kept for `version`, checked again, and what they say; null
   * unless all of it holds. The mark has to be the digest of the list beside
   * it, the list has to verify against this build's keys, and every file has
   * to be the one it lists.
   */
  static Info kept(File folder, String version, App app) {
    try {
      byte[] sums = readSmall(new File(folder, SUMS), MAX_SUMS_BYTES);
      byte[] mark = readSmall(new File(folder, CHECKED), 128);
      if (!new String(mark, StandardCharsets.US_ASCII).equals(sha256(sums) + "\n")) return null;
      byte[] signature = readSmall(new File(folder, SIGNATURE), 1024);
      if (signedBy(sums, new String(signature, StandardCharsets.US_ASCII), app.keys) < 0) {
        return null;
      }
      Map<String, String> listed = parseSums(sums);
      if (!listed.containsKey(INFO)) return null;
      for (Map.Entry<String, String> file : listed.entrySet()) {
        File on = new File(folder, file.getKey());
        if (!on.isFile() || !sha256(on).equals(file.getValue())) return null;
      }
      Info info = readInfo(readSmall(new File(folder, INFO), MAX_INFO_BYTES));
      return info.version.equals(version) ? info : null;
    } catch (IOException | Refused e) {
      return null;
    }
  }

  /**
   * Clear away what no start will use: a download that never finished, a
   * folder whose mark isn't the digest of its list, and anything else that
   * isn't a version's folder.
   */
  static void sweep(File root) {
    String[] names = root.list();
    if (names == null) return;
    for (String name : names) {
      File entry = new File(root, name);
      if (!isVersion(name) || !entry.isDirectory() || !marked(entry)) deleteTree(entry);
    }
  }

  private static boolean marked(File folder) {
    try {
      byte[] mark = readSmall(new File(folder, CHECKED), 128);
      byte[] sums = readSmall(new File(folder, SUMS), MAX_SUMS_BYTES);
      return new String(mark, StandardCharsets.US_ASCII).equals(sha256(sums) + "\n");
    } catch (IOException e) {
      return false;
    }
  }

  /** A whole answer from the box, or null for a 404. */
  private static byte[] fetch(Box box, String path, long cap) throws IOException {
    try (InputStream in = box.open(path)) {
      if (in == null) return null;
      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      copy(in, bytes, cap, null);
      return bytes.toByteArray();
    } catch (IOException e) {
      throw new IOException(path + ": " + e.getMessage(), e);
    }
  }

  /** One file of the screens, written to `target` as it comes, and checked. */
  private static long fetchInto(Box box, String path, File target, String digest, long cap)
      throws IOException {
    MessageDigest hash = sha256();
    long size;
    try (InputStream in = box.open(path)) {
      if (in == null) throw new IOException("not on the box");
      try (FileOutputStream out = new FileOutputStream(target)) {
        size = copy(in, out, cap, hash);
        out.getFD().sync();
      }
    } catch (IOException e) {
      //noinspection ResultOfMethodCallIgnored
      target.delete();
      throw new IOException(path + ": " + e.getMessage(), e);
    }
    if (!hex(hash.digest()).equals(digest)) {
      //noinspection ResultOfMethodCallIgnored
      target.delete();
      throw new IOException(path + " isn't the file that was signed");
    }
    return size;
  }

  private static long copy(InputStream in, OutputStream out, long cap, MessageDigest hash)
      throws IOException {
    byte[] buffer = new byte[16 * 1024];
    long total = 0;
    for (int n = in.read(buffer); n != -1; n = in.read(buffer)) {
      total += n;
      if (total > cap) throw new IOException("more than a phone takes");
      if (hash != null) hash.update(buffer, 0, n);
      out.write(buffer, 0, n);
    }
    return total;
  }

  private static void write(File file, byte[] bytes) throws IOException {
    try (FileOutputStream out = new FileOutputStream(file)) {
      out.write(bytes);
      out.getFD().sync();
    }
  }

  private static byte[] readSmall(File file, int cap) throws IOException {
    try (InputStream in = new FileInputStream(file)) {
      ByteArrayOutputStream bytes = new ByteArrayOutputStream();
      copy(in, bytes, cap, null);
      return bytes.toByteArray();
    }
  }

  static void deleteTree(File file) {
    File[] inside = file.listFiles();
    if (inside != null) {
      for (File each : inside) deleteTree(each);
    }
    //noinspection ResultOfMethodCallIgnored
    file.delete();
  }

  /** A JSON object, read as strictly as JSON.parse reads one. */
  private static JsonObject object(byte[] json, String what) throws Refused {
    String text = new String(json, StandardCharsets.UTF_8);
    // Gson steps over a byte-order mark, which JSON.parse, and so the release, won't.
    if (text.startsWith("\uFEFF")) throw new Refused(what + " starts with a byte-order mark");
    try {
      JsonReader reader = new JsonReader(new StringReader(text));
      reader.setStrictness(Strictness.STRICT);
      JsonElement element = JsonParser.parseReader(reader);
      if (reader.peek() != JsonToken.END_DOCUMENT) {
        throw new Refused(what + " goes on after its end");
      }
      if (!element.isJsonObject()) throw new Refused(what + " isn't a JSON object");
      return element.getAsJsonObject();
    } catch (IOException | RuntimeException e) {
      throw new Refused(what + " isn't JSON: " + e.getMessage());
    }
  }

  private static String string(JsonObject object, String name) {
    JsonElement value = object.get(name);
    return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isString()
        ? value.getAsString()
        : null;
  }

  /** A whole number of 1 or more, as Number.isInteger takes one, or 0 for anything else. */
  private static double whole(JsonElement value) {
    if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) {
      return 0;
    }
    double number = value.getAsDouble();
    return !Double.isInfinite(number) && number == Math.floor(number) && number >= 1 ? number : 0;
  }

  static String sha256(byte[] bytes) {
    MessageDigest hash = sha256();
    hash.update(bytes);
    return hex(hash.digest());
  }

  static String sha256(File file) throws IOException {
    MessageDigest hash = sha256();
    try (InputStream in = new FileInputStream(file)) {
      byte[] buffer = new byte[16 * 1024];
      for (int n = in.read(buffer); n != -1; n = in.read(buffer)) hash.update(buffer, 0, n);
    }
    return hex(hash.digest());
  }

  private static MessageDigest sha256() {
    try {
      return MessageDigest.getInstance("SHA-256");
    } catch (NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
  }

  private static String hex(byte[] bytes) {
    StringBuilder text = new StringBuilder(bytes.length * 2);
    for (byte b : bytes) {
      text.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
    }
    return text.toString();
  }
}
