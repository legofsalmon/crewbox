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

Then point your domain at the project.

## Before it works

Two placeholders need replacing, and one repo needs to exist.

1. **`CREWBOX_SITE`** appears in `index.html` and `install.sh`. Replace both
   with the real hostname, e.g. `crewbox.example.com`.
2. **`legofsalmon/crewbox-dist`** must exist as a **public** repo. It needs no
   content — the release workflow creates releases in it.
3. The release workflow needs a **`DIST_REPO_TOKEN`** secret in the private
   repo: a fine-grained PAT with `contents: read and write` on `crewbox-dist`
   only. That's the one credential in this arrangement, and it can do nothing
   except publish binaries.

Until then the download links 404, which is honest — there is nothing to
download yet.
