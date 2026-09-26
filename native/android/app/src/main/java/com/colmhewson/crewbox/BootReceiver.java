package com.colmhewson.crewbox;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Alerts back after a restart and after an update (docs/ALERTS.md).
 *
 * Without it a phone that rebooted in a pocket, or took an update from the
 * box, stayed silent until somebody opened crewbox, and nothing said so. It
 * starts the service only when it was on: signed in, with alerts, and not
 * signed out since. The service then reads the token where the app keeps it
 * (Sessions), as it does after the OS restarts it.
 *
 * The boot broadcast comes after the first unlock, when that sign-in can be
 * read; nothing runs before it. A phone force-stopped by its owner gets no
 * broadcast at all until the app is opened again, which is Android's rule.
 * `specialUse` is one of the foreground service types Android still lets a
 * boot receiver start on 15 and later; `dataSync` is not.
 */
public class BootReceiver extends BroadcastReceiver {

  @Override
  public void onReceive(Context context, Intent intent) {
    String action = intent == null ? null : intent.getAction();
    if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
        && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
      return;
    }
    if (!AlertsService.wasOn(context)) return;
    try {
      AlertsService.resume(context);
    } catch (RuntimeException e) {
      // A start Android refused (a maker's own battery rules): the app
      // starts the service again when it is next opened.
    }
  }

  /** Signed in with alerts on: an address and the name of the sign-in, kept. */
  static boolean shouldResume(String serverUrl, String session) {
    return serverUrl != null && !serverUrl.isEmpty() && session != null && !session.isEmpty();
  }
}
