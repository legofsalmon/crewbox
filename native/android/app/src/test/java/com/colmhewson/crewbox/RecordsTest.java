package com.colmhewson.crewbox;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/**
 * The app's copy of what the page keeps for each event (Records), in a folder
 * of the test's own where the app has getNoBackupFilesDir().
 */
public class RecordsTest {

  @Rule public TemporaryFolder files = new TemporaryFolder();

  private File root() {
    return new File(files.getRoot(), Records.FOLDER);
  }

  private static final String FRIDAY =
      "{\"known\":{\"id\":\"friday\",\"name\":\"Harbour Fest\"},\"todaysNames\":true}";

  @Test
  public void readsNothingBeforeAnythingIsKept() throws IOException {
    assertEquals(Collections.emptyMap(), Records.readAll(root(), "event"));
    assertFalse(root().exists());
  }

  @Test
  public void readsBackEachEventsCopyOfASlot() throws IOException {
    Records.write(root(), "friday", "event", FRIDAY);
    Records.write(root(), "saturday", "event", "{}");
    Records.write(root(), "saturday", "outbox", "[]");
    Map<String, String> expected = new HashMap<>();
    expected.put("friday", FRIDAY);
    expected.put("saturday", "{}");
    assertEquals(expected, Records.readAll(root(), "event"));
    assertEquals(Collections.singletonMap("saturday", "[]"), Records.readAll(root(), "outbox"));
  }

  @Test
  public void keepsAFolderPerEventAndAFilePerSlot() throws IOException {
    // These names reach phones: a change strands every copy on them.
    Records.write(root(), "friday", "event", FRIDAY);
    assertEquals("crewbox-records", Records.FOLDER);
    File file = new File(new File(root(), "friday"), "event");
    assertTrue(file.isFile());
    assertEquals(FRIDAY.getBytes(StandardCharsets.UTF_8).length, file.length());
  }

  @Test
  public void replacesACopyWholeAndLeavesNothingBeside() throws IOException {
    Records.write(root(), "friday", "event", FRIDAY);
    Records.write(root(), "friday", "event", "{}");
    assertEquals(Collections.singletonMap("friday", "{}"), Records.readAll(root(), "event"));
    assertArrayEquals(new String[] {"event"}, new File(root(), "friday").list());
  }

  @Test
  public void keepsTextAsItCame() throws IOException {
    String name = "{\"name\":\"Fèis na Mara 🎶\"}";
    Records.write(root(), "friday", "event", name);
    assertEquals(name, Records.readAll(root(), "event").get("friday"));
  }

  @Test
  public void readsNoHalfWrittenCopy() throws IOException {
    // What a phone that died mid-write leaves: the copy being written beside
    // the one it was to replace, which is still whole.
    Records.write(root(), "friday", "event", FRIDAY);
    File partial = new File(new File(root(), "friday"), ".event");
    try (FileOutputStream out = new FileOutputStream(partial)) {
      out.write("{\"kno".getBytes(StandardCharsets.UTF_8));
    }
    assertEquals(Collections.singletonMap("friday", FRIDAY), Records.readAll(root(), "event"));
    Records.write(root(), "friday", "event", "{}");
    assertArrayEquals(new String[] {"event"}, new File(root(), "friday").list());
  }

  @Test
  public void readsOnlyFoldersNamedAsEvents() throws IOException {
    Records.write(root(), "friday", "event", FRIDAY);
    assertTrue(new File(root(), "..boxes").mkdirs());
    try (FileOutputStream out = new FileOutputStream(new File(new File(root(), "..boxes"), "event"))) {
      out.write("{}".getBytes(StandardCharsets.UTF_8));
    }
    assertEquals(Collections.singletonMap("friday", FRIDAY), Records.readAll(root(), "event"));
  }

  @Test
  public void forgetsOneSlotOrTheWholeEvent() throws IOException {
    Records.write(root(), "friday", "event", FRIDAY);
    Records.write(root(), "friday", "outbox", "[]");
    Records.write(root(), "saturday", "event", "{}");
    Records.remove(root(), "friday", "outbox");
    assertEquals(FRIDAY, Records.readAll(root(), "event").get("friday"));
    assertEquals(Collections.emptyMap(), Records.readAll(root(), "outbox"));
    Records.remove(root(), "friday", null);
    assertFalse(new File(root(), "friday").exists());
    assertEquals(Collections.singletonMap("saturday", "{}"), Records.readAll(root(), "event"));
  }

  @Test
  public void forgetsWhatIsntThereWithoutComplaint() throws IOException {
    Records.remove(root(), "friday", null);
    Records.remove(root(), "friday", "event");
    Records.write(root(), "saturday", "event", "{}");
    Records.remove(root(), "saturday", "outbox");
    assertEquals(Collections.singletonMap("saturday", "{}"), Records.readAll(root(), "event"));
  }

  @Test
  public void refusesNamesThatCouldLeaveItsFolder() {
    String[] events = {"", "..", "../x", "a/b", "fri.day", "fri-day", "crewbox@x", null};
    for (String event : events) {
      assertFalse(String.valueOf(event), Records.isEvent(event));
      assertThrows(IllegalArgumentException.class, () -> Records.write(root(), event, "event", "{}"));
      assertThrows(IllegalArgumentException.class, () -> Records.remove(root(), event, null));
    }
    for (String slot : new String[] {"", ".event", "..", "a/b", "-event", "ev.ent", null}) {
      assertFalse(String.valueOf(slot), Records.isSlot(slot));
      assertThrows(IllegalArgumentException.class, () -> Records.write(root(), "friday", slot, "{}"));
    }
    assertThrows(IllegalArgumentException.class, () -> Records.readAll(root(), "../event"));
    assertTrue(Records.isEvent("A1_b2"));
    assertTrue(Records.isSlot("show-log"));
    assertFalse(root().exists());
  }

  @Test
  public void saysSoWhenTheFolderWontList() throws IOException {
    // A file where the folder should be: something is wrong, and the page
    // hears so rather than an empty copy, which it would take as every event
    // forgotten.
    assertTrue(files.getRoot().isDirectory());
    try (FileOutputStream out = new FileOutputStream(root())) {
      out.write(1);
    }
    assertThrows(IOException.class, () -> Records.readAll(root(), "event"));
    assertThrows(IOException.class, () -> Records.write(root(), "friday", "event", "{}"));
  }
}
