package com.colmhewson.crewbox;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.security.InvalidKeyException;
import java.security.ProviderException;
import java.security.UnrecoverableKeyException;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.Deque;

import javax.crypto.IllegalBlockSizeException;

import org.junit.Test;

/**
 * Asking the Keystore (KeystoreCalls), with calls of the test's own where the
 * app's go to the Keystore.
 */
public class KeystoreCallsTest {

  /** A call that answers, or fails, as it is told to, in turn. */
  private static final class Scripted implements KeystoreCalls.Call<String> {
    private final Deque<Object> script;
    int calls = 0;

    Scripted(Object... answers) {
      script = new ArrayDeque<>(Arrays.asList(answers));
    }

    @Override
    public String call() throws GeneralSecurityException, IOException {
      calls++;
      Object next = script.removeFirst();
      if (next instanceof GeneralSecurityException) throw (GeneralSecurityException) next;
      if (next instanceof IOException) throw (IOException) next;
      if (next instanceof RuntimeException) throw (RuntimeException) next;
      return (String) next;
    }
  }

  private static final class Waits implements Runnable {
    int count = 0;

    @Override
    public void run() {
      count++;
    }
  }

  /** What the app counts as gone, stood in for: the test's own marked failures. */
  private static final class GoneForGood extends InvalidKeyException {
    private static final long serialVersionUID = 1L;
  }

  private static boolean gone(Throwable failure) {
    return failure instanceof GoneForGood;
  }

  private static String ask(Scripted call, Waits waits) throws GeneralSecurityException {
    return KeystoreCalls.retried(call, KeystoreCallsTest::gone, waits);
  }

  @Test
  public void answersWithoutWaitingWhenTheKeystoreDoes() throws Exception {
    Scripted call = new Scripted("token");
    Waits waits = new Waits();
    assertEquals("token", ask(call, waits));
    assertEquals(1, call.calls);
    assertEquals(0, waits.count);
  }

  @Test
  public void asksOnceMoreAfterAWait() throws Exception {
    // Each way the Keystore fails a call now and then: loading a key, a
    // cipher starting, a cipher finishing, reading the Keystore itself, and
    // the runtime exception it throws for a service it can't reach.
    Exception[] failures = {
      new UnrecoverableKeyException("Failed to obtain information about key"),
      new InvalidKeyException("Keystore operation failed"),
      new IllegalBlockSizeException(),
      new IOException("load"),
      new ProviderException("Keystore operation failed"),
    };
    for (Exception failure : failures) {
      Scripted call = new Scripted(failure, "token");
      Waits waits = new Waits();
      assertEquals(failure.toString(), "token", ask(call, waits));
      assertEquals(failure.toString(), 2, call.calls);
      assertEquals(failure.toString(), 1, waits.count);
    }
  }

  @Test
  public void saysNotNowAfterFailingTwice() {
    InvalidKeyException second = new InvalidKeyException("again");
    Scripted call = new Scripted(new InvalidKeyException("first"), second, "never asked");
    Waits waits = new Waits();
    KeystoreCalls.NotNow notNow = assertThrows(KeystoreCalls.NotNow.class, () -> ask(call, waits));
    assertSame(second, notNow.getCause());
    assertEquals(2, call.calls);
    assertEquals(1, waits.count);
  }

  @Test
  public void neverAsksAgainForATokenThatWillNotOpen() {
    // A failed tag check is an answer: this token, this name, this key.
    SessionSeal.Unreadable unreadable = new SessionSeal.Unreadable("Sealed under another key", null);
    Scripted call = new Scripted(unreadable, "never asked");
    Waits waits = new Waits();
    assertSame(unreadable, assertThrows(SessionSeal.Unreadable.class, () -> ask(call, waits)));
    assertEquals(1, call.calls);
    assertEquals(0, waits.count);

    // Nor after a first failure: it is still an answer, not a NotNow.
    Scripted later = new Scripted(new InvalidKeyException("first"), unreadable);
    assertSame(unreadable, assertThrows(SessionSeal.Unreadable.class, () -> ask(later, new Waits())));
  }

  @Test
  public void neverAsksAgainForAKeyThatIsGone() {
    GoneForGood failure = new GoneForGood();
    Scripted call = new Scripted(failure, "never asked");
    Waits waits = new Waits();
    KeystoreCalls.Gone gone = assertThrows(KeystoreCalls.Gone.class, () -> ask(call, waits));
    assertSame(failure, gone.getCause());
    assertEquals(1, call.calls);
    assertEquals(0, waits.count);

    // Found gone when asked again, it is gone, not merely not answering.
    GoneForGood second = new GoneForGood();
    Scripted later = new Scripted(new InvalidKeyException("first"), second);
    assertSame(second, assertThrows(KeystoreCalls.Gone.class, () -> ask(later, new Waits())).getCause());
  }

  @Test
  public void passesOnWhatACallInsideHasSettled() {
    // A call made of calls that have each asked twice already asks no more.
    KeystoreCalls.NotNow notNow = new KeystoreCalls.NotNow(null);
    Scripted call = new Scripted(notNow, "never asked");
    Waits waits = new Waits();
    assertSame(notNow, assertThrows(KeystoreCalls.NotNow.class, () -> ask(call, waits)));
    KeystoreCalls.Gone gone = new KeystoreCalls.Gone(null);
    Scripted other = new Scripted(gone, "never asked");
    assertSame(gone, assertThrows(KeystoreCalls.Gone.class, () -> ask(other, waits)));
    assertEquals(1, call.calls);
    assertEquals(1, other.calls);
    assertEquals(0, waits.count);
  }

  @Test
  public void leavesAMistakeOfTheAppsOwnAlone() {
    // Not the Keystore's doing, so not asked again, and not called NotNow.
    Scripted call = new Scripted(new NullPointerException("a bug"), "never asked");
    Waits waits = new Waits();
    assertThrows(NullPointerException.class, () -> ask(call, waits));
    assertEquals(1, call.calls);
    assertEquals(0, waits.count);
  }

  @Test
  public void aKeyIsGoneOnlyWhenAndroidSaysSo() {
    // Android 13 and later: a key that doesn't exist, or that is corrupted.
    for (int sdk : new int[] {33, 34, 35, 36}) {
      assertTrue(KeystoreCalls.keyGone(sdk, 6));
      assertTrue(KeystoreCalls.keyGone(sdk, 7));
    }
    // Everything else is waited out: another failure of the Keystore's
    // (1, 4, 10, 11, 12), one that isn't set up yet or wants the phone
    // unlocked (2, 3), and nothing said at all (0).
    for (int code : new int[] {0, 1, 2, 3, 4, 5, 8, 10, 11, 12, 13, 14, 15, 16, 17}) {
      assertFalse(Integer.toString(code), KeystoreCalls.keyGone(36, code));
    }
    // Before Android 13 the codes aren't Android's to give, so nothing is gone.
    for (int sdk = 24; sdk < 33; sdk++) {
      assertFalse(KeystoreCalls.keyGone(sdk, 6));
      assertFalse(KeystoreCalls.keyGone(sdk, 7));
    }
  }

  @Test
  public void aMissingKeyIsWaitedOutBeforeAndroid12() {
    // Android 11 and older answer "no key" when the Keystore can't be asked,
    // so the sign-ins sealed under it are kept for a later look.
    for (int sdk = 24; sdk <= 30; sdk++) {
      assertTrue(Integer.toString(sdk), KeystoreCalls.missingMayBeOutOfReach(sdk));
    }
    for (int sdk = 31; sdk <= 36; sdk++) {
      assertFalse(Integer.toString(sdk), KeystoreCalls.missingMayBeOutOfReach(sdk));
    }
  }

  @Test
  public void theCodesAreAndroidsOwn() {
    assertEquals(
        android.security.KeyStoreException.ERROR_KEY_DOES_NOT_EXIST,
        KeystoreCalls.ERROR_KEY_DOES_NOT_EXIST);
    assertEquals(
        android.security.KeyStoreException.ERROR_KEY_CORRUPTED, KeystoreCalls.ERROR_KEY_CORRUPTED);
  }
}
