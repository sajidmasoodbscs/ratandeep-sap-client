import Redis from "ioredis";
import {
  buildSapRootCustomerXml,
  getRedisKeyPrefix,
  logRedisConnectionFromEnv,
  normalizeShopifyCustomerId,
  postSapWebhook,
} from "./sap-api.js";

export function getRedisConfigFromEnv() {
  logRedisConnectionFromEnv("Redis");
  const redisString = process.env.REDIS_STRING?.trim();
  if (!redisString) {
    console.warn("[Redis] REDIS_STRING is not set");
    return null;
  }
  try {
    const url = new URL(redisString);
    if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
      console.error("[Redis] REDIS_STRING must use redis:// or rediss://");
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
    console.error("[Redis] Failed to parse REDIS_STRING:", e.message);
    return null;
  }
}

export function createRedisClient(config) {
  return new Redis(config);
}

/** Shopify cart.js unit price (cents → dollars) when Redis has no price. */
export function cartLineDefaultUnitPrice(item) {
  const cents = item?.price ?? item?.original_price ?? item?.final_line_price;
  if (cents == null) return null;
  const unit = Number(cents) / 100;
  return Number.isFinite(unit) && unit >= 0 ? unit : null;
}

/** Fill missing SKUs from cart line Shopify prices. */
export function mergeCartDefaultPrices(lineItems, priceMap = {}) {
  const merged = { ...priceMap };
  for (const item of lineItems || []) {
    const sku = String(item.sku || item.variant_sku || "").trim();
    if (!sku || merged[sku] !== undefined) continue;
    const fallback = cartLineDefaultUnitPrice(item);
    if (fallback !== null) {
      merged[sku] = fallback;
      console.log("[Redis] default price (cart) for", sku, "=>", fallback);
    }
  }
  return merged;
}

export async function getRedisPricesForSkus(redis, redisKeyPrefix, skuList) {
  const priceMap = {};
  if (!skuList?.length) {
    return { allFound: true, priceMap };
  }

  const requested = skuList
    .map((sku) => {
      if (typeof sku === "string") return sku.trim();
      if (sku?.sku) return String(sku.sku).trim();
      return "";
    })
    .filter(Boolean);

  console.log("[Redis] getRedisPricesForSkus — prefix:", redisKeyPrefix, "skus:", requested);

  try {
    for (const s of requested) {
      const redisKey = `${redisKeyPrefix}_${s}`;
      const price = await redis.get(redisKey);
      console.log("[Redis] GET", redisKey, "=>", price);
      if (price !== null && price !== undefined) {
        priceMap[s] = parseFloat(price);
      }
    }

    const allFound =
      requested.length > 0 && requested.every((s) => priceMap[s] !== undefined);
    console.log("[Redis] getRedisPricesForSkus — allFound:", allFound, "priceMap:", priceMap);
    return { allFound, priceMap };
  } catch (error) {
    console.error("[Redis] getRedisPricesForSkus error:", error.message);
    return { allFound: false, priceMap, error: error.message };
  }
}

export async function pollRedisForPrices(redisKeyPrefix, skuList, maxRetries = 3, interval = 2000) {
  const config = getRedisConfigFromEnv();
  if (!config) {
    return { allFound: false, priceMap: {} };
  }

  const redis = createRedisClient(config);
  try {
    for (let i = 0; i < maxRetries; i++) {
      const result = await getRedisPricesForSkus(redis, redisKeyPrefix, skuList);
      if (result.allFound) {
        console.log(`[Redis] poll — all prices found on attempt ${i + 1}`);
        return result;
      }
      if (i < maxRetries - 1) {
        console.log(`[Redis] poll — retry ${i + 1}/${maxRetries} in ${interval}ms`);
        await new Promise((r) => setTimeout(r, interval));
      }
    }
    return await getRedisPricesForSkus(redis, redisKeyPrefix, skuList);
  } finally {
    try {
      await redis.quit();
    } catch (_) {}
  }
}

/**
 * Redis-first pricing: read cache → SAP webhook (loads Redis) → poll up to 3× → cart default price.
 */
export async function fetchCartPricesFromRedis(_session, shopifyCustId, skuList, options = {}) {
  const {
    triggerSapIfMissing = true,
    maxPollRetries = 3,
    pollIntervalMs = 2000,
    lineItems = null,
  } = options;

  const shopifyCustomerId = normalizeShopifyCustomerId(shopifyCustId);
  const redisKey = getRedisKeyPrefix(shopifyCustId);

  console.log("[Redis] fetchCartPricesFromRedis — redisKey:", redisKey);

  if (!redisKey.prefix) {
    const priceMap = mergeCartDefaultPrices(lineItems, {});
    return { ok: Object.keys(priceMap).length > 0, priceMap, reason: "no_customer_id", allFound: false };
  }

  const config = getRedisConfigFromEnv();
  if (!config) {
    const priceMap = mergeCartDefaultPrices(lineItems, {});
    return { ok: Object.keys(priceMap).length > 0, priceMap, reason: "redis_not_configured", allFound: false };
  }

  const redis = createRedisClient(config);
  let priceMap = {};
  let allFound = false;

  try {
    const initial = await getRedisPricesForSkus(redis, redisKey.prefix, skuList);
    priceMap = initial.priceMap;
    allFound = initial.allFound;

    const missing = skuList
      .map((s) => (typeof s === "string" ? s.trim() : String(s?.sku || "").trim()))
      .filter((s) => s && priceMap[s] === undefined);

    if (!allFound && triggerSapIfMissing && shopifyCustomerId) {
      console.log("[Redis] Missing SKUs:", missing, "— POST SAP webhook (load Redis)");
      const xml = buildSapRootCustomerXml(shopifyCustomerId);
      const sapResult = await postSapWebhook(xml, "redis-refresh");
      if (!sapResult.ok) {
        console.warn("[Redis] SAP webhook non-OK — still polling Redis:", sapResult.status);
      }

      await redis.quit();

      const polled = await pollRedisForPrices(
        redisKey.prefix,
        skuList,
        maxPollRetries,
        pollIntervalMs
      );
      priceMap = { ...priceMap, ...polled.priceMap };
      allFound = polled.allFound;
    } else {
      await redis.quit();
    }
  } catch (e) {
    try {
      await redis.quit();
    } catch (_) {}
    console.error("[Redis] fetchCartPricesFromRedis error:", e.message);
    priceMap = mergeCartDefaultPrices(lineItems, priceMap);
    return { ok: Object.keys(priceMap).length > 0, priceMap, reason: e.message, allFound: false };
  }

  priceMap = mergeCartDefaultPrices(lineItems, priceMap);
  const requested = skuList
    .map((s) => (typeof s === "string" ? s.trim() : String(s?.sku || "").trim()))
    .filter(Boolean);
  const allResolved =
    requested.length > 0 && requested.every((s) => priceMap[s] !== undefined);

  return {
    ok: Object.keys(priceMap).length > 0,
    priceMap,
    redisKeyPrefix: redisKey.prefix,
    allFound: allResolved,
    allFoundInRedis: allFound,
    source: redisKey.source,
    usedDefaults: !allFound && allResolved,
  };
}

/** Ajax cart line updates so Cart Transform sees sap_price at checkout (line item properties). */
export function buildAjaxLinePropertyUpdates(cartItems, priceMap) {
  const updates = [];
  for (const item of cartItems || []) {
    const sku = String(item.sku || item.variant_sku || "").trim();
    let price = priceMap[sku];
    if (price === undefined || price === null) {
      price = cartLineDefaultUnitPrice(item);
    }
    if (!sku || price === undefined || price === null) {
      console.log("[Redis] buildAjaxLinePropertyUpdates — skip item (no sku/price):", {
        key: item.key,
        sku,
      });
      continue;
    }
    const sapPrice = String(price);
    updates.push({
      lineKey: item.key,
      sku,
      sap_price: sapPrice,
      properties: {
        ...(item.properties || {}),
        sap_price: sapPrice,
      },
    });
  }
  console.log("[Redis] buildAjaxLinePropertyUpdates — count:", updates.length, updates);
  return updates;
}

export function redisPriceMapToSapProducts(lineItems, priceMap) {
  const products = [];
  for (const item of lineItems || []) {
    const sku = String(item.sku || "").trim();
    let unit = priceMap[sku];
    if (unit === undefined || unit === null) {
      unit = cartLineDefaultUnitPrice(item);
    }
    if (!sku || unit === undefined || unit === null) continue;
    const qty = Number(item.quantity) || 1;
    unit = Number(unit);
    if (!Number.isFinite(unit)) continue;
    products.push({
      sku,
      quantity: qty,
      totalitemprice: unit * qty,
    });
  }
  console.log("[Redis] redisPriceMapToSapProducts:", products);
  return products;
}
