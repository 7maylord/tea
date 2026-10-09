import { expect, test } from "@playwright/test";

test("public routes fit the viewport and keep claim responses private", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page).toHaveTitle("TEA");
  await expect(page.locator("link[rel=manifest]")).toHaveAttribute("href", "/manifest.webmanifest");
  const signIn = page.getByRole("button", { name: "Continue with email" });
  await expect(signIn).toBeVisible();
  expect((await signIn.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  const playground = page.getByRole("group", { name: "Explore payment types" });
  await playground.getByRole("button", { name: "Stream", exact: true }).click();
  await expect(page.locator(".landing-receipt")).toContainText("Streaming");
  const split = playground.getByRole("button", { name: "Split", exact: true });
  await split.focus();
  await page.keyboard.press("Enter");
  await expect(split).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".landing-receipt")).toContainText("Request created");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".landing-orbit-star")).toHaveCSS("animation-name", "none");
  const receiptBounds = await page.locator(".landing-receipt").boundingBox();
  const pickerBounds = await playground.boundingBox();
  expect(receiptBounds!.y + receiptBounds!.height).toBeLessThan(pickerBounds!.y);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("landing.png"), fullPage: true });

  const claim = await page.goto("/claim/not-a-valid-token");
  expect(await claim?.headerValue("cache-control")).toContain("no-store");
  expect(await claim?.headerValue("referrer-policy")).toBe("no-referrer");
  await expect(page.getByText("This invitation link is invalid.")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("installed shell loads offline and blocks sign-in", async ({ context, page }) => {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText("You are offline. Payments are paused until you reconnect.")).toBeVisible();
  const signIn = page.getByRole("button", { name: "Continue with email" });
  if (await signIn.isVisible()) await expect(signIn).toBeDisabled();
  await context.setOffline(false);
  await expect(page.getByText("You are offline. Payments are paused until you reconnect.")).toBeHidden();
});

test("the app wordmark returns to the public homepage", async ({ page }) => {
  await page.goto("/app");
  await page.getByRole("link", { name: "Go to TEA homepage" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button", { name: "Continue with email" })).toBeVisible();
});
