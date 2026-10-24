import type { RequestContext } from "./env"
import { IMMUTABLE } from "./serve-release"

export const LAUNCH_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OmO in action</title>
  <meta name="description" content="From a question to research, verification and a working simulation.">
  <link rel="canonical" href="https://get.omo.dev/launch">
  <meta property="og:type" content="video.other">
  <meta property="og:url" content="https://get.omo.dev/launch">
  <meta property="og:title" content="OmO in action">
  <meta property="og:description" content="From a question to research, verification and a working simulation.">
  <meta property="og:video" content="https://get.omo.dev/media/launch-20261024.mp4">
  <meta property="og:video:secure_url" content="https://get.omo.dev/media/launch-20261024.mp4">
  <meta property="og:video:type" content="video/mp4">
  <meta property="og:video:width" content="1920">
  <meta property="og:video:height" content="1242">
  <meta property="og:image" content="https://get.omo.dev/media/launch-20261024.jpg">
  <meta property="og:image:alt" content="A physics simulation created with OmO">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="OmO in action">
  <meta name="twitter:description" content="From a question to research, verification and a working simulation.">
  <meta name="twitter:image" content="https://get.omo.dev/media/launch-20261024.jpg">
  <style>
    :root{color-scheme:dark;font-family:system-ui,-apple-system,sans-serif;background:#0b0d10;color:#f4f4f5}
    *{box-sizing:border-box}body{margin:0}main{width:min(1120px,100%);margin:auto;padding:48px 24px}
    a{color:inherit}header a{text-decoration:none;font-size:20px;font-weight:700}h1{font-size:clamp(32px,5vw,52px);letter-spacing:-.04em;margin:40px 0 12px}
    p{color:#b7bbc4;font-size:18px;line-height:1.6;margin:0 0 28px}video{display:block;width:100%;height:auto;background:#000;border:1px solid #30343b;border-radius:12px}
    footer{margin-top:24px;font-size:14px;color:#b7bbc4}@media(max-width:600px){main{padding:24px 16px}h1{margin-top:28px}}
  </style>
</head>
<body>
  <main>
    <header><a href="https://omo.dev">OmO</a></header>
    <h1>OmO in action</h1>
    <p>From a question to research, verification and a working simulation.</p>
    <video controls playsinline preload="metadata" width="1920" height="1242" poster="https://get.omo.dev/media/launch-20261024.jpg" aria-label="OmO product demonstration">
      <source src="https://get.omo.dev/media/launch-20261024.mp4" type="video/mp4">
      <a href="https://get.omo.dev/media/launch-20261024.mp4">Watch the MP4 video</a>.
    </video>
    <footer><a href="https://omo.dev">Learn more about OmO</a></footer>
  </main>
</body>
</html>`

export async function serveLaunchMedia(request: Request, ctx: RequestContext, pathname: string): Promise<Response> {
  const video = pathname.endsWith(".mp4")
  const key = `public/launch/2026-10-24/${video ? "demo.mp4" : "poster.jpg"}`
  const object = await ctx.env.RELEASES.head(key)
  if (object === null) return new Response("Not found\n", { status: 404 })
  const headers = new Headers({
    "Content-Type": video ? "video/mp4" : "image/jpeg",
    "Content-Length": String(object.size),
    "Accept-Ranges": "bytes",
    "Cache-Control": IMMUTABLE,
    ETag: object.httpEtag,
    "X-Content-Type-Options": "nosniff",
  })
  if (request.method === "HEAD") return new Response(null, { headers })

  let offset = 0
  let length = object.size
  const range = request.headers.get("Range")
  const ifRange = request.headers.get("If-Range")
  const partial = range !== null && (ifRange === null || ifRange === object.httpEtag)
  if (partial) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    const start = match?.[1] ?? ""
    const finish = match?.[2] ?? ""
    offset = start !== "" ? Number(start) : Math.max(0, object.size - Number(finish))
    const end = start !== "" && finish !== "" ? Math.min(Number(finish), object.size - 1) : object.size - 1
    if (
      match === null ||
      (start === "" && finish === "") ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(end) ||
      offset >= object.size ||
      end < offset ||
      (start === "" && Number(finish) === 0)
    ) {
      headers.set("Content-Range", `bytes */${object.size}`)
      headers.delete("Content-Length")
      return new Response(null, { status: 416, headers })
    }
    length = end - offset + 1
    headers.set("Content-Length", String(length))
    headers.set("Content-Range", `bytes ${offset}-${end}/${object.size}`)
  }
  const body = await ctx.env.RELEASES.get(key, partial ? { range: { offset, length } } : undefined)
  if (body === null) return new Response("Not found\n", { status: 404 })
  return new Response(body.body, { status: partial ? 206 : 200, headers })
}
