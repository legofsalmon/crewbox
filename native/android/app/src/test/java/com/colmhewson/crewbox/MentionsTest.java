package com.colmhewson.crewbox;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The service's mention test, which must match the page's (web/src/lib/alerts.ts). */
public class MentionsTest {

  private static boolean mentions(String body, String name) {
    return Mentions.isMentioned(body, Mentions.forName(name));
  }

  @Test
  public void aNameMentionsItsPerson() {
    assertTrue(mentions("@Sam can you check FOH", "Sam"));
    assertTrue(mentions("thanks @sam", "Sam"));
    assertTrue(mentions("@SAM, now", "Sam"));
    assertTrue(mentions("(@Sam)", "Sam"));
  }

  @Test
  public void aLongerNameIsSomebodyElse() {
    // The shipped bug: "@Sammy" buzzed Sam.
    assertFalse(mentions("@Sammy can you check FOH", "Sam"));
    assertFalse(mentions("@Sam2 over here", "Sam"));
  }

  @Test
  public void everyoneNeedsItsOwnBoundaryToo() {
    assertTrue(mentions("@all doors in 5", "Sam"));
    assertTrue(mentions("@Everyone doors", "Sam"));
    assertTrue(mentions("@channel.", "Sam"));
    // The shipped bug: "@allison" buzzed everyone.
    assertFalse(mentions("@allison can you check FOH", "Sam"));
    assertFalse(mentions("@channels list", "Sam"));
  }

  @Test
  public void namesWithRegexCharactersAreLiteral() {
    assertTrue(mentions("@alex (stage 2) cue", "Alex (Stage 2)"));
    assertFalse(mentions("@alex stage 2 cue", "Alex (Stage 2)"));
  }

  @Test
  public void noNameOnlyHearsEveryone() {
    assertNull(Mentions.forName(""));
    assertNull(Mentions.forName(null));
    assertFalse(mentions("@sam", ""));
    assertTrue(mentions("@all", null));
    assertFalse(Mentions.isMentioned(null, Mentions.forName("Sam")));
  }
}
