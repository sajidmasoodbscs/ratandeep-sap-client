import { Router } from "express";
import { getRedisKeyPrefix } from "../helper/sap-api.js";
import {
  createRedisClient,
  getRedisConfigFromEnv,
  lookupSkuPriceInRedis,
} from "../helper/redis-pricing.js";

const router = Router();

const EXTERNAL_PATH = "/api/external/redis-sku";

function getExternalApiBaseUrl(req) {
  const fromEnv = process.env.APPLICATION_URL || process.env.SHOPIFY_APP_URL;
  if (fromEnv) return String(fromEnv).replace(/\/$/, "");
  const host = req.get("host");
  const protocol = req.protocol || "https";
  if (host) return `${protocol}://${host}`;
  return "";
}

export function getExternalRedisSkuApiUrl(req) {
  const base = getExternalApiBaseUrl(req);
  return base ? `${base}${EXTERNAL_PATH}` : EXTERNAL_PATH;
}

/** External callers: customer id + SKU via headers only. */
function parseExternalHeaders(req) {
  const customerId =
    req.get("x-customer-id") ||
    req.get("customer-id") ||
    req.get("Customer-Id");
  const sku = req.get("x-sku") || req.get("sku") || req.get("Sku");
  return {
    customerId: customerId != null ? String(customerId).trim() : "",
    sku: sku != null ? String(sku).trim() : "",
  };
}

async function handleExternalRedisSku(req, res) {
  try {
    const { customerId, sku } = parseExternalHeaders(req);
    const apiUrl = getExternalRedisSkuApiUrl(req);

    console.log(`[External] ${req.method} ${EXTERNAL_PATH} customerId=${customerId} sku=${sku}`);

    if (!customerId || !sku) {
      return res.status(400).json({
        available: false,
        message: "Required headers: x-customer-id, x-sku",
        url: apiUrl,
      });
    }

    const redisKeyMeta = getRedisKeyPrefix(customerId);
    const customerPrefix = redisKeyMeta.prefix;
    if (!customerPrefix) {
      return res.status(400).json({
        sku,
        customerId,
        available: false,
        price: null,
        message: "Invalid customer id",
        url: apiUrl,
      });
    }

    const redisConfig = getRedisConfigFromEnv();
    if (!redisConfig) {
      return res.status(503).json({
        sku,
        customerId,
        available: false,
        price: null,
        message: "Redis is not configured",
        url: apiUrl,
      });
    }

    const redis = createRedisClient(redisConfig);
    let lookup;
    try {
      lookup = await lookupSkuPriceInRedis(redis, customerPrefix, sku);
    } finally {
      await redis.quit();
    }

    if (!lookup.available) {
      return res.status(200).json({
        sku,
        customerId,
        available: false,
        price: null,
        redisKey: lookup.redisKey,
        url: apiUrl,
        message: "SKU not found in Redis for this customer",
      });
    }

    return res.status(200).json({
      sku,
      customerId,
      available: true,
      price: lookup.price,
      redisKey: lookup.redisKey,
      url: apiUrl,
    });
  } catch (error) {
    console.error("[External] redis-sku error:", error.message);
    return res.status(500).json({
      available: false,
      message: "Error looking up SKU in Redis",
      error: error.message,
      url: getExternalRedisSkuApiUrl(req),
    });
  }
}

router.get("/redis-sku", handleExternalRedisSku);
router.post("/redis-sku", handleExternalRedisSku);

export default router;
