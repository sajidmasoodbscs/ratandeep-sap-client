import { DeliveryMethod } from "@shopify/shopify-api";
import shopify from "./shopify.js";
import { getCheckout } from "./helper/price-change-helper.js";
import { PriceChangeDB } from "./price-change-db.js";

const SAP_WEBHOOK_URL = "https://webhooks.appseconnectapi.com/52f38dc4-a9b1-4eab-b3fd-4ce3890e1b83/bc0958e5-c79b-429c-92c0-ccc370e6cff2_default";

/**
 * Call SAP webhook with all product SKUs from DB (no Redis). Uses default sold_to from settings or 1000.
 */
async function callSapWebhookWithAllProducts(shop) {
  const skus = await PriceChangeDB.getAllProductSKUs();
  if (!skus || skus.length === 0) {
    console.log("[Webhook ORDERS_CREATE] No SKUs in DB, skipping SAP call");
    return { ok: false, reason: "no_skus" };
  }
  let defaultSoldTo = 1000;
  try {
    const settings = await PriceChangeDB.Getsettings(shop);
    if (settings && settings[0] && settings[0].default_sold_to_number != null) {
      defaultSoldTo = Number(settings[0].default_sold_to_number) || 1000;
    }
  } catch (_) {}

  const productSkusXml = skus.map((sku, index) => `<item>
<id>${index + 1}</id>
<sku>${String(sku).trim()}</sku>
<qty>1</qty>
</item>`).join("\n");

  const xmlData = `<productPriceUpdateCollection>
<simulationid>2</simulationid>
<product_skus>
${productSkusXml}
</product_skus>
<customer>
<item>
<role>WE</role>
</item>
<item>
<role>AG</role>
<number>${defaultSoldTo}</number>
</item>
</customer>
</productPriceUpdateCollection>`;

  try {
    const response = await fetch(SAP_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: xmlData,
    });
    const text = await response.text();
    if (!response.ok) {
      console.error("[Webhook ORDERS_CREATE] SAP webhook failed:", response.status, text);
      return { ok: false, status: response.status, body: text };
    }
    console.log("[Webhook ORDERS_CREATE] SAP webhook called successfully, SKU count:", skus.length);
    return { ok: true, skuCount: skus.length, body: text };
  } catch (error) {
    console.error("[Webhook ORDERS_CREATE] SAP webhook error:", error.message);
    return { ok: false, error: error.message };
  }
}

export default {
  /**
   * When an order is placed, call SAP webhook with all product SKUs from DB (no Redis).
   */
  ORDERS_CREATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (topic, shop, body, webhookId) => {
      console.log("========== ORDERS_CREATE WEBHOOK FIRED ========== shop:", shop);
      const order = JSON.parse(body);
      console.log("[Webhook ORDERS_CREATE] Order placed — order id:", order.id, "shop:", shop);
      const result = await callSapWebhookWithAllProducts(shop);
      console.log("[Webhook ORDERS_CREATE] SAP call done — ok:", result?.ok, "skuCount:", result?.skuCount ?? "n/a");
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