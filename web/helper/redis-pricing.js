import Redis from "ioredis";
import {
  buildSapRootCustomerXml,
  logRedisConnectionFromEnv,
  normalizeShopifyCustomerId,
  postSapWebhook,
  resolveRedisKeyPrefix,
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
 * Load cart line prices from Redis. If missing, trigger SAP webhook (fills Redis) then poll.
 * Cart Transform reads sap_price attributes — not SAP HTTP pricing URL.
 */
export async function fetchCartPricesFromRedis(session, shopifyCustId, skuList, options = {}) {
  const { triggerSapIfMissing = true, maxPollRetries = 3 } = options;
  const shopifyCustomerId = normalizeShopifyCustomerId(shopifyCustId);
  const redisKey = await resolveRedisKeyPrefix(session, shopifyCustId);

  console.log("[Redis] fetchCartPricesFromRedis — redisKey:", redisKey);

  if (!redisKey.prefix) {
    return { ok: false, priceMap: {}, reason: "no_redis_key_prefix" };
  }

  const config = getRedisConfigFromEnv();
  if (!config) {
    return { ok: false, priceMap: {}, reason: "redis_not_configured" };
  }

  const redis = createRedisClient(config);
  let priceMap = {};

  try {
    let { allFound, priceMap: initial } = await getRedisPricesForSkus(
      redis,
      redisKey.prefix,
      skuList
    );
    priceMap = initial;

    if (!allFound && triggerSapIfMissing && shopifyCustomerId) {
      const missing = skuList
        .map((s) => (typeof s === "string" ? s.trim() : String(s?.sku || "").trim()))
        .filter((s) => s && priceMap[s] === undefined);

      console.log("[Redis] Missing SKUs in Redis:", missing, "— triggering SAP webhook to refresh Redis");
      const xml = buildSapRootCustomerXml(shopifyCustomerId);
      await postSapWebhook(xml, "redis-refresh");

      await redis.quit();
      const polled = await pollRedisForPrices(redisKey.prefix, skuList, maxPollRetries);
      priceMap = polled.priceMap;
      allFound = polled.allFound;
    } else {
      await redis.quit();
    }

    return {
      ok: allFound || Object.keys(priceMap).length > 0,
      priceMap,
      redisKeyPrefix: redisKey.prefix,
      allFound,
      source: redisKey.source,
    };
  } catch (e) {
    try {
      await redis.quit();
    } catch (_) {}
    console.error("[Redis] fetchCartPricesFromRedis error:", e.message);
    return { ok: false, priceMap: {}, reason: e.message };
  }
}

/** Build sapProducts shape for applySapPricesToCart from Redis unit prices */
export function redisPriceMapToSapProducts(lineItems, priceMap) {
  const products = [];
  for (const item of lineItems || []) {
    const sku = String(item.sku || "").trim();
    if (!sku || priceMap[sku] === undefined || priceMap[sku] === null) continue;
    const qty = Number(item.quantity) || 1;
    const unit = Number(priceMap[sku]);
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
