# @crewbox/st2110

The ST 2110 checks from [legofsalmon/st2110](https://github.com/legofsalmon/st2110),
compiled to WebAssembly: the SDP file linter, the ST 2059-2 PTP message
checks, the NMOS registry checks and the RP 2110-25 capture analyser. They are
written once, in Rust, in that repository; this package is how crewbox runs
them, on the box under Node and in the browser on the Network page.

`pkg/` is generated and committed, so building crewbox needs no Rust. The
commit it was built from is `st2110.commit` in `package.json`, and
`NOTICES.txt` lists the Rust crates compiled into the module with their
licences (`scripts/third-party-notices.mjs` carries them into the notices a
box serves). st2110 has the same licensor and licence as crewbox.

## Using it

The box: `server/src/st2110.ts`, which loads the module once, on first use,
from the box binary or from this directory, and hands back `null` rather than
throwing when it cannot.

The browser: `web/src/lib/st2110.ts`, which fetches the module the first time
somebody uses a tool that needs it, so no phone downloads it otherwise.

## Rebuilding it

```sh
node scripts/build-st2110.mjs ../st2110   # a clean checkout at the commit you want
```

That needs Rust with the `wasm32-unknown-unknown` target and the
wasm-bindgen CLI at the version st2110's `Cargo.lock` names; the script says
which, and refuses a mismatch. Commit `pkg/`, `NOTICES.txt` and
`package.json` together, then run `node scripts/third-party-notices.mjs`.
