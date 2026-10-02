import { expect, test } from "@playwright/test";

// Full screen as video players do it (Fullscreen.tsx): an expand button in
// the corner, the controls hidden in full screen, and an exit button that
// fades out until the pointer moves.
test("full screen hides the controls, and its exit button wakes with the pointer", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("section.plot svg.graph")).toHaveCount(7);
  await page.getByLabel("Renderer", { exact: true }).selectOption("canvas");

  await expect(page.locator('.garden-canvas[data-ready="true"]')).toBeVisible();
  const plots = await page.locator("section.plot").count();

  const enter = page.getByRole("button", { name: "Full screen", exact: true });
  await expect(enter).toBeVisible();
  await enter.click();
  await expect(page.locator(".app.fullscreen")).toHaveCount(1);
  await expect(page.locator(".topbar")).toBeHidden();
  // The garden stays.
  await expect(page.locator("section.plot")).toHaveCount(plots);

  const exit = page.getByRole("button", { name: "Exit full screen" });
  await expect(exit).toBeVisible();
  await expect(exit).not.toHaveClass(/asleep/);
  // Idle: the exit button fades out.
  await expect(exit).toHaveClass(/asleep/, { timeout: 5000 });
  await page.mouse.move(400, 300);
  await page.mouse.move(420, 310);
  await expect(exit).not.toHaveClass(/asleep/);

  await exit.click();
  await expect(page.locator(".app.fullscreen")).toHaveCount(0);
  await expect(page.locator(".topbar")).toBeVisible();
  await expect(enter).toBeVisible();
  await expect(enter).not.toHaveClass(/asleep/);
});
