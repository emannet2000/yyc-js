import { test as base, expect } from '@playwright/test';
import { setup, booking, action, secret } from '../helpers/app.mjs';

const test = base.extend({
  workspace: async ({ context }, provide) => {
    const cleanup = [];
    const previous = process.env.YYC_LIVE_TESTS;
    let fixture;
    try {
      process.env.YYC_LIVE_TESTS = 'true';
      fixture = await setup({ after: (fn) => cleanup.push(fn) });
    } finally {
      if (previous === undefined) delete process.env.YYC_LIVE_TESTS;
      else process.env.YYC_LIVE_TESTS = previous;
    }
    await context.route('https://tile.openstreetmap.org/**', (route) => route.abort());
    try {
      await provide(fixture);
    } finally {
      for (const close of cleanup) await close();
    }
  },
});
test.use({ serviceWorkers: 'allow' });

test('PWA installs its worker and reloads its shell offline without caching account APIs', async ({
  page,
  context,
  workspace,
}) => {
  await page.goto(workspace.url + '/react/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);
  const manifest = await page.evaluate(async () =>
    (await fetch('/react/manifest.webmanifest')).json(),
  );
  expect(manifest.display).toBe('standalone');
  expect(manifest.scope).toBe('/react/');
  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    return (
      await Promise.all(
        names.map(async (name) =>
          (await (await caches.open(name)).keys()).map(
            (request) => new URL(request.url).pathname,
          ),
        ),
      )
    ).flat();
  });
  expect(cached).toContain('/react/');
  expect(cached).toContain('/react/icon.svg');
  expect(cached.some((path) => path.startsWith('/api/'))).toBe(false);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#root')).not.toBeEmpty();
  await expect(page.getByRole('heading', { name: 'Cannot load YYC' })).toBeVisible();
  await context.setOffline(false);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Log in to your workspace.' }),
  ).toBeVisible();
});

test('PWA browser GPS updates reach only the assigned delivery and stop on request', async ({
  page,
  context,
  workspace: f,
}) => {
  const id = (await f.store('/api/shipments', 'POST', booking())).value.id;
  await f.admin(`/api/drivers/${f.driverId}/approve`, 'POST', {});
  await action(f.admin, id, 'quote', { price: 450, rate: 300 });
  await action(f.store, id, 'acceptQuote');
  await action(f.admin, id, 'offer', { driverId: f.driverId });
  await action(f.driver, id, 'acceptJob');
  await context.grantPermissions(['geolocation'], { origin: f.url });
  await context.setGeolocation({ latitude: 51.05, longitude: -114.07, accuracy: 8 });
  await page.goto(f.url + '/react/');
  await page.locator('[name="email"]').fill('driver@example.com');
  await page.locator('[name="password"]').fill(secret);
  await page.locator('form').getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByRole('button', { name: 'Share phone GPS', exact: true }).click();
  await expect
    .poll(async () => (await f.store(`/api/shipments/${id}/tracking`)).value.latitude)
    .toBe(51.05);
  expect((await f.other(`/api/shipments/${id}/tracking`)).status).toBe(404);
  await page.getByRole('button', { name: 'Stop sharing phone GPS', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Share phone GPS', exact: true }),
  ).toBeVisible();
  const saved = (await f.store(`/api/shipments/${id}/tracking`)).value.recordedAt;
  await context.setGeolocation({ latitude: 51.09, longitude: -114.09, accuracy: 8 });
  expect((await f.store(`/api/shipments/${id}/tracking`)).value.recordedAt).toBe(saved);
});
