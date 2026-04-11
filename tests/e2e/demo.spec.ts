import { expect, test } from "@playwright/test";

test("demo story renders KPI + chart narrative", async ({ page }) => {
  const browserErrors: string[] = [];
  const browserWarnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(message.text());
    }
    if (message.type() === "warning") {
      browserWarnings.push(message.text());
    }
  });

  await page.goto("/");

  await expect(page.getByTestId("hero-title")).toContainText(
    "Ten Seconds In The Life Of A Spiky Checkout"
  );
  await expect(page.getByTestId("story-kpis").locator(".kpi-card")).toHaveCount(4);

  await expect(page.getByTestId("act-demand-wave")).toBeVisible();
  await expect(page.getByTestId("act-retry-turbulence")).toBeVisible();
  await expect(page.getByTestId("act-error-rates")).toBeVisible();
  await expect(page.getByTestId("act-latency-shape")).toBeVisible();
  await expect(page.getByTestId("collector-pulse")).toBeVisible();

  await expect(page.locator("[data-testid='collector-pulse'] canvas")).toHaveCount(1);
  await expect(page.locator(".act-card")).toHaveCount(5);

  expect(browserErrors).toEqual([]);
  expect(browserWarnings.filter((text) => text.includes("width(-1)"))).toEqual([]);
});

test("demo remains readable on mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await expect(page.getByTestId("hero-title")).toBeVisible();
  await expect(page.getByTestId("story-kpis")).toBeVisible();
  await expect(page.locator(".act-card").first()).toBeVisible();
  await expect(page.locator("[data-testid='collector-pulse'] canvas")).toBeVisible();
});
