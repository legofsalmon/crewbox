// Unit tests for the docs generator. Run with `npm run docs:test`
// (node --test — no dependencies, like the generator itself).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildNav,
  buildPage,
  buildSearchIndex,
  buildSitemap,
  checkLinks,
  extractText,
  parseFrontMatter,
  parseMarkdown,
  pngSize,
  renderInline,
  slugifyAnchor,
} from './build-docs.mjs'

const FM = (over = {}) => {
  const meta = {
    title: 'A page',
    section: 'Reference',
    order: '10',
    blurb: 'About a thing.',
    ...over,
  }
  return `---\n${Object.entries(meta)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n---\n`
}

// ------------------------------------------------------------ front matter

test('front matter parses and coerces order', () => {
  const { meta, body } = parseFrontMatter(FM() + 'Hello.')
  assert.equal(meta.title, 'A page')
  assert.equal(meta.order, 10)
  assert.equal(body, 'Hello.')
})

test('front matter rejects missing keys, bad sections, bad order', () => {
  assert.throws(() => parseFrontMatter('---\ntitle: X\n---\n'), /needs "section"/)
  assert.throws(() => parseFrontMatter(FM({ section: 'Nonsense' })), /unknown section/)
  assert.throws(() => parseFrontMatter(FM({ order: 'first' })), /order must be a number/)
  assert.throws(() => parseFrontMatter('no fence'), /missing front matter/)
})

// ------------------------------------------------------------------ blocks

test('every block type parses', () => {
  const blocks = parseMarkdown(
    [
      '# Title',
      '',
      'A paragraph.',
      '',
      '- one',
      '- two',
      '  - nested',
      '',
      '1. first',
      '2. second',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '```sh',
      'crewbox --status',
      '```',
      '',
      '> [!NOTE]',
      '> A gentle note.',
      '',
      '---',
    ].join('\n')
  )
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['heading', 'paragraph', 'list', 'list', 'table', 'code', 'callout', 'rule']
  )
  assert.equal(blocks[2].items[2].depth, 1)
  assert.equal(blocks[4].rows.length, 1)
  assert.equal(blocks[6].kind, 'note')
})

test('unsupported syntax is a build error, not a passthrough', () => {
  assert.throws(() => parseMarkdown('##### too deep'), /#### only/)
  assert.throws(() => parseMarkdown('```\nunclosed'), /unclosed code fence/)
  assert.throws(() => parseMarkdown('> plain blockquote'), /NOTE.*WARNING/)
  assert.throws(() => parseMarkdown('| a |\n| b |'), /separator/)
})

// ------------------------------------------------------------------ inline

test('raw HTML in markdown comes out escaped', () => {
  assert.equal(renderInline('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;')
})

test('inline marks render and never apply inside code spans', () => {
  assert.equal(renderInline('**bold** and _calm_'), '<strong>bold</strong> and <em>calm</em>')
  assert.equal(renderInline('use `a ** b` here'), 'use <code>a ** b</code> here')
  assert.equal(renderInline('[docs](/docs/chat)'), '<a href="/docs/chat">docs</a>')
  assert.match(renderInline('[x](https://e.com)'), /noopener noreferrer/)
  assert.throws(() => renderInline('[x](javascript:alert(1))'), /refusing/)
})

test('snake_case words are not italicised', () => {
  assert.equal(renderInline('CREWBOX_WATCH and DATA_DIR'), 'CREWBOX_WATCH and DATA_DIR')
})

// ----------------------------------------------------------------- anchors

test('anchor slugs and collisions', () => {
  assert.equal(slugifyAnchor('Joining the event Wi-Fi'), 'joining-the-event-wi-fi')
  assert.equal(slugifyAnchor("What's a “sub-box”?"), 'whats-a-sub-box')
  const page = buildPage('p', FM() + '## Twice\n\n## Twice\n')
  assert.deepEqual(page.anchors, ['twice', 'twice-2'])
})

// -------------------------------------------------------------------- png

test('pngSize reads IHDR and rejects non-PNGs', () => {
  const png = Buffer.alloc(24)
  png.writeUInt32BE(0x49484452, 12)
  png.writeUInt32BE(390, 16)
  png.writeUInt32BE(844, 20)
  assert.deepEqual(pngSize(png), { width: 390, height: 844 })
  assert.throws(() => pngSize(Buffer.from('GIF89a')), /not a PNG/)
})

// ------------------------------------------------------------------ search

test('search index: one entry per H1/H2 span, deterministic', () => {
  const src =
    FM() +
    '# Top\n\nIntro text.\n\n## First\n\nBody one.\n\n### Sub\n\nMore.\n\n## Second\n\nBody two.\n'
  const page = buildPage('p', src)
  const index = buildSearchIndex([page])
  assert.deepEqual(
    index.map((e) => e.heading),
    ['Top', 'First', 'Second']
  )
  assert.equal(index[0].anchor, 'top')
  assert.match(index[1].text, /Sub/)
  assert.deepEqual(buildSearchIndex([page]), index)
})

test('extractText strips markup and caps length', () => {
  const spans = extractText(parseMarkdown('## H\n\nUse `code` and **bold** here.'))
  assert.equal(spans.at(-1).text, 'Use code and bold here.')
})

// ------------------------------------------------------------------- links

test('dead links and dead anchors fail the check', () => {
  const a = buildPage('alpha', FM() + '## Here\n\nSee [beta](/docs/beta) and [gone](/docs/nope).')
  const b = buildPage('beta', FM() + 'See [anchor](/docs/alpha#here) and [bad](/docs/alpha#nope).')
  const { problems } = checkLinks([a, b], '/definitely/missing')
  assert.deepEqual(problems, ['alpha: dead link /docs/nope', 'beta: dead anchor /docs/alpha#nope'])
})

test('missing shot files are a build error', () => {
  assert.throws(
    () => buildPage('p', FM() + '![The join screen](shot:no-such-scene)'),
    /needs both no-such-scene-dark\.png and no-such-scene-light\.png/
  )
})

// --------------------------------------------------------------------- nav

test('nav groups by section in fixed order and marks the current page', () => {
  const a = buildPage('index', FM({ section: 'Start here', order: '1', title: 'Overview' }) + 'Hi.')
  const b = buildPage('glossary', FM({ title: 'Glossary' }) + 'Words.')
  const nav = buildNav([a, b], 'glossary')
  assert.ok(nav.indexOf('Start here') < nav.indexOf('Reference'))
  assert.match(nav, /href="\/docs">Overview/)
  assert.match(nav, /href="\/docs\/glossary" aria-current="page"/)
})

test('sitemap lists the landing page and every docs page', () => {
  const a = buildPage('index', FM({ section: 'Start here', order: '1' }) + 'Hi.')
  const xml = buildSitemap([a])
  assert.match(xml, /<loc>https:\/\/crewbox\.letissier\.ie\/<\/loc>/)
  assert.match(xml, /<loc>https:\/\/crewbox\.letissier\.ie\/docs<\/loc>/)
})
