package com.colmhewson.crewbox;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.security.ProviderException;
import java.util.function.Predicate;

/**
 * Asking the Android Keystore about the key that seals the sign-ins
 * (Sessions). It fails now and then for reasons of its own, and a second try
 * a moment later usually works: when a Keystore encryption or decryption
 * fails, Google's Tink asks again once, after a random wait of up to 100 ms,
 * and this does the same for every call. A key the Keystore says is gone for
 * good is another matter, and no wait brings it back.
 *
 * No Android calls, with the call, the wait and what says a key is gone
 * handed in, so the JVM tests run it.
 */
final class KeystoreCalls {
  private KeystoreCalls() {}

  /** One call to the Keystore. */
  interface Call<T> {
    T call() throws GeneralSecurityException, IOException;
  }

  /**
   * The Keystore didn't answer, even when asked again. That says nothing
   * about the sign-ins: nothing is dropped, and asking later may well work.
   */
  static final class NotNow extends GeneralSecurityException {
    private static final long serialVersionUID = 1L;

    NotNow(Throwable cause) {
      super("The Keystore didn't answer", cause);
    }
  }

  /** The Keystore says the key is gone for good. What it sealed will never open. */
  static final class Gone extends GeneralSecurityException {
    private static final long serialVersionUID = 1L;

    Gone(Throwable cause) {
      super("The Keystore no longer has the key", cause);
    }
  }

  /** The longest wait before asking again, Tink's. */
  static final int MAX_WAIT_MS = 100;

  /**
   * The call's answer, asked for once more after a wait if the Keystore
   * fails the first time.
   *
   * A sealed token that will never open (SessionSeal.Unreadable) is an
   * answer, not a failure, so it isn't asked again: Tink never asks again
   * after a failed tag check either. Nor is a key that is gone, or a call
   * that has already asked twice.
   *
   * @throws Gone when a failure says the key is gone
   * @throws NotNow when it fails both times
   */
  static <T> T retried(Call<T> call, Predicate<Throwable> gone, Runnable wait)
      throws GeneralSecurityException {
    try {
      return call.call();
    } catch (SessionSeal.Unreadable | NotNow | Gone answer) {
      throw answer;
    } catch (GeneralSecurityException | IOException | ProviderException first) {
      if (gone.test(first)) throw new Gone(first);
      wait.run();
      try {
        return call.call();
      } catch (SessionSeal.Unreadable | NotNow | Gone answer) {
        throw answer;
      } catch (GeneralSecurityException | IOException | ProviderException again) {
        if (gone.test(again)) throw new Gone(again);
        throw new NotNow(again);
      }
    }
  }

  /** android.security.KeyStoreException's ERROR_KEY_DOES_NOT_EXIST, from Android 13. */
  static final int ERROR_KEY_DOES_NOT_EXIST = 6;

  /** android.security.KeyStoreException's ERROR_KEY_CORRUPTED, from Android 13. */
  static final int ERROR_KEY_CORRUPTED = 7;

  /**
   * Whether a Keystore error's code says the key is gone for good. Only
   * Android 13 and later say which error it was; before that, a failure is
   * one to wait out.
   */
  static boolean keyGone(int sdk, int errorCode) {
    return sdk >= 33 && (errorCode == ERROR_KEY_DOES_NOT_EXIST || errorCode == ERROR_KEY_CORRUPTED);
  }

  /**
   * Whether a key the Keystore says isn't there may only be out of reach.
   * From Android 12 a key is said to be missing only when it is. Before, the
   * Keystore asked whether it has the key answers no when it can't be asked
   * at all (KeyStore.contains, read in Android 11's framework), and dropping
   * every sign-in on that would sign the phone out of every event.
   */
  static boolean missingMayBeOutOfReach(int sdk) {
    return sdk < 31;
  }
}
