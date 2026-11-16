import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
let bundle;
function frontendBundle() {
  bundle ||= build({
    configFile: fileURLToPath(new URL('../../vite.config.ts', import.meta.url)),
    logLevel: 'silent',
    build: { write: false },
  }).then((result) => {
    const outputs = Array.isArray(result)
      ? result.flatMap((item) => item.output)
      : result.output;
    return outputs.find((output) => output.type === 'chunk' && output.isEntry).code;
  });
  return bundle;
}
export async function renderApp(t, client, options = {}) {
  const errors = [],
    console = new VirtualConsole();
  console.on('jsdomError', (error) => errors.push(error.message));
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      url: options.url || 'http://127.0.0.1:3000/react/',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
      virtualConsole: console,
    },
  );
  t.after(() => {
    dom.window.close();
    assert.deepEqual(errors, []);
  });
  let failRefresh = false;
  dom.window.fetch = async (path, options = {}) => {
    if (failRefresh && path === '/api/state') {
      failRefresh = false;
      return new Response(JSON.stringify({ error: 'Temporarily offline' }), {
        status: 503,
      });
    }
    const response = await client(
      path,
      options.method || 'GET',
      options.body ? JSON.parse(options.body) : undefined,
      {
        ...(options.headers || {}),
        'X-CSRF-Token': options.headers?.['X-CSRF-Token'] || '',
      },
    );
    return new Response(JSON.stringify(response.value), { status: response.status });
  };
  options.beforeRender?.(dom.window);
  dom.window.eval(await frontendBundle());
  const doc = dom.window.document;
  async function wait(predicate) {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
      if (Date.now() >= deadline)
        throw new Error(`DOM condition timed out: ${doc.body.textContent.slice(-1000)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  function button(label) {
    return [...doc.querySelectorAll('button')].find(
      (element) => element.textContent.trim() === label,
    );
  }
  async function drawer(selector = '[role="dialog"]') {
    await wait(() => button('View delivery →'));
    button('View delivery →').click();
    await wait(() => doc.querySelector(selector));
  }
  async function input(name, value) {
    const field = doc.querySelector(
      name.startsWith('#') ? name : `input[name="${name}"], select[name="${name}"]`,
    );
    field.focus();
    const prototype =
      field.tagName === 'SELECT'
        ? dom.window.HTMLSelectElement.prototype
        : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, value);
    field.dispatchEvent(
      new dom.window.Event(field.tagName === 'SELECT' ? 'change' : 'input', {
        bubbles: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  function detail(label) {
    const element = [...doc.querySelectorAll('summary')].find(
      (item) => item.textContent === label,
    );
    assert.ok(element, label);
    if (!element.parentElement.open) element.click();
  }
  return {
    doc,
    window: dom.window,
    wait,
    button,
    drawer,
    input,
    detail,
    failNextRefresh: () => {
      failRefresh = true;
    },
  };
}
