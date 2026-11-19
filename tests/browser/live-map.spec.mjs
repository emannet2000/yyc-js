import { test as base, expect } from '@playwright/test';
import {
  start,
  registration,
  secret,
  booking,
  action as apiAction,
} from '../helpers/app.mjs';

// Same transport-only fixture as the workflow acceptance tests: requests reach the
// real HTTP handler and database. Browser geolocation is supplied by Playwright.
const test = base.extend({
  app: async ({ context }, provide) => {
    const cleanup = [];
    const fixture = await start(
      { after: (fn) => cleanup.push(fn) },
      { publicOrigin: 'http://127.0.0.1:3000' },
    );
    await fixture.app.createAdmin({
      ...registration('admin', 'broker@acceptance.example'),
      name: 'Acceptance Broker',
    });
    await context.route('http://127.0.0.1:3000/**', async (route) => {
      const request = route.request();
      const reply = await fixture.request(request.url(), {
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
    const errors = [];
    const watch = (page) => page.on('pageerror', (error) => errors.push(error.message));
    for (const page of context.pages()) watch(page);
    context.on('page', watch);
    await provide(fixture);
    expect(errors).toEqual([]);
    for (const close of cleanup) await close();
  },
});

async function login(page, email, password = secret) {
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.locator('form').getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
}

async function delivery(page) {
  await page
    .getByRole('button', { name: 'View delivery →', exact: true })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  return page.getByRole('dialog');
}

// An assigned delivery with an approved driver, created through the API.
async function assignedDelivery(app, tag) {
  const owner = app.client(),
    broker = app.client(),
    driver = app.client();
  await owner('/api/register', 'POST', registration('store', `${tag}-owner@example.com`));
  const driverId = (
    await driver(
      '/api/register',
      'POST',
      registration('driver', `${tag}-driver@example.com`),
    )
  ).value.id;
  for (const [client, email] of [
    [owner, `${tag}-owner@example.com`],
    [driver, `${tag}-driver@example.com`],
    [broker, 'broker@acceptance.example'],
  ])
    await client('/api/login', 'POST', { email, password: secret });
  await broker(`/api/drivers/${driverId}/approve`, 'POST', {});
  const id = (await owner('/api/shipments', 'POST', booking())).value.id;
  await apiAction(broker, id, 'quote', { price: 450, rate: 300 });
  await apiAction(owner, id, 'acceptQuote');
  await apiAction(broker, id, 'offer', { driverId });
  await apiAction(driver, id, 'acceptJob');
  return { id, driverId };
}

test('a driver shares browser GPS and the broker sees the live location on the map', async ({
  page,
  context,
  app,
}) => {
  const { id } = await assignedDelivery(app, 'gps');
  await context.grantPermissions(['geolocation'], { origin: 'http://127.0.0.1:3000' });
  await context.setGeolocation({ latitude: 51.0447, longitude: -114.0719, accuracy: 12 });

  await page.goto('/react/');
  await login(page, 'gps-driver@example.com');
  const driverDialog = await delivery(page);
  await driverDialog
    .getByRole('button', { name: 'Share current location', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Location sharing active' }),
  ).toBeVisible();

  // The first GPS sample reaches the server; the broker's API client reads it back.
  const broker = app.client();
  await broker('/api/login', 'POST', {
    email: 'broker@acceptance.example',
    password: secret,
  });
  await expect
    .poll(async () => (await broker(`/api/shipments/${id}/tracking`)).value.latitude, {
      timeout: 15000,
    })
    .toBeCloseTo(51.0447, 3);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await login(page, 'broker@acceptance.example');
  const brokerDialog = await delivery(page);
  const map = brokerDialog.getByRole('region', { name: 'Last shared driver location' });
  await expect(map).toBeVisible({ timeout: 15000 });
  await expect(
    map.locator('xpath=ancestor::div[contains(@class,"livemap-wrap")]'),
  ).toBeVisible();
  await expect(brokerDialog.getByText(/Updated/)).toBeVisible();
  await expect(
    brokerDialog.getByRole('button', { name: 'Center on driver', exact: true }),
  ).toBeVisible();
});

test('a driver who denies location is told why sharing did not start', async ({
  page,
  context,
  app,
}) => {
  await assignedDelivery(app, 'denied');
  await context.clearPermissions();
  await page.goto('/react/');
  await login(page, 'denied-driver@example.com');
  const dialog = await delivery(page);
  await dialog
    .getByRole('button', { name: 'Share current location', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Location permission or GPS is unavailable',
  );
});
