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
  fillTemplate,
  parseFrontMatter,
  parseMarkdown,
  plainText,
  pngSize,
  renderInline,
  slugifyAnchor,
} from './build-docs.mjs'
import { deployed } from './preview.mjs'

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

test('a bullet wrapping onto a line that starts with a number stays one item', () => {
  // Two real pages broke on this. The continuation rule refused any line
  // beginning with a digit, so the wrap became a paragraph of its own — the
  // list ended early and the `**` the item had opened was left unclosed,
  // which put literal asterisks on the page.
  const blocks = parseMarkdown(
    [
      '- **"Live — 12 receiving · 1 universe not heard, since',
      '  18:42"** — the working state.',
      '- Your connection ("Online ·',
      '  42 ms"), and the buttons beside it.',
    ].join('\n')
  )
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['list']
  )
  assert.equal(blocks[0].items.length, 2)
  assert.match(blocks[0].items[0].text, /18:42"\*\* — the working state\./)
  assert.match(blocks[0].items[1].text, /42 ms"\), and the buttons/)
})

test('an indented list marker is still a nested item, not a continuation', () => {
  // The other half of the same rule: `- ` and `1. ` under a bullet nest.
  const blocks = parseMarkdown(['- Outer', '  - Nested', '  1. Also nested'].join('\n'))
  assert.equal(blocks[0].items.length, 3)
  assert.deepEqual(
    blocks[0].items.map((item) => item.depth),
    [0, 1, 1]
  )
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

  // The cap the name promises. A span is one heading's worth of a page, and
  // the index ships to every reader on first search.
  const long = extractText(parseMarkdown(`## H\n\n${'word '.repeat(400)}`))
  assert.equal(long.at(-1).text.length, 1200)
})

test('the search index keeps the identifiers people search for', () => {
  // The whole reason to search these docs is to find out what an environment
  // variable does. Stripping the character class `[*_`>#|[\]]` took the
  // underscore out of every one of them — DATA_DIR indexed as DATADIR — so
  // the docs about DATA_DIR could not be found by typing DATA_DIR.
  assert.equal(plainText('Set `DATA_DIR` and `CREWBOX_IFACE`.'), 'Set DATA_DIR and CREWBOX_IFACE.')

  // And deleting every parenthesis to get rid of link targets took ordinary
  // ones with it, along with the qualifying phrase inside.
  assert.equal(plainText('DATA_DIR (the default)'), 'DATA_DIR (the default)')

  // A link is its label; the target is not prose anybody searches for.
  assert.equal(plainText('See [the admin panel](/docs/admin) first.'), 'See the admin panel first.')

  // Emphasis comes off where it is emphasis, and nowhere else.
  assert.equal(
    plainText('**Bold** and _italic_ and snake_case_name.'),
    'Bold and italic and snake_case_name.'
  )
})

test('a template value is inserted literally, dollar signs and all', () => {
  // `$&` in a *string* replacement means "the matched substring", so a page
  // quoting a shell one-liner used to splice `{{content}}` back into itself.
  assert.equal(
    fillTemplate('<main>{{content}}</main>', { content: 'run `foo $& bar`' }),
    '<main>run `foo $& bar`</main>'
  )
  assert.equal(fillTemplate('{{a}}', { a: "$`$'$$" }), "$`$'$$")
  assert.equal(fillTemplate('{{a}} {{a}}', { a: 'x' }), 'x x')
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

// -------------------------------------------------------------- rendering

test('a nested list nests, and closes nothing it did not open', () => {
  const { content } = buildPage('p', FM() + '- one\n  - inner\n- two')
  // Written as two separate `if`s, opening the nested list also fell into
  // the "close the previous item" branch and emitted a `</li>` immediately
  // after the `<ul>` — a closing tag for an element that was never opened.
  assert.equal(content, '<ul><li>one<ul><li>inner</li></ul></li><li>two</li></ul>')
  assert.doesNotMatch(content, /<ul><\/li>/)
})

test('a numbered sub-list under a bulleted one is numbered', () => {
  // The nested list inherited the outer list's marker, silently renumbering
  // the steps of every nested procedure into bullets.
  const { content } = buildPage('p', FM() + '- first\n  1. step one\n  2. step two')
  assert.equal(content, '<ul><li>first<ol><li>step one</li><li>step two</li></ol></li></ul>')
})

test('a list that ends inside a nested level still closes both', () => {
  const { content } = buildPage('p', FM() + '- one\n  - inner')
  assert.equal(content, '<ul><li>one<ul><li>inner</li></ul></li></ul>')
})

test('an ampersand in a link target is escaped exactly once', () => {
  // The link pass runs over already-escaped text, so escaping the captured
  // href again turned every `&` into `&amp;amp;` — which the browser then
  // shows as a literal "&amp;" in the address it follows.
  assert.equal(
    renderInline('[report](https://example.com/r?a=1&b=2)'),
    '<a href="https://example.com/r?a=1&amp;b=2" rel="noopener noreferrer">report</a>'
  )
})

// ------------------------------------------------------------ link checker

test('a dead link in a table header is caught like any other', () => {
  // The header row was never collected, so a link in one could point at a
  // page that does not exist and the build said nothing.
  const page = buildPage('p', FM() + '| [gone](/docs/nope) | b |\n| --- | --- |\n| 1 | 2 |')
  const { problems } = checkLinks([page], '/definitely/missing')
  assert.deepEqual(problems, ['p: dead link /docs/nope'])
})

test('a link inside a heading is refused, because it would nest in its own anchor', () => {
  assert.throws(
    () => buildPage('p', FM() + '## See [the panel](/docs/admin)'),
    /contains a link, which would nest inside its own anchor/
  )
})

// ----------------------------------------------------------------- preview

test('the preview serves only what Vercel would deploy', () => {
  // A preview that shows more than the deploy is not a preview — and this
  // one bound every interface, so running it at a venue published the
  // generator and the page sources to the whole crew network.
  assert.equal(deployed('docs/admin.html'), true)
  assert.equal(deployed('index.html'), true)
  assert.equal(deployed('docs-src/admin.md'), false)
  assert.equal(deployed('build-docs.mjs'), false)
  assert.equal(deployed('preview.mjs'), false)
  assert.equal(deployed('README.md'), false)
})
