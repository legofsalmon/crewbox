package com.colmhewson.crewbox;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.net.InetAddress;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import org.junit.Test;

/**
 * When the app counts its box as on the Wi-Fi, and so keeps its traffic
 * there rather than on mobile data (SiteWifi).
 */
public class SiteWifiTest {

  private static InetAddress ip(String literal) throws Exception {
    // A literal: parsed, never looked up.
    return InetAddress.getByName(literal);
  }

  private static List<InetAddress> ips(String... literals) throws Exception {
    List<InetAddress> out = new ArrayList<>();
    for (String literal : literals) out.add(ip(literal));
    return out;
  }

  /** A crew Wi-Fi on 10.20.0.0/16, with IPv6 on its link only. */
  private static List<SiteWifi.Subnet> crewWifi() throws Exception {
    return Arrays.asList(
        new SiteWifi.Subnet(ip("10.20.4.17"), 16),
        new SiteWifi.Subnet(ip("fe80::1c2:3ff:fe44:5566"), 64));
  }

  @Test
  public void aBoxOnTheWifisSubnetIsOnIt() throws Exception {
    assertTrue(SiteWifi.onSite(ips("10.20.0.1"), crewWifi()));
    assertTrue(SiteWifi.onSite(ips("10.20.255.254"), crewWifi()));
    assertTrue(SiteWifi.onSite(ips("fe80::99"), crewWifi()));
  }

  @Test
  public void aPrivateAddressOffTheWifiIsNot() throws Exception {
    // Reached some other way, such as a VPN, which binding to the Wi-Fi
    // would go round.
    assertFalse(SiteWifi.onSite(ips("10.21.0.1"), crewWifi()));
    assertFalse(SiteWifi.onSite(ips("192.168.1.10"), crewWifi()));
    assertFalse(SiteWifi.onSite(ips("fd00::5"), crewWifi()));
  }

  @Test
  public void anInternetAddressIsNot() throws Exception {
    assertFalse(SiteWifi.onSite(ips("203.0.113.9"), crewWifi()));
    assertFalse(SiteWifi.onSite(ips("2001:db8::9"), crewWifi()));
  }

  @Test
  public void anyOneOfANamesAddressesWillDo() throws Exception {
    assertTrue(SiteWifi.onSite(ips("203.0.113.9", "10.20.1.2"), crewWifi()));
    assertFalse(SiteWifi.onSite(Collections.emptyList(), crewWifi()));
  }

  @Test
  public void aWifiWithNoAddressHasNothingOnIt() throws Exception {
    assertFalse(SiteWifi.onSite(ips("10.20.0.1"), Collections.emptyList()));
  }

  @Test
  public void untilAndroidHasSaidTheSubnetsAPrivateAddressCounts() throws Exception {
    for (String local : new String[] {
        "10.0.0.5", "172.16.0.5", "172.31.255.1", "192.168.0.5", "169.254.10.1",
        "fd12:3456::1", "fc00::1", "fe80::1"}) {
      assertTrue(local, SiteWifi.onSite(ips(local), null));
    }
    for (String elsewhere : new String[] {
        "203.0.113.9", "172.32.0.5", "2001:db8::9",
        // A carrier's, or a VPN's such as Tailscale's.
        "100.64.0.1", "100.100.1.1"}) {
      assertFalse(elsewhere, SiteWifi.onSite(ips(elsewhere), null));
    }
  }

  @Test
  public void aSubnetMatchesOnItsPrefix() throws Exception {
    SiteWifi.Subnet slash22 = new SiteWifi.Subnet(ip("192.168.4.200"), 22);
    assertTrue(slash22.contains(ip("192.168.4.1")));
    assertTrue(slash22.contains(ip("192.168.7.255")));
    assertFalse(slash22.contains(ip("192.168.8.0")));
    assertFalse(slash22.contains(ip("192.168.3.255")));

    SiteWifi.Subnet slash64 = new SiteWifi.Subnet(ip("2001:db8:1:2::77"), 64);
    assertTrue(slash64.contains(ip("2001:db8:1:2:ffff::1")));
    assertFalse(slash64.contains(ip("2001:db8:1:3::1")));
  }

  @Test
  public void oneFamilyNeverMatchesTheOther() throws Exception {
    assertFalse(new SiteWifi.Subnet(ip("10.0.0.1"), 0).contains(ip("a00::1")));
    assertFalse(new SiteWifi.Subnet(ip("a00::1"), 0).contains(ip("10.0.0.1")));
  }

  @Test
  public void theEdgesOfAPrefixAreEverythingAndOneAddress() throws Exception {
    assertTrue(new SiteWifi.Subnet(ip("10.0.0.5"), 0).contains(ip("203.0.113.1")));
    assertTrue(new SiteWifi.Subnet(ip("10.0.0.5"), 32).contains(ip("10.0.0.5")));
    assertFalse(new SiteWifi.Subnet(ip("10.0.0.5"), 32).contains(ip("10.0.0.6")));
  }

  @Test
  public void subnetsAreEqualByAddressAndPrefix() throws Exception {
    // So a repeat of the same link properties changes nothing.
    assertEquals(new SiteWifi.Subnet(ip("10.0.0.5"), 24), new SiteWifi.Subnet(ip("10.0.0.5"), 24));
    assertFalse(
        new SiteWifi.Subnet(ip("10.0.0.5"), 24).equals(new SiteWifi.Subnet(ip("10.0.0.5"), 16)));
    assertFalse(
        new SiteWifi.Subnet(ip("10.0.0.5"), 24).equals(new SiteWifi.Subnet(ip("10.0.0.6"), 24)));
  }

  @Test
  public void theHostComesOutOfAnOrigin() {
    assertEquals("10.20.0.1", SiteWifi.hostOf("http://10.20.0.1:8080"));
    assertEquals("10.20.0.1", SiteWifi.hostOf("http://10.20.0.1"));
    assertEquals("crew.example", SiteWifi.hostOf("https://crew.example"));
    assertEquals("crew_box", SiteWifi.hostOf("http://crew_box:8080"));
    assertEquals("fd00::5", SiteWifi.hostOf("http://[fd00::5]:8080"));
    assertEquals("fd00::5", SiteWifi.hostOf("http://[fd00::5]"));
    assertEquals("10.20.0.1", SiteWifi.hostOf("http://10.20.0.1:8080/"));
    assertEquals("", SiteWifi.hostOf(""));
    assertEquals("", SiteWifi.hostOf("10.20.0.1"));
    assertEquals("", SiteWifi.hostOf("http://[fd00::5"));
  }

  @Test
  public void anAddressIsReadAsOne() throws Exception {
    assertEquals(ip("10.20.0.1"), SiteWifi.literal("10.20.0.1"));
    assertEquals(ip("fd00::5"), SiteWifi.literal("fd00::5"));
  }

  @Test
  public void aNameIsNotAnAddress() {
    assertNull(SiteWifi.literal("crew.example"));
    assertNull(SiteWifi.literal("crewbox"));
    assertNull(SiteWifi.literal("256.1.1.1"));
    assertNull(SiteWifi.literal("1.2.3"));
    assertNull(SiteWifi.literal(""));
  }
}
