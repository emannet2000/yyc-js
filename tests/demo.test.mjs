import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
function demo() {
  const element = {
    innerHTML: '',
    focus() {},
    after() {},
    prepend() {},
    querySelector() {
      return element;
    },
    scrollIntoView() {},
    setAttribute() {},
    appendChild() {},
  };
  const context = vm.createContext({
    Intl,
    Date,
    setTimeout: () => 0,
    clearTimeout() {},
    FormData: class {
      constructor(data) {
        this.data = data;
      }
      *[Symbol.iterator]() {
        yield* Object.entries(this.data);
      }
      get(key) {
        return this.data[key];
      }
    },
    document: {
      querySelector: () => element,
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => ({ ...element }),
    },
    window: { scrollTo() {} },
  });
  for (const file of ['app', 'dispatch', 'refine', 'experience'])
    vm.runInContext(
      readFileSync(new URL(`../public/demo/${file}.js`, import.meta.url), 'utf8'),
      context,
      { filename: file + '.js' },
    );
  const run = (source) => vm.runInContext(source, context);
  run(
    `render=()=>{};openDelivery=()=>{};toast=()=>{};refreshDelivery=(s,t)=>event(s,t);role='driver';`,
  );
  return run;
}
test('demo unresolved issue blocks completion in handler and UI; resolution allows completion', () => {
  const run = demo();
  run(`shipments[1].issue={reason:'Damaged cargo',note:'Hold',resolved:false};`);
  assert.doesNotMatch(run('controls(shipments[1])'), /onsubmit="completeDelivery/);
  run(
    `completeDelivery({preventDefault(){},target:{pod:'POD',recipient:'Receiver'}},shipments[1].id);`,
  );
  assert.equal(run('shipments[1].status'), 'In transit');
  run(
    `shipments[1].issue.resolved=true;completeDelivery({preventDefault(){},target:{pod:'POD',recipient:'Receiver'}},shipments[1].id);`,
  );
  assert.equal(run('shipments[1].status'), 'Delivered');
});
test('demo pickup clears current-leg arrival while preserving pickup arrival', () => {
  const run = demo();
  run(
    `shipments[1].status='Assigned';markArrival(shipments[1].id);transition(shipments[1].id,'pickup');`,
  );
  assert.equal(run('shipments[1].arrivedAt'), null);
  assert.equal(run('shipments[1].pickupArrivedAt'), 'pickup warehouse');
  assert.match(run('driverScreen()'), /Record arrival at store/);
  run('markArrival(shipments[1].id)');
  assert.equal(run('shipments[1].arrivedAt'), 'receiving store');
});
test('demo blocks overlapping offers and accepts, but permits another pickup window', () => {
  const run = demo();
  run(
    `role='admin';shipments[0].window=shipments[1].window;shipments[0].status='Ready to assign';transition(shipments[0].id,'offer');`,
  );
  assert.equal(run('shipments[0].status'), 'Ready to assign');
  run(
    `shipments[0].status='Offered';role='driver';transition(shipments[0].id,'acceptJob');`,
  );
  assert.equal(run('shipments[0].status'), 'Offered');
  run(
    `shipments[0].window='13:00–16:00';role='admin';shipments[0].status='Ready to assign';transition(shipments[0].id,'offer');role='driver';transition(shipments[0].id,'acceptJob');`,
  );
  // Seeded job is 13:00–16:00; same window remains blocked.
  assert.equal(run('shipments[0].status'), 'Ready to assign');
  run(
    `shipments[0].window='09:00–12:00';role='admin';transition(shipments[0].id,'offer');role='driver';transition(shipments[0].id,'acceptJob');`,
  );
  assert.equal(run('shipments[0].status'), 'Assigned');
});

test('demo rejects invalid quote amounts without changing data or history', () => {
  const run = demo();
  run(`role='admin';`);
  const before = run('JSON.stringify(shipments[0])');
  for (const [price, rate] of [
    ['100', '200'],
    ['-1', '1'],
    ['Infinity', '10'],
    ['NaN', '1'],
    ['100', '0'],
    ['0.001', '0.0005'],
    ['100', '1.005'],
  ]) {
    run(
      `sendQuote({preventDefault(){},target:{price:${JSON.stringify(price)},rate:${JSON.stringify(rate)}}},shipments[0].id);`,
    );
    assert.equal(run('JSON.stringify(shipments[0])'), before);
  }
  run(
    `sendQuote({preventDefault(){},target:{price:'100.50',rate:'80.25'}},shipments[0].id);`,
  );
  assert.equal(run('shipments[0].price'), 100.5);
  assert.equal(run('shipments[0].rate'), 80.25);
  assert.equal(run('shipments[0].status'), 'Quote ready');
  assert.equal(run('shipments[0].events.length'), JSON.parse(before).events.length + 1);
});

test('demo inputs require whole pallets and whole cents', () => {
  const run = demo();
  assert.match(run(`field('pallets','Pallets','number')`), /step="1"/);
  assert.match(run(`field('price','Price','number')`), /step="0.01"/);
});
