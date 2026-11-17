import { test as base, expect } from '@playwright/test';
import {
  start,
  registration,
  secret,
  booking,
  action as apiAction,
  attachDeliveryEvidence,
} from '../helpers/app.mjs';

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
  await page.getByRole('button', { name: 'Record arrival', exact: true }).click();
  await page.getByLabel('Photo, signature image, or document').setInputFiles({
    name: 'receipt.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\nAcceptance delivery receipt'),
  });
  await page.getByRole('button', { name: 'Attach evidence file', exact: true }).click();
  await expect(
    page.getByRole('link', { name: 'receipt.pdf', exact: true }),
  ).toBeVisible();
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

test('external quotation updates automatically and owner requests reach broker review', async ({
  page,
  app,
}) => {
  const owner = app.client(),
    broker = app.client();
  await owner('/api/register', 'POST', registration('store', 'live-owner@example.com'));
  await owner('/api/login', 'POST', {
    email: 'live-owner@example.com',
    password: secret,
  });
  await broker('/api/login', 'POST', {
    email: 'broker@acceptance.example',
    password: secret,
  });
  const id = (await owner('/api/shipments', 'POST', booking())).value.id;
  await page.goto('/react/');
  await login(page, 'live-owner@example.com');
  await delivery(page);
  await apiAction(broker, id, 'quote', { price: 450, rate: 300 });
  await expect(
    page.getByRole('button', { name: 'Accept quotation', exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await page
    .getByLabel('Request details and reason', { exact: true })
    .fill('Please review the price');
  await page.getByRole('button', { name: 'Send request to broker', exact: true }).click();
  await expect(page.getByText('Awaiting broker review.', { exact: false })).toBeVisible();
  await logout(page);
  await login(page, 'broker@acceptance.example');
  await delivery(page);
  await page.getByLabel('Decision', { exact: true }).selectOption('approve');
  await page.getByLabel('Revised customer price (CAD)', { exact: true }).fill('420');
  await page.getByLabel('Driver rate (CAD)', { exact: true }).fill('300');
  await page
    .getByLabel('Broker explanation and instructions', { exact: true })
    .fill('Reduced price approved');
  await page.getByRole('button', { name: 'Send broker decision', exact: true }).click();
  await expect(page.getByText('quotation · approved', { exact: true })).toBeVisible();
  expect((await owner('/api/state')).value.shipments[0].price).toBe(420);
  await layout(page);
});

test('driver accepts a rate without redispatch and receives assignment removal warning automatically', async ({
  page,
  app,
}) => {
  const owner = app.client(),
    broker = app.client(),
    driver = app.client();
  await owner('/api/register', 'POST', registration('store', 'rate-owner@example.com'));
  const driverId = (
    await driver(
      '/api/register',
      'POST',
      registration('driver', 'rate-driver@example.com'),
    )
  ).value.id;
  for (const [client, email] of [
    [owner, 'rate-owner@example.com'],
    [driver, 'rate-driver@example.com'],
    [broker, 'broker@acceptance.example'],
  ])
    await client('/api/login', 'POST', { email, password: secret });
  await broker(`/api/drivers/${driverId}/approve`, 'POST', {});
  const id = (await owner('/api/shipments', 'POST', booking())).value.id;
  await apiAction(broker, id, 'quote', { price: 450, rate: 300 });
  await apiAction(owner, id, 'acceptQuote');
  await apiAction(broker, id, 'offer', { driverId });
  await apiAction(driver, id, 'acceptJob');
  await page.goto('/react/');
  await login(page, 'rate-driver@example.com');
  await delivery(page);
  await apiAction(broker, id, 'changeRate', {
    rate: 325,
    reason: 'Agreed rate increase',
  });
  await expect(
    page.getByRole('button', { name: 'Accept new driver rate', exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'Accept new driver rate', exact: true }).click();
  await status(page, 'Assigned');
  await expect(
    page.getByRole('button', { name: 'Accept new driver rate', exact: true }),
  ).toHaveCount(0);
  expect((await driver('/api/state')).value.shipments[0].rate).toBe(325);
  await apiAction(broker, id, 'requote', {
    price: 500,
    rate: 325,
    reason: 'Customer service changed',
  });
  await expect(
    page.getByRole('button', { name: 'Acknowledge assignment change', exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Confirm pickup', exact: true }),
  ).toHaveCount(0);
  await layout(page);
});

test('owner escalates cancellation and broker allocates and pays both handover drivers', async ({
  page,
  app,
}) => {
  const owner = app.client(),
    broker = app.client(),
    driver = app.client(),
    replacement = app.client();
  await owner('/api/register', 'POST', registration('store', 'split-owner@example.com'));
  const originalId = (
    await driver('/api/register', 'POST', {
      ...registration('driver', 'split-original@example.com'),
      name: 'First Cargo Driver',
    })
  ).value.id;
  const replacementId = (
    await replacement('/api/register', 'POST', {
      ...registration('driver', 'split-replacement@example.com'),
      name: 'Final Cargo Driver',
    })
  ).value.id;
  for (const [client, email] of [
    [owner, 'split-owner@example.com'],
    [driver, 'split-original@example.com'],
    [replacement, 'split-replacement@example.com'],
    [broker, 'broker@acceptance.example'],
  ])
    await client('/api/login', 'POST', { email, password: secret });
  for (const id of [originalId, replacementId])
    await broker(`/api/drivers/${id}/approve`, 'POST', {});
  const id = (await owner('/api/shipments', 'POST', booking())).value.id;
  await apiAction(broker, id, 'quote', { price: 450, rate: 300 });
  await apiAction(owner, id, 'acceptQuote');
  await apiAction(broker, id, 'offer', { driverId: originalId });
  await apiAction(driver, id, 'acceptJob');
  await apiAction(owner, id, 'requestChange', {
    kind: 'quotation',
    details: 'Review price',
  });
  await apiAction(driver, id, 'pickup');
  await page.goto('/react/');
  await login(page, 'split-owner@example.com');
  await delivery(page);
  await page
    .getByLabel('Request details and reason', { exact: true })
    .fill('Receiving dock closed; return cargo');
  await page.getByRole('button', { name: 'Send request to broker', exact: true }).click();
  await expect(page.getByText('quotation · superseded', { exact: true })).toBeVisible();
  await page
    .getByLabel('Reason for withdrawing request', { exact: true })
    .fill('Receiving dock reopened; continue');
  await page
    .getByRole('button', { name: 'Withdraw pending request', exact: true })
    .click();
  await expect(page.getByText('cancellation · withdrawn', { exact: true })).toBeVisible();
  await logout(page);
  await apiAction(broker, id, 'handover', {
    driverId: replacementId,
    reason: 'Split the cargo trip',
  });
  await apiAction(replacement, id, 'acceptJob');
  await apiAction(replacement, id, 'deliver', {
    pod: 'SPLIT-PROOF',
    recipient: 'Receiving team',
  });
  await login(page, 'broker@acceptance.example');
  await nav(page, 'Billing');
  await page
    .getByRole('combobox', { name: 'Completed delivery', exact: true })
    .selectOption(id);
  await page
    .getByLabel('First Cargo Driver — allocated amount (CAD)', { exact: true })
    .fill('100');
  await page
    .getByLabel('First Cargo Driver — allocation reason', { exact: true })
    .fill('Pickup and first leg');
  await page
    .getByLabel('Final Cargo Driver — allocated amount (CAD)', { exact: true })
    .fill('200');
  await page
    .getByLabel('Final Cargo Driver — allocation reason', { exact: true })
    .fill('Final delivery leg');
  await page.getByRole('button', { name: 'Issue invoice', exact: true }).click();
  await expect(
    page.getByText('First Cargo Driver: allocated CAD 100.00', { exact: false }),
  ).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Entry type', exact: true })
    .selectOption('payout');
  await page
    .getByRole('combobox', {
      name: 'Payout recipient (used for payout and payoutRefund entries)',
      exact: true,
    })
    .selectOption(originalId);
  await page.getByLabel('Amount (CAD)', { exact: true }).fill('100');
  await page
    .getByLabel('Payment or adjustment reference', { exact: true })
    .fill('BANK-SPLIT');
  await page.getByLabel('Reason', { exact: true }).fill('Verified first driver transfer');
  await page.getByRole('button', { name: 'Record financial entry', exact: true }).click();
  await expect(
    page.getByText('Driver rate $300.00 · Paid out $100.00', { exact: true }),
  ).toBeVisible();
  expect((await driver('/api/settlements')).value[0].paidCents).toBe(10000);
  expect((await replacement('/api/settlements')).value[0].dueCents).toBe(20000);
  await logout(page);
  await login(page, 'split-original@example.com');
  await nav(page, 'Payouts');
  await expect(
    page.getByText('Allocation explanation: Pickup and first leg', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Allocated driver share: \$100\.00/)).toBeVisible();
  await expect(page.getByText(/Invoice total:/)).toHaveCount(0);
  await layout(page);
});

async function auditJob(app, prefix) {
  const owner = app.client(),
    driver = app.client(),
    broker = app.client();
  await owner(
    '/api/register',
    'POST',
    registration('store', `${prefix}-owner@example.com`),
  );
  const driverId = (
    await driver(
      '/api/register',
      'POST',
      registration('driver', `${prefix}-driver@example.com`),
    )
  ).value.id;
  for (const [client, email] of [
    [owner, `${prefix}-owner@example.com`],
    [driver, `${prefix}-driver@example.com`],
    [broker, 'broker@acceptance.example'],
  ])
    await client('/api/login', 'POST', { email, password: secret });
  await broker(`/api/drivers/${driverId}/approve`, 'POST', {});
  const id = (await owner('/api/shipments', 'POST', booking())).value.id;
  await apiAction(broker, id, 'quote', { price: 450, rate: 300 });
  await apiAction(owner, id, 'acceptQuote');
  await apiAction(broker, id, 'offer', { driverId });
  await apiAction(driver, id, 'acceptJob');
  return { owner, driver, broker, driverId, id };
}

test('new owner requests clear old approval drafts and return navigation skips unfinished stops', async ({
  page,
  app,
}) => {
  const f = await auditJob(app, 'request-scope');
  await apiAction(f.owner, f.id, 'requestChange', {
    kind: 'quotation',
    details: 'Review the price',
  });
  const request = (await f.broker('/api/state')).value.shipments[0].customerRequests[0];
  await page.goto('/react/');
  await login(page, 'broker@acceptance.example');
  await delivery(page);
  await page.getByLabel('Decision', { exact: true }).selectOption('approve');
  await page.getByLabel('Revised customer price (CAD)', { exact: true }).fill('420');
  await page.getByLabel('Driver rate (CAD)', { exact: true }).fill('300');
  await page
    .getByLabel('Broker explanation and instructions', { exact: true })
    .fill('Approve reduced price only');
  await apiAction(f.owner, f.id, 'withdrawRequest', {
    requestId: request.id,
    reason: 'Keep original price',
  });
  await apiAction(f.owner, f.id, 'requestChange', {
    kind: 'cancellation',
    details: 'New cancellation request',
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('cancellation · pending', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Decision', { exact: true })).toHaveValue('');
  await expect(
    page.getByLabel('Broker explanation and instructions', { exact: true }),
  ).toHaveValue('');
  await page.getByRole('button', { name: 'Send broker decision', exact: true }).click();
  expect((await f.broker('/api/state')).value.shipments[0].status).toBe('Assigned');
  await page.getByLabel('Decision', { exact: true }).selectOption('decline');
  await page
    .getByLabel('Broker explanation and instructions', { exact: true })
    .fill('Delivery still required');
  await page.getByRole('button', { name: 'Send broker decision', exact: true }).click();
  await expect(page.getByText('cancellation · declined', { exact: true })).toBeVisible();
  await logout(page);
  await apiAction(f.broker, f.id, 'setStops', {
    stops: [{ kind: 'dropoff', address: 'Unfinished customer dock', contact: 'Staff' }],
    reason: 'Add a customer stop',
  });
  await apiAction(f.broker, f.id, 'quote', { price: 450, rate: 300 });
  await apiAction(f.owner, f.id, 'acceptQuote');
  await apiAction(f.broker, f.id, 'offer', { driverId: f.driverId });
  await apiAction(f.driver, f.id, 'acceptJob');
  await apiAction(f.driver, f.id, 'pickup');
  await apiAction(f.broker, f.id, 'return', {
    reason: 'Return cargo without remaining deliveries',
  });
  await login(page, 'request-scope-driver@example.com');
  await delivery(page);
  const url = new URL(
    await page.getByRole('link', { name: 'Open route in maps' }).getAttribute('href'),
  );
  expect(url.searchParams.get('destination')).toBe('Warehouse address');
  expect(url.searchParams.get('waypoints')).toBe('');
  expect(url.searchParams.has('origin')).toBe(false);
  await expect(page.locator('.stop-timeline')).not.toContainText(
    'Unfinished customer dock',
  );
  await expect(page.locator('.stop-timeline')).toContainText('RETURN · PICKUP LOCATION');
  await layout(page);
});

test('rescue handover retains the exception hold and redelivery needs fresh attempt proof', async ({
  page,
  app,
}) => {
  const f = await auditJob(app, 'attempt-proof');
  await apiAction(f.driver, f.id, 'pickup');
  await attachDeliveryEvidence(f.driver, f.id);
  await apiAction(f.driver, f.id, 'issue', {
    reason: 'Truck broke down',
    note: 'Replacement needed',
  });
  const next = app.client(),
    email = 'rescue-browser@example.com';
  const nextId = (await next('/api/register', 'POST', registration('driver', email)))
    .value.id;
  await next('/api/login', 'POST', { email, password: secret });
  await f.broker(`/api/drivers/${nextId}/approve`, 'POST', {});
  await apiAction(f.broker, f.id, 'handover', {
    driverId: nextId,
    reason: 'Rescue cargo from broken truck',
  });
  await page.goto('/react/');
  await login(page, email);
  await nav(page, 'Job offers');
  await delivery(page);
  await expect(
    page.getByRole('button', { name: 'Accept handover', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Accept handover', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Confirm delivery', exact: true }),
  ).toHaveCount(0);
  await apiAction(f.broker, f.id, 'resolve', {
    resolution: 'Cargo transferred; receiving can proceed',
  });
  const eta = new Date(Date.now() + 3600000).toISOString();
  await f.broker(`/api/shipments/${f.id}/tracking`, 'PATCH', { eta });
  const link = (await f.owner(`/api/shipments/${f.id}/recipient-link`, 'POST', {})).value;
  await apiAction(next, f.id, 'failDelivery', {
    reason: 'Receiving dock closed',
    note: 'Arrange another attempt',
  });
  expect(
    (
      await app.client()('/api/recipient-tracking', 'POST', {
        token: new URL(link.url).hash.slice('#track='.length),
      })
    ).value.eta,
  ).toBe(null);
  await apiAction(f.broker, f.id, 'redeliver', {
    date: '2099-11-06',
    window: '09:00–12:00',
    deliveryDeadline: '',
    estimatedMinutes: 60,
    travelBufferMinutes: 15,
    reason: 'New receiving appointment',
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(
    page.getByRole('button', { name: 'Record arrival', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Record arrival', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Record arrival', exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel('Delivery receipt reference', { exact: true })
    .fill('ATTEMPT-TWO');
  await page.getByLabel('Received by', { exact: true }).fill('Receiving team');
  await page.getByRole('button', { name: 'Confirm delivery', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('Attach a delivery photo');
  await page.getByLabel('Photo, signature image, or document').setInputFiles({
    name: 'attempt-two.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\nCurrent attempt receipt'),
  });
  await page.getByRole('button', { name: 'Attach evidence file', exact: true }).click();
  await expect(
    page.getByRole('link', { name: 'attempt-two.pdf', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Confirm delivery', exact: true }).click();
  await status(page, 'Delivered');
  expect((await f.broker('/api/state')).value.shipments[0].deliveryEvidence.attempt).toBe(
    2,
  );
  await layout(page);
});
