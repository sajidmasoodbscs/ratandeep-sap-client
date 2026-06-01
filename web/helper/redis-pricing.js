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

/**
 * SAP/Redis unit price is used only when > 0.
 * Zero (or invalid) means keep the original Shopify catalog/cart price.
 */
export function isUsableSapUnitPrice(price) {
  const n = Number(price);
  return Number.isFinite(n) && n > 0;
}

/** Prefer SAP price when > 0; otherwise Shopify unit price (dollars). */
export function resolveUnitPrice(sapPrice, shopifyUnitPrice = null) {
  if (isUsableSapUnitPrice(sapPrice)) return Number(sapPrice);
  const shopify = shopifyUnitPrice != null ? Number(shopifyUnitPrice) : null;
  if (shopify !== null && Number.isFinite(shopify) && shopify >= 0) return shopify;
  return null;
}

/** Shopify cart.js unit price (cents → dollars) when Redis has no price. */
export function cartLineDefaultUnitPrice(item) {
  const cents = item?.price ?? item?.original_price ?? item?.final_line_price;
  if (cents == null) return null;
  const unit = Number(cents) / 100;
  return Number.isFinite(unit) && unit >= 0 ? unit : null;
}

/** Fill missing SKUs and replace SAP zero prices with cart line Shopify prices. */
export function mergeCartDefaultPrices(lineItems, priceMap = {}) {
  const merged = { ...priceMap };
  for (const item of lineItems || []) {
    const sku = String(item.sku || item.variant_sku || "").trim();
    if (!sku) continue;
    const fallback = cartLineDefaultUnitPrice(item);
    if (fallback === null) continue;
    if (merged[sku] === undefined) {
      merged[sku] = fallback;
      console.log("[Redis] default price (cart) for", sku, "=>", fallback);
    } else if (!isUsableSapUnitPrice(merged[sku])) {
      console.log("[Redis] SAP price zero/invalid — Shopify cart price for", sku, "=>", fallback);
      merged[sku] = fallback;
    }
  }
  return merged;
}

/** Build Redis key for a customer-scoped SKU price. */
export function buildRedisSkuKey(redisKeyPrefix, sku) {
  const normalizedSku = String(sku || "").trim();
  if (!redisKeyPrefix || !normalizedSku) return null;
  return `${redisKeyPrefix}_${normalizedSku}`;
}

/**
 * Look up a single SKU in Redis.
 * @returns {{ available: boolean, price: number|null, redisKey: string|null, rawValue: string|null }}
 */
export async function lookupSkuPriceInRedis(redis, redisKeyPrefix, sku) {
  const normalizedSku = String(sku || "").trim();
  const redisKey = buildRedisSkuKey(redisKeyPrefix, normalizedSku);

  if (!redisKey) {
    return { available: false, price: null, redisKey: null, rawValue: null };
  }

  try {
    const rawValue = await redis.get(redisKey);
    if (rawValue === null || rawValue === undefined) {
      return { available: false, price: null, redisKey, rawValue: null };
    }
    const price = parseFloat(rawValue);
    if (!Number.isFinite(price)) {
      return { available: false, price: null, redisKey, rawValue: String(rawValue), sapPriceZero: false };
    }
    if (!isUsableSapUnitPrice(price)) {
      return {
        available: false,
        price: null,
        redisKey,
        rawValue: String(rawValue),
        sapPriceInRedis: price,
        sapPriceZero: price === 0,
        useShopifyPrice: true,
      };
    }
    return { available: true, price, redisKey, rawValue: String(rawValue), sapPriceZero: false };
  } catch (error) {
    console.error("[Redis] lookupSkuPriceInRedis error:", redisKey, error.message);
    throw error;
  }
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
        const parsed = parseFloat(price);
        if (isUsableSapUnitPrice(parsed)) {
          priceMap[s] = parsed;
        } else {
          console.log("[Redis] SAP price zero/invalid for", s, "— use Shopify fallback");
        }
      }
    }

    const allFound =
      requested.length > 0 && requested.every((s) => isUsableSapUnitPrice(priceMap[s]));
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
    return {
      ok: Object.keys(priceMap).length > 0,
      priceMap,
      sapPriceMap: {},
      reason: "no_customer_id",
      allFound: false,
    };
  }

  const config = getRedisConfigFromEnv();
  if (!config) {
    const priceMap = mergeCartDefaultPrices(lineItems, {});
    return {
      ok: Object.keys(priceMap).length > 0,
      priceMap,
      sapPriceMap: {},
      reason: "redis_not_configured",
      allFound: false,
    };
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
    const sapPriceMap = { ...priceMap };
    priceMap = mergeCartDefaultPrices(lineItems, priceMap);
    return {
      ok: Object.keys(priceMap).length > 0,
      priceMap,
      sapPriceMap,
      reason: e.message,
      allFound: false,
    };
  }

  const sapPriceMap = { ...priceMap };
  priceMap = mergeCartDefaultPrices(lineItems, priceMap);
  const requested = skuList
    .map((s) => (typeof s === "string" ? s.trim() : String(s?.sku || "").trim()))
    .filter(Boolean);
  const allResolved =
    requested.length > 0 && requested.every((s) => priceMap[s] !== undefined);

  return {
    ok: Object.keys(priceMap).length > 0,
    priceMap,
    sapPriceMap,
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
    const price = resolveUnitPrice(priceMap[sku], cartLineDefaultUnitPrice(item));
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
      properties: {
        ...(item.properties || {}),
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
    let unit = resolveUnitPrice(priceMap[sku], cartLineDefaultUnitPrice(item));
    if (!sku || unit === undefined || unit === null) continue;
    const qty = Number(item.quantity) || 1;
    unit = Number(unit);
    if (!Number.isFinite(unit) || !isUsableSapUnitPrice(unit)) continue;
    products.push({
      sku,
      quantity: qty,
      totalitemprice: unit * qty,
    });
  }
  console.log("[Redis] redisPriceMapToSapProducts:", products);
  return products;
}
