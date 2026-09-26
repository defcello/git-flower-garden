/*
 * Touch devices have no hover (roadmap section 7): focus controls must be
 * visible without it, and tapping must work for +, −, and commit details.
 */
import { expect, test } from "@playwright/test";

test("touch: + is visible without hover; tap to focus, tap a commit, tap − to return", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("section.plot svg.graph")).toHaveCount(7, {
    timeout: 20_000,
  });
  expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(
    true,
  );

  const plus = page.getByRole("button", { name: "Focus Criss-cross" });
  await plus.scrollIntoViewIfNeeded();
  await expect(plus).toHaveCSS("opacity", "1");
  await plus.tap();
  const minus = page.getByRole("button", { name: "Show all repositories" });
  await expect(minus).toBeVisible();

  await page.locator(".focus-graph g.commit", { hasText: "Add tulips" }).tap();
  await expect(
    page.getByRole("complementary", { name: "Commit details" }),
  ).toContainText("Add tulips");
  await minus.tap();
  await expect(
    page.getByRole("main", { name: "All repositories" }),
  ).toBeVisible();
});
