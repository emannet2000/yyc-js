import { test as base, expect } from '@playwright/test';
import { start, registration, secret } from '../helpers/app.mjs';

// Only transport is intercepted: requests reach the real HTTP handler, SQLite,
// authentication and CSRF logic. No API responses or application state are mocked.
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
async function layout(page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflow).toBe(false);
}
async function login(page, email, password = secret) {
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.locator('form').getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
  await layout(page);
}
async function logout(page) {
  if (await page.getByRole('dialog').count()) await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Log in to your workspace.' }),
  ).toBeVisible();
}
async function nav(page, name) {
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name, exact: true })
    .click();
}
async function register(page, role) {
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  await page
    .getByRole('button', {
      name: role === 'driver' ? 'Driver / truck owner' : 'Store owner',
      exact: true,
    })
    .click();
  await page
    .getByLabel(role === 'driver' ? 'Full name' : 'Store / business name', {
      exact: true,
    })
    .fill(role === 'driver' ? 'Acceptance Driver' : 'Acceptance Store');
  await page.getByLabel('Contact phone', { exact: true }).fill('555-0100');
  await page
    .getByLabel('Email address', { exact: true })
    .fill(`${role}@acceptance.example`);
  await page.getByLabel('Password', { exact: true }).fill(secret);
  await page.getByLabel('Confirm password', { exact: true }).fill(secret);
  if (role === 'driver') {
    await page.getByLabel('Truck make and model').fill('Acceptance truck');
    await page.getByLabel('Plate / unit reference').fill('ACCEPT-001');
    await page.getByLabel('Payload capacity (kg)', { exact: true }).fill('3500');
    await page.getByLabel('Pallet capacity', { exact: true }).fill('8');
    await page.getByLabel('Service area').fill('Calgary');
    await page.getByLabel('Truck has a liftgate').check();
  } else {
    await page.getByLabel('Store delivery address').fill('Acceptance store address');
    await page.getByLabel('Receiving contact', { exact: true }).fill('Receiving team');
  }
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Log in to your workspace.' }),
  ).toBeVisible();
}
async function delivery(page) {
  await page
    .getByRole('button', { name: 'View delivery →', exact: true })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  return page.getByRole('dialog');
}
async function status(page, value) {
  await expect(page.getByRole('dialog').getByText(value, { exact: true })).toBeVisible();
}

test('registration through delivered shipment, including broker approval and exception resolution', async ({
  page,
  app,
}) => {
  expect(app).toBeTruthy();
  await page.goto('/react/');
  await register(page, 'driver');
  await register(page, 'store');
  await login(page, 'store@acceptance.example');
  await nav(page, 'Request delivery');
  for (const [label, value] of [
    ['Pickup address', 'Acceptance warehouse'],
    ['Delivery address', 'Acceptance store address'],
    ['Pickup date', '2099-11-05'],
    ['Goods / cargo', 'Household supplies'],
    ['Weight (kg)', '900'],
    ['Pallet count', '4'],
    ['Pickup contact', 'Warehouse team'],
    ['Receiving contact', 'Store team'],
    ['Receiving hours', '09:00–17:00'],
  ])
    await page.getByLabel(label, { exact: true }).fill(value);
  await page
    .getByRole('button', { name: 'Submit delivery request', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'My deliveries', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close delivery', exact: true }).click();
  await layout(page);
  await logout(page);
  await login(page, 'broker@acceptance.example');
  await nav(page, 'Approvals');
  await page.getByRole('button', { name: 'Record manual approval', exact: true }).click();
  await expect(page.getByText('Approved', { exact: true })).toBeVisible();
  await nav(page, 'Deliveries');
  await delivery(page);
  await page.getByLabel('Customer quote (CAD)', { exact: true }).fill('450.50');
  await page.getByLabel('Driver rate (CAD)', { exact: true }).fill('300.25');
  await page.getByRole('button', { name: 'Issue quotation', exact: true }).click();
  await status(page, 'Quote ready');
  await logout(page);
  await login(page, 'store@acceptance.example');
  await delivery(page);
  await page.getByRole('button', { name: 'Accept quotation', exact: true }).click();
  await status(page, 'Ready to assign');
  await logout(page);
  await login(page, 'broker@acceptance.example');
  await delivery(page);
  await page
    .getByLabel('Approved suitable driver')
    .selectOption({ label: 'Acceptance Driver · ACCEPT-001' });
  await page.getByRole('button', { name: 'Send job offer', exact: true }).click();
  await status(page, 'Offered');
  await logout(page);
  await login(page, 'driver@acceptance.example');
  await nav(page, 'Job offers');
  await delivery(page);
  await page.getByRole('button', { name: 'Accept job', exact: true }).click();
  await status(page, 'Assigned');
  await page.getByRole('button', { name: 'Record arrival', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm pickup', exact: true }).click();
  await status(page, 'In transit');
  await page.getByText('Report an issue', { exact: true }).click();
  await page.getByLabel('Issue', { exact: true }).fill('Receiving delay');
  await page
    .getByLabel('Issue details', { exact: true })
    .fill('Receiving team requested a short hold');
  await page.getByRole('button', { name: 'Report issue', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Confirm delivery', exact: true }),
  ).toHaveCount(0);
  await logout(page);
  await login(page, 'broker@acceptance.example');
  await delivery(page);
  await page.getByLabel('Resolution', { exact: true }).fill('Receiving team is ready');
  await page.getByRole('button', { name: 'Resolve exception', exact: true }).click();
  await logout(page);
  await login(page, 'driver@acceptance.example');
  await delivery(page);
  await page
    .getByLabel('Delivery receipt reference', { exact: true })
    .fill('ACCEPTANCE-POD');
  await page.getByLabel('Received by', { exact: true }).fill('Receiving team');
  await page.getByRole('button', { name: 'Confirm delivery', exact: true }).click();
  await status(page, 'Delivered');
  await layout(page);
  await logout(page);
  await login(page, 'store@acceptance.example');
  await delivery(page);
  await expect(
    page.getByText('ACCEPTANCE-POD · Received by Receiving team', { exact: true }),
  ).toBeVisible();
  await status(page, 'Delivered');
});

test('broker recovery and disable/re-enable controls operate through the UI', async ({
  page,
  app,
}) => {
  expect(app).toBeTruthy();
  await page.goto('/react/');
  await register(page, 'store');
  await login(page, 'broker@acceptance.example');
  await nav(page, 'Accounts');
  const account = page.locator('.accountcard').filter({
    has: page.getByRole('heading', { name: 'Acceptance Store', exact: true }),
  });
  await account
    .getByLabel('Recovery verification for store@acceptance.example', { exact: true })
    .fill('Verified registered contact');
  await account
    .getByRole('button', { name: 'Create password reset link', exact: true })
    .click();
  const link = account.getByLabel('Recovery link for store@acceptance.example');
  await expect(link).not.toHaveValue('');
  const resetUrl = await link.inputValue();
  await logout(page);
  await page.goto(resetUrl);
  await page
    .getByLabel('New password', { exact: true })
    .fill('New-acceptance-password-123');
  await page
    .getByLabel('Confirm new password', { exact: true })
    .fill('New-acceptance-password-123');
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(
    page.getByText('Password updated. All previous sessions have ended.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Back to log in', exact: true }).click();
  await login(page, 'store@acceptance.example', 'New-acceptance-password-123');
  await logout(page);
  await login(page, 'broker@acceptance.example');
  await nav(page, 'Accounts');
  await account
    .getByLabel('Reason for disabling store@acceptance.example', { exact: true })
    .fill('Requested suspension');
  await account.getByRole('button', { name: 'Disable account', exact: true }).click();
  await expect(account.getByText('store · Disabled', { exact: true })).toBeVisible();
  await logout(page);
  await page
    .getByLabel('Email address', { exact: true })
    .fill('store@acceptance.example');
  await page.getByLabel('Password', { exact: true }).fill('New-acceptance-password-123');
  await page.locator('form').getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.');
  await login(page, 'broker@acceptance.example');
  await nav(page, 'Accounts');
  await account
    .getByLabel('Reason for enabling store@acceptance.example', { exact: true })
    .fill('Suspension ended');
  await account.getByRole('button', { name: 'Enable account', exact: true }).click();
  await expect(account.getByText('store · Active', { exact: true })).toBeVisible();
  await logout(page);
  await login(page, 'store@acceptance.example', 'New-acceptance-password-123');
});
