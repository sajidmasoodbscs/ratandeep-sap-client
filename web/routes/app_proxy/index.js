import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import Redis from 'ioredis';
import { getCheckout, getSession } from '../../helper/price-change-helper.js';
import { PriceChangeDB } from '../../price-change-db.js';

const proxyRouter = Router();
const jobs = {};

/** Redis connection from REDIS_STRING (e.g. redis://user:pass@host:port). Shop is ignored. */
function getRedisConfigForShop(_shop) {
  const redisString = process.env.REDIS_STRING?.trim();
  if (!redisString) {
    console.warn("[Proxy] REDIS_STRING environment variable is not set");
    return null;
  }
  try {
    const url = new URL(redisString);
    if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
      console.error("[Proxy] REDIS_STRING must use redis:// or rediss://");
      return null;
    }
    const port = url.port ? parseInt(url.port, 10) : 6379;
    if (!url.hostname || Number.isNaN(port)) return null;
    return {
      host: url.hostname,
      port,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      username: url.username ? decodeURIComponent(url.username) : undefined,
      ...(url.protocol === "rediss:" ? { tls: {} } : {}),
      retryStrategy: (times) => Math.min(times * 50, 2000),
      maxRetriesPerRequest: 3,
    };
  } catch (e) {
    console.error("[Proxy] Failed to parse REDIS_STRING:", e.message);
    return null;
  }
}

function createRedisClient(config) {
  return new Redis(config);
}

async function getSapCustomerId(session, custId) {
  const url = `https://${session.shop}/admin/api/2023-07/metafields.json?metafield[owner_id]=${custId}&metafield[owner_resource]=customers`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": session.accessToken,
        "Content-Type": "application/json",
      },
    });

    console.log(`[Local getSapCustomerId] Using session token: ${session.accessToken}`);

    if (!response.ok) {
      console.log("[Local getSapCustomerId] Error in get meta field:", response.status);
      return null;
    }

    const customerMetaFields = await response.json();
    const metafields = customerMetaFields.metafields || [];
    console.log(`[Local getSapCustomerId] Received ${metafields.length} metafields for customer ${custId}`);
    const sapMetafield = metafields.find(m => m.key === 'sap_account_number' || m.key === 'customerid' || m.key === process.env.SOLD_TO_NUMBER);

    if (sapMetafield && sapMetafield.value) {
      console.log(`[Local getSapCustomerId] Found SAP Customer ID: ${sapMetafield.value} in metafield ${sapMetafield.key}`);
      return sapMetafield.value;
    }

    console.log(`[Local getSapCustomerId] SAP Customer ID NOT found in metafields: ${JSON.stringify(metafields.map(m => m.key))}`);
    return null;
  } catch (error) {
    console.error("[Local getSapCustomerId] Error fetching customer metafields:", error.message);
    return null;
  }
}

function normalizeShop(shop) {
  if (!shop || typeof shop !== 'string') return null;
  let normalized = shop.replace(/^https?:\/\//, '');
  normalized = normalized.replace(/\/$/, '');
  return normalized;
}

function extractShop(req, res) {
  const rawShop =
    (res && res.locals && res.locals.user_shop) ||
    req.query.shop ||
    req.body?.shop ||
    req.body?.data?.shop ||
    req.body?.customer?.shop ||
    req.body?.shopUrl ||
    req.body?.data?.shopUrl ||
    req.body?.customer?.shopUrl;
  if (rawShop) return normalizeShop(rawShop);
  const referer = req.get("Referer") || req.get("Origin") || "";
  if (referer) {
    try {
      const u = new URL(referer);
      const host = u.hostname;
      if (host.endsWith(".myshopify.com")) return normalizeShop(host);
    } catch (_) {}
  }
  return null;
}

async function getRedisPricesForSkus(redis, customerId, skuList) {
  const priceMap = {};
  if (!skuList || skuList.length === 0) {
    return { allFound: true, priceMap };
  }
  try {
    for (const sku of skuList) {
      let s = '';
      if (typeof sku === 'string') {
        s = sku.trim();
      } else if (sku && sku.sku) {
        s = sku.sku.trim();
      }
      if (!s) continue;
      const price = await redis.get(`${customerId}_${s}`);
      if (price !== null && price !== undefined) {
        priceMap[s] = parseFloat(price);
      }
    }

    const requested = skuList.map(sku => {
      if (typeof sku === 'string') return sku.trim();
      if (sku && sku.sku) return sku.sku.trim();
      return '';
    }).filter(Boolean);

    const allFound = requested.length > 0 && requested.every(s => priceMap[s] !== undefined);
    return { allFound, priceMap };
  } catch (error) {
    console.error(`[Redis] Error getting prices for customer ${customerId}:`, error.message);
    return { allFound: false, priceMap, error: error.message };
  }
}

async function pollRedisForPrices(shop, customerId, skuList, maxRetries = 3, interval = 2000) {
  const config = getRedisConfigForShop(shop);
  if (!config) {
    console.warn("[Redis Polling] REDIS_STRING is not configured");
    return { allFound: false, priceMap: {} };
  }
  const redis = createRedisClient(config);
  try {
    for (let i = 0; i < maxRetries; i++) {
      const { allFound, priceMap } = await getRedisPricesForSkus(redis, customerId, skuList);
      if (allFound) {
        console.log(`[Redis Polling] All prices found for customer ${customerId} on attempt ${i + 1}`);
        return { allFound, priceMap };
      }
      console.log(`[Redis Polling] Attempt ${i + 1}/${maxRetries}: Missing prices for customer ${customerId}. Retrying in ${interval}ms...`);
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, interval));
      }
    }
    return await getRedisPricesForSkus(redis, customerId, skuList);
  } catch (error) {
    console.error("[Redis Polling] Error:", error.message);
    return { allFound: false, priceMap: {} };
  } finally {
    try {
      await redis.quit();
    } catch (e) {
      console.error("[Redis Polling] Error quitting redis:", e.message);
    }
  }
}
proxyRouter.get("/testapi", async (req, res) => {
  console.log("Query parameters from front end => ", req.query);
  console.log("Output from the json!");
  return res.status(200).send({
    content:
      "https://anninonlinesandbox.myshopify.com/87819387194/checkouts/e8bb336e6478fa2a3daef45cc545b223?key=48a23962d48d6d5c1278c151f62f7120",
  });
});

proxyRouter.post("/createDraftOrder", async (req, res) => {
  const jobId = uuidv4();
  jobs[jobId] = { status: "pending", redirectUrl: null };
  console.log("Query parameters from front end => ", req.query);
  res.status(200).send({ jobId: jobId });

  try {
    const shop = extractShop(req, res);
    console.log(`[Proxy] /createDraftOrder hit. Shop: ${shop}`);
    const response = await getCheckout(shop, req.body);
    jobs[jobId] = {
      status: "completed",
      redirectUrl: response,
    };
    console.log("jobs:", jobs)
    console.log(`Job ${jobId} completed. Redirect URL: ${response}`);
  } catch (error) {
    jobs[jobId] = {
      status: "failed",
      redirectUrl: "/cart",
      error: error.message,
    };
    console.error(`Job ${jobId} failed:`, error.message);
  }
});

proxyRouter.post("/check-checkout-url", (req, res) => {
  console.log("calling for job status", req.body.jobId);

  const jobId = req.body.jobId;
  if (!jobId) {
    return res.status(400).send({ error: "Job ID is required" });
  }

  const job = jobs[jobId];

  if (!job) {
    return res.status(404).send({ error: "Job not found" });
  }

  if (job.status === "completed" || job.status === "failed") {
    res.status(200).send({ status: job.status, redirectUrl: job.redirectUrl, error: job.error });
  } else {
    res.status(200).send({ status: job.status });
  }
});

proxyRouter.post("/sapcall", async (req, res) => {
  try {
    console.log("===== /SAPCALL ENDPOINT HIT =====");
    console.log("Request Body:", req.body);

    const requestData = req.body.data || req.body;
    const cartItems = requestData.items || [];
    const customerAddresses = requestData.customer_addresses || [];

    if (!cartItems || cartItems.length === 0) {
      return res.status(400).json({ message: "Invalid cart data - no items found" });
    }

    const validItems = cartItems
      .map((item) => {
        const sku = item.sku || item.variant_sku || item.variant?.sku || '';
        const quantity = item.quantity || item.qty || 1;
        return { sku: sku.trim(), quantity };
      })
      .filter((item) => {
        if (!item.sku || item.sku.length === 0) {
          console.log(`Skipping item - no SKU found:`, item);
          return false;
        }
        return true;
      });

    if (validItems.length === 0) {
      return res.status(400).json({
        message: "No valid items found - all items are missing SKUs",
        totalItems: cartItems.length,
        validItems: 0
      });
    }

    console.log(`Processing ${validItems.length} valid items out of ${cartItems.length} total items`);

    const defaultAddress = customerAddresses.find(addr => addr.default) || customerAddresses[0] || {};

    const address1 = (defaultAddress.address1 || defaultAddress.address || '').trim();
    const city = (defaultAddress.city || '').trim();
    const zip = (defaultAddress.zip || defaultAddress.zip_code || '').trim();
    const provinceCode = (defaultAddress.province_code || defaultAddress.province || defaultAddress.state_code || '').trim();
    const countryCode = (defaultAddress.country_code || defaultAddress.country || '').trim();

    const shop = extractShop(req, res);
    const shopifyCustId = requestData.customer_id;

    console.log(`[Proxy] /sapcall hit. Shop: ${shop}, Shopify Customer ID: ${shopifyCustId}`);

    if (!shop || !shopifyCustId) {
      console.log("[Proxy] /sapcall error: Missing shop or customer_id", { shop, shopifyCustId });
      return res.status(400).json({ message: "Shop and customer_id are required" });
    }

    const sessionRes = await getSession(shop);
    if (!sessionRes.flag || !sessionRes.session) {
      return res.status(500).json({ message: "Session not found for shop" });
    }

    const customerId = await getSapCustomerId(sessionRes.session, shopifyCustId);

    if (!customerId) {
      console.log(`[Proxy] SAP Customer ID lookup failed for Shopify customer ${shopifyCustId}`);
      return res.status(400).json({ message: "SAP Customer ID not found for this customer" });
    }

    console.log(`[Proxy] Successfully resolved Shopify customer ${shopifyCustId} to SAP ID: ${customerId}`);

    const redisConfig = getRedisConfigForShop(shop);
    if (!redisConfig) {
      return res.status(503).json({ message: "Redis not configured for this shop. Set credentials in the app." });
    }
    const cartSkus = validItems.map((item) => item.sku);
    const redis = createRedisClient(redisConfig);
    const { priceMap } = await getRedisPricesForSkus(redis, customerId, cartSkus);
    await redis.quit();

    const itemsMissingInRedis = validItems.filter(item => priceMap[item.sku] === undefined || priceMap[item.sku] === null);

    if (itemsMissingInRedis.length === 0) {
      console.log(`[Proxy] /sapcall: Redis has data for all ${cartSkus.length} SKUs, skipping SAP webhook`);
      const skus = validItems.map((item) => ({ sku: item.sku, quantity: item.quantity }));
      return res.status(200).json({
        message: "SAP webhook skipped (Redis cache hit)",
        skus,
        customerId,
        webhookResponse: "[cache]",
      });
    }

    console.log(`[Proxy] /sapcall: ${itemsMissingInRedis.length} of ${validItems.length} items missing in Redis. Calling SAP for missing items.`);
    let productSkusXml = '';
    itemsMissingInRedis.forEach((item, index) => {
      productSkusXml += `<item>
<id>${index + 1}</id>
<sku>${item.sku}</sku>
<qty>${item.quantity}</qty>
</item>`;
    });

    let customerWeItemXml = '<item>\n<role>WE</role>';

    if (address1) {
      customerWeItemXml += `\n<address1>${address1}</address1>`;
    }
    if (city) {
      customerWeItemXml += `\n<city>${city}</city>`;
    }
    if (zip) {
      customerWeItemXml += `\n<zip>${zip}</zip>`;
    }
    if (provinceCode) {
      customerWeItemXml += `\n<province_code>${provinceCode}</province_code>`;
    }
    if (countryCode) {
      customerWeItemXml += `\n<country_code>${countryCode}</country_code>`;
    }

    customerWeItemXml += '\n</item>';

    const xmlData = `<productPriceUpdateCollection>
<simulationid>2</simulationid>
<product_skus>
${productSkusXml}
</product_skus>
<customer>
${customerWeItemXml}
<item>
<role>AG</role>
<number>${customerId}</number>
</item>
</customer>
</productPriceUpdateCollection>`;

    console.log("Generated XML (full):", xmlData);

    const response = await fetch(
      "https://webhooks.appseconnectapi.com/52f38dc4-a9b1-4eab-b3fd-4ce3890e1b83/bc0958e5-c79b-429c-92c0-ccc370e6cff2_default",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/xml",
        },
        body: xmlData,
      }
    );

    const responseText = await response.text();

    if (response.ok) {
      console.log(`[Proxy] /sapcall: Webhook successful. Now polling Redis for ${itemsMissingInRedis.length} missing prices...`);
      await pollRedisForPrices(shop, customerId, itemsMissingInRedis.map(i => i.sku));
    } else {
      console.warn(`[Proxy] /sapcall: Webhook returned non-OK status: ${response.status}`);
    }

    const skus = validItems.map(item => ({
      sku: item.sku,
      quantity: item.quantity
    }));

    return res.status(200).json({
      message: "SAP webhook called successfully",
      skus: skus,
      customerId: customerId,
      webhookResponse: responseText,
    });
  } catch (error) {
    console.error("SAP call error:", error.message);
    return res.status(500).json({
      message: "Error calling SAP webhook",
      error: error.message,
    });
  }
});

proxyRouter.all("/get-all-redis-pricing", async (req, res) => {
  try {
    console.log("===== /GET-REDIS-PRICING ENDPOINT HIT =====");
    const shop = extractShop(req, res);
    const shopifyCustId = req.body?.customerId || req.query?.customerId;

    console.log(`[Proxy] /get-all-redis-pricing hit. Shop: ${shop}, Shopify Customer ID: ${shopifyCustId}`);

    if (!shop || !shopifyCustId) {
      console.log("[Proxy] /get-all-redis-pricing error: Missing shop or customerId", { shop, shopifyCustId });
      return res.status(400).json({ message: "Shop and customerId are required" });
    }

    const sessionRes = await getSession(shop);
    if (!sessionRes.flag || !sessionRes.session) {
      return res.status(500).json({ message: "Session not found" });
    }

    const customerId = await getSapCustomerId(sessionRes.session, shopifyCustId);
    if (!customerId) {
      console.log(`[Proxy] /get-all-redis-pricing: SAP ID not found for ${shopifyCustId}`);
      return res.status(400).json({ message: "SAP Customer ID not found" });
    }
    console.log(`[Proxy] /get-all-redis-pricing resolved SAP ID: ${customerId}`);
    let skusRaw = req.body?.skus || req.query?.skus;
    let skus = [];
    if (Array.isArray(skusRaw)) {
      skus = skusRaw.map(s => String(s).trim()).filter(Boolean);
    } else if (typeof skusRaw === "string") {
      skus = skusRaw.split(",").map(s => s.trim()).filter(Boolean);
    }

    if (skus.length === 0) {
      return res.status(400).json({ message: "No SKUs provided", prices: {} });
    }

    const redisConfig = getRedisConfigForShop(shop);
    if (!redisConfig) {
      return res.status(503).json({ message: "Redis not configured for this shop. Set credentials in the app.", prices: {} });
    }
    const redis = createRedisClient(redisConfig);
    const prices = {};

    for (const sku of skus) {
      const redisKey = `${customerId}_${sku}`;
      try {
        const price = await redis.get(redisKey);
        prices[sku] = price !== null ? parseFloat(price) : null;
      } catch (err) {
        console.error(`Error fetching Redis key ${redisKey}:`, err.message);
        prices[sku] = null;
      }
    }

    await redis.quit();
    console.log(`Returning prices for ${skus.length} SKUs for customer ${customerId}`);
    return res.status(200).json({ prices });
  } catch (error) {
    console.error("/get-redis-pricing error:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

proxyRouter.all("/redis-prices", async (req, res) => {
  try {
    const shop = extractShop(req, res);
    const shopifyCustId = req.body?.customerId || req.query?.customerId;

    console.log(`[Proxy] /redis-prices hit. Shop: ${shop}, Shopify Customer ID: ${shopifyCustId}`);
    console.log("[Proxy] /redis-prices Full Query:", JSON.stringify(req.query));
    console.log("[Proxy] /redis-prices Full Body:", JSON.stringify(req.body));

    if (!shop || !shopifyCustId) {
      console.log("[Proxy] /redis-prices error: Missing shop or customerId", { shop, shopifyCustId });
      return res.status(400).json({ message: "Shop and customerId are required" });
    }

    const sessionRes = await getSession(shop);
    const customerId = await getSapCustomerId(sessionRes.session, shopifyCustId);

    if (!customerId) {
      return res.status(400).json({ message: "SAP Customer ID not found" });
    }
    const skusRaw = req.body?.skus || req.query?.skus;
    const skus = Array.isArray(skusRaw)
      ? skusRaw.map((s) => (typeof s === 'string' ? s.trim() : String(s))).filter(Boolean)
      : (typeof skusRaw === 'string' ? skusRaw.split(',').map((s) => s.trim()).filter(Boolean) : []);

    if (skus.length === 0) {
      return res.status(400).json({ message: "Body must include 'skus' (array of SKU strings)", prices: {} });
    }

    const redisConfig = getRedisConfigForShop(shop);
    if (!redisConfig) {
      return res.status(503).json({ message: "Redis not configured for this shop. Set credentials in the app.", prices: {} });
    }
    const redis = createRedisClient(redisConfig);
    const prices = {};
    const results = [];

    for (const sku of skus) {
      const redisKey = `${customerId}_${sku}`;
      try {
        const price = await redis.get(redisKey);
        const numPrice = price !== null ? (parseFloat(price) || price) : null;
        prices[sku] = numPrice;
        results.push({ sku, price: numPrice });
      } catch (err) {
        prices[sku] = null;
        results.push({ sku, price: null, error: err.message });
      }
    }

    await redis.quit();
    return res.status(200).json({ prices, results });
  } catch (error) {
    console.error("Redis GET prices error:", error.message);
    return res.status(500).json({ message: "Error fetching prices from Redis", error: error.message, prices: {} });
  }
});

proxyRouter.post("/redis-call", async (req, res) => {
  try {
    console.log("===== /REDIS-CALL ENDPOINT HIT =====");
    console.log("Request Body:", req.body);

    const { skus, customerId } = req.body;

    if (!skus || !Array.isArray(skus) || skus.length === 0) {
      return res.status(400).json({
        message: "Invalid request - skus array is required"
      });
    }

    if (!customerId) {
      return res.status(400).json({
        message: "Invalid request - customerId is required"
      });
    }

    const shop = extractShop(req, res);
    const redisConfig = getRedisConfigForShop(shop);
    if (!redisConfig) {
      return res.status(503).json({ message: "Redis not configured for this shop. Set credentials in the app." });
    }
    const redis = createRedisClient(redisConfig);

    const priceResults = [];

    for (const item of skus) {
      const sku = item.sku;
      const redisKey = `${customerId}_${sku}`;

      try {
        const price = await redis.get(redisKey);

        if (price !== null) {
          priceResults.push({
            sku: sku,
            price: parseFloat(price) || price 
          });
          console.log(`Found price for ${redisKey}: ${price}`);
        } else {
          priceResults.push({
            sku: sku,
            price: null
          });
          console.log(`No price found for ${redisKey}`);
        }
      } catch (error) {
        console.error(`Error fetching price for ${redisKey}:`, error);
        priceResults.push({
          sku: sku,
          price: null,
          error: error.message
        });
      }
    }

    await redis.quit();

    return res.status(200).json({
      message: "Redis prices fetched successfully",
      results: priceResults
    });
  } catch (error) {
    console.error("Redis call error:", error.message);
    return res.status(500).json({
      message: "Error fetching prices from Redis",
      error: error.message,
    });
  }
});

const CART_QUERY = `
  query Cart($id: ID!) {
    cart(id: $id) {
      id
      lines(first: 250) {
        nodes {
          id
          merchandise {
            ... on ProductVariant {
              sku
            }
          }
        }
      }
    }
  }
`;
const CART_LINES_UPDATE_MUTATION = `
  mutation CartLinesUpdate($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
    cartLinesUpdate(cartId: $cartId, lines: $lines) {
      cart { id }
      userErrors { message field }
    }
  }
`;

async function storefrontGraphql(shop, query, variables) {
  const token = process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN;
  if (!token) {
    throw new Error("SHOPIFY_STOREFRONT_ACCESS_TOKEN not set");
  }
  const shopDomain = shop.replace(/^https?:\/\//, "").split("/")[0];
  const url = `https://${shopDomain}/api/2024-01/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Storefront API ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  return json.data;
}

proxyRouter.post("/set-cart-line-prices", async (req, res) => {
  try {
    const shop = req.query.shop || req.body.shop;
    const { cartId, priceMap } = req.body || {};
    if (!cartId || !priceMap || typeof priceMap !== "object") {
      return res.status(400).json({ message: "cartId and priceMap required" });
    }
    if (!shop) {
      return res.status(400).json({ message: "shop required (query or body)" });
    }

    const data = await storefrontGraphql(shop, CART_QUERY, { id: cartId });
    const cart = data?.cart;
    if (!cart?.lines?.nodes?.length) {
      return res.status(200).json({ message: "ok", updated: 0, reason: "cart empty or not found" });
    }

    const lines = cart.lines.nodes
      .map((node) => {
        const sku = node.merchandise?.sku;
        const price = sku ? priceMap[sku] : null;
        if (price == null || !Number.isFinite(Number(price))) return null;
        return {
          id: node.id,
          attributes: [{ key: "sap_price", value: String(price) }],
        };
      })
      .filter(Boolean);

    if (lines.length === 0) {
      return res.status(200).json({ message: "ok", updated: 0, reason: "no matching prices" });
    }

    const updateData = await storefrontGraphql(shop, CART_LINES_UPDATE_MUTATION, {
      cartId: cartId.startsWith("gid://") ? cartId : `gid://shopify/Cart/${cartId}`,
      lines,
    });
    const errs = updateData?.cartLinesUpdate?.userErrors || [];
    if (errs.length) {
      console.error("set-cart-line-prices userErrors", errs);
      return res.status(400).json({ message: errs.map((e) => e.message).join("; "), userErrors: errs });
    }
    console.log("set-cart-line-prices: updated", lines.length, "lines for cart", cartId);
    return res.status(200).json({ message: "ok", updated: lines.length });
  } catch (e) {
    console.error("set-cart-line-prices error:", e.message);
    return res.status(500).json({ message: e.message });
  }
});

proxyRouter.post("/api-trigger", async (req, res) => {
  return handleAllSkusSync(req, res, "API-TRIGGER");
});

proxyRouter.post("/sapcall-all-skus", async (req, res) => {
  return handleAllSkusSync(req, res, "SAPCALL-ALL-SKUS");
});

async function handleAllSkusSync(req, res, source) {
  try {
    console.log(`===== /${source} ENDPOINT HIT =====`);
    console.log("Request Body:", req.body);

    const requestData = req.body.data || req.body;
    const shop = extractShop(req, res);
    const shopifyCustId = requestData.customer_id || requestData.customerId;

    console.log(`[Proxy] /${source} hit. Shop: ${shop}, Shopify Customer ID: ${shopifyCustId}`);

    if (!shop || !shopifyCustId) {
      console.log(`[Proxy] /${source} error: Missing shop or customerId`, { shop, shopifyCustId });
      return res.status(400).json({ message: "Shop and customerId are required" });
    }

    const sessionRes = await getSession(shop);
    if (!sessionRes.flag || !sessionRes.session) {
      return res.status(500).json({ message: "Session not found for shop" });
    }

    const customerId = await getSapCustomerId(sessionRes.session, shopifyCustId);

    if (!customerId) {
      return res.status(400).json({ message: "SAP Customer ID not found" });
    }

    const customerAddresses = requestData.customer_addresses || requestData.customer_addresses || [];

    try {
      await PriceChangeDB.createProductSKUsTable();
    } catch (e) {
      console.error("Error creating/checking table:", e);
    }

    const allSKUs = await PriceChangeDB.getAllProductSKUs();

    if (!allSKUs || allSKUs.length === 0) {
      return res.status(400).json({ message: "No SKUs found in database", totalSKUs: 0 });
    }

    const redisConfig = getRedisConfigForShop(shop);
    if (!redisConfig) {
      return res.status(503).json({ message: "Redis not configured for this shop. Set credentials in the app." });
    }
    const redisForAll = createRedisClient(redisConfig);
    const { priceMap: allRedisPrices } = await getRedisPricesForSkus(redisForAll, customerId, allSKUs);
    await redisForAll.quit();

    const skusMissingInRedis = allSKUs.filter(sku => {
      const s = sku.trim();
      return allRedisPrices[s] === undefined || allRedisPrices[s] === null;
    });

    if (skusMissingInRedis.length === 0) {
      console.log(`[Proxy] /${source}: Redis has data for all ${allSKUs.length} SKUs, skipping SAP webhook`);
      const skus = allSKUs.map((sku) => ({ sku: sku.trim(), quantity: 1 }));
      return res.status(200).json({
        message: "SAP webhook skipped (Redis cache hit)",
        totalSKUs: skus.length,
        skus,
        customerId,
        webhookResponse: "[cache]",
      });
    }

    console.log(`[Proxy] /${source}: ${skusMissingInRedis.length} of ${allSKUs.length} SKUs missing in Redis. Calling SAP for missing items.`);

    const defaultAddress = customerAddresses.find(addr => addr.default) || customerAddresses[0] || {};
    const address1 = (defaultAddress.address1 || defaultAddress.address || '').trim();
    const city = (defaultAddress.city || '').trim();
    const zip = (defaultAddress.zip || defaultAddress.zip_code || '').trim();
    const provinceCode = (defaultAddress.province_code || defaultAddress.province || defaultAddress.state_code || '').trim();
    const countryCode = (defaultAddress.country_code || defaultAddress.country || '').trim();

    let productSkusXml = '';
    skusMissingInRedis.forEach((sku, index) => {
      productSkusXml += `<item>
<id>${index + 1}</id>
<sku>${sku.trim()}</sku>
<qty>1</qty>
</item>`;
    });

    let customerWeItemXml = '<item>\n<role>WE</role>';
    if (address1) customerWeItemXml += `\n<address1>${address1}</address1>`;
    if (city) customerWeItemXml += `\n<city>${city}</city>`;
    if (zip) customerWeItemXml += `\n<zip>${zip}</zip>`;
    if (provinceCode) customerWeItemXml += `\n<province_code>${provinceCode}</province_code>`;
    if (countryCode) customerWeItemXml += `\n<country_code>${countryCode}</country_code>`;
    customerWeItemXml += '\n</item>';

    const xmlData = `<productPriceUpdateCollection>
<simulationid>2</simulationid>
<product_skus>
${productSkusXml}
</product_skus>
<customer>
${customerWeItemXml}
<item>
<role>AG</role>
<number>${customerId}</number>
</item>
</customer>
</productPriceUpdateCollection>`;

    const sapResponse = await fetch(
      "https://webhooks.appseconnectapi.com/52f38dc4-a9b1-4eab-b3fd-4ce3890e1b83/bc0958e5-c79b-429c-92c0-ccc370e6cff2_default",
      {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: xmlData,
      }
    );

    const responseText = await sapResponse.text();

    if (sapResponse.ok) {
      console.log(`[Proxy] /${source}: Webhook successful. Now polling Redis for ${skusMissingInRedis.length} missing prices...`);
      await pollRedisForPrices(shop, customerId, skusMissingInRedis);
    }

    const skus = allSKUs.map(sku => ({ sku: sku.trim(), quantity: 1 }));

    return res.status(200).json({
      message: `SAP webhook processed for ${source}`,
      totalSKUs: skus.length,
      skus: skus,
      customerId: customerId,
      webhookResponse: responseText,
    });
  } catch (error) {
    console.error(`/${source} error:`, error.message);
    return res.status(500).json({ message: `Error processing ${source}`, error: error.message });
  }
}


proxyRouter.post("/cart-price-sync", async (req, res) => {
  try {
    console.log("===== /CART-PRICE-SYNC ENDPOINT HIT =====");
    const { cart, customer } = req.body;

    if (!cart || !cart.items || cart.items.length === 0) {
      return res.status(400).json({ message: "Cart data missing or empty" });
    }

    const shop = extractShop(req, res);
    const shopifyCustId = customer?.id;

    console.log(`[Proxy] /cart-price-sync hit. Shop: ${shop}, Shopify Customer ID: ${shopifyCustId}`);

    if (!shop || !shopifyCustId) {
      console.log("[Proxy] /cart-price-sync error: Missing shop or customer ID", { shop, shopifyCustId });
      return res.status(400).json({ message: "Shop and customer ID are required" });
    }

    const sessionRes = await getSession(shop);
    if (!sessionRes.flag || !sessionRes.session) {
      console.log("[Proxy] /cart-price-sync: Session not found for", shop);
      return res.status(500).json({ message: "Session not found" });
    }
    const customerId = await getSapCustomerId(sessionRes.session, shopifyCustId);

    if (!customerId) {
      return res.status(400).json({ message: "SAP Customer ID not found" });
    }

    const redisConfigSync = getRedisConfigForShop(shop);
    if (!redisConfigSync) {
      return res.status(503).json({ message: "Redis not configured for this shop. Set credentials in the app." });
    }
    const syncSkus = cart.items.map((item) => item.sku || item.variant_sku || "").filter(Boolean);
    const redisSync = createRedisClient(redisConfigSync);
    const { priceMap: redisPrices } = await getRedisPricesForSkus(redisSync, customerId, syncSkus);
    await redisSync.quit();

    const missingSkusInRedis = cart.items.filter(item => {
      const sku = item.sku || item.variant_sku;
      return !sku || redisPrices[sku] === undefined || redisPrices[sku] === null;
    });

    if (missingSkusInRedis.length === 0) {
      console.log(`[Proxy] /cart-price-sync: Redis has data for all ${syncSkus.length} SKUs, skipping SAP webhook`);
      return res.status(200).json({
        message: "Sync completed (Redis cache)",
        prices: redisPrices
      });
    }

    const addresses = customer?.addresses || [];
    const defaultAddress = addresses.find(a => a.default) || addresses[0] || null;

    let productSkusXml = "";
    missingSkusInRedis.forEach((item, index) => {
      const sku = item.sku || item.variant_sku || "";
      if (sku) {
        productSkusXml += `<item>
<id>${index + 1}</id>
<sku>${sku}</sku>
<qty>${item.quantity || 1}</qty>
</item>`;
      }
    });

    let customerWeItemXml = "<item>\n<role>WE</role>";
    if (defaultAddress) {
      if (defaultAddress.address1) customerWeItemXml += `\n<address1>${defaultAddress.address1}</address1>`;
      if (defaultAddress.city) customerWeItemXml += `\n<city>${defaultAddress.city}</city>`;
      if (defaultAddress.zip) customerWeItemXml += `\n<zip>${defaultAddress.zip}</zip>`;
      if (defaultAddress.province_code) customerWeItemXml += `\n<province_code>${defaultAddress.province_code}</province_code>`;
      if (defaultAddress.country_code) customerWeItemXml += `\n<country_code>${defaultAddress.country_code}</country_code>`;
    }
    customerWeItemXml += "\n</item>";

    const sapXmlData = `<productPriceUpdateCollection>
<simulationid>2</simulationid>
<product_skus>
${productSkusXml}
</product_skus>
<customer>
${customerWeItemXml}
<item>
<role>AG</role>
<number>${customerId}</number>
</item>
</customer>
</productPriceUpdateCollection>`;

    console.log(`Calling SAP for ${missingSkusInRedis.length} items missing in Redis...`);

    try {
      const sapRes = await fetch(
        "https://webhooks.appseconnectapi.com/52f38dc4-a9b1-4eab-b3fd-4ce3890e1b83/bc0958e5-c79b-429c-92c0-ccc370e6cff2_default",
        {
          method: "POST",
          headers: { "Content-Type": "application/xml" },
          body: sapXmlData,
        }
      );
      if (sapRes.ok) {
        console.log("SAP call successful. Polling Redis for missing items...");
        await pollRedisForPrices(shop, customerId, missingSkusInRedis.map(i => i.sku || i.variant_sku));
      } else {
        console.error(`SAP call failed with status: ${sapRes.status}`);
      }
    } catch (sapError) {
      console.error("SAP call failed:", sapError.message);
    }

    const finalRedis = createRedisClient(redisConfigSync);
    const { priceMap: finalPriceMap } = await getRedisPricesForSkus(finalRedis, customerId, syncSkus);
    await finalRedis.quit();

    return res.status(200).json({
      message: "Sync completed",
      prices: finalPriceMap
    });
  } catch (error) {
    console.error("Cart price sync error:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

proxyRouter.post("/get-price-by-sku", async (req, res) => {
  try {
    console.log("===== /GET-PRICE-BY-SKU ENDPOINT HIT =====");
    const { customerId: shopifyCustId, sku, shopUrl } = req.body;

    if (!shopifyCustId || !sku || !shopUrl) {
      return res.status(400).json({ message: "customerId, sku, and shopUrl are required" });
    }

    const shop = normalizeShop(shopUrl);
    const sessionRes = await getSession(shop);
    if (!sessionRes.flag || !sessionRes.session) {
      return res.status(500).json({ message: "Session not found for shop" });
    }

    const customerId = await getSapCustomerId(sessionRes.session, shopifyCustId);
    if (!customerId) {
      return res.status(400).json({ message: "SAP Customer ID not found for this customer" });
    }

    console.log(`[Proxy] /get-price-by-sku: Shopify ID ${shopifyCustId} -> SAP ID ${customerId}, SKU: ${sku}`);

    const redisConfigBySku = getRedisConfigForShop(shop);
    if (!redisConfigBySku) {
      return res.status(503).json({ message: "Redis not configured for this shop. Set credentials in the app." });
    }
    const trimmedSku = sku.trim();
    const redis = createRedisClient(redisConfigBySku);

    const { priceMap: initialPriceMap } = await getRedisPricesForSkus(redis, customerId, [trimmedSku]);
    const cachedPrice = initialPriceMap[trimmedSku];

    if (cachedPrice !== undefined && cachedPrice !== null) {
      console.log(`[Proxy] /get-price-by-sku: Cache hit for ${trimmedSku}: ${cachedPrice}`);
      await redis.quit();
      return res.status(200).json({
        message: "Price found in cache",
        sku: trimmedSku,
        price: cachedPrice
      });
    }

    await redis.quit();
    console.log(`[Proxy] /get-price-by-sku: Cache miss for ${trimmedSku}. Calling SAP...`);

    const sapXmlData = `<productPriceUpdateCollection>
<simulationid>2</simulationid>
<product_skus>
<item>
<id>1</id>
<sku>${trimmedSku}</sku>
<qty>1</qty>
</item>
</product_skus>
<customer>
<item>
<role>WE</role>
</item>
<item>
<role>AG</role>
<number>${customerId}</number>
</item>
</customer>
</productPriceUpdateCollection>`;

    const sapRes = await fetch(
      "https://webhooks.appseconnectapi.com/52f38dc4-a9b1-4eab-b3fd-4ce3890e1b83/bc0958e5-c79b-429c-92c0-ccc370e6cff2_default",
      {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: sapXmlData,
      }
    );

    if (sapRes.ok) {
      console.log(`[Proxy] /get-price-by-sku: SAP call successful. Polling Redis...`);
      const { priceMap: polledPriceMap } = await pollRedisForPrices(shop, customerId, [trimmedSku]);
      const finalPrice = polledPriceMap[trimmedSku];

      return res.status(200).json({
        message: finalPrice !== undefined ? "Price fetched from SAP" : "Price sync initiated",
        sku: trimmedSku,
        price: finalPrice || null
      });
    } else {
      console.error(`[Proxy] /get-price-by-sku: SAP call failed: ${sapRes.status}`);
      return res.status(500).json({ message: "SAP call failed", status: sapRes.status });
    }
  } catch (error) {
    console.error("/get-price-by-sku error:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

export default proxyRouter;