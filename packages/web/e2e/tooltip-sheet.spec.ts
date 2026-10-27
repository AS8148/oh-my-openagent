import { expect, test } from "@playwright/test"

test.describe("Icon control tooltip", () => {
  test("keyboard focus on the Fit button shows its tooltip and Escape dismisses it", async ({
    page,
  }) => {
    // given
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/")
    const fit = page.getByTestId("hero-dag").getByRole("button", { name: "Fit graph" })
    const tooltip = page.getByTestId("hero-dag").getByRole("tooltip", { name: "Fit graph" })
    await expect(tooltip).toBeHidden()

    // when
    await fit.focus()

    // then
    await expect(tooltip).toBeVisible()
    await expect(fit).toHaveAttribute("aria-describedby", (await tooltip.getAttribute("id")) ?? "")

    // when
    await page.keyboard.press("Escape")

    // then
    await expect(tooltip).toBeHidden()
    await expect(fit).toBeFocused()
  })

  test("pointer hover on the Fit button shows its tooltip", async ({ page }) => {
    // given
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.goto("/")
    const dag = page.getByTestId("hero-dag")

    // when
    await dag.getByRole("button", { name: "Fit graph" }).hover()

    // then
    await expect(dag.getByRole("tooltip", { name: "Fit graph" })).toBeVisible()
  })
})

test("Escape closes the mobile nav sheet and returns focus to its toggle", async ({ page }) => {
  // given
  await page.setViewportSize({ width: 375, height: 800 })
  await page.goto("/")
  const toggle = page.getByRole("button", { name: "Open menu" })
  await toggle.click()
  const sheet = page.locator("#mobile-nav")
  await expect(sheet).toBeVisible()
  await sheet.getByRole("link", { name: "Docs", exact: true }).focus()

  // when
  await page.keyboard.press("Escape")

  // then
  await expect(sheet).toHaveAttribute("aria-hidden", "true")
  await expect(page.getByRole("button", { name: "Open menu" })).toBeFocused()
})
