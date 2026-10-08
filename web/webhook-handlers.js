import { DeliveryMethod } from "@shopify/shopify-api";
import shopify from "./shopify.js";
import { getCheckout } from "./helper/price-change-helper.js";
import { PriceChangeDB } from "./price-change-db.js";
import {
  buildSapRootCustomerXml,
  normalizeShopifyCustomerId,
  postSapWebhookForCustomer,
  touchSapCustomer,
} from "./helper/sap-api.js";
import {
  createRedisClient,
  getRedisConfigFromEnv,
  getRedisPricesForSkus,
  pollRedisForPrices,
} from "./helper/redis-pricing.js";

/**
 * Redis-first: check all product SKUs for the order customer in Redis.
 * Call SAP only on miss, then poll Redis (same pattern as proxy pricing routes).
 */
async function ensureSapPricesAfterOrder(shop, order) {
  const skus = await PriceChangeDB.getAllProductSKUs();
  if (!skus || skus.length === 0) {
    console.log("[Webhook ORDERS_CREATE] No SKUs in DB, skipping SAP call");
    return { ok: false, reason: "no_skus" };
  }

  const shopifyCustomerId = normalizeShopifyCustomerId(order?.customer?.id);
  if (!shopifyCustomerId) {
    console.log("[Webhook ORDERS_CREATE] No customer on order — skipping SAP (cannot key Redis)");
    return { ok: false, reason: "no_customer" };
  }

  await touchSapCustomer(shopifyCustomerId);

  const redisConfig = getRedisConfigFromEnv();
  if (!redisConfig) {
    console.warn("[Webhook ORDERS_CREATE] Redis not configured — skipping SAP");
    return { ok: false, reason: "redis_not_configured" };
  }

  const redis = createRedisClient(redisConfig);
  let priceMap = {};
  try {
    const result = await getRedisPricesForSkus(redis, shopifyCustomerId, skus);
    priceMap = result.priceMap || {};
  } finally {
    try {
      await redis.quit();
    } catch (_) {}
  }

  const missingSkus = skus
    .map((sku) => String(sku).trim())
    .filter((sku) => sku && priceMap[sku] === undefined);

  if (missingSkus.length === 0) {
    console.log(
      `[Webhook ORDERS_CREATE] Redis has data for all ${skus.length} SKUs — skipping SAP webhook`
    );
    return {
      ok: true,
      skipped: true,
      reason: "redis_cache_hit",
      skuCount: skus.length,
    };
  }

  console.log(
    `[Webhook ORDERS_CREATE] ${missingSkus.length} of ${skus.length} SKUs missing in Redis. Calling SAP...`
  );

  const xmlData = buildSapRootCustomerXml(shopifyCustomerId);
  const { ok, skipped, reason, status, text, secondsRemaining } =
    await postSapWebhookForCustomer(shopifyCustomerId, xmlData, "ORDERS_CREATE");

  if (skipped) {
    console.log(
      `[Webhook ORDERS_CREATE] SAP skipped (${reason}) — Redis still readable`,
      secondsRemaining ? `${secondsRemaining}s left` : ""
    );
    return {
      ok: true,
      skipped: true,
      reason,
      secondsRemaining,
      skuCount: skus.length,
      missingCount: missingSkus.length,
    };
  }

  if (!ok) {
    console.error("[Webhook ORDERS_CREATE] SAP webhook failed:", status, text);
    return { ok: false, status, body: text, skuCount: skus.length, missingCount: missingSkus.length };
  }

  console.log("[Webhook ORDERS_CREATE] SAP webhook ok — polling Redis for missing SKUs");
  await pollRedisForPrices(shopifyCustomerId, missingSkus);

  return {
    ok: true,
    skipped: false,
    skuCount: skus.length,
    missingCount: missingSkus.length,
  };
}

export default {
  /**
   * When an order is placed: Redis first, SAP only if prices are missing, then poll Redis.
   */
  ORDERS_CREATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (topic, shop, body, webhookId) => {
      console.log("========== ORDERS_CREATE WEBHOOK FIRED ========== shop:", shop);
      const order = JSON.parse(body);
      console.log(
        "[Webhook ORDERS_CREATE] Order placed — order id:",
        order.id,
        "customer:",
        order?.customer?.id,
        "shop:",
        shop
      );
      const result = await ensureSapPricesAfterOrder(shop, order);
      console.log(
        "[Webhook ORDERS_CREATE] done — ok:",
        result?.ok,
        "skipped:",
        result?.skipped ?? false,
        "reason:",
        result?.reason ?? "n/a",
        "skuCount:",
        result?.skuCount ?? "n/a",
        "missingCount:",
        result?.missingCount ?? "n/a"
      );
      console.log("========== ORDERS_CREATE WEBHOOK FINISHED ==========");
    },
  },

  /**
   * Customers can request their data from a store owner. When this happens,
   * Shopify invokes this webhook.
   *
   * https://shopify.dev/docs/apps/webhooks/configuration/mandatory-webhooks#customers-data_request
   */
  CUSTOMERS_DATA_REQUEST: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (topic, shop, body, webhookId) => {
      const payload = JSON.parse(body);
      // Payload has the following shape:
      // {
      //   "shop_id": 954889,
      //   "shop_domain": "{shop}.myshopify.com",
      //   "orders_requested": [
      //     299938,
      //     280263,
      //     220458
      //   ],
      //   "customer": {
      //     "id": 191167,
      //     "email": "john@example.com",
      //     "phone": "555-625-1199"
      //   },
      //   "data_request": {
      //     "id": 9999
      //   }
      // }
    },
  },
  // PRODUCTS_UPDATE: {

  //   deliveryMethod: DeliveryMethod.Http,

  //   callbackUrl: "/api/webhooks",

  //   callback: async (topic, shop, body, webhookId) => {

  //     console.log('--- Product update ---');

  //     console.log('DeliveryMethod is', DeliveryMethod);

  //     const payload = JSON.parse(body);

  //     console.log(payload);

  //     console.log('--- /Product update ---');

  //   },
  // },

  //   CARTS_UPDATE: {

  //   deliveryMethod: DeliveryMethod.Http,

  //   callbackUrl: "/api/webhooks",

  //   callback: async (topic, shop, body, webhookId) => {

  //     console.log('--- Carts update start---');

  //     console.log('DeliveryMethod is', DeliveryMethod);

  //     // const payload = JSON.parse(body);
      
  //     // const cartUpdate= variantCreate(shop,payload)
       
  //     // console.log("Update Cart Function Called",cartUpdate);

  //     console.log('--- Carts update end---');
  //   },
  // },


  // CHECKOUTS_CREATE: {

  //   deliveryMethod: DeliveryMethod.Http,

  //   callbackUrl: "/api/webhooks",

  //   callback: async (topic, shop, body, webhookId) => {

  //     console.log('--- Checkout create ---');

  //     console.log('DeliveryMethod is', DeliveryMethod);

  //     const payload = JSON.parse(body);
  //           //  console.log(payload);


  //     // console.log("Shop :",shop);
  //     // console.log("Token :",payload.cart_token);


  //     // const response = getCheckout(shop,payload.token,payload.cart_token,payload.email,payload);
  //     // console.log("Webhook called successfully =>:",response);


  //     // Session is built by the OAuth process

  //     // console.log(payload);

  //     console.log('--- /Checkouts create ---');

  //   },
  // },



  /**
   * Store owners can request that data is deleted on behalf of a customer. When
   * this happens, Shopify invokes this webhook.
   *
   * https://shopify.dev/docs/apps/webhooks/configuration/mandatory-webhooks#customers-redact
   */
  CUSTOMERS_REDACT: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (topic, shop, body, webhookId) => {
      const payload = JSON.parse(body);
      // Payload has the following shape:
      // {
      //   "shop_id": 954889,
      //   "shop_domain": "{shop}.myshopify.com",
      //   "customer": {
      //     "id": 191167,
      //     "email": "john@example.com",
      //     "phone": "555-625-1199"
      //   },
      //   "orders_to_redact": [
      //     299938,
      //     280263,
      //     220458
      //   ]
      // }
    },
  },

  /**
   * 48 hours after a store owner uninstalls your app, Shopify invokes this
   * webhook.
   *
   * https://shopify.dev/docs/apps/webhooks/configuration/mandatory-webhooks#shop-redact
   */
  SHOP_REDACT: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (topic, shop, body, webhookId) => {
      const payload = JSON.parse(body);
      // Payload has the following shape:
      // {
      //   "shop_id": 954889,
      //   "shop_domain": "{shop}.myshopify.com"
      // }
    },
  },
};