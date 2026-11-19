import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers/app.mjs';

const book = [
  {
    label: 'Main warehouse',
    address: '12 Industrial Rd, Calgary',
    contact: 'Shipping desk',
  },
  { label: 'Store 7', address: '88 Main St, Calgary', contact: '' },
];

test('store saves an address book that is shown in the store state', async (t) => {
  const f = await setup(t);
  const res = await f.store('/api/saved-addresses', 'PATCH', { addresses: book });
  assert.equal(res.status, 200);
  const state = (await f.store('/api/state')).value;
  assert.deepEqual(state.user.profile.savedAddresses, book);
});

test('editing the main store profile keeps the saved addresses', async (t) => {
  const f = await setup(t);
  await f.store('/api/saved-addresses', 'PATCH', { addresses: book });
  const edit = await f.store('/api/profile', 'PATCH', {
    name: 'Renamed Store',
    phone: '403-555-0200',
    address: 'New address',
    contact: 'Receiving',
  });
  assert.equal(edit.status, 200);
  const state = (await f.store('/api/state')).value;
  assert.equal(state.user.profile.address, 'New address');
  assert.deepEqual(state.user.profile.savedAddresses, book);
});

test('saved addresses reject empty labels, too many entries and non-store accounts', async (t) => {
  const f = await setup(t);
  assert.equal(
    (
      await f.store('/api/saved-addresses', 'PATCH', {
        addresses: [{ label: '', address: 'x', contact: '' }],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.store('/api/saved-addresses', 'PATCH', {
        addresses: Array.from({ length: 21 }, (_, i) => ({
          label: `L${i}`,
          address: 'x',
          contact: '',
        })),
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.driver('/api/saved-addresses', 'PATCH', { addresses: [] })).status,
    403,
  );
});
