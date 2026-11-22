// Screenshot zprof dashboard views in headless Chrome and list page errors and
// WebGL warnings (the zprof invariant: zero of either on every view, both themes).
// Uses Sferic's harness (Chrome with the GPU, puppeteer-core) from ../lightning.
//   node scripts/snap.mjs [--views target,live] [--theme storm|daylight] [--wait 6000] [--out ../captures/snaps]
//   --click "x,y;x,y": click those page points after the wait (300 ms apart), then a second
//   screenshot, <view>-<theme>-click.png (a table heading, a button)
// The dev server must be running (run.cmd, port 8781); for the live view, the bridge too.
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const LIGHTNING = resolve(import.meta.dirname, '..', '..', '..', 'lightning')
const { args, launch, gpuInfo } = await import(pathToFileURL(join(LIGHTNING, 'scripts', 'harness.mjs')).href)

const o = args({ views: 'target', theme: 'storm', wait: 6000, size: '1600x1000', out: resolve(import.meta.dirname, '..', '..', 'captures', 'snaps') })
const [width, height] = String(o.size).split('x').map(Number)
mkdirSync(o.out, { recursive: true })
const browser = await launch({ width, height })
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e?.message ?? e)))
page.on('console', (m) => {
  const warn = m.type() === 'warn' || m.type() === 'warning'
  if (m.type() === 'error' || (warn && /WebGL|GL_INVALID|GL ERROR/i.test(m.text()))) errors.push(m.text())
})
const q = o.theme === 'daylight' ? '?theme=light' : ''
let failed = 0
for (const v of String(o.views).split(',')) {
  errors.length = 0
  await page.goto(`http://127.0.0.1:8781/${q}#${v}`, { waitUntil: 'load' })
  if (v === String(o.views).split(',')[0]) console.log(`GPU: ${await gpuInfo(page)}`)
  await new Promise((r) => setTimeout(r, Number(o.wait)))
  const file = join(o.out, `${v}-${o.theme}.png`)
  await page.screenshot({ path: file })
  let clicked = ''
  if (o.click) {
    for (const p of String(o.click).split(';')) {
      const [x, y] = p.split(',').map(Number)
      await page.mouse.click(x, y)
      await new Promise((r) => setTimeout(r, 300))
    }
    clicked = join(o.out, `${v}-${o.theme}-click.png`)
    await page.screenshot({ path: clicked })
  }
  const errs = [...new Set(errors)]
  failed += errs.length ? 1 : 0
  console.log(`${errs.length ? 'ERR' : 'ok '} ${v} -> ${file}${clicked ? `, ${clicked}` : ''}${errs.length ? '\n    ' + errs.slice(0, 5).join('\n    ') : ''}`)
}
await browser.close()
process.exitCode = failed ? 1 : 0
