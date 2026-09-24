package com.colmhewson.crewbox;

import static org.junit.Assert.assertEquals;

import android.app.Activity;
import android.provider.Settings;

import java.util.Arrays;
import java.util.Collections;

import org.junit.Test;

/**
 * What the phone's "Save this network?" screen answers, as the join screen
 * hears it (WifiOutcome in web/src/lib/server.ts). Settings'
 * AddAppNetworksFragment finishes with RESULT_OK and one code per network, or
 * RESULT_CANCELED and nothing.
 */
public class WifiPluginTest {

  @Test
  public void aSavedNetworkIsSaved() {
    assertEquals("saved", WifiPlugin.outcome(
        Activity.RESULT_OK, Collections.singletonList(Settings.ADD_WIFI_RESULT_SUCCESS)));
  }

  @Test
  public void oneSavedAlreadyIsKnown() {
    // Settings then shows nothing, and joins nothing.
    assertEquals("known", WifiPlugin.outcome(
        Activity.RESULT_OK, Collections.singletonList(Settings.ADD_WIFI_RESULT_ALREADY_EXISTS)));
  }

  @Test
  public void aNoIsDeclined() {
    assertEquals("declined", WifiPlugin.outcome(Activity.RESULT_CANCELED, null));
    // Whatever else comes with it.
    assertEquals("declined", WifiPlugin.outcome(
        Activity.RESULT_CANCELED, Collections.singletonList(Settings.ADD_WIFI_RESULT_SUCCESS)));
  }

  @Test
  public void aFailedSaveIsNotCalledSaved() {
    assertEquals("unavailable", WifiPlugin.outcome(
        Activity.RESULT_OK, Collections.singletonList(Settings.ADD_WIFI_RESULT_ADD_OR_UPDATE_FAILED)));
  }

  @Test
  public void aYesWithNoCodeIsSaved() {
    assertEquals("saved", WifiPlugin.outcome(Activity.RESULT_OK, null));
    assertEquals("saved", WifiPlugin.outcome(Activity.RESULT_OK, Collections.emptyList()));
    assertEquals("saved", WifiPlugin.outcome(Activity.RESULT_OK, Arrays.asList((Integer) null)));
  }
}
