---
title: HTTPS, names and certificates
section: Running the box
order: 30
blurb: Why the box wants a name and a certificate, and how the pieces fit on a network with no internet.
---

# HTTPS, names and certificates

The box works over plain HTTP. Two things need more: **browser
microphones** (voice beyond listen-only) and **installing the web app to a
home screen**. Both are browser security rules tied to HTTPS — so if you
want them, the box needs a certificate, and a certificate needs a name.

If your crew uses the Android/iOS apps for voice and nobody installs the
web app, you can skip this whole page.

## The two-names idea

One hostname can't serve both worlds, so crewbox's reference setup uses
two:

| Name                                       | Points at        | Job                                                |
| ------------------------------------------ | ---------------- | -------------------------------------------------- |
| A public name (like `crewbox.example.com`) | the internet     | the download page — where you got the box          |
| A box name (like `chat.example.com`)       | the box's LAN IP | what crew type; what the certificate is issued for |

The box name resolves to a **private address on the event network** —
which is exactly why the venue's DNS has to be taught about it.

## Getting the certificate on the box

Get a certificate for the box's name (a normal Let's Encrypt DNS-01
issuance works — it never needs the box reachable from the internet), then
drop `cert.pem` and `key.pem` into the box's data directory and restart.
The box serves TLS itself — no reverse proxy, nothing else to install.

Two forgiving behaviours worth knowing:

- **Broken or expired material never stops the box.** It logs why, serves
  plain HTTP, and the readiness list says what's wrong. A certificate
  problem on show day costs you browser mic, not comms.
- With a certificate installed, the box **advertises its name first** —
  the QR and join links lead with `https://chat.example.com` (raw IPs fail
  the browser's name check) with the plain addresses still listed after.

## Making the name resolve on site

Crew phones must resolve the box name to the box's LAN IP with no
internet. In order of preference:

1. **The venue router speaks dnsmasq** (most do): add one line mapping the
   name to the box's IP. **Admin → This network** generates exactly this
   file when it detects the name isn't resolving — download, hand to
   whoever runs the router.
2. **Your own event router**: same line, your own kit, no venue
   conversation.
3. **No DNS control at all**: crew use the IP over plain HTTP — everything
   works except browser mic and install, and the readiness list says so
   honestly.

## Checking it worked

**Admin → This network** is the scoreboard: the name check goes green when
phones can resolve the box, the certificate row shows expiry, and
**Admin → This box** shows voice fully working once browsers can get a
microphone. Certificate expiring mid-run? Renew before the event — the
readiness list starts warning as expiry approaches.
