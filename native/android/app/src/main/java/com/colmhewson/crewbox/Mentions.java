package com.colmhewson.crewbox;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Whether a message mentions somebody: the page's test
 * ({@code isMentioned} in web/src/lib/alerts.ts), so a phone and the page
 * agree on who a message is for.
 *
 * <p>A name needs a boundary after it, so "@Sammy" doesn't mention Sam, and
 * "@allison" doesn't mention everyone.
 */
final class Mentions {
  private static final Pattern EVERYONE = Pattern.compile("@(all|everyone|channel)\\b");

  private Mentions() {}

  /** The test for one person, built once per sign-in. */
  static Pattern forName(String myName) {
    String name = myName == null ? "" : myName.toLowerCase(Locale.ROOT);
    if (name.isEmpty()) return null;
    // Names can hold regex metacharacters ("Alex (Stage 2)"), hence quote().
    return Pattern.compile("@" + Pattern.quote(name) + "(?![a-z0-9])");
  }

  /** True when {@code body} mentions the person {@code mine} was built for, or everyone. */
  static boolean isMentioned(String body, Pattern mine) {
    if (body == null) return false;
    String lower = body.toLowerCase(Locale.ROOT);
    if (EVERYONE.matcher(lower).find()) return true;
    return mine != null && mine.matcher(lower).find();
  }
}
