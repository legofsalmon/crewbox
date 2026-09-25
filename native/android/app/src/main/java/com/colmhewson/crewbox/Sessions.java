package com.colmhewson.crewbox;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.security.Key;
import java.security.KeyStore;
import java.util.HashMap;
import java.util.Map;

import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

/**
 * The app's sign-ins: one session token per event, under the name the page
 * gives it (web/src/lib/sessions.ts). The page reads them through
 * SessionsPlugin, and AlertsService reads the one it was started for when
 * Android restarts it without a page.
 *
 * Each token is sealed (SessionSeal) with an AES key in the Android Keystore,
 * which never hands the key to the app, and kept in a preferences file of its
 * own that the app's backup rules leave out, in the cloud and from phone to
 * phone (res/xml/data_extraction_rules.xml, backup_rules.xml). A backup or a
 * transfer carries the web view's storage to a new phone, and with it came a
 * sign-in made on the old one. Now it carries the sign-in's name and not the
 * token, and the page knows from that to start signed out.
 *
 * Every Keystore call is asked twice before giving up for now
 * (KeystoreCalls), and a key the Keystore says is gone for good is deleted,
 * so the next sign-in makes a new one.
 *
 * Synchronized: the plugin runs on Capacitor's thread and the service on the
 * main one.
 */
final class Sessions {
  private Sessions() {}

  /** Where the sealed tokens are, by name. It reaches phones: renaming it signs every one out. */
  static final String PREFS = "crewbox-sessions";

  /** The Keystore key that seals them. The same goes for it. */
  static final String KEY_ALIAS = "crewbox-sessions";

  private static final String KEYSTORE = "AndroidKeyStore";

  private static SharedPreferences prefs(Context context) {
    return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  /** A Keystore call, asked again after a moment when it fails. */
  private static <T> T ask(KeystoreCalls.Call<T> call) throws GeneralSecurityException {
    return KeystoreCalls.retried(call, Sessions::keyGone, Sessions::pause);
  }

  /** Up to Tink's 100 ms, at random, so callers that failed together don't ask together. */
  private static void pause() {
    try {
      Thread.sleep((long) (Math.random() * KeystoreCalls.MAX_WAIT_MS));
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
    }
  }

  /**
   * Whether a failure says the key itself is gone for good, rather than
   * that the Keystore didn't answer.
   *
   * A cipher started with a key that can't be used again fails with
   * KeyPermanentlyInvalidatedException: from Android 12 when the Keystore no
   * longer has it, and before that when the Keystore has been reset (read in
   * Android 16's and 11's framework). Android 13 and later also say why, in
   * the android.security.KeyStoreException behind a failure, which is how a
   * key the Keystore found corrupted shows, loading it or using it.
   */
  private static boolean keyGone(Throwable failure) {
    for (Throwable cause = failure; cause != null; cause = cause.getCause()) {
      if (cause instanceof KeyPermanentlyInvalidatedException) return true;
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
          && cause instanceof android.security.KeyStoreException) {
        int code = ((android.security.KeyStoreException) cause).getNumericErrorCode();
        return KeystoreCalls.keyGone(Build.VERSION.SDK_INT, code);
      }
    }
    return false;
  }

  private static KeyStore keyStore() throws GeneralSecurityException, IOException {
    KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
    keyStore.load(null);
    return keyStore;
  }

  /** The key, or null before the first sign-in has made one, or once it is gone. */
  private static SecretKey key() throws GeneralSecurityException {
    try {
      return ask(() -> {
        Key key = keyStore().getKey(KEY_ALIAS, null);
        return key instanceof SecretKey ? (SecretKey) key : null;
      });
    } catch (KeystoreCalls.Gone e) {
      forgetKey();
      return null;
    }
  }

  /**
   * The key goes, so the next sign-in makes a new one. What it sealed will
   * never open, and is dropped as it is read.
   */
  private static void forgetKey() throws GeneralSecurityException {
    try {
      ask(() -> {
        keyStore().deleteEntry(KEY_ALIAS);
        return null;
      });
    } catch (KeystoreCalls.Gone e) {
      // Too far gone to delete, and a new key replaces it all the same.
    }
  }

  /**
   * A new key, usable with the phone locked, so the alerts service can read
   * its sign-in when Android restarts it with the phone in a pocket.
   */
  private static SecretKey newKey() throws GeneralSecurityException {
    return ask(() -> {
      KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
      generator.init(new KeyGenParameterSpec.Builder(
              KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setKeySize(256)
          .build());
      return generator.generateKey();
    });
  }

  /**
   * Every sign-in, by name.
   *
   * One that will never open is dropped: sealed under a key the Keystore no
   * longer has, or not sealed at all. Throws, and drops nothing, when the
   * Keystore won't answer, or before Android 12 says it has no key
   * (KeystoreCalls.missingMayBeOutOfReach); the page then starts signed out
   * of these and deletes nothing either.
   */
  static synchronized Map<String, String> all(Context context) throws GeneralSecurityException {
    SharedPreferences prefs = prefs(context);
    Map<String, String> sessions = new HashMap<>();
    Map<String, ?> stored = prefs.getAll();
    if (stored.isEmpty()) return sessions;
    SecretKey key = key();
    if (key == null && KeystoreCalls.missingMayBeOutOfReach(Build.VERSION.SDK_INT)) {
      throw new KeystoreCalls.NotNow(null);
    }
    SharedPreferences.Editor unreadable = prefs.edit();
    boolean dropped = false;
    for (Map.Entry<String, ?> entry : stored.entrySet()) {
      String name = entry.getKey();
      Object sealed = entry.getValue();
      try {
        if (key == null || !(sealed instanceof String)) {
          throw new SessionSeal.Unreadable("No key to open it with", null);
        }
        sessions.put(name, ask(() -> SessionSeal.open(key, name, (String) sealed)));
      } catch (SessionSeal.Unreadable e) {
        unreadable.remove(name);
        dropped = true;
      } catch (KeystoreCalls.Gone e) {
        // The key they were all sealed under.
        forgetKey();
        prefs.edit().clear().commit();
        return new HashMap<>();
      }
    }
    if (dropped) unreadable.commit();
    return sessions;
  }

  /**
   * One sign-in's token, or null when there is none: none under that name,
   * or one that will never open, which the page's next load drops.
   *
   * @throws KeystoreCalls.NotNow when the Keystore won't answer, which says
   *     nothing about the sign-in: it is still there to ask for later
   */
  static synchronized String get(Context context, String name) throws KeystoreCalls.NotNow {
    if (name == null || name.isEmpty()) return null;
    try {
      String sealed = prefs(context).getString(name, null);
      if (sealed == null) return null;
      SecretKey key = key();
      if (key == null && KeystoreCalls.missingMayBeOutOfReach(Build.VERSION.SDK_INT)) {
        throw new KeystoreCalls.NotNow(null);
      }
      if (key == null) return null;
      return ask(() -> SessionSeal.open(key, name, sealed));
    } catch (SessionSeal.Unreadable | KeystoreCalls.Gone | ClassCastException e) {
      // It will never open: the page drops it at its next load, and the key
      // with it if the key is gone.
      return null;
    } catch (KeystoreCalls.NotNow e) {
      throw e;
    } catch (GeneralSecurityException | RuntimeException e) {
      // Nothing else comes out of those, but whatever the Keystore throws
      // next, the sign-in is still there.
      throw new KeystoreCalls.NotNow(e);
    }
  }

  /** Keep a sign-in. Returns once it is written, so the page can reload straight after. */
  static synchronized void put(Context context, String name, String token)
      throws GeneralSecurityException, IOException {
    String sealed;
    try {
      sealed = seal(name, token);
    } catch (KeystoreCalls.Gone e) {
      // Once more, under a new key.
      forgetKey();
      sealed = seal(name, token);
    }
    if (!prefs(context).edit().putString(name, sealed).commit()) {
      throw new IOException("The sign-in wasn't written");
    }
  }

  private static String seal(String name, String token) throws GeneralSecurityException {
    SecretKey found = key();
    SecretKey key = found != null ? found : newKey();
    return ask(() -> SessionSeal.seal(key, name, token));
  }

  static synchronized void remove(Context context, String name) {
    prefs(context).edit().remove(name).commit();
  }
}
