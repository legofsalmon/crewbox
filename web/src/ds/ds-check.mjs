// @letissier/design-system 0.11.0 · ds-check.mjs · sha256-6872bd565dd4b66f · vendored by scripts/sync.mjs; change the design-system repo, not this copy
// The design system's checker, vendored into an app by scripts/sync.mjs and
// run from the app's CI. It needs nothing but Node 18 or later, and no
// checkout of the design system: the stamps carry what it checks against,
// and the published manifest says what is current.
//
//   node scripts/ds-check.mjs src/ds index.html
//       every copy in src/ds/ and every ds: block in index.html is as it was
//       vendored (not edited by hand), and current or behind is said
//   node scripts/ds-check.mjs src/ds --reads src
//       also: every var(--ds-*) read under src/ is one the tokens define
//   --strict          fail when a copy is behind, not only warn
//   --manifest URL    where the current manifest is (a URL or a file); else
//                     ../design-system/dist/manifest.json if it is checked
//                     out beside the app, else DS_MANIFEST, else the gallery
//   --offline         do not fetch the manifest
//   --sync            refill the copies from ../design-system first
//
// A hand edit or an undefined var(--ds-*) always fails: the edit is a fix the
// design system should get, and the next sync would drop it. Being behind is
// a warning (a GitHub annotation in Actions) unless --strict. If the manifest
// cannot be reached, it says so and does not fail. scripts/ds_check.py does
// the same for an app without Node.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

export const MANIFEST_URL = 'https://design-system-colly.vercel.app/manifest.json';
export const NAMES = ['tokens.css', 'base.css', 'components.css', 'tokens.js', 'tokens.d.ts', 'tokens.rs', 'icons.js', 'icons.d.ts', 'ds-check.mjs', 'ds_check.py'];
const STAMP = /^(?:\/\*|\/\/|#) @letissier\/design-system (\S+) · (\S+) · (sha256-[0-9a-f]{16}) · /;
const BLOCK = /\/\* ds:(tokens|base|components):start([^*]*)\*\/\r?\n?([\s\S]*?)\/\* ds:\1:end \*\//g;
const SHEET = { tokens: 'tokens.css', base: 'base.css', components: 'components.css' };
const READ_EXT = /\.(css|scss|html|js|mjs|jsx|ts|tsx|svelte|vue)$/;
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.next', 'out', 'coverage']);

// sync.mjs writes LF; a CRLF checkout of the same copy is not a hand edit
export const hash = (text) => `sha256-${createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16)}`;
const readText = (file) => readFileSync(file, 'utf8').replace(/^\uFEFF/, '');

/** -1, 0 or 1, comparing two x.y.z versions. */
const compare = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
};

/** What was vendored at each path: { where, name, version, hash, payload } per copy or block. */
export function vendored(paths) {
  const found = [];
  const problems = [];
  for (const path of paths) {
    if (!existsSync(path)) {
      problems.push(`${path}: not found`);
      continue;
    }
    const before = found.length;
    const isDir = statSync(path).isDirectory();
    const files = isDir ? readdirSync(path).sort().filter((f) => NAMES.includes(f)).map((f) => join(path, f)) : [path];
    for (const file of files) {
      const text = readText(file);
      const newline = text.indexOf('\n');
      const m = (newline === -1 ? text : text.slice(0, newline)).match(STAMP);
      if (m) {
        if (NAMES.includes(basename(file)) && m[2] !== basename(file)) problems.push(`${file}: its stamp says it is ${m[2]}`);
        found.push({ where: file, name: m[2], version: m[1], hash: m[3], payload: text.slice(newline + 1) });
        continue;
      }
      if (isDir) {
        // a copy with its stamp taken off would otherwise drop out unchecked
        problems.push(`${file}: not written by the design system's sync.mjs (no stamp on its first line)`);
        continue;
      }
      for (const sheet of Object.keys(SHEET)) {
        const starts = text.split(`/* ds:${sheet}:start`).length - 1;
        const ends = text.split(`/* ds:${sheet}:end */`).length - 1;
        const blocks = [...text.matchAll(BLOCK)].filter((b) => b[1] === sheet).length;
        if (starts !== blocks || ends !== blocks) problems.push(`${file}: the ds:${sheet} start and end markers do not pair`);
      }
      for (const b of text.matchAll(BLOCK)) {
        const declared = b[2].match(/@letissier\/design-system (\S+) (sha256-[0-9a-f]{16})/);
        found.push({
          where: `${file} (ds:${b[1]})`,
          name: SHEET[b[1]],
          version: declared?.[1] ?? null,
          hash: declared?.[2] ?? null,
          payload: b[3],
        });
      }
    }
    if (found.length === before) problems.push(`${path}: nothing vendored from the design system here`);
  }
  return { found, problems };
}

/** Hand edits: a copy whose payload no longer matches its own stamp. */
export function edits(found) {
  return found.flatMap((c) => {
    if (!c.hash) return [`${c.where}: never synced — run scripts/sync.mjs --inline`];
    if (hash(c.payload) !== c.hash) return [`${c.where}: edited by hand since it was vendored; take the change to the design-system repo`];
    return [];
  });
}

/** Every var(--ds-*) read under the given paths that the vendored tokens do not define. */
export function undefinedReads(found, reads) {
  const sheets = found.filter((c) => c.name === 'tokens.css');
  if (!sheets.length) return reads.length ? ['--reads needs a vendored tokens.css or ds:tokens block to compare with'] : [];
  const defined = new Set(sheets.flatMap((c) => [...c.payload.matchAll(/(--ds-[a-z0-9-]+)\s*:/g)].map((m) => m[1])));
  const problems = [];
  const visit = (path) => {
    let st;
    try {
      st = statSync(path);
    } catch {
      return; // a dangling link
    }
    if (st.isDirectory()) {
      if (SKIP_DIR.has(basename(path))) return;
      for (const f of readdirSync(path).sort()) visit(join(path, f));
      return;
    }
    if (!READ_EXT.test(path)) return;
    const text = readFileSync(path, 'utf8');
    // the vendored sheets define and read their own names
    if (STAMP.test(text.split('\n', 1)[0])) return;
    const own = new Set([...text.matchAll(/(--ds-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const missing = [...new Set([...text.matchAll(/var\(\s*(--ds-[a-z0-9-]+)/g)].map((m) => m[1]))]
      .filter((n) => !defined.has(n) && !own.has(n))
      .sort();
    for (const n of missing) problems.push(`${path}: reads ${n}, which the design system does not define`);
  };
  for (const r of reads) {
    if (existsSync(r)) visit(r);
    else problems.push(`${r}: not found`);
  }
  return problems;
}

/** Copies whose hash is not the manifest's: behind it, or ahead (synced from a branch not yet published). */
export function behind(found, manifest) {
  const late = [];
  const ahead = [];
  for (const c of found) {
    const current = manifest.files?.[c.name];
    if (!current || !c.hash || c.hash === current.hash) continue;
    if (c.version && /^\d+\.\d+\.\d+$/.test(c.version) && compare(c.version, manifest.version) > 0) {
      ahead.push(`${c.where}: ${c.version}, ahead of the published ${manifest.version}`);
    } else late.push(`${c.where}: ${c.version ?? 'unversioned'}, behind ${manifest.version}`);
  }
  return { late, ahead };
}

/** The manifest from a file or a URL, or { error } saying why there is none. */
export async function loadManifest(where) {
  try {
    if (!/^https?:/.test(where)) return JSON.parse(readFileSync(where, 'utf8'));
    const res = await fetch(where, { signal: AbortSignal.timeout(10000), redirect: 'manual' });
    if (!res.ok) return { error: `${where} answered ${res.status}` };
    return await res.json();
  } catch (e) {
    return { error: `${where}: ${e.message}` };
  }
}

function sync(paths, cwd) {
  const script = join(cwd, '..', 'design-system', 'scripts', 'sync.mjs');
  if (!existsSync(script)) throw new Error('--sync needs a checkout of legofsalmon/design-system beside this repository');
  for (const path of paths) {
    if (statSync(path).isDirectory()) {
      const files = readdirSync(path).filter((f) => NAMES.includes(f));
      execFileSync('node', [script, '--to', path, '--files', files.join(',')], { stdio: 'inherit' });
    } else if (/ds:tokens:start|ds:base:start|ds:components:start/.test(readFileSync(path, 'utf8'))) {
      execFileSync('node', [script, '--inline', path], { stdio: 'inherit' });
    } else {
      execFileSync('node', [script, '--to', join(path, '..'), '--files', basename(path)], { stdio: 'inherit' });
    }
  }
}

export async function main(argv, { cwd = process.cwd(), env = process.env, log = console.log, warn = console.error } = {}) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
  const takesValue = new Set(['--manifest']);
  const paths = [];
  const reads = [];
  let into = paths;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reads') into = reads;
    else if (takesValue.has(a)) i++;
    else if (!a.startsWith('--')) into.push(resolve(cwd, a));
  }
  if (!paths.length) {
    warn('ds-check: name the vendored copies, e.g. node scripts/ds-check.mjs src/ds index.html');
    return 2;
  }
  if (flags.has('--sync')) sync(paths, cwd);

  const { found, problems } = vendored(paths);
  problems.push(...edits(found), ...undefinedReads(found, reads));

  const notes = [];
  const late = [];
  if (!flags.has('--offline')) {
    const beside = join(cwd, '..', 'design-system', 'dist', 'manifest.json');
    const where = value('--manifest') ?? (existsSync(beside) ? beside : env.DS_MANIFEST || MANIFEST_URL);
    const manifest = await loadManifest(where);
    if (manifest.error) notes.push(`could not read the manifest (${manifest.error}), so whether the copies are current is not known`);
    else {
      const { late: l, ahead } = behind(found, manifest);
      late.push(...l);
      notes.push(...ahead);
      if (!l.length && !ahead.length) notes.push(`current with design-system ${manifest.version}`);
    }
  }

  const gh = env.GITHUB_ACTIONS === 'true';
  const here = (line) => line.split(cwd + sep).join('');
  for (const p of problems) warn(here(gh ? `::error::${p}` : p));
  for (const l of late) warn(here(gh ? `::warning::${l} — run the sync` : `${l} — run the sync`));
  for (const n of notes) log(`ds-check: ${n}`);
  if (!problems.length) log(`ok — ${found.length} cop${found.length === 1 ? 'y' : 'ies'} as vendored, in ${paths.map((p) => relative(cwd, p) || p).join(', ')}`);
  return problems.length || (late.length && flags.has('--strict')) ? 1 : 0;
}

if (process.argv[1] && /ds-check\.mjs$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e) => {
      console.error(e.message);
      process.exitCode = 1;
    },
  );
}
