import { test, expect } from '@playwright/test';
import { start } from '../helpers/app.mjs';

test('first broker onboarding uses a one-time operator token and closes setup', async ({
  page,
  context,
}) => {
  const cleanup = [];
  const app = await start({ after: (fn) => cleanup.push(fn) });
  try {
    const token = app.app.createSetupToken();
    await context.route('http://127.0.0.1:3000/**', async (route) => {
      const request = route.request();
      const reply = await app.request(request.url(), {
        method: request.method(),
        headers: await request.allHeaders(),
        body: request.postData() || undefined,
      });
      await route.fulfill({
        status: reply.status,
        headers: Object.fromEntries(reply.headers),
        body: Buffer.from(await reply.arrayBuffer()),
      });
    });
    await page.goto('/react/');
    await page
      .getByRole('button', { name: 'Set up broker account', exact: true })
      .click();
    await page.getByLabel('Operator setup token', { exact: true }).fill(token);
    await page.getByLabel('Full name', { exact: true }).fill('Operations Broker');
    await page.getByLabel('Contact phone', { exact: true }).fill('4035550100');
    await page
      .getByLabel('Email address', { exact: true })
      .fill('operations@example.com');
    await page.getByLabel('Password', { exact: true }).fill('Private-password-2026');
    await page
      .getByLabel('Confirm password', { exact: true })
      .fill('Private-password-2026');
    await page
      .getByRole('button', { name: 'Create broker account', exact: true })
      .click();
    await expect(
      page.locator('form').getByRole('button', { name: 'Log in', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Set up broker account', exact: true }),
    ).toHaveCount(0);
    await page
      .getByLabel('Email address', { exact: true })
      .fill('operations@example.com');
    await page.getByLabel('Password', { exact: true }).fill('Private-password-2026');
    await page
      .locator('form')
      .getByRole('button', { name: 'Log in', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Operations', exact: true }),
    ).toBeVisible();
    expect((await app.client()('/api/setup')).value.required).toBe(false);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      ),
    ).toBe(false);
  } finally {
    for (const close of cleanup) await close();
  }
});
