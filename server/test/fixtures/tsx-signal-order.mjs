// Preloaded into a box started under tsx by crashRecovery.test.ts.
//
// tsx adds a SIGINT/SIGTERM listener of its own that exits the process with
// 128+signal if no other listener is left when it runs. Locally it is always
// registered before the box's; on CI it was once registered after, and that
// order is the one that ended a shutdown early. This puts it last, so the
// test always runs the order that failed rather than whichever one it gets.
import process from 'node:process'
import { setInterval } from 'node:timers'

const reorder = setInterval(() => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const all = process.rawListeners(signal)
    const hidden = all.find((listener) => listener.name === 'hiddenHandler')
    if (!hidden || all.length < 2 || all.at(-1) === hidden) continue
    process.removeListener(signal, hidden)
    process.on(signal, hidden)
  }
}, 20)
reorder.unref()
