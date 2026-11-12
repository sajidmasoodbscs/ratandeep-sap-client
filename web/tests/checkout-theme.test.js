import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const theme = readdirSync(root).find(name => name.startsWith('theme_export__inkquestca-'));
const footer = readFileSync(`${root}/${theme}/sections/main-cart-footer.liquid`, 'utf8');
const embed = readFileSync(`${root}/extensions/real-time-pricing-clone/blocks/proxy-embded.liquid`, 'utf8');
const themeScript = footer.match(/<script>([\s\S]*?)<\/script>/)[1];
const appScript = embed.slice(embed.indexOf('    let checkoutNavigated'), embed.indexOf('      // Call SAP webhook')) + '\n});';

function setup(appFirst, shippingAccepted = true) {
  const listeners = [];
  const requests = [];
  const alerts = [];
  const shipping = { checked: shippingAccepted, focus() {} };
  const dropship = { checked: true, addEventListener() {} };
  const form = { id: 'cart', dataset: {}, requestSubmit(submitter) { dispatch('submit', form, submitter); } };
  const button = { tagName: 'BUTTON', id: 'checkout', form, getAttribute: name => name === 'name' ? 'checkout' : null, closest() { return this; } };
  function dispatch(type, target, submitter) {
    const event = { target, submitter, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    for (const capture of [true, false]) {
      for (const listener of listeners.filter(l => l.type === type && l.capture === capture)) {
        listener.fn(event);
        if (event.stopped) return event;
      }
    }
    return event;
  }
  const document = {
    addEventListener(type, fn, capture = false) { listeners.push({type, fn, capture}); },
    getElementById: id => ({cart: form, shipping_agree: shipping, dropship})[id],
    querySelectorAll: () => [],
  };
  const context = vm.createContext({ document, URL, console: {log(){},warn(){},error(){}},
    window: {Shopify: {routes: {root: '/'}}, location: {href: 'https://test.myshopify.com/cart', origin: 'https://test.myshopify.com', pathname: '/cart'}},
    alert: message => alerts.push(message), hideCheckoutLoader(){}, showCheckoutLoader(){},
    SAP_APP_PROXY: '/apps/sap-price-test', SHOP_DOMAIN: 'test.myshopify.com', CUSTOMER_ID: 1, CUSTOMER_ADDRESSES: [],
    setInterval: () => 1, clearInterval(){}, setTimeout: () => 2, clearTimeout(){},
    fetch: async (url, options) => {
      requests.push({url, options});
      return {ok: true, status: 200, json: async () => url.endsWith('cart.js') ? {items:[{sku:'INK'}]} : {jobId:'job'}};
    },
  });
  for (const script of appFirst ? [appScript, themeScript] : [themeScript, appScript]) vm.runInContext(script, context);
  dispatch('DOMContentLoaded', document);
  return {dispatch, button, form, requests, alerts, context};
}

for (const appFirst of [true, false]) {
  test(`validated checkout reaches SAP once (app registered first: ${appFirst})`, async () => {
    const env = setup(appFirst);
    env.dispatch('click', env.button);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(env.requests.map(r => r.url), ['/cart/update.js', '/cart.js', '/apps/sap-price-test/createDraftOrder']);
    assert.equal(JSON.parse(env.requests[0].options.body).attributes['Dropship Order'], 'Yes');
    assert.equal(JSON.parse(env.requests[2].options.body).data.customer_id, 1);
  });
}

test('shipping acknowledgement remains mandatory', async () => {
  const env = setup(true, false);
  env.dispatch('click', env.button);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.requests.length, 0);
  assert.match(env.alerts[0], /shipping charges acknowledgement/);
});

test('requestSubmit without a click also prepares SAP pricing', async () => {
  const env = setup(true);
  env.form.requestSubmit(env.button);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.requests.filter(r => r.url.endsWith('createDraftOrder')).length, 1);
});

test('VIEW CART link is not treated as checkout', () => {
  const env = setup(true);
  const link = {tagName:'A', href:'https://test.myshopify.com/cart', closest(){return this;}};
  assert.equal(vm.runInContext('isCheckoutElement', env.context)(link), false);
  link.href = 'https://test.myshopify.com/fr/checkout?discount=CODE';
  assert.equal(vm.runInContext('isCheckoutElement', env.context)(link), true);
});
