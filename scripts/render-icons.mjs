/**
 * Renders the PRAEVION app icons (PNG) from the inline SVG mark using the
 * preinstalled Playwright Chromium. Run: node scripts/render-icons.mjs
 *
 * Outputs:
 *   public/icons/icon-192.png     — gradient rounded square, white mono mark
 *   public/icons/icon-512.png     — same at 512
 *   public/apple-touch-icon.png   — 180×180 full-bleed (iOS applies its own mask)
 *   src/app/favicon.ico           — 32×32 PNG-in-ICO (dark rounded square)
 */
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** White mono mark (matches LogoMark mono variant), 64×64 grid. */
const MONO_MARK = `
  <svg width="100%" height="100%" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M40.62 12.67 A23 23 0 0 1 26.05 56.22" stroke="#FFFFFF" stroke-width="4.5"/>
    <path d="M18.81 52.84 A23 23 0 0 1 23.38 12.67" stroke="#FFFFFF" stroke-width="4.5"/>
    <path d="M32 3.6 L41 13.6 L32 10.3 L23 13.6 Z" fill="#FFFFFF"/>
    <path d="M26 19 L31.5 19 L31.5 45 L22.6 54.2 Z M31.5 19 L40.5 22.5 L43 29 L38.5 34.5 L31.5 36.3 Z M31.5 24 L36.3 25.6 L37.6 28.8 L35.1 31.2 L31.5 31.9 Z" fill="#FFFFFF" fill-rule="evenodd"/>
  </svg>`

function iconHtml({ size, radius, background, markScale = 0.72, mark = MONO_MARK }) {
  const markSize = Math.round(size * markScale)
  return `<!doctype html><html><body style="margin:0;background:transparent">
    <div style="width:${size}px;height:${size}px;border-radius:${radius}px;background:${background};display:flex;align-items:center;justify-content:center">
      <div style="width:${markSize}px;height:${markSize}px">${mark}</div>
    </div>
  </body></html>`
}

const GRADIENT = 'linear-gradient(135deg, #7C3AED 0%, #3B82FF 100%)'

/** Full-colour mark on dark, for the favicon. */
const faviconSvg = fs
  .readFileSync(path.join(root, 'src/app/icon.svg'), 'utf8')
  .replace('width="64" height="64"', 'width="100%" height="100%"')

const jobs = [
  { out: 'public/icons/icon-192.png', size: 192, radius: 42, background: GRADIENT },
  { out: 'public/icons/icon-512.png', size: 512, radius: 112, background: GRADIENT },
  { out: 'public/apple-touch-icon.png', size: 180, radius: 0, background: GRADIENT },
  { out: '.favicon-32.png', size: 32, radius: 0, background: 'transparent', markScale: 1, mark: faviconSvg },
]

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const page = await browser.newPage({ viewport: { width: 600, height: 600 }, deviceScaleFactor: 1 })

fs.mkdirSync(path.join(root, 'public/icons'), { recursive: true })

for (const job of jobs) {
  await page.setViewportSize({ width: job.size, height: job.size })
  await page.setContent(iconHtml(job))
  await page.screenshot({
    path: path.join(root, job.out),
    omitBackground: true,
    clip: { x: 0, y: 0, width: job.size, height: job.size },
  })
  console.log('wrote', job.out)
}
await browser.close()

/* Wrap the 32px PNG in an ICO container (PNG-in-ICO, supported everywhere modern). */
const png = fs.readFileSync(path.join(root, '.favicon-32.png'))
const header = Buffer.alloc(6 + 16)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(1, 4) // count
header.writeUInt8(32, 6) // width
header.writeUInt8(32, 7) // height
header.writeUInt8(0, 8) // palette
header.writeUInt8(0, 9) // reserved
header.writeUInt16LE(1, 10) // planes
header.writeUInt16LE(32, 12) // bpp
header.writeUInt32LE(png.length, 14) // data size
header.writeUInt32LE(22, 18) // data offset
fs.writeFileSync(path.join(root, 'src/app/favicon.ico'), Buffer.concat([header, png]))
fs.unlinkSync(path.join(root, '.favicon-32.png'))
console.log('wrote src/app/favicon.ico')
