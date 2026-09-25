package com.colmhewson.crewbox;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Log;

import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * Keeps the app's traffic for its box on the Wi-Fi the box is on.
 *
 * <p>A crew Wi-Fi usually has no internet. Android tests each network it
 * joins, and with mobile data on, a Wi-Fi that fails the test is not the
 * phone's default network: an app's connections go out over mobile data,
 * where a box on a private address can't be reached. So while the app's box
 * is on a Wi-Fi, the whole app is bound to that Wi-Fi
 * ({@link ConnectivityManager#bindProcessToNetwork}): the web view's requests,
 * sockets and voice, and the alerts service's WebSocket, all go out over it
 * whatever Android's default is. The app holds a request for the Wi-Fi
 * ({@link ConnectivityManager#requestNetwork}), which is how an app finds the
 * network to bind to, and keeps it one apps may use. That needs
 * CHANGE_NETWORK_STATE, a normal permission granted at install.
 *
 * <p>A box is on the Wi-Fi when its address is on one of the Wi-Fi's own
 * subnets. A name is looked up on the Wi-Fi, as the crew network's DNS
 * answers it. No box yet counts as on it: the one a crew member is about to
 * join is on the Wi-Fi they are on. So do the boxes the app is searching the
 * Wi-Fi for (DiscoveryPlugin), on a Wi-Fi with no internet, where nothing
 * else reaches what the search finds: at a new venue, say, while the app
 * still has the last one's box. A box anywhere else is left to Android's
 * default network: one reached over the internet, or over a VPN, which
 * binding to the Wi-Fi would go round. So is everything when the phone has
 * no Wi-Fi, and when the Wi-Fi goes, the binding goes with it.
 *
 * <p>The page says which box it uses (NetworkPlugin), and the box is kept here
 * too, so the app is bound before the page has loaded, and the alerts service
 * is when Android restarts it on its own. Everything runs on one thread of its
 * own, and a name is looked up on another.
 *
 * <p>A connection keeps the network it was opened on, and one still trying
 * the old way goes on trying until it times out, so whoever holds one hears
 * each time the app's traffic moves ({@link #hear}): the page, told as a
 * browser is when its network comes back, and the alerts service.
 */
final class SiteWifi {

  private static final String TAG = "CrewboxSiteWifi";
  private static final String PREFS = "crewbox-site-wifi";
  private static final String PREF_ORIGIN = "origin";

  /**
   * How long a page waits to hear where its traffic goes: for Android to say
   * whether there is a Wi-Fi, and for a name to be looked up on it. After
   * that the page carries on, and a late answer still binds the app.
   */
  private static final long SETTLE_MS = 1_500;

  /**
   * Before looking a name up again that the Wi-Fi's DNS didn't answer,
   * doubling to a minute: the crew network's DNS may be the box itself,
   * still starting up, or a router whose entry for the box is on its way.
   */
  private static final long RETRY_MS = 5_000;
  private static final long MAX_RETRY_MS = 60_000;

  private static final Pattern IPV4 = Pattern.compile("^\\d{1,3}(\\.\\d{1,3}){3}$");

  private static SiteWifi instance;

  static synchronized SiteWifi get(Context context) {
    if (instance == null) instance = new SiteWifi(context.getApplicationContext());
    return instance;
  }

  private final ConnectivityManager connectivity;
  private final SharedPreferences prefs;
  private final Handler handler;
  private final ExecutorService lookups =
      Executors.newSingleThreadExecutor(task -> {
        Thread thread = new Thread(task, "crewbox-site-wifi-lookup");
        thread.setDaemon(true);
        return thread;
      });

  // Everything below is touched on the handler's thread only.

  private boolean started;
  /** When the request went in: until SETTLE_MS after, no Wi-Fi may mean not heard yet. */
  private long requestedAt;
  /** The box's origin, '' before the app has one. */
  private String origin = "";
  /** The Wi-Fi the request has, or null. */
  private Network wifi;
  /** That Wi-Fi's own subnets, or null until Android has said. */
  private List<Subnet> subnets;
  /** Whether Android has found internet on that Wi-Fi. */
  private boolean validated;
  /** Whether the app is searching the Wi-Fi for boxes. */
  private boolean searching;
  /** What the app is bound to, or null for Android's default. */
  private Network bound;
  /** A name being looked up for the decision numbered {@link #decision}. */
  private boolean looking;
  /** Counts decisions, so a lookup for one that has been overtaken changes nothing. */
  private int decision;
  /** Until the next look at a name the Wi-Fi's DNS didn't answer. */
  private long retryMs = RETRY_MS;
  private final Runnable retry = this::decide;
  /** Pages waiting to hear where their traffic goes. */
  private final List<Consumer<Boolean>> waiting = new ArrayList<>();
  /** Told whenever the app's traffic moves; added to and taken from on any thread. */
  private final List<Runnable> hearing = new CopyOnWriteArrayList<>();

  private SiteWifi(Context context) {
    connectivity = context.getSystemService(ConnectivityManager.class);
    prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    HandlerThread thread = new HandlerThread("crewbox-site-wifi");
    thread.start();
    handler = new Handler(thread.getLooper());
  }

  /**
   * Start holding the Wi-Fi for the box kept from last time, or for {@code
   * fallback} when nothing was kept, as for a phone updated while the alerts
   * service ran. Once per process; later calls change nothing.
   */
  void start(String fallback) {
    handler.post(() -> {
      if (started) return;
      started = true;
      origin = prefs.getString(PREF_ORIGIN, fallback == null ? "" : fallback);
      requestedAt = SystemClock.elapsedRealtime();
      NetworkRequest request =
          new NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build();
      try {
        connectivity.requestNetwork(request, callback);
      } catch (RuntimeException e) {
        // No CHANGE_NETWORK_STATE, or too many requests: the app follows
        // Android's default network, as it did before.
        Log.w(TAG, "can't hold the Wi-Fi", e);
      }
    });
  }

  /** The box the page uses now, '' for none; {@code done} as for {@link #whenSettled}. */
  void use(String next, Consumer<Boolean> done) {
    start("");
    handler.post(() -> {
      String box = next == null ? "" : next;
      if (box.equals(origin)) return;
      origin = box;
      prefs.edit().putString(PREF_ORIGIN, box).apply();
      retryMs = RETRY_MS;
      decide();
    });
    whenSettled(done);
  }

  /** Whether the app is searching the Wi-Fi for boxes, which it then has to reach. */
  void searching(boolean now) {
    start("");
    handler.post(() -> {
      if (now == searching) return;
      searching = now;
      decide();
    });
  }

  /**
   * {@code moved} runs each time the app's traffic moves onto a Wi-Fi or off
   * it, on this class's thread, until {@link #stopHearing}.
   */
  void hear(Runnable moved) {
    hearing.add(moved);
  }

  void stopHearing(Runnable moved) {
    hearing.remove(moved);
  }

  /**
   * {@code done} hears whether the app is bound to a Wi-Fi, once where its
   * traffic goes is settled, or after SETTLE_MS, on this class's thread.
   */
  void whenSettled(Consumer<Boolean> done) {
    handler.post(() -> {
      waiting.add(done);
      if (settled()) settle();
      else handler.postDelayed(this::settle, SETTLE_MS);
    });
  }

  /**
   * Whether where the app's traffic goes is known: no name is being looked
   * up, and Android has said there is a Wi-Fi, or has had time to.
   */
  private boolean settled() {
    return !looking
        && (wifi != null || SystemClock.elapsedRealtime() >= requestedAt + SETTLE_MS);
  }

  private final ConnectivityManager.NetworkCallback callback =
      new ConnectivityManager.NetworkCallback() {
        @Override
        public void onAvailable(Network network) {
          handler.post(() -> {
            if (network.equals(wifi)) return;
            wifi = network;
            subnets = null;
            validated = false;
            retryMs = RETRY_MS;
            decide();
          });
        }

        @Override
        public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {
          // Often: the signal strength is one of them. Only internet matters here.
          boolean now = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
          handler.post(() -> {
            if (!network.equals(wifi) || now == validated) return;
            validated = now;
            decide();
          });
        }

        @Override
        public void onLinkPropertiesChanged(Network network, LinkProperties properties) {
          List<Subnet> now = subnetsOf(properties);
          handler.post(() -> {
            if (!network.equals(wifi) || now.equals(subnets)) return;
            subnets = now;
            decide();
          });
        }

        @Override
        public void onLost(Network network) {
          handler.post(() -> {
            if (!network.equals(wifi)) return;
            wifi = null;
            subnets = null;
            decide();
          });
        }
      };

  /** Bind the app for the box and Wi-Fi as they are now, looking a name up first. */
  private void decide() {
    final int mine = ++decision;
    looking = false;
    handler.removeCallbacks(retry);
    final Network on = wifi;
    if (on == null) {
      bind(null);
      if (settled()) settle();
      return;
    }
    Route route = route(origin, searching, validated, subnets);
    if (route != Route.LOOK_UP) {
      bind(route == Route.WIFI ? on : null);
      settle();
      return;
    }
    // A name, looked up on the Wi-Fi itself, as the crew network's DNS
    // answers it. The binding stays as it is meanwhile.
    looking = true;
    final String host = hostOf(origin);
    final List<Subnet> theirs = subnets;
    lookups.execute(() -> {
      List<InetAddress> found;
      try {
        found = Arrays.asList(on.getAllByName(host));
      } catch (UnknownHostException | RuntimeException e) {
        found = null;
      }
      final List<InetAddress> addresses = found;
      handler.post(() -> {
        if (mine != decision) return;
        looking = false;
        if (addresses == null) {
          bind(null);
          handler.postDelayed(retry, retryMs);
          retryMs = Math.min(MAX_RETRY_MS, retryMs * 2);
        } else {
          retryMs = RETRY_MS;
          bind(onSite(addresses, theirs) ? on : null);
        }
        settle();
      });
    });
  }

  private void bind(Network network) {
    if (network == null ? bound == null : network.equals(bound)) return;
    if (connectivity.bindProcessToNetwork(network)) {
      bound = network;
      for (Runnable moved : hearing) moved.run();
    } else {
      // A network gone since, or one this app may not use, as under a VPN
      // that allows no way round it. Traffic stays where it was going.
      Log.w(TAG, "couldn't bind to " + network);
    }
  }

  /** Where the app's traffic goes, before any name is looked up. */
  enum Route { WIFI, DEFAULT, LOOK_UP }

  /**
   * Where the app's traffic goes while a Wi-Fi is up, from the box's origin
   * ('' for none), whether the app is searching the Wi-Fi for boxes, whether
   * Android found internet on the Wi-Fi, and its subnets (null until heard).
   * A name has to be looked up on the Wi-Fi first.
   */
  static Route route(String origin, boolean searching, boolean validated, List<Subnet> subnets) {
    if (origin.isEmpty()) return Route.WIFI;
    // What the search finds is reached over the Wi-Fi only, when it has no
    // internet; one with internet is Android's default anyway.
    if (searching && !validated) return Route.WIFI;
    String host = hostOf(origin);
    InetAddress literal = literal(host);
    if (literal != null) {
      return onSite(Collections.singletonList(literal), subnets) ? Route.WIFI : Route.DEFAULT;
    }
    return host.isEmpty() ? Route.DEFAULT : Route.LOOK_UP;
  }

  /** Tell the pages waiting where their traffic goes. */
  private void settle() {
    if (waiting.isEmpty()) return;
    boolean onWifi = bound != null;
    List<Consumer<Boolean>> told = new ArrayList<>(waiting);
    waiting.clear();
    for (Consumer<Boolean> done : told) done.accept(onWifi);
  }

  /**
   * The host in an origin as the page writes one, scheme://host:port, with
   * an IPv6 address out of its brackets; '' for anything else.
   */
  static String hostOf(String origin) {
    int at = origin.indexOf("://");
    if (at < 0) return "";
    String authority = origin.substring(at + 3);
    int slash = authority.indexOf('/');
    if (slash >= 0) authority = authority.substring(0, slash);
    if (authority.startsWith("[")) {
      int close = authority.indexOf(']');
      return close < 0 ? "" : authority.substring(1, close);
    }
    int colon = authority.indexOf(':');
    return colon < 0 ? authority : authority.substring(0, colon);
  }

  /** An address written as one, read without a lookup; null for a name. */
  static InetAddress literal(String host) {
    try {
      if (IPV4.matcher(host).matches()) {
        String[] parts = host.split("\\.");
        byte[] bytes = new byte[4];
        for (int i = 0; i < 4; i++) {
          int part = Integer.parseInt(parts[i]);
          if (part > 255) return null;
          bytes[i] = (byte) part;
        }
        return InetAddress.getByAddress(bytes);
      }
      // The page writes IPv6 as a URL does, which parses as a literal.
      return host.contains(":") ? InetAddress.getByName(host) : null;
    } catch (UnknownHostException | NumberFormatException e) {
      return null;
    }
  }

  private static List<Subnet> subnetsOf(LinkProperties properties) {
    if (properties == null) return Collections.emptyList();
    List<Subnet> out = new ArrayList<>();
    for (LinkAddress address : properties.getLinkAddresses()) {
      out.add(new Subnet(address.getAddress(), address.getPrefixLength()));
    }
    return out;
  }

  /**
   * Whether a box at one of these addresses is on this Wi-Fi: on one of its
   * own subnets. Until Android has said what those are (null), which before
   * Android 8 it isn't promised to do straight away, a private or link-local
   * address counts, since only a local network reaches one. 100.64.0.0/10
   * doesn't: it is a carrier's, or a VPN's such as Tailscale's.
   */
  static boolean onSite(List<InetAddress> addresses, List<Subnet> subnets) {
    for (InetAddress address : addresses) {
      if (subnets == null) {
        if (address.isSiteLocalAddress() || address.isLinkLocalAddress() || uniqueLocal(address)) {
          return true;
        }
        continue;
      }
      for (Subnet subnet : subnets) {
        if (subnet.contains(address)) return true;
      }
    }
    return false;
  }

  /** IPv6's own private addresses, fc00::/7. */
  private static boolean uniqueLocal(InetAddress address) {
    return address instanceof Inet6Address && (address.getAddress()[0] & 0xfe) == 0xfc;
  }

  /** One of the Wi-Fi's subnets: an address on it, and its prefix length. */
  static final class Subnet {
    final byte[] address;
    final int prefixLength;

    Subnet(InetAddress address, int prefixLength) {
      this.address = address.getAddress();
      this.prefixLength = prefixLength;
    }

    boolean contains(InetAddress other) {
      byte[] bytes = other.getAddress();
      if (bytes.length != address.length) return false;
      int bits = Math.max(0, Math.min(prefixLength, bytes.length * 8));
      for (int i = 0; i < bits; i++) {
        int mask = 0x80 >> (i % 8);
        if ((bytes[i / 8] & mask) != (address[i / 8] & mask)) return false;
      }
      return true;
    }

    @Override
    public boolean equals(Object other) {
      return other instanceof Subnet
          && ((Subnet) other).prefixLength == prefixLength
          && Arrays.equals(((Subnet) other).address, address);
    }

    @Override
    public int hashCode() {
      return 31 * Arrays.hashCode(address) + prefixLength;
    }
  }
}
