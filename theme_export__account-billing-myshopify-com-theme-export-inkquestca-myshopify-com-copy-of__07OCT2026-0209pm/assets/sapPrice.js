console.log('[sapPrice] Script loaded ✅');

document.addEventListener('DOMContentLoaded', async () => {
  console.log('[sapPrice] DOMContentLoaded fired');

  const customerId = document.querySelector('[data-customer-id]')?.dataset.customerId;
  console.log('[sapPrice] Customer ID:', customerId ?? 'NOT FOUND (guest or missing data attribute)');

  // Guest → show all Shopify prices immediately
  if (!customerId) {
    console.warn('[sapPrice] No customer ID → showing Shopify prices');
    document.querySelectorAll('[data-sku]').forEach(el => el.classList.add('sap-price-ready'));
    return;
  }

  const wrappers = document.querySelectorAll('[data-sku][data-customer-id]');
  console.log('[sapPrice] Price wrappers found:', wrappers.length);

  if (!wrappers.length) {
    console.warn('[sapPrice] No [data-sku] elements found → check your liquid wrapper');
    return;
  }

  const skus = [...new Set([...wrappers].map(el => el.dataset.sku).filter(Boolean))];
  console.log('[sapPrice] Unique SKUs to fetch:', skus);

  if (!skus.length) {
    console.warn('[sapPrice] SKUs array empty after filtering');
    wrappers.forEach(w => w.classList.add('sap-price-ready')); // fallback show
    return;
  }

  try {
    console.log('[sapPrice] Calling API...');

    const res = await fetch('https://ratandeep-sap-client.onrender.com/apps/sap-price-test/get-all-redis-pricing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ customerId, skus, shopUrl: window.location.origin })    });

    console.log('[sapPrice] API response status:', res.status);
    if (!res.ok) throw new Error(`API error: ${res.status}`);

    const { prices } = await res.json();
    console.log('[sapPrice] Prices from Redis:', prices);

    wrappers.forEach(wrapper => {
      const sku = wrapper.dataset.sku;
      const price = prices[sku];
      console.log(`[sapPrice] SKU: ${sku} → Redis price: ${price ?? 'null (keeping Shopify price)'}`);

      if (price !== null && price !== undefined) {
        const priceEl = wrapper.querySelector('.price-item--regular')
                     || wrapper.querySelector('.price__regular')
                     || wrapper.querySelector('.price-item');

        console.log(`[sapPrice] Price element for ${sku}:`, priceEl ?? 'NOT FOUND');

        if (priceEl) {
          priceEl.textContent = formatMoney(price);
          console.log(`[sapPrice] ✅ Updated ${sku} → ${formatMoney(price)}`);
        }
      }

      // ✅ Always reveal the price (Redis or Shopify fallback)
      wrapper.classList.add('sap-price-ready');
    });

    console.log('[sapPrice] ✅ All prices resolved');

  } catch (e) {
    console.error('[sapPrice] ❌ API failed, revealing Shopify prices as fallback:', e);
    // Show all Shopify prices if API crashes
    wrappers.forEach(w => w.classList.add('sap-price-ready'));
  }
});