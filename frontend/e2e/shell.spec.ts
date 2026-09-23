import { expect, test } from "@playwright/test";

test("public routes fit the viewport and keep claim responses private", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("TEA");
  await expect(page.locator("link[rel=manifest]")).toHaveAttribute("href", "/manifest.webmanifest");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

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
