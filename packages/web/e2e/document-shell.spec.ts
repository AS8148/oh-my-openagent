import { expect, test } from "@playwright/test"

const ROUTES = [
  ["/", "en"],
  ["/ko", "ko"],
  ["/ja", "ja"],
  ["/zh", "zh-CN"],
  ["/pt-BR/docs", "pt-BR"],
] as const

test.describe("Document shell", () => {
  for (const [route, lang] of ROUTES) {
    test(`${route} declares lang="${lang}", a dark colour scheme and the ink tokens`, async ({
      page,
    }) => {
      // given / when
      await page.goto(route)

      // then
      await expect(page.locator("html")).toHaveAttribute("lang", lang)
      const shell = await page.evaluate(() => ({
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        background: getComputedStyle(document.body).backgroundColor,
        color: getComputedStyle(document.body).color,
      }))
      expect(shell).toEqual({
        colorScheme: "dark",
        background: "rgb(9, 9, 11)",
        color: "rgb(245, 245, 247)",
      })
    })
  }

  test("the first Tab reaches the skip link and Enter moves focus into main", async ({ page }) => {
    // given
    await page.goto("/docs")
    await page.locator("body").focus()

    // when
    await page.keyboard.press("Tab")

    // then
    const skip = page.getByRole("link", { name: "Skip to content" })
    await expect(skip).toBeFocused()
    await expect(skip).toBeInViewport()

    // when
    await page.keyboard.press("Enter")

    // then
    await expect(page.locator("main#main-content")).toBeFocused()
  })

  test("reverse Tab never leaves a focused control under the sticky nav", async ({ page }) => {
    // given
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/manifesto")
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await page.locator("footer a").last().focus()
    const obscured: string[] = []

    // when
    for (let index = 0; index < 25; index++) {
      await page.keyboard.press("Shift+Tab")
      const verdict = await page.evaluate(() => {
        const focused = document.activeElement
        const header = document.querySelector("header")
        if (!(focused instanceof HTMLElement) || !header || header.contains(focused)) return null
        const rect = focused.getBoundingClientRect()
        const navBottom = header.getBoundingClientRect().bottom
        return rect.top < navBottom - 1 && rect.bottom > 0
          ? `${focused.tagName.toLowerCase()} "${(focused.textContent ?? "").trim().slice(0, 30)}" top ${Math.round(rect.top)} < ${Math.round(navBottom)}`
          : null
      })
      if (verdict !== null) obscured.push(verdict)
    }

    // then
    expect(obscured).toEqual([])
  })
})
