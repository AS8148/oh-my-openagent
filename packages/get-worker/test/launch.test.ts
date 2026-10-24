import { describe, expect, test } from "bun:test"
import { route } from "../src"
import { harness } from "./fakes"

const mp4 = "public/launch/2026-10-24/demo.mp4"
const poster = "public/launch/2026-10-24/poster.jpg"

describe("launch video", () => {
  test("page metadata and player use permanent public assets", async () => {
    const response = await route(new Request("https://get.omo.dev/launch"), harness().ctx)
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8")
    expect(html).toContain('controls playsinline preload="metadata"')
    expect(html).toContain('property="og:video" content="https://get.omo.dev/media/launch-20261024.mp4"')
    expect(html).toContain('property="og:video:type" content="video/mp4"')
    expect(html).toContain('property="og:image" content="https://get.omo.dev/media/launch-20261024.jpg"')
    for (const field of ["og:title", "og:description", "twitter:card", "twitter:image"]) {
      expect(html).toContain(`="${field}"`)
    }
    const head = await route(new Request("https://get.omo.dev/launch/", { method: "HEAD" }), harness().ctx)
    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")
  })

  test("serves MP4 and poster with correct MIME types and immutable caching", async () => {
    const h = harness()
    h.bucket.put(mp4, "0123456789")
    h.bucket.put(poster, "jpeg")
    for (const [extension, type, body] of [["mp4", "video/mp4", "0123456789"], ["jpg", "image/jpeg", "jpeg"]] as const) {
      const response = await route(new Request(`https://get.omo.dev/media/launch-20261024.${extension}`), h.ctx)
      expect(response.status).toBe(200)
      expect(response.headers.get("Content-Type")).toBe(type)
      expect(response.headers.get("Cache-Control")).toContain("immutable")
      expect(await response.text()).toBe(body)
    }
  })

  test.each([
    ["bytes=2-5", "2345", "bytes 2-5/10"],
    ["bytes=7-", "789", "bytes 7-9/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
    ["bytes=8-100", "89", "bytes 8-9/10"],
  ])("serves %s as an exact partial response", async (range, body, contentRange) => {
    const h = harness()
    h.bucket.put(mp4, "0123456789")
    const response = await route(new Request("https://get.omo.dev/media/launch-20261024.mp4", { headers: { Range: range } }), h.ctx)
    expect(response.status).toBe(206)
    expect(response.headers.get("Content-Type")).toBe("video/mp4")
    expect(response.headers.get("Accept-Ranges")).toBe("bytes")
    expect(response.headers.get("Content-Range")).toBe(contentRange)
    expect(response.headers.get("Content-Length")).toBe(String(body.length))
    expect(await response.text()).toBe(body)
  })

  test.each(["bytes=10-", "bytes=5-2", "bytes=-0", "bytes=-", "bytes=0-1,4-5"])("rejects invalid or unsatisfiable %s", async (range) => {
    const h = harness()
    h.bucket.put(mp4, "0123456789")
    const response = await route(new Request("https://get.omo.dev/media/launch-20261024.mp4", { headers: { Range: range } }), h.ctx)
    expect(response.status).toBe(416)
    expect(response.headers.get("Content-Range")).toBe("bytes */10")
  })

  test("HEAD does not read the object body and stale If-Range returns the full file", async () => {
    const h = harness()
    h.bucket.put(mp4, "0123456789")
    const head = await route(new Request("https://get.omo.dev/media/launch-20261024.mp4", { method: "HEAD", headers: { Range: "bytes=0-1" } }), h.ctx)
    expect(head.status).toBe(200)
    expect(head.headers.get("Content-Length")).toBe("10")
    expect(await head.text()).toBe("")
    expect(h.bucket.reads).toEqual([mp4])
    const response = await route(new Request("https://get.omo.dev/media/launch-20261024.mp4", { headers: { Range: "bytes=0-1", "If-Range": '"older"' } }), h.ctx)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("0123456789")
  })

  test("missing and unlisted objects remain inaccessible", async () => {
    const h = harness()
    h.bucket.put("public/launch/private.mp4", "private")
    for (const path of ["/media/launch-20261024.mp4", "/media/private.mp4", "/public/launch/private.mp4"]) {
      const response = await route(new Request(`https://get.omo.dev${path}`), h.ctx)
      expect(response.status).toBe(404)
    }
  })
})
