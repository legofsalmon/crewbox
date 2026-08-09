// Docs client script: search over the prebuilt index, and the phone menu.
// No dependencies, no network beyond one fetch of search-index.json — the
// same offline-first posture as the app the docs describe.
;(() => {
  const input = document.querySelector('.search input')
  const list = document.querySelector('.search .results')
  const menu = document.querySelector('.menu')

  // ------------------------------------------------------------- search
  let index = null
  let active = -1

  const load = async () => {
    if (index) return
    try {
      const res = await fetch('/docs/search-index.json')
      index = await res.json()
    } catch {
      index = []
    }
  }

  // Rank: every query token must appear somewhere; heading hits beat page
  // title hits beat body hits. Small and predictable beats clever.
  const search = (query) => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return []
    const scored = []
    for (const entry of index) {
      const heading = entry.heading.toLowerCase()
      const page = entry.page.toLowerCase()
      const body = entry.text.toLowerCase()
      let score = 0
      let ok = true
      for (const token of tokens) {
        if (heading.includes(token)) score += 3
        else if (page.includes(token)) score += 2
        else if (body.includes(token)) score += 1
        else {
          ok = false
          break
        }
      }
      if (ok) scored.push({ entry, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, 10).map((s) => s.entry)
  }

  const snippet = (entry, query) => {
    const token = query.toLowerCase().split(/\s+/).filter(Boolean)[0] ?? ''
    const at = entry.text.toLowerCase().indexOf(token)
    if (at < 0) return entry.text.slice(0, 90)
    const from = Math.max(0, at - 30)
    return (from > 0 ? '…' : '') + entry.text.slice(from, from + 100)
  }

  const render = (results, query) => {
    active = -1
    if (query === '') {
      list.hidden = true
      return
    }
    list.innerHTML = ''
    if (results.length === 0) {
      const li = document.createElement('li')
      li.innerHTML = '<span class="none">Nothing matches.</span>'
      list.appendChild(li)
    }
    for (const entry of results) {
      const li = document.createElement('li')
      const a = document.createElement('a')
      a.href = entry.anchor ? `${entry.url}#${entry.anchor}` : entry.url
      const where = document.createElement('span')
      where.className = 'where'
      where.textContent = `${entry.section} › ${entry.page}`
      const title = document.createElement('span')
      title.textContent = entry.heading
      const snip = document.createElement('span')
      snip.className = 'snip'
      snip.textContent = snippet(entry, query)
      a.append(where, title, snip)
      li.appendChild(a)
      list.appendChild(li)
    }
    list.hidden = false
  }

  input.addEventListener('focus', load)
  input.addEventListener('input', async () => {
    await load()
    render(search(input.value), input.value.trim())
  })
  input.addEventListener('keydown', (e) => {
    const links = [...list.querySelectorAll('a')]
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (links.length === 0) return
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length
      links.forEach((a, i) => a.classList.toggle('active', i === active))
      links[active].scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter' && active >= 0 && links[active]) {
      links[active].click()
    } else if (e.key === 'Escape') {
      list.hidden = true
      input.blur()
    }
  })
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search')) list.hidden = true
  })
  // The same reach-for-search keys as the app: / anywhere, ⌘/Ctrl-K.
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '')
    if ((e.key === '/' && !typing) || (e.key === 'k' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault()
      input.focus()
    }
  })

  // ---------------------------------------------------------- phone menu
  menu.addEventListener('click', () => {
    const open = document.body.classList.toggle('nav-open')
    menu.setAttribute('aria-expanded', String(open))
  })
})()
