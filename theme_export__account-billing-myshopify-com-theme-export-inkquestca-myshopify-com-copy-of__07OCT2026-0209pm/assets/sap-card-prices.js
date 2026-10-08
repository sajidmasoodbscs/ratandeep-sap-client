/**
 * Collection / search / related product card SAP prices.
 * Survives Facets filter AJAX: inline <script> in replaced HTML does not re-run,
 * so we hydrate via data attributes + MutationObserver / section events.
 */
(function () {
  'use strict';

  var cfg = window.SAP_CARD_PRICES || {};
  var API_BASE = cfg.apiBase || 'https://ratandeep-sap-client.onrender.com/apps/sap-price-test';
  var CUSTOMER_ID = cfg.customerId;
  var SHOP = cfg.shop || (window.Shopify && window.Shopify.shop) || '';
  var MONEY_FORMAT =
    cfg.moneyFormat ||
    (window.Shopify && window.Shopify.money_format) ||
    '${{amount}}';

  var hydrateTimer = null;
  var inFlight = false;
  var queued = false;

  function ensureStyles() {
    if (document.getElementById('sap-card-price-styles')) return;
    var style = document.createElement('style');
    style.id = 'sap-card-price-styles';
    style.textContent =
      '.sap-card-price{min-height:24px;display:flex;align-items:center;font-weight:700;font-size:14px}' +
      '.sap-price-loader{display:inline-block;width:55px;height:18px;border-radius:4px;' +
      'background:linear-gradient(90deg,#eee 25%,#ddd 50%,#eee 75%);background-size:200% 100%;' +
      'animation:sapPriceLoading 1.2s infinite}' +
      '@keyframes sapPriceLoading{0%{background-position:200% 0}100%{background-position:-200% 0}}';
    document.head.appendChild(style);
  }

  function formatMoney(dollars) {
    var cents = Math.round(Number(dollars) * 100);
    if (!Number.isFinite(cents)) return '';
    if (window.Shopify && typeof window.Shopify.formatMoney === 'function') {
      try {
        return window.Shopify.formatMoney(cents, MONEY_FORMAT);
      } catch (e) {}
    }
    return '$' + (cents / 100).toFixed(2);
  }

  function showShopify(el) {
    if (!el) return;
    var money = el.getAttribute('data-shopify-money') || '';
    el.innerHTML =
      '<span class="price-item price-item--regular">' + money + '</span>';
    el.classList.remove('sap-price-loading');
    el.setAttribute('data-sap-hydrated', '1');
  }

  function showPrice(el, dollars) {
    if (!el) return;
    el.innerHTML =
      '<span class="price-item price-item--regular">' +
      formatMoney(dollars) +
      '</span>';
    el.classList.remove('sap-price-loading');
    el.setAttribute('data-sap-hydrated', '1');
  }

  function resolveDisplayPrice(redisPrice, shopifyCents) {
    var shopifyDollars =
      shopifyCents != null && shopifyCents !== ''
        ? Number(shopifyCents) / 100
        : NaN;
    var n = Number(redisPrice);
    if (!Number.isFinite(n) || n <= 0) {
      return Number.isFinite(shopifyDollars) ? shopifyDollars : null;
    }
    if (Number.isFinite(shopifyDollars) && n >= shopifyDollars) {
      return shopifyDollars;
    }
    return n;
  }

  function pendingCards(root) {
    var scope = root && root.querySelectorAll ? root : document;
    return Array.prototype.slice.call(
      scope.querySelectorAll('[data-sap-card-price]:not([data-sap-hydrated])')
    );
  }

  async function fetchRedisPrices(skus) {
    var res = await fetch(API_BASE + '/redis-prices', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        customerId: CUSTOMER_ID,
        skus: skus,
        shop: SHOP,
      }),
    });
    if (!res.ok) throw new Error('redis-prices ' + res.status);
    var data = await res.json();
    return data.prices || {};
  }

  async function triggerSapLoad(skus) {
    try {
      await fetch(API_BASE + '/sapcall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: {
            items: skus.map(function (sku) {
              return { sku: sku, quantity: 1 };
            }),
            customer_id: CUSTOMER_ID,
            shop: SHOP,
          },
        }),
      });
    } catch (e) {
      console.warn('[SAP cards] sapcall failed:', e);
    }
  }

  async function hydrateOnce(root) {
    ensureStyles();

    if (!CUSTOMER_ID) {
      pendingCards(root).forEach(showShopify);
      return;
    }

    var cards = pendingCards(root);
    if (!cards.length) return;

    var skus = [];
    cards.forEach(function (el) {
      var sku = (el.getAttribute('data-sku') || '').trim();
      if (!sku) {
        showShopify(el);
        return;
      }
      if (skus.indexOf(sku) === -1) skus.push(sku);
    });

    if (!skus.length) return;

    var priceMap = {};
    try {
      priceMap = await fetchRedisPrices(skus);
    } catch (e) {
      console.warn('[SAP cards] redis-prices failed, showing Shopify:', e);
      cards.forEach(showShopify);
      return;
    }

    var missing = skus.filter(function (sku) {
      var p = priceMap[sku];
      return p === undefined || p === null || !(Number(p) > 0);
    });

    if (missing.length) {
      await triggerSapLoad(missing);
      try {
        var again = await fetchRedisPrices(missing);
        Object.keys(again).forEach(function (sku) {
          priceMap[sku] = again[sku];
        });
      } catch (e) {
        console.warn('[SAP cards] redis refresh after SAP failed:', e);
      }
    }

    cards.forEach(function (el) {
      if (el.getAttribute('data-sap-hydrated')) return;
      var sku = (el.getAttribute('data-sku') || '').trim();
      if (!sku) {
        showShopify(el);
        return;
      }
      var shopifyCents = el.getAttribute('data-shopify-cents');
      var finalPrice = resolveDisplayPrice(priceMap[sku], shopifyCents);
      if (finalPrice == null) {
        showShopify(el);
        return;
      }
      var shopifyDollars =
        shopifyCents != null && shopifyCents !== ''
          ? Number(shopifyCents) / 100
          : NaN;
      // Prefer preformatted Shopify money when we kept catalog price (locale/currency exact)
      if (
        Number.isFinite(shopifyDollars) &&
        Math.abs(finalPrice - shopifyDollars) < 0.005
      ) {
        showShopify(el);
        return;
      }
      showPrice(el, finalPrice);
    });
  }

  function scheduleHydrate(root) {
    queued = true;
    if (hydrateTimer) clearTimeout(hydrateTimer);
    hydrateTimer = setTimeout(function () {
      hydrateTimer = null;
      runHydrate(root || document);
    }, 80);
  }

  async function runHydrate(root) {
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    queued = false;
    try {
      await hydrateOnce(root);
    } catch (e) {
      console.error('[SAP cards] hydrate error:', e);
      pendingCards(root).forEach(showShopify);
    } finally {
      inFlight = false;
      if (queued) scheduleHydrate(document);
    }
  }

  function observeGrids() {
    var targets = [
      document.getElementById('ProductGridContainer'),
      document.getElementById('product-grid'),
      document.getElementById('MainContent'),
    ].filter(Boolean);

    if (!targets.length) return;

    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (!m.addedNodes || !m.addedNodes.length) continue;
        for (var j = 0; j < m.addedNodes.length; j++) {
          var node = m.addedNodes[j];
          if (node.nodeType !== 1) continue;
          if (
            node.matches &&
            (node.matches('[data-sap-card-price]') ||
              node.querySelector('[data-sap-card-price]'))
          ) {
            scheduleHydrate(document);
            return;
          }
        }
      }
    });

    targets.forEach(function (el) {
      observer.observe(el, { childList: true, subtree: true });
    });
  }

  function patchFacetsRender() {
    // Dawn Facets replaces ProductGridContainer via innerHTML (scripts do not run).
    // Hook render so prices hydrate after every filter/sort.
    if (
      typeof window.FacetFiltersForm === 'undefined' ||
      !window.FacetFiltersForm.renderProductGridContainer
    ) {
      return;
    }
    if (window.FacetFiltersForm.__sapCardPricesPatched) return;
    var original = window.FacetFiltersForm.renderProductGridContainer.bind(
      window.FacetFiltersForm
    );
    window.FacetFiltersForm.renderProductGridContainer = function (html) {
      original(html);
      scheduleHydrate(document);
    };
    window.FacetFiltersForm.__sapCardPricesPatched = true;
  }

  function boot() {
    ensureStyles();
    scheduleHydrate(document);
    observeGrids();
    patchFacetsRender();
    // Facets class may load after us (both defer) — retry briefly
    setTimeout(patchFacetsRender, 500);
    setTimeout(patchFacetsRender, 2000);

    document.addEventListener('shopify:section:load', function () {
      scheduleHydrate(document);
    });

    // Facets / collection filter history updates
    window.addEventListener('popstate', function () {
      scheduleHydrate(document);
    });

    // Safety: never leave loaders spinning if something raced
    setTimeout(function () {
      pendingCards(document).forEach(showShopify);
    }, 12000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // Expose for manual re-run after custom theme AJAX
  window.hydrateSapCardPrices = function () {
    scheduleHydrate(document);
  };
})();
