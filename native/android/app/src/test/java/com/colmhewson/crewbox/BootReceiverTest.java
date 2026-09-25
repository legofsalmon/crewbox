package com.colmhewson.crewbox;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Alerts come back after a reboot only for a phone that had them on. */
public class BootReceiverTest {

  @Test
  public void aKeptSignInResumes() {
    assertTrue(BootReceiver.shouldResume("http://10.20.0.1:3000", "crewbox:evt-3f9c2a:token"));
  }

  @Test
  public void aSignOutOrNoSignInStaysOff() {
    // Signing out clears both (AlertsService.stop), as does a refused token.
    assertFalse(BootReceiver.shouldResume("", ""));
    assertFalse(BootReceiver.shouldResume("http://10.20.0.1:3000", ""));
    assertFalse(BootReceiver.shouldResume("", "crewbox:evt-3f9c2a:token"));
    assertFalse(BootReceiver.shouldResume(null, null));
  }
}
