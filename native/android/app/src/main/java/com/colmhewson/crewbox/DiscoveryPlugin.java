package com.colmhewson.crewbox;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ext.SdkExtensions;

import androidx.annotation.RequiresApi;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Crew boxes on the Wi-Fi, for the page (web/src/lib/discovery.ts), as
 * CrewboxDiscovery.
 *
 * A box announces {@code _crewbox._tcp} on its crew network
 * (docs/DISCOVERY.md). NsdManager finds each service by name only, so every
 * one is resolved for its address, port and TXT record:
 *
 * <ul>
 *   <li>Android 14 and later: registerServiceInfoCallback, one per service,
 *       which keeps it up to date and is cancelled when the service goes.
 *   <li>Before that: resolveService, which the old stack runs one at a time
 *       per app ({@code FAILURE_ALREADY_ACTIVE} otherwise), with no time limit
 *       that its source shows. So resolves are queued, each is given ten
 *       seconds, and one that fails is tried again a little later, a few
 *       times at most.
 * </ul>
 *
 * Android 12 and earlier, and Android 13 without the T extensions 7 update,
 * only hear mDNS while an app holds a multicast lock (NsdManager's own
 * documentation), so the search takes one there and nowhere else. Searching
 * stops while the app is paused, as Android's guidance asks, and starts again
 * when it is back.
 *
 * No permission is asked for: at targetSdk 36 local network access comes
 * with INTERNET. Android 17's own permission, when the app targets it, fails
 * discovery with FAILURE_PERMISSION_DENIED, which is passed on as
 * {@code denied}.
 *
 * What is passed on is what the network said and no more. The page treats
 * every entry as a claim and asks the box itself before using one, over the
 * Wi-Fi even when it has no internet: SiteWifi keeps the app's traffic there
 * while the page is searching. Every callback is taken to the main thread,
 * where all of this runs.
 */
@CapacitorPlugin(name = "CrewboxDiscovery")
public class DiscoveryPlugin extends Plugin {

  private static final String SERVICE_TYPE = "_crewbox._tcp";

  /** The TXT keys the page reads (docs/DISCOVERY.md). Nothing else is passed on. */
  private static final String[] TXT_KEYS = {"txtvers", "id", "name", "ver", "proto", "setup", "tls"};

  /** How long one resolve on the old stack may take before the next is tried. */
  private static final long RESOLVE_TIMEOUT_MS = 10_000;

  /** Before trying a service again whose resolve failed or timed out. */
  private static final long RETRY_MS = 1_000;

  /** Resolves per service before it is left unlisted until the next search. */
  private static final int MAX_TRIES = 3;

  /** NsdManager.FAILURE_PERMISSION_DENIED, from API 37: local network access refused. */
  private static final int FAILURE_PERMISSION_DENIED = 7;

  private final Handler main = new Handler(Looper.getMainLooper());
  private NsdManager nsd;
  private WifiManager.MulticastLock lock;

  /** The search running now, or null. A callback from any other is stale. */
  private Discovery discovery;

  /** The page has asked for a search and not stopped it. */
  private boolean wanted;

  /** The last state passed on, so a page that asks again hears it again. */
  private String state = "";

  /** What the search reports now, by service name. */
  private final Map<String, Found> found = new LinkedHashMap<>();

  // The old stack's resolves, one at a time.
  private final ArrayDeque<String> queue = new ArrayDeque<>();
  private final Map<String, Integer> tries = new HashMap<>();
  private String resolving;
  private int attempt;

  /** One service, and what resolving it has said so far. */
  private static final class Found {
    final NsdServiceInfo info;
    List<String> addresses = new ArrayList<>();
    int port;
    Map<String, String> txt = new HashMap<>();
    /** Android 14 and later: its ServiceInfoCallback, while registered. */
    Object watcher;

    Found(NsdServiceInfo info) {
      this.info = info;
    }
  }

  @Override
  public void load() {
    nsd = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
  }

  @PluginMethod
  public void start(PluginCall call) {
    main.post(() -> {
      wanted = true;
      SiteWifi.get(getContext()).searching(true);
      if (discovery == null) {
        begin();
      } else {
        // Already looking, for a page that has just loaded: tell it what
        // there is so far.
        if (!state.isEmpty()) emitState(state, null);
        emitBoxes();
      }
      call.resolve();
    });
  }

  @PluginMethod
  public void stop(PluginCall call) {
    main.post(() -> {
      wanted = false;
      SiteWifi.get(getContext()).searching(false);
      end();
      call.resolve();
    });
  }

  @Override
  protected void handleOnPause() {
    main.post(this::end);
  }

  @Override
  protected void handleOnResume() {
    main.post(() -> {
      if (wanted && discovery == null) begin();
    });
  }

  /** A page is starting, so whatever asked for the search has gone. */
  @Override
  public void removeAllListeners() {
    super.removeAllListeners();
    main.post(() -> {
      wanted = false;
      SiteWifi.get(getContext()).searching(false);
      end();
    });
  }

  private void begin() {
    end();
    if (nsd == null) {
      emitState("failed", "This phone has no network service discovery");
      return;
    }
    takeLock();
    Discovery search = new Discovery();
    discovery = search;
    try {
      nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, search);
    } catch (RuntimeException e) {
      discovery = null;
      releaseLock();
      emitState("failed", e.getMessage());
    }
  }

  private void end() {
    Discovery search = discovery;
    discovery = null;
    if (search != null) {
      try {
        nsd.stopServiceDiscovery(search);
      } catch (RuntimeException ignored) {
        // Never started, or already stopped: either way it is not running.
      }
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      for (Found entry : found.values()) Watchers.unwatch(nsd, entry);
    }
    found.clear();
    queue.clear();
    tries.clear();
    resolving = null;
    // Any resolve still out there is stale from here on.
    attempt++;
    releaseLock();
    state = "";
  }

  /** One search. Its callbacks come on NsdManager's own thread. */
  private final class Discovery implements NsdManager.DiscoveryListener {
    @Override
    public void onDiscoveryStarted(String serviceType) {
      main.post(() -> {
        if (discovery == this) emitState("searching", null);
      });
    }

    @Override
    public void onStartDiscoveryFailed(String serviceType, int errorCode) {
      main.post(() -> {
        if (discovery != this) return;
        discovery = null;
        releaseLock();
        emitState(errorCode == FAILURE_PERMISSION_DENIED ? "denied" : "failed", "error " + errorCode);
      });
    }

    @Override
    public void onServiceFound(NsdServiceInfo info) {
      main.post(() -> {
        if (discovery == this) add(info);
      });
    }

    @Override
    public void onServiceLost(NsdServiceInfo info) {
      main.post(() -> {
        if (discovery == this) remove(info.getServiceName());
      });
    }

    @Override
    public void onDiscoveryStopped(String serviceType) {}

    @Override
    public void onStopDiscoveryFailed(String serviceType, int errorCode) {}
  }

  private void add(NsdServiceInfo info) {
    String name = info.getServiceName();
    // The same box seen on a second network is the same box.
    if (name == null || found.containsKey(name)) return;
    Found entry = new Found(info);
    found.put(name, entry);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      Watchers.watch(this, entry);
    } else {
      queue.add(name);
      resolveNext();
    }
  }

  private void remove(String name) {
    Found entry = found.remove(name);
    if (entry == null) return;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      Watchers.unwatch(nsd, entry);
    }
    queue.remove(name);
    tries.remove(name);
    // A resolve in flight for it runs its course: the old stack cannot
    // cancel one, and starting the next before it ends only fails.
    emitBoxes();
  }

  @SuppressWarnings("deprecation") // resolveService: the only resolve before Android 14
  private void resolveNext() {
    if (resolving != null || discovery == null) return;
    String name;
    Found entry;
    do {
      name = queue.poll();
      if (name == null) return;
      entry = found.get(name);
    } while (entry == null || entry.port > 0);
    final String service = name;
    final int mine = ++attempt;
    resolving = service;
    try {
      nsd.resolveService(
          entry.info,
          new NsdManager.ResolveListener() {
            @Override
            public void onResolveFailed(NsdServiceInfo info, int errorCode) {
              main.post(() -> resolveFailed(mine, service));
            }

            @Override
            public void onServiceResolved(NsdServiceInfo info) {
              main.post(() -> resolved(mine, service, info));
            }
          });
    } catch (RuntimeException e) {
      main.post(() -> resolveFailed(mine, service));
      return;
    }
    main.postDelayed(() -> resolveFailed(mine, service), RESOLVE_TIMEOUT_MS);
  }

  private void resolved(int mine, String name, NsdServiceInfo info) {
    // Taken even when it comes after its time ran out: it is still the answer.
    Found entry = found.get(name);
    if (entry != null) {
      fill(entry, info);
      emitBoxes();
    }
    if (mine == attempt) {
      resolving = null;
      resolveNext();
    }
  }

  private void resolveFailed(int mine, String name) {
    // Stale: this resolve has already ended one way or the other.
    if (mine != attempt || !name.equals(resolving)) return;
    resolving = null;
    Found entry = found.get(name);
    if (entry != null && entry.port == 0) {
      Integer before = tries.get(name);
      int count = before == null ? 1 : before + 1;
      tries.put(name, count);
      if (count < MAX_TRIES) {
        // Most often the one resolve the old stack allows is still out,
        // stuck or slow: after the others, and after a moment.
        main.postDelayed(
            () -> {
              if (found.get(name) == entry && discovery != null) {
                queue.add(name);
                resolveNext();
              }
            },
            RETRY_MS);
      }
    }
    resolveNext();
  }

  private void updated(Found entry, NsdServiceInfo info) {
    // Gone since, or from a search that has ended.
    if (found.get(entry.info.getServiceName()) != entry) return;
    fill(entry, info);
    emitBoxes();
  }

  private static void fill(Found entry, NsdServiceInfo info) {
    entry.addresses = ipv4Of(info);
    entry.port = info.getPort();
    entry.txt = txtOf(info);
  }

  /**
   * The service's IPv4 addresses. A box publishes only IPv4
   * (server/src/announce/responder.ts), but the old stack's one address can
   * be anything its lookup found first.
   */
  @SuppressWarnings("deprecation") // getHost: the only address before Android 14
  private static List<String> ipv4Of(NsdServiceInfo info) {
    List<InetAddress> all = new ArrayList<>();
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      all.addAll(info.getHostAddresses());
    } else if (info.getHost() != null) {
      all.add(info.getHost());
    }
    List<String> ipv4 = new ArrayList<>();
    for (InetAddress address : all) {
      if (address instanceof Inet4Address) ipv4.add(address.getHostAddress());
    }
    return ipv4;
  }

  /** The keys the page reads, as strings: "" for a key with no value. */
  private static Map<String, String> txtOf(NsdServiceInfo info) {
    Map<String, String> txt = new HashMap<>();
    Map<String, byte[]> attributes = info.getAttributes();
    if (attributes == null) return txt;
    for (Map.Entry<String, byte[]> attribute : attributes.entrySet()) {
      for (String key : TXT_KEYS) {
        // TXT keys are case-insensitive (RFC 6763), and Android keeps them as sent.
        if (!key.equalsIgnoreCase(attribute.getKey())) continue;
        byte[] value = attribute.getValue();
        txt.put(key, value == null ? "" : new String(value, StandardCharsets.UTF_8));
      }
    }
    return txt;
  }

  private void emitBoxes() {
    // The page that asked has gone, having said nothing. The bridge drops a
    // page's listeners when the next one starts, so this is the sign.
    if (!hasListeners("boxes")) {
      wanted = false;
      end();
      return;
    }
    List<String> names = new ArrayList<>(found.keySet());
    Collections.sort(names);
    JSArray boxes = new JSArray();
    for (String name : names) {
      Found entry = found.get(name);
      if (entry == null || entry.port <= 0 || entry.addresses.isEmpty()) continue;
      JSObject txt = new JSObject();
      for (Map.Entry<String, String> pair : entry.txt.entrySet()) {
        txt.put(pair.getKey(), pair.getValue());
      }
      JSObject box = new JSObject();
      box.put("name", name);
      box.put("addresses", new JSArray(entry.addresses));
      box.put("port", entry.port);
      box.put("txt", txt);
      boxes.put(box);
    }
    JSObject data = new JSObject();
    data.put("boxes", boxes);
    notifyListeners("boxes", data);
  }

  private void emitState(String value, String reason) {
    state = value;
    JSObject data = new JSObject();
    data.put("state", value);
    if (reason != null) data.put("reason", reason);
    notifyListeners("state", data);
  }

  private void takeLock() {
    if (lock != null || !needsLock()) return;
    WifiManager wifi =
        (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
    if (wifi == null) return;
    WifiManager.MulticastLock taken = wifi.createMulticastLock("crewbox-find-boxes");
    taken.setReferenceCounted(false);
    try {
      taken.acquire();
      lock = taken;
    } catch (RuntimeException e) {
      // Without it this phone may hear nothing, and the page says so after a while.
    }
  }

  private void releaseLock() {
    if (lock != null && lock.isHeld()) lock.release();
    lock = null;
  }

  /**
   * Whether this phone hears mDNS only while an app holds a multicast lock:
   * Android 12 and earlier, and Android 13 before T extensions 7. From then
   * on the system holds one for an app in the foreground that is searching.
   */
  private static boolean needsLock() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return false;
    return SdkExtensions.getExtensionVersion(Build.VERSION_CODES.TIRAMISU) < 7;
  }

  /** Android 14's resolve: a callback per service, kept up to date. */
  @RequiresApi(api = Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
  private static final class Watchers {
    static void watch(DiscoveryPlugin plugin, Found entry) {
      NsdManager.ServiceInfoCallback callback =
          new NsdManager.ServiceInfoCallback() {
            @Override
            public void onServiceInfoCallbackRegistrationFailed(int errorCode) {
              if (entry.watcher == this) entry.watcher = null;
            }

            @Override
            public void onServiceUpdated(NsdServiceInfo info) {
              plugin.updated(entry, info);
            }

            @Override
            public void onServiceLost() {
              // Discovery says so too, and that is what takes it off the list.
            }

            @Override
            public void onServiceInfoCallbackUnregistered() {}
          };
      entry.watcher = callback;
      try {
        // Its callbacks come on the main thread, where everything else is.
        plugin.nsd.registerServiceInfoCallback(entry.info, plugin.main::post, callback);
      } catch (RuntimeException e) {
        entry.watcher = null;
      }
    }

    static void unwatch(NsdManager nsd, Found entry) {
      Object watcher = entry.watcher;
      entry.watcher = null;
      if (!(watcher instanceof NsdManager.ServiceInfoCallback)) return;
      try {
        nsd.unregisterServiceInfoCallback((NsdManager.ServiceInfoCallback) watcher);
      } catch (RuntimeException ignored) {
        // Already gone with its service.
      }
    }
  }
}
