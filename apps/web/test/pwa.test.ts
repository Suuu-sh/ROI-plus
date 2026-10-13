import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('PWA metadata and safe areas', () => {
  it('declares a standalone ROI+ app scoped to the existing root route', () => {
    const manifest = JSON.parse(read('public/manifest.webmanifest')) as {
      name: string
      short_name: string
      id: string
      scope: string
      start_url: string
      display: string
      icons: Array<{ src: string; sizes: string; type: string }>
    }
    const html = read('index.html')

    expect(manifest).toMatchObject({ name: 'ROI+', short_name: 'ROI+', id: '/', scope: '/', start_url: '/', display: 'standalone' })
    expect(manifest.icons).toEqual([
      { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
    ])
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"')
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"')
    expect(html).toContain('name="apple-mobile-web-app-title" content="ROI+"')
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style" content="default"')
    expect(html).toContain('rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"')
    expect(html).toContain('media="(prefers-color-scheme: light)"')
    expect(html).toContain('media="(prefers-color-scheme: dark)"')
  })

  it('ships favicon-derived PNG icons at their declared dimensions', () => {
    for (const [file, size] of [['pwa-192.png', 192], ['pwa-512.png', 512], ['apple-touch-icon.png', 180]] as const) {
      const png = readFileSync(resolve(process.cwd(), `public/${file}`))
      expect(png.toString('ascii', 1, 4)).toBe('PNG')
      expect(png.readUInt32BE(16)).toBe(size)
      expect(png.readUInt32BE(20)).toBe(size)
    }
  })

  it('keeps standalone mobile content inside top, bottom, and landscape safe areas', () => {
    const css = read('src/index.css')
    const layout = read('src/components/Layout.tsx')

    expect(css).toContain('padding-inline: env(safe-area-inset-left, 0px) env(safe-area-inset-right, 0px)')
    expect(css).toContain('env(safe-area-inset-top, 0px)')
    expect(css).toContain('left: env(safe-area-inset-left, 0px)')
    expect(css).toContain('right: env(safe-area-inset-right, 0px)')
    expect(css).toContain('padding-bottom: env(safe-area-inset-bottom, 0px)')
    expect(css).toContain('.safe-area-content { padding-bottom: calc(7rem + env(safe-area-inset-bottom, 0px)); }')
    expect(layout).toContain('safe-area-header')
    expect(layout).toContain('safe-area-bottom-nav')
    expect(layout).toContain('safe-area-content')
    expect(layout).toContain('pb-28')
  })
})
