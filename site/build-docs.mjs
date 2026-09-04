// Build the user docs: site/docs-src/*.md → site/docs/*.html, plus the
// search index and the sitemap. Zero dependencies, deterministic output —
// the generated files are committed, and CI regenerates and diffs them, so
// a byte of nondeterminism here shows up as a red build.
//
// The Markdown dialect is deliberately a strict subset. Anything this file
// does not recognise is a build error, not a silent passthrough: docs that
// render wrong are worse than docs that fail to build.
//
//   npm run docs:build      regenerate site/docs + site/sitemap.xml
//   npm run docs:test       unit tests (node --test)
//   npm run docs:preview    serve the site locally with clean URLs
//
// Screenshots are referenced as ![alt](shot:scene-name) and expand to a
// <picture> that serves scene-name-light.png to light-theme readers and
// scene-name-dark.png (the app's default look) to everyone else. Both files
// must exist in site/docs/img — a missing one fails the build, so a renamed
// scene can never leave a broken image in production.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SITE_DIR = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = join(SITE_DIR, 'docs-src')
const OUT_DIR = join(SITE_DIR, 'docs')
const IMG_DIR = join(OUT_DIR, 'img')

/** The public origin. Also hard-coded in index.html, install.sh and
 *  QUICKSTART.md — site/README.md keeps the list. */
export const ORIGIN = 'https://crewbox.letissier.ie'

/** Sidebar groups, in display order. A page naming any other section is a
 *  build error — typos must not silently mint a new nav group. */
export const SECTIONS = [
  'Start here',
  'Chat & voice',
  'Running order',
  'Show log',
  'Patch sheets',
  'Lighting',
  'Video',
  'Network',
  'Running the box',
  'Reference',
]

// ---------------------------------------------------------------- parsing

/** Strict front matter: `---` fence, `key: value` lines, `---` fence. */
export function parseFrontMatter(src, name = 'page') {
  const lines = src.split('\n')
  if (lines[0] !== '---') throw new Error(`${name}: missing front matter`)
  const meta = {}
  let i = 1
  for (; i < lines.length && lines[i] !== '---'; i++) {
    const m = /^([a-z]+):\s+(.+)$/.exec(lines[i])
    if (!m) throw new Error(`${name}: bad front matter line: "${lines[i]}"`)
    meta[m[1]] = m[2]
  }
  if (i >= lines.length) throw new Error(`${name}: unterminated front matter`)
  for (const key of ['title', 'section', 'order', 'blurb']) {
    if (!meta[key]) throw new Error(`${name}: front matter needs "${key}"`)
  }
  if (!SECTIONS.includes(meta.section)) {
    throw new Error(`${name}: unknown section "${meta.section}"`)
  }
  if (!/^\d+$/.test(meta.order)) throw new Error(`${name}: order must be a number`)
  return { meta: { ...meta, order: Number(meta.order) }, body: lines.slice(i + 1).join('\n') }
}

/** Block-level parse of the Markdown subset. Returns typed blocks. */
export function parseMarkdown(body, name = 'page') {
  const lines = body.split('\n')
  const blocks = []
  let i = 0
  const fail = (why) => {
    throw new Error(`${name}:${i + 1}: ${why}`)
  }

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === '') {
      i++
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      if (heading[1].length > 4) fail('headings go to #### only')
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() })
      i++
      continue
    }

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const code = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++])
      if (i >= lines.length) fail('unclosed code fence')
      blocks.push({ type: 'code', lang, text: code.join('\n') })
      i++
      continue
    }

    if (/^---+\s*$/.test(line)) {
      blocks.push({ type: 'rule' })
      i++
      continue
    }

    if (line.startsWith('>')) {
      const kind = /^>\s*\[!(NOTE|WARNING)\]\s*$/.exec(line)
      if (!kind) fail('blockquotes must open with > [!NOTE] or > [!WARNING]')
      const body = []
      i++
      while (i < lines.length && lines[i].startsWith('>')) {
        body.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      blocks.push({ type: 'callout', kind: kind[1].toLowerCase(), text: body.join('\n').trim() })
      continue
    }

    if (line.startsWith('|')) {
      const rows = []
      while (i < lines.length && lines[i].startsWith('|')) {
        rows.push(
          lines[i]
            .replace(/^\|/, '')
            .replace(/\|\s*$/, '')
            .split('|')
            .map((c) => c.trim())
        )
        i++
      }
      if (rows.length < 3 || !rows[1].every((c) => /^:?-+:?$/.test(c))) {
        fail('tables need a header row, a |---| separator row, and at least one body row')
      }
      const width = rows[0].length
      for (const row of rows) {
        if (row.length !== width) fail(`table rows must all have ${width} cells`)
      }
      blocks.push({ type: 'table', header: rows[0], rows: rows.slice(2) })
      continue
    }

    const image = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line)
    if (image) {
      if (!image[1]) fail('images need alt text')
      blocks.push({ type: 'image', alt: image[1], src: image[2] })
      i++
      continue
    }

    if (/^(-|\d+\.)\s/.test(line)) {
      const ordered = /^\d+\./.test(line)
      const items = []
      while (i < lines.length && /^(\s*)(-|\d+\.)\s+(.*)$/.test(lines[i])) {
        const m = /^(\s*)(-|\d+\.)\s+(.*)$/.exec(lines[i])
        // Prettier indents nesting by 2 under "-" and 3 under "1." — accept
        // the band rather than fighting the formatter.
        const depth = m[1].length === 0 ? 0 : 1
        if (m[1].length === 1 || m[1].length > 4) fail('nested list items indent by 2-4 spaces')
        items.push({ depth, text: m[3] })
        i++
        // A wrapped continuation line (indented, no marker) joins the item.
        //
        // "No marker" means an actual list marker — `- ` or `1. ` — and not,
        // as it used to, any line starting with a digit. A bullet wrapping
        // onto a line that began with a number ("18:42\"** — the working
        // state") was left behind as a paragraph of its own, which broke the
        // list *and* stranded the `**` the item had opened, so the asterisks
        // came out as text on the page.
        while (i < lines.length && /^\s{2,}(?!-\s|\d+\.\s)\S/.test(lines[i])) {
          items[items.length - 1].text += ' ' + lines[i].trim()
          i++
        }
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    // Paragraph: consume until a blank line or a recognised block opener.
    const para = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,6}\s|```|>|\||!\[|-\s|\d+\.\s|---+\s*$)/.test(lines[i])
    ) {
      para.push(lines[i].trim())
      i++
    }
    if (para.length === 0) fail(`unrecognised syntax: "${line}"`)
    blocks.push({ type: 'paragraph', text: para.join(' ') })
  }
  return blocks
}

// ------------------------------------------------------------- rendering

const escapeHtml = (s) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

/** Inline marks over escaped text. Code spans are lifted out first so no
 *  mark ever applies inside one. */
export function renderInline(text) {
  const codes = []
  const stashed = text.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${escapeHtml(code)}</code>`)
    // Stash marker: a private-use-area character that cannot occur in prose.
    return `\uE000${codes.length - 1}\uE000`
  })
  let html = escapeHtml(stashed)
  html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    if (/^javascript:/i.test(href)) throw new Error(`refusing javascript: link "${href}"`)
    const external = /^https?:\/\//.test(href)
    const attrs = external ? ' rel="noopener noreferrer"' : ''
    return `<a href="${escapeHtml(href)}"${attrs}>${label}</a>`
  })
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
  return html.replace(/\uE000(\d+)\uE000/g, (_, n) => codes[Number(n)])
}

export const slugifyAnchor = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')

/** 16-byte PNG header parse: width and height from IHDR. */
export function pngSize(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(12) !== 0x49484452) {
    throw new Error('not a PNG')
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/**
 * Render blocks to HTML. `ctx` carries the page slug (errors), the anchor
 * registry (filled as headings render), and a shot resolver.
 */
export function renderBlocks(blocks, ctx) {
  const out = []
  const seen = new Map()
  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        let anchor = slugifyAnchor(block.text)
        const n = seen.get(anchor) ?? 0
        seen.set(anchor, n + 1)
        if (n > 0) anchor = `${anchor}-${n + 1}`
        ctx.anchors.push(anchor)
        out.push(
          `<h${block.level} id="${anchor}"><a class="anchor" href="#${anchor}">${renderInline(block.text)}</a></h${block.level}>`
        )
        break
      }
      case 'paragraph':
        out.push(`<p>${renderInline(block.text)}</p>`)
        break
      case 'code':
        out.push(`<pre><code>${escapeHtml(block.text)}</code></pre>`)
        break
      case 'rule':
        out.push('<hr />')
        break
      case 'callout':
        out.push(
          `<div class="callout callout-${block.kind}"><p>${renderInline(block.text)}</p></div>`
        )
        break
      case 'table': {
        const head = block.header.map((c) => `<th>${renderInline(c)}</th>`).join('')
        const rows = block.rows
          .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`)
          .join('')
        out.push(
          `<div class="table-scroll"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`
        )
        break
      }
      case 'list': {
        const tag = block.ordered ? 'ol' : 'ul'
        let html = `<${tag}>`
        let depth = 0
        for (const item of block.items) {
          if (item.depth > depth) html += `<${tag}>`
          if (item.depth < depth) html += `</li></${tag}></li>`
          else if (html !== `<${tag}>`) html += '</li>'
          html += `<li>${renderInline(item.text)}`
          depth = item.depth
        }
        html += '</li>' + (depth > 0 ? `</${tag}></li>` : '') + `</${tag}>`
        out.push(html)
        break
      }
      case 'image': {
        if (block.src.startsWith('shot:')) {
          out.push(ctx.shot(block.src.slice(5), block.alt))
        } else {
          throw new Error(`${ctx.slug}: images must use shot:scene-name, got "${block.src}"`)
        }
        break
      }
      default:
        throw new Error(`${ctx.slug}: unknown block type ${block.type}`)
    }
  }
  return out.join('\n')
}

/** Plain text per heading span, for the search index. Index unit = the H1
 *  (page top) and each H2; deeper headings fold into their parent H2. */
export function extractText(blocks) {
  const spans = []
  let current = { heading: null, anchor: '', parts: [] }
  const seen = new Map()
  for (const block of blocks) {
    if (block.type === 'heading' && block.level <= 2) {
      if (current.parts.length > 0 || current.heading !== null) spans.push(current)
      let anchor = slugifyAnchor(block.text)
      const n = seen.get(anchor) ?? 0
      seen.set(anchor, n + 1)
      if (n > 0) anchor = `${anchor}-${n + 1}`
      current = { heading: block.text, anchor, parts: [] }
      continue
    }
    if (block.type === 'heading') {
      const n = (seen.get(slugifyAnchor(block.text)) ?? 0) + 1
      seen.set(slugifyAnchor(block.text), n)
      current.parts.push(block.text)
    } else if (block.type === 'paragraph' || block.type === 'callout') {
      current.parts.push(block.text)
    } else if (block.type === 'list') {
      current.parts.push(...block.items.map((x) => x.text))
    } else if (block.type === 'table') {
      current.parts.push(...block.rows.flat())
    }
  }
  spans.push(current)
  return spans.map((s) => ({
    heading: s.heading,
    anchor: s.anchor,
    text: s.parts
      .join(' ')
      .replace(/[*_`>#|[\]]/g, '')
      .replace(/\([^)]*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1200),
  }))
}

// ------------------------------------------------------------ assembling

const byNavOrder = (a, b) =>
  SECTIONS.indexOf(a.meta.section) - SECTIONS.indexOf(b.meta.section) ||
  a.meta.order - b.meta.order ||
  (a.slug < b.slug ? -1 : 1)

export function buildNav(pages, currentSlug) {
  const groups = []
  for (const section of SECTIONS) {
    const inSection = pages.filter((p) => p.meta.section === section)
    if (inSection.length === 0) continue
    const items = inSection
      .map((p) => {
        const href = p.slug === 'index' ? '/docs' : `/docs/${p.slug}`
        const current = p.slug === currentSlug ? ' aria-current="page"' : ''
        return `<li><a href="${href}"${current}>${escapeHtml(p.meta.title)}</a></li>`
      })
      .join('')
    groups.push(`<section><h2>${escapeHtml(section)}</h2><ul>${items}</ul></section>`)
  }
  return groups.join('')
}

export function prevNext(pages, currentSlug) {
  const i = pages.findIndex((p) => p.slug === currentSlug)
  const link = (p, cls, label) =>
    p
      ? `<a class="${cls}" href="${p.slug === 'index' ? '/docs' : `/docs/${p.slug}`}"><span>${label}</span>${escapeHtml(p.meta.title)}</a>`
      : '<span></span>'
  return link(pages[i - 1], 'prev', 'Previous') + link(pages[i + 1], 'next', 'Next')
}

export function buildSearchIndex(pages) {
  const entries = []
  for (const page of pages) {
    const url = page.slug === 'index' ? '/docs' : `/docs/${page.slug}`
    for (const span of extractText(page.blocks)) {
      if (!span.text && !span.heading) continue
      entries.push({
        url,
        anchor: span.heading ? span.anchor : '',
        page: page.meta.title,
        heading: span.heading ?? page.meta.title,
        section: page.meta.section,
        text: span.text,
      })
    }
  }
  return entries
}

export function buildSitemap(pages) {
  const urls = [
    `${ORIGIN}/`,
    ...pages.map((p) => (p.slug === 'index' ? `${ORIGIN}/docs` : `${ORIGIN}/docs/${p.slug}`)),
  ]
  const body = urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`
}

/**
 * Validate every internal link, anchor and shot reference across the built
 * pages. Dead = error; an image on disk nothing references = warning only,
 * so a screenshots PR can land images before the prose that uses them.
 */
export function checkLinks(pages, imgDir) {
  const slugs = new Set(pages.map((p) => p.slug))
  const anchorsBySlug = new Map(pages.map((p) => [p.slug, new Set(p.anchors)]))
  const problems = []
  const referencedShots = new Set()

  for (const page of pages) {
    for (const ref of page.links) {
      const m = /^\/docs(?:\/([a-z0-9-]+))?(?:#([a-z0-9-]+))?$/.exec(ref)
      if (!m) {
        if (ref.startsWith('/docs')) problems.push(`${page.slug}: unparseable link ${ref}`)
        continue
      }
      const slug = m[1] ?? 'index'
      if (slug !== 'privacy-policy' && !slugs.has(slug)) {
        problems.push(`${page.slug}: dead link ${ref}`)
      } else if (m[2] && slugs.has(slug) && !anchorsBySlug.get(slug).has(m[2])) {
        problems.push(`${page.slug}: dead anchor ${ref}`)
      }
    }
    for (const anchor of page.selfAnchors) {
      if (!anchorsBySlug.get(page.slug).has(anchor)) {
        problems.push(`${page.slug}: dead anchor #${anchor}`)
      }
    }
    for (const scene of page.shots) referencedShots.add(scene)
  }

  const orphans = []
  if (existsSync(imgDir)) {
    for (const file of readdirSync(imgDir)) {
      const m = /^(.+)-(dark|light)\.png$/.exec(file)
      if (m && !referencedShots.has(m[1])) orphans.push(file)
    }
  }
  return { problems, orphans }
}

// ------------------------------------------------------------------ main

export function buildPage(slug, src) {
  const { meta, body } = parseFrontMatter(src, slug)
  const blocks = parseMarkdown(body, slug)
  const links = []
  const selfAnchors = []
  const shots = []
  const anchors = []
  const shot = (scene, alt) => {
    shots.push(scene)
    const dark = join(IMG_DIR, `${scene}-dark.png`)
    const light = join(IMG_DIR, `${scene}-light.png`)
    if (!existsSync(dark) || !existsSync(light)) {
      throw new Error(
        `${slug}: shot "${scene}" needs both ${scene}-dark.png and ${scene}-light.png in docs/img`
      )
    }
    const { width, height } = pngSize(readFileSync(dark))
    const phone = height > width ? ' class="phone"' : ''
    return (
      `<picture${phone}>` +
      `<source media="(prefers-color-scheme: light)" srcset="/docs/img/${scene}-light.png" />` +
      `<img src="/docs/img/${scene}-dark.png" alt="${escapeHtml(alt)}" width="${width}" height="${height}" loading="lazy" />` +
      `</picture>`
    )
  }
  // Collect link targets for the checker as a side effect of a dry inline
  // pass over every text-bearing block.
  const collect = (text) => {
    for (const m of text.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) {
      if (m[1].startsWith('/docs')) links.push(m[1])
      else if (m[1].startsWith('#')) selfAnchors.push(m[1].slice(1))
    }
  }
  for (const block of blocks) {
    if (block.type === 'paragraph' || block.type === 'callout') collect(block.text)
    if (block.type === 'list') block.items.forEach((x) => collect(x.text))
    if (block.type === 'table') block.rows.flat().forEach(collect)
  }
  const content = renderBlocks(blocks, { slug, anchors, shot })
  return { slug, meta, blocks, content, links, selfAnchors, shots, anchors }
}

export function main() {
  const template = readFileSync(join(SRC_DIR, 'template.html'), 'utf8')
  const sources = readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
  const pages = sources
    .map((f) => buildPage(f.replace(/\.md$/, ''), readFileSync(join(SRC_DIR, f), 'utf8')))
    .sort(byNavOrder)

  const { problems, orphans } = checkLinks(pages, IMG_DIR)
  if (problems.length > 0) {
    throw new Error(`docs build failed:\n  ${problems.join('\n  ')}`)
  }
  for (const orphan of orphans) console.warn(`warning: docs/img/${orphan} is referenced by no page`)

  mkdirSync(OUT_DIR, { recursive: true })
  for (const page of pages) {
    const html = template
      .replaceAll('{{title}}', escapeHtml(page.meta.title))
      .replaceAll('{{blurb}}', escapeHtml(page.meta.blurb))
      .replaceAll('{{sidebar}}', buildNav(pages, page.slug))
      .replaceAll('{{content}}', page.content)
      .replaceAll('{{prevnext}}', prevNext(pages, page.slug))
    writeFileSync(join(OUT_DIR, `${page.slug}.html`), html)
  }
  writeFileSync(join(OUT_DIR, 'search-index.json'), JSON.stringify(buildSearchIndex(pages)))
  writeFileSync(join(SITE_DIR, 'sitemap.xml'), buildSitemap(pages))
  console.log(`built ${pages.length} pages`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
