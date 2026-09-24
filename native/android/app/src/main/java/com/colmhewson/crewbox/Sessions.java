package com.colmhewson.crewbox;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
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

  /** The key, or null before the first sign-in has made one. */
  private static SecretKey key() throws GeneralSecurityException, IOException {
    KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
    keyStore.load(null);
    Key key = keyStore.getKey(KEY_ALIAS, null);
    return key instanceof SecretKey ? (SecretKey) key : null;
  }

  /**
   * A new key, usable with the phone locked, so the alerts service can read
   * its sign-in when Android restarts it with the phone in a pocket.
   */
  private static SecretKey newKey() throws GeneralSecurityException {
    KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
    generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build());
    return generator.generateKey();
  }

  /**
   * Every sign-in, by name.
   *
   * One that will never open is dropped: sealed under a key the Keystore no
   * longer has, or not sealed at all. Throws, and drops nothing, when the
   * Keystore won't answer; the page then starts signed out of these and
   * deletes nothing either.
   */
  static synchronized Map<String, String> all(Context context)
      throws GeneralSecurityException, IOException {
    SharedPreferences prefs = prefs(context);
    Map<String, String> sessions = new HashMap<>();
    Map<String, ?> stored = prefs.getAll();
    if (stored.isEmpty()) return sessions;
    SecretKey key = key();
    SharedPreferences.Editor unreadable = prefs.edit();
    boolean dropped = false;
    for (Map.Entry<String, ?> entry : stored.entrySet()) {
      String name = entry.getKey();
      try {
        if (key == null || !(entry.getValue() instanceof String)) {
          throw new SessionSeal.Unreadable("No key to open it with", null);
        }
        sessions.put(name, SessionSeal.open(key, name, (String) entry.getValue()));
      } catch (SessionSeal.Unreadable e) {
        unreadable.remove(name);
        dropped = true;
      }
    }
    if (dropped) unreadable.commit();
    return sessions;
  }

  /** One sign-in's token, or null when there is none, or none to be had now. */
  static synchronized String get(Context context, String name) {
    if (name == null || name.isEmpty()) return null;
    try {
      String sealed = prefs(context).getString(name, null);
      SecretKey key = sealed == null ? null : key();
      return key == null ? null : SessionSeal.open(key, name, sealed);
    } catch (Exception e) {
      return null;
    }
  }

  /** Keep a sign-in. Returns once it is written, so the page can reload straight after. */
  static synchronized void put(Context context, String name, String token)
      throws GeneralSecurityException, IOException {
    SecretKey key = key();
    if (key == null) key = newKey();
    String sealed = SessionSeal.seal(key, name, token);
    if (!prefs(context).edit().putString(name, sealed).commit()) {
      throw new IOException("The sign-in wasn't written");
    }
  }

  static synchronized void remove(Context context, String name) {
    prefs(context).edit().remove(name).commit();
  }
}
