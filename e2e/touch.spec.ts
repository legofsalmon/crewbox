import { expect, type Browser, type Page } from '@playwright/test'
import { test, uniqueName } from './helpers'

/** A phone, joined to the event. */
const phone = async (browser: Browser, name: string): Promise<Page> => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })
  const page = await context.newPage()
  await page.goto('/?pin=4242')
  await page.getByLabel('Your name').fill(uniqueName(name))
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
  return page
}

type Point = [number, number]

/**
 * Fingers on the glass, through Chromium's own touch input: it makes the
 * pointer events, taps and clicks a phone would. Playwright's `tap` is one
 * finger that doesn't move, and a pinch needs two that do.
 */
const fingers = async (page: Page) => {
  const cdp = await page.context().newCDPSession(page)
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: Point[]) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map(([x, y], id) => ({ x, y, id })),
    })
  /** Put fingers down at `from`, slide each to its place in `to`, and lift them. */
  return async (from: Point[], to: Point[], steps = 12) => {
    await send('touchStart', from)
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      await send(
        'touchMove',
        from.map(([x, y], n) => [x + (to[n]![0] - x) * t, y + (to[n]![1] - y) * t])
      )
    }
    await send('touchEnd', [])
  }
}

/**
 * Touch targets. Platform guidance (iOS 44pt, Android 48dp) wants controls a
 * fingertip can hit reliably; the icon buttons were 28px, and one of them is
 * the hamburger — the single control a phone user cannot do without. On a
 * coarse pointer they grow to 40px visually (with the hit area extended to
 * 48px by a pseudo-element the bounding box cannot see, so 40 is what is
 * asserted here).
 */
test('icon buttons grow to fingertip size on a touch device', async ({ browser }) => {
  // hasTouch flips `pointer: coarse` in Chromium — the media query under test.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })
  const page = await context.newPage()
  await page.goto('/?pin=4242')
  await page.getByLabel('Your name').fill(uniqueName('Touch Tech'))
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()

  // Computed style, not boundingBox: with isMobile emulation the page can be
  // auto-zoomed out a few percent to fit content (long messages left by
  // earlier specs against the shared server), and boundingBox reports the
  // visually scaled size. The property under test is the CSS size the media
  // query sets, which computed style reads unscaled.
  const cssSize = (locator: ReturnType<typeof page.getByRole>) =>
    locator.evaluate((el) => {
      const style = getComputedStyle(el)
      return { width: parseFloat(style.width), height: parseFloat(style.height) }
    })

  const hamburger = page.getByRole('button', { name: 'Open channels' }).first()
  await expect(hamburger).toBeVisible()
  const box = await cssSize(hamburger)
  expect(box.width).toBeGreaterThanOrEqual(40)
  expect(box.height).toBeGreaterThanOrEqual(40)

  // And the drawer it opens still works end to end under touch emulation.
  await hamburger.tap()
  const newChannel = page.getByRole('button', { name: 'New channel' })
  await expect(newChannel).toBeVisible()
  const plusBox = await cssSize(newChannel)
  expect(plusBox.width).toBeGreaterThanOrEqual(40)
  expect(plusBox.height).toBeGreaterThanOrEqual(40)

  await context.close()
})

/**
 * Tapping a channel must not throw up the soft keyboard.
 *
 * The composer focused itself on every channel change. On a keyboard that
 * costs nothing and saves a click; on a phone it opens the keyboard, so a
 * crew member who tapped #stage in the drawer to read what was posted
 * arrived to the messages they wanted pushed off the top of the screen by a
 * keyboard they had not asked for — and had to dismiss it before they could
 * see anything. Reading is what most channel taps are for.
 */
test('tapping a channel does not open the keyboard on a phone', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })
  const page = await context.newPage()
  await page.goto('/?pin=4242')
  await page.getByLabel('Your name').fill(uniqueName('Phone Tech'))
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()

  const composer = page.getByPlaceholder(/Message/)
  await expect(composer).toBeVisible()
  // Arriving at the first channel is a channel change like any other.
  await expect(composer).not.toBeFocused()

  // And so is a tap in the drawer. #general is always there.
  await page.getByRole('button', { name: 'Open channels' }).first().tap()
  await page.getByRole('button', { name: '#general' }).tap()
  await expect(composer).toBeVisible()
  await expect(composer).not.toBeFocused()

  // Tapping the box itself still focuses it — that is a request to type.
  await composer.tap()
  await expect(composer).toBeFocused()

  await context.close()
})

/**
 * The closed drawer left a grey band down the left of the screen.
 *
 * It waits just off the left edge, and its shadow reached 40px back onto the
 * screen from there, in both themes and plain to see in the light one. The
 * shadow belongs to the drawer only while it is open.
 */
test('the closed drawer leaves nothing on the screen', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    colorScheme: 'light',
  })
  const page = await context.newPage()
  await page.goto('/?pin=4242')
  await page.getByLabel('Your name').fill(uniqueName('Edge Tech'))
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()

  const shadow = () => page.locator('.sidebar').evaluate((el) => getComputedStyle(el).boxShadow)
  expect(await shadow()).toBe('none')

  // Open, it still stands out from the page behind it.
  await page.getByRole('button', { name: 'Open channels' }).first().tap()
  await expect(page.getByRole('button', { name: '#general' })).toBeVisible()
  await expect.poll(shadow).not.toBe('none')

  await context.close()
})

/**
 * The patch sheet's + and − on a phone.
 *
 * They were shown on hover, which a finger cannot do, so on a phone they were
 * invisible until a channel's name was being typed in, and then 19 by 17
 * pixels, one on top of the other. They are always there on a touch screen
 * now, side by side and the height of the row, and the channel column gives
 * up the room for them rather than taking more of a 390-pixel screen.
 */
test('a phone can insert and remove a patch channel', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })
  const page = await context.newPage()
  await page.goto('/?pin=4242')
  await page.getByLabel('Your name').fill(uniqueName('Patch Tech'))
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
  await page.getByRole('button', { name: 'Open channels' }).first().tap()
  await page.getByRole('button', { name: 'All sheets…' }).tap()
  await page.getByRole('button', { name: '+ New Sheet' }).tap()
  await page.locator('#new-sheet-name').fill(uniqueName('Phone Fest'))
  await page.getByRole('button', { name: 'Create', exact: true }).tap()
  await expect(page.locator('table')).toBeVisible()

  const rows = page.locator('tbody th[scope="row"]')
  await expect(rows).toHaveCount(10)
  const house = (channel: number) => page.getByLabel(`Input on channel ${channel}`, { exact: true })
  for (const [channel, input] of [
    [3, 'Kick In'],
    [4, 'ACOUSTIC GTR'],
  ] as const) {
    await house(channel).fill(input)
    await house(channel).press('Enter')
  }

  // Seen without hovering, and big enough for a thumb. Opacity is read
  // directly: Playwright counts an element at opacity 0 as visible.
  const insert = page.getByRole('button', { name: 'Insert channel below 3', exact: true })
  const shown = (locator: typeof insert) =>
    locator.evaluate((el) => getComputedStyle(el.parentElement!).opacity)
  expect(await shown(insert)).toBe('1')
  const size = await insert.evaluate((el) => {
    const style = getComputedStyle(el)
    return { width: parseFloat(style.width), height: parseFloat(style.height) }
  })
  expect(size.width).toBeGreaterThanOrEqual(32)
  expect(size.height).toBeGreaterThanOrEqual(34)
  // The column that stays put while the acts scroll past it was 272 pixels,
  // and a dozen capitals still read whole in it.
  const column = await rows.first().evaluate((el) => el.getBoundingClientRect().width)
  expect(column).toBeLessThanOrEqual(240)
  expect(await house(4).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)

  await insert.tap()
  await expect(rows).toHaveCount(11)
  await expect(house(3)).toHaveValue('Kick In')
  await expect(house(4)).toHaveValue('')
  await expect(house(5)).toHaveValue('ACOUSTIC GTR')

  // An empty channel goes without a confirmation.
  const remove = page.getByRole('button', { name: 'Remove channel 4', exact: true })
  expect(await shown(remove)).toBe('1')
  await remove.tap()
  await expect(rows).toHaveCount(10)
  await expect(house(4)).toHaveValue('ACOUSTIC GTR')

  await context.close()
})

/** A computer keeps the tidy grid: the buttons wait for the mouse. */
test('a computer still shows the patch channel buttons on hover only', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  await page.goto('/?pin=4242')
  await page.getByLabel('Your name').fill(uniqueName('Desk Tech'))
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
  await page.getByRole('button', { name: 'All sheets…' }).click()
  await page.getByRole('button', { name: '+ New Sheet' }).click()
  await page.locator('#new-sheet-name').fill(uniqueName('Desk Fest'))
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.locator('table')).toBeVisible()

  const insert = page.getByRole('button', { name: 'Insert channel below 3', exact: true })
  const shown = () => insert.evaluate((el) => getComputedStyle(el.parentElement!).opacity)
  await expect.poll(shown).toBe('0')
  await page.locator('tbody th[scope="row"]').nth(2).hover()
  await expect.poll(shown).toBe('1')
  // And the house input keeps the width a laptop has room for.
  const width = await page
    .getByLabel('Input on channel 3', { exact: true })
    .evaluate((el) => el.getBoundingClientRect().width)
  expect(width).toBeGreaterThan(150)

  await context.close()
})

/**
 * Fingers on the lighting plan.
 *
 * The plan's box told the browser to do nothing with a touch
 * (`touch-action: none`), so a truss could be dragged, and nothing else did
 * anything with one either: a finger could not scroll the plan and nothing
 * pinched it. On a phone, any rig bigger than the box was out of reach.
 */
test('a finger pans the lighting plan and two pinch it', async ({ browser }) => {
  const page = await phone(browser, 'Plot Tech')
  await page.getByRole('button', { name: 'Open channels' }).first().tap()
  await page.getByRole('button', { name: 'All plots…' }).tap()
  await page.getByLabel('Import CSV or MVR file').setInputFiles('e2e/fixtures/rig.mvr')
  await expect(page.getByText(/Imported 4 fixtures across/)).toBeVisible()
  await page.getByRole('tab', { name: 'Plan' }).tap()
  // Touch coordinates and page coordinates agree only at scale 1.
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1)

  const plan = page.getByRole('img', { name: /^Plan of/ })
  const zoom = page
    .getByRole('button', { name: 'Zoom out' })
    .locator('xpath=following-sibling::span[1]')
  await expect(zoom).toHaveText('100%')
  const slide = await fingers(page)
  const onPlan = page.getByRole('tab', { name: 'Plan' })

  /** The scrolling box around the drawing, inside its border. */
  const box = () =>
    plan.evaluate((svg) => {
      const el = svg.parentElement!
      const rect = el.getBoundingClientRect()
      return {
        x: rect.left + el.clientLeft,
        y: rect.top + el.clientTop,
        width: el.clientWidth,
        height: el.clientHeight,
        scrollLeft: el.scrollLeft,
        scrollTop: el.scrollTop,
      }
    })
  const drawing = () => plan.evaluate((svg) => svg.getBoundingClientRect().toJSON() as DOMRect)
  const middleOf = async (): Promise<Point> => {
    const frame = await box()
    return [frame.x + frame.width / 2, frame.y + frame.height / 2]
  }

  // The rig is wider than a phone. It opens at the middle of the stage, and
  // both of its ends can be reached.
  const opened = await box()
  const whole = await drawing()
  expect(opened.scrollLeft).toBeGreaterThan(0)
  expect(Math.abs(opened.x + opened.width / 2 - (whole.left + whole.width / 2))).toBeLessThan(1)

  // The truss, measured from the centre line so a change of the drawing's
  // bounds doesn't read as a move.
  const truss = page.locator('line[class*="_position_"]')
  const centre = page.locator('line[class*="_centreLine_"]')
  const trussX = async () =>
    Number(await truss.getAttribute('x1')) - Number(await centre.getAttribute('x1'))
  /** Scroll the middle of the truss to the middle of the box, and say where that is. */
  const onTruss = async (): Promise<Point> => {
    await truss.evaluate((line: SVGLineElement) => {
      const el = line.ownerSVGElement!.parentElement!
      const rect = line.ownerSVGElement!.getBoundingClientRect()
      const frame = el.getBoundingClientRect()
      el.scrollLeft +=
        rect.left +
        (line.x1.baseVal.value + line.x2.baseVal.value) / 2 -
        (frame.left + frame.width / 2)
      el.scrollTop += rect.top + line.y1.baseVal.value - (frame.top + frame.height / 2)
    })
    const svg = await drawing()
    return [
      svg.left +
        (Number(await truss.getAttribute('x1')) + Number(await truss.getAttribute('x2'))) / 2,
      svg.top + Number(await truss.getAttribute('y1')),
    ]
  }

  // A touch that moves selects nothing, even one that starts on a fixture:
  // not a long drag, and not a nudge short enough that the browser still
  // calls it a tap.
  const sharpy = page.getByRole('button', { name: /^Sharpy 2/ })
  const dot = (await sharpy.boundingBox())!
  const onDot: Point = [dot.x + dot.width / 2, dot.y + dot.height / 2]
  for (const [dx, dy] of [
    [12, 0],
    [-60, -40],
  ]) {
    await slide([onDot], [[onDot[0] + dx, onDot[1] + dy]])
    await page.waitForTimeout(300)
    await expect(onPlan).toHaveAttribute('aria-selected', 'true')
  }

  // Two fingers pinch. What was between them stays between them.
  const mid = await middleOf()
  const before = await drawing()
  const held = { x: mid[0] - before.left, y: mid[1] - before.top }
  await slide(
    [
      [mid[0] - 50, mid[1]],
      [mid[0] + 50, mid[1]],
    ],
    [
      [mid[0] - 100, mid[1]],
      [mid[0] + 100, mid[1]],
    ]
  )
  await expect(zoom).toHaveText('200%')
  const after = await drawing()
  expect(after.width).toBeCloseTo(before.width * 2, 0)
  expect(Math.abs(after.left + held.x * 2 - mid[0])).toBeLessThan(2)
  expect(Math.abs(after.top + held.y * 2 - mid[1])).toBeLessThan(2)

  // One finger pans, taking up where a tap would have left off.
  const panned = await box()
  await slide([mid], [[mid[0] - 100, mid[1] - 80]])
  const moved = await box()
  expect(moved.scrollLeft - panned.scrollLeft).toBeGreaterThan(80)
  expect(moved.scrollTop - panned.scrollTop).toBeGreaterThan(60)

  // A finger on a truss drags the truss, and the plan stays put under it.
  const startX = await trussX()
  const grab = await onTruss()
  const still = await box()
  await slide([grab], [[grab[0] + 112, grab[1]]])
  // 112 pixels is 2 m at 200%.
  await expect.poll(trussX).toBeCloseTo(startX + 112, 0)
  expect(await box()).toEqual(still)

  // A second finger that lands on a truss mid-pan is pinching, not dragging.
  const beside = await onTruss()
  const draggedX = await trussX()
  await slide(
    [
      [beside[0], beside[1] + 80],
      [beside[0], beside[1]],
    ],
    [
      [beside[0], beside[1] + 100],
      [beside[0], beside[1] - 20],
    ]
  )
  await expect(zoom).toHaveText('300%')
  expect((await trussX()) / 3).toBeCloseTo(draggedX / 2, 0)

  // A tap still picks a fixture, and takes you to its row. Not at once: a
  // tap within moments of a quick swipe is taken as stopping the swipe's
  // fling, and clicks nothing, as on any Android phone (Chromium's
  // TouchscreenTapSuppressionController). A person's next tap comes later
  // than a test's.
  await page.waitForTimeout(300)
  await sharpy.tap()
  const onFixtures = page.getByRole('tab', { name: 'Fixtures' })
  await expect(onFixtures).toHaveAttribute('aria-selected', 'true')
  // And so does one that wobbles by a few pixels, as a fingertip does.
  await onPlan.tap()
  // The picked fixture's channels now sit under the plan, and the box
  // gave them the room: bring the dot back into view.
  await sharpy.scrollIntoViewIfNeeded()
  const again = (await sharpy.boundingBox())!
  const wobble: Point = [again.x + again.width / 2, again.y + again.height / 2]
  await slide([wobble], [[wobble[0] + 4, wobble[1] + 3]], 3)
  await expect(onFixtures).toHaveAttribute('aria-selected', 'true')

  // The front elevation pinches too.
  await page.getByRole('tab', { name: 'Front' }).tap()
  const front = page.getByRole('img', { name: /^Front elevation of/ })
  await expect(zoom).toHaveText('100%')
  const frontMiddle = await front.evaluate((svg) => {
    const rect = svg.parentElement!.getBoundingClientRect()
    return [rect.left + rect.width / 2, rect.top + rect.height / 2] as Point
  })
  await slide(
    [
      [frontMiddle[0] - 40, frontMiddle[1]],
      [frontMiddle[0] + 40, frontMiddle[1]],
    ],
    [
      [frontMiddle[0] - 60, frontMiddle[1]],
      [frontMiddle[0] + 60, frontMiddle[1]],
    ]
  )
  await expect(zoom).toHaveText('150%')

  await page.context().close()
})

/**
 * Zoomed in on a computer, the left of the rig was cut off: the drawing was
 * centred in its box even when wider than it, so half the overflow went off
 * the left edge, where no scrollbar reaches. And the buttons zoomed about
 * the drawing's corner, so what was in the middle of the box drifted away.
 */
test('the plan zooms about its middle and every edge of it can be reached', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  await page.goto('/?pin=4242')
  await page.getByLabel('Your name').fill(uniqueName('Desk Plot Tech'))
  await page.getByLabel('Your PIN').fill('1234')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible()
  await page.getByRole('button', { name: 'All plots…' }).click()
  await page.getByLabel('Import CSV or MVR file').setInputFiles('e2e/fixtures/rig.mvr')
  await expect(page.getByText(/Imported 4 fixtures across/)).toBeVisible()
  await page.getByRole('tab', { name: 'Plan' }).click()

  const plan = page.getByRole('img', { name: /^Plan of/ })
  const zoom = page
    .getByRole('button', { name: 'Zoom out' })
    .locator('xpath=following-sibling::span[1]')
  const middle = () =>
    plan.evaluate((svg) => {
      const el = svg.parentElement!
      const box = el.getBoundingClientRect()
      const rect = svg.getBoundingClientRect()
      // Where the middle of the box falls on the drawing, as a fraction of it.
      return {
        x: (box.left + el.clientLeft + el.clientWidth / 2 - rect.left) / rect.width,
        y: (box.top + el.clientTop + el.clientHeight / 2 - rect.top) / rect.height,
      }
    })
  const start = await middle()
  for (let i = 0; i < 10; i++) await page.getByRole('button', { name: 'Zoom in' }).click()
  await expect(zoom).toHaveText('300%')
  const end = await middle()
  expect(end.x).toBeCloseTo(start.x, 2)

  const edges = await plan.evaluate((svg) => {
    const el = svg.parentElement!
    el.scrollLeft = 0
    const left =
      svg.getBoundingClientRect().left - (el.getBoundingClientRect().left + el.clientLeft)
    el.scrollLeft = el.scrollWidth
    const right =
      el.getBoundingClientRect().left +
      el.clientLeft +
      el.clientWidth -
      svg.getBoundingClientRect().right
    return { left, right }
  })
  expect(edges.left).toBeGreaterThanOrEqual(0)
  expect(edges.right).toBeGreaterThanOrEqual(0)

  await context.close()
})

/** A phone has no Cmd+Z, and on a lighting plot that was all undo was. */
test('a plot is undone and redone from a phone', async ({ browser }) => {
  const page = await phone(browser, 'Undo Tech')
  await page.getByRole('button', { name: 'Open channels' }).first().tap()
  await page.getByRole('button', { name: 'All plots…' }).tap()
  await page.getByRole('button', { name: '+ New Plot' }).tap()
  await page.locator('#new-plot-name').fill(uniqueName('Phone Rig'))
  await page.getByRole('button', { name: 'Create', exact: true }).tap()
  await expect(page.getByRole('tab', { name: 'Fixtures' })).toBeVisible()

  const undo = page.getByRole('button', { name: 'Undo', exact: true })
  const redo = page.getByRole('button', { name: 'Redo', exact: true })
  // Making the plot is not something to take back.
  await expect(undo).toBeDisabled()
  await expect(redo).toBeDisabled()

  // The plot's own count, above the list; each position has one too.
  const fixtures = page.getByText(/^\d+ fixtures?$/).first()
  await expect(fixtures).toHaveText('0 fixtures')
  await page.locator('main').getByRole('button', { name: '+ Fixture' }).first().tap()
  await expect(fixtures).toHaveText('1 fixture')
  await undo.tap()
  await expect(fixtures).toHaveText('0 fixtures')
  await expect(undo).toBeDisabled()
  await redo.tap()
  await expect(fixtures).toHaveText('1 fixture')

  // They share the tabs' row rather than taking a line of their own.
  const tabs = (await page.getByRole('tablist').boundingBox())!
  const button = (await undo.boundingBox())!
  expect(Math.abs(button.y + button.height / 2 - (tabs.y + tabs.height / 2))).toBeLessThan(4)

  await page.context().close()
})
