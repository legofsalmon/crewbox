# The crewbox download site

A static page and the installer, deployed to Vercel. It exists so admins have
somewhere to be sent that isn't a source repository — and so the source repo
can stay private while the binaries are public.

## How the pieces fit

```
crewbox (private)          this repo — source, and the release workflow
   │
   ├── site/               → Vercel, on your domain: the download page + install.sh
   │
   └── release workflow    → pushes built binaries to…
                              crewbox-dist (public) — releases only, no source
```

Nothing proxies the binaries. The page and `install.sh` both link straight at
`crewbox-dist` release assets, so GitHub's CDN carries the 120 MB and Vercel
serves two small files.

## Deploying it

Connect Vercel to the **private** crewbox repo (Vercel handles private repos
fine) and set:

| Setting          | Value   |
| ---------------- | ------- |
| Root Directory   | `site`  |
| Framework Preset | Other   |
| Build Command    | _empty_ |
| Output Directory | `.`     |

Then point `crewbox.letissier.ie` at the project. That hostname is written
into `index.html`, `install.sh` and `QUICKSTART.md`; change it in all three
if the site ever moves.

## Two names, not one

The download site and the box itself need **different** hostnames, because
they resolve to different places:

| Name                   | Resolves to      | What it is                                                    |
| ---------------------- | ---------------- | ------------------------------------------------------------- |
| `crewbox.letissier.ie` | Vercel, publicly | This page and `install.sh` — where an admin downloads the box |
| `chat.letissier.ie`    | the box's LAN IP | The box on site; the name its certificate is issued for       |

One name can't do both: the download page has to answer from the public
internet, and the box has to answer from a private address on the event
network. `deploy/dnsmasq.conf` and `deploy/cert-renew.sh` cover the second
one.

## Before it works

**`legofsalmon/crewbox-dist`** must exist as a **public** repo **with at least
one commit in it.** A README is enough. An empty repo looks like it should
work — the workflow uploads every asset successfully — and then fails on the
final call with `Validation Failed: Repository is empty`, because a release
needs a default branch to anchor its tag to. That cost a release once.

The private repo needs a **`DIST_REPO_TOKEN`** secret: a fine-grained PAT with
**Contents: Read and write** on `crewbox-dist` only. Read-only is the default
and produces `403 Resource not accessible by personal access token` at the
create-release step — a 403 rather than a 404 means the token can see the repo
but can't write to it, which is the quickest way to tell the two mistakes
apart. That's the one credential in this arrangement, and it can do nothing
except publish binaries.

Until the first release the download links 404, which is honest — there is
nothing to download yet.
