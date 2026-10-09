// 画面配信 + /api の中継。Cloudflare Access はこの Worker（roi-plus）に掛ける。
interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> }
  API: { fetch(req: Request): Promise<Response> }
  PROXY_TOKEN: string
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname.startsWith('/api/')) {
      const headers = new Headers(req.headers)
      headers.set('X-ROI-Proxy', env.PROXY_TOKEN)
      return env.API.fetch(new Request(req, { headers }))
    }
    return env.ASSETS.fetch(req)
  },
}
