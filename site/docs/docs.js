// Docs client script: search over the prebuilt index, the phone menu, and
// the screenshot lightbox. No dependencies, no network beyond one fetch of
// search-index.json — the same offline-first posture as the app the docs
// describe.
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

  // ------------------------------------------------------------ lightbox
  //
  // Screenshots are captured at 1280x720 (390x844 for the phone ones) and
  // shown inside a 46em column, so a dense one — the patch grid, the
  // fixtures list — reads as an illustration but not as a reference. Click
  // to expand.
  //
  // Built here rather than in the generator on purpose: the markup stays a
  // plain image, so a reader with no JavaScript gets a picture rather than
  // a button that does nothing, and the committed HTML doesn't change.
  const shots = document.querySelectorAll('.content picture')
  const box = document.createElement('dialog')
  if (shots.length > 0 && typeof box.showModal === 'function') {
    box.className = 'lightbox'
    // The expanded image, its caption, and a close button. innerHTML with
    // no interpolation — every value below is set via textContent/setAttribute.
    box.innerHTML =
      '<button class="lightbox-close" aria-label="Close">✕</button>' +
      '<div class="lightbox-frame"><img alt="" /></div>' +
      '<p class="lightbox-caption"></p>'
    document.body.appendChild(box)

    const full = box.querySelector('img')
    const frame = box.querySelector('.lightbox-frame')
    const caption = box.querySelector('.lightbox-caption')

    /** Fit-to-viewport is the default; actual size is for reading values. */
    const setActual = (on) => {
      full.classList.toggle('actual', on)
      full.setAttribute('aria-label', on ? 'Shrink to fit' : 'Show at actual size')
      caption.textContent = `${full.dataset.caption} · ${on ? 'Click to fit' : 'Click for actual size'} · Esc to close`
    }

    const open = (img) => {
      // currentSrc, not src: it is the source the browser actually chose
      // from the <picture>, so a light-theme reader expands the light
      // capture and a dark-theme reader the dark one.
      full.src = img.currentSrc || img.src
      full.alt = img.alt
      full.dataset.caption = img.alt
      box.setAttribute('aria-label', img.alt)
      setActual(false)
      frame.scrollTop = 0
      frame.scrollLeft = 0
      box.showModal()
    }

    for (const picture of shots) {
      const img = picture.querySelector('img')
      if (!img) continue
      // A real button, so focus, Enter and Space come from the platform
      // rather than a hand-rolled role/tabindex pair.
      const trigger = document.createElement('button')
      trigger.type = 'button'
      trigger.className = 'shot'
      trigger.setAttribute('aria-label', `Expand: ${img.alt}`)
      picture.parentNode.insertBefore(trigger, picture)
      trigger.appendChild(picture)
      trigger.addEventListener('click', () => open(img))
    }

    full.addEventListener('click', () => setActual(!full.classList.contains('actual')))
    box.querySelector('.lightbox-close').addEventListener('click', () => box.close())
    // A click that lands on the dialog itself is a click on the backdrop —
    // anything on the image or the controls stops at them.
    box.addEventListener('click', (e) => {
      if (e.target === box) box.close()
    })
    // Free the memory a 1280px screenshot holds once it is off screen.
    box.addEventListener('close', () => full.removeAttribute('src'))
  }
})()
