import 'dotenv/config';

import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import xml2js from 'xml2js';
import { PriceChangeDB } from '../price-change-db.js';
import { logRedisConnectionFromEnv } from './sap-api.js';
import {
  fetchCartPricesFromRedis,
  isUsableSapUnitPrice,
  redisPriceMapToSapProducts,
} from './redis-pricing.js';

function checkoutFailure(shop, reason, details = {}) {
  console.error("[getCheckout] FAILED:", reason, details);
  return {
    ok: false,
    redirectUrl: "/cart",
    reason,
    ...details,
  };
}

function checkoutSuccess(shop, payload = {}) {
  const shopHost = String(shop || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  let redirectUrl = shopHost ? `https://${shopHost}/checkout` : "/checkout";
  const discountCode = payload.discountCode;
  if (discountCode) {
    const sep = redirectUrl.includes("?") ? "&" : "?";
    redirectUrl = `${redirectUrl}${sep}discount=${encodeURIComponent(discountCode)}`;
  }
  console.log("[getCheckout] SUCCESS — redirectUrl:", redirectUrl);
  return {
    ok: true,
    redirectUrl,
    ...payload,
  };
}

const customerRoleFiled = process.env.CUSTOMER_ROLE;
const soldToNumberField = process.env.SOLD_TO_NUMBER;
const custRoleShipTo = process.env.CUSTOMER_ROLE_SHIP_TO;
const custRoleSoldTo = process.env.CUSTOMER_ROLE_SOLD_TO;
const TAX_PRODUCT_ID = process.env.TAX_PRODUCT_ID || "10522189955374";

export const getSession = async (shopName) => {
  let response = {
    flag: true,
    session: null,
  };
  try {
    const sessionObject = await PriceChangeDB.byShop(shopName);
    const rows = sessionObject?.rows ?? sessionObject;
    console.log("[getSession] shop:", shopName, "rows:", Array.isArray(rows) ? rows.length : 0);

    if (rows?.length) {
      const row = rows[0];
      response.session = {
        ...row,
        shop: row.shop || shopName,
        accessToken: row.access_token || row.accessToken,
        access_token: row.access_token || row.accessToken,
      };
      console.log("[getSession] token present:", !!response.session.accessToken);
    } else {
      console.warn("[getSession] No session row for shop:", shopName);
    }
  } catch (error) {
    response.flag = false;
    console.log("Error in fetching session from database:=>", error);
  }
  return response;
};


async function ensureStorefrontTokenForShop(shop, adminAccessToken) {
  try {
    console.log("[StorefrontToken] ensureStorefrontTokenForShop called for:", shop);
    if (!shop) {
      throw new Error("shop is required");
    }
    if (!adminAccessToken) {
      throw new Error("adminAccessToken is missing");
    }

    // 1. Check DB if we already have one for this shop (if DB helpers exist)
    if (typeof PriceChangeDB.getStorefrontToken === "function") {
      const existing = await PriceChangeDB.getStorefrontToken(shop);
      if (existing) {
        const preview = `${String(existing).slice(0, 6)}...${String(existing).slice(-4)}`;
        console.log("[StorefrontToken] Reusing existing token from DB:", preview);
        return existing;
      }
      console.log("[StorefrontToken] No existing token in DB, creating a new one.");
    } else {
      console.log("[StorefrontToken] PriceChangeDB.getStorefrontToken not implemented, skipping DB lookup.");
    }

    // 2. Otherwise, create one via Admin GraphQL
    const adminGraphqlUrl = `https://${shop}/admin/api/2024-10/graphql.json`;
    const query = `
      mutation storefrontAccessTokenCreate($title: String!) {
        storefrontAccessTokenCreate(input: {title: $title}) {
          storefrontAccessToken {
            accessToken
            title
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const res = await fetch(adminGraphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": adminAccessToken,
      },
      body: JSON.stringify({
        query,
        variables: { title: `sap-pricing-${shop}` },
      }),
    });

    const raw = await res.text();
    console.log("[StorefrontToken] Admin GraphQL status:", res.status);
    console.log("[StorefrontToken] Admin GraphQL raw response:", raw);
    const json = JSON.parse(raw);

    if (json.errors?.length) {
      throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
    }

    const createResult = json.data?.storefrontAccessTokenCreate;
    if (!createResult || createResult.userErrors?.length) {
      throw new Error(
        "Failed to create storefront token: " +
          JSON.stringify(createResult?.userErrors || json, null, 2)
      );
    }

    const token = createResult.storefrontAccessToken?.accessToken;
    if (!token) {
      throw new Error("storefrontAccessTokenCreate returned no accessToken");
    }

    const preview = `${String(token).slice(0, 6)}...${String(token).slice(-4)}`;
    console.log("[StorefrontToken] Token created successfully:", preview);

    // 3. Save in DB for reuse if helper exists
    if (typeof PriceChangeDB.saveStorefrontToken === "function") {
      await PriceChangeDB.saveStorefrontToken(shop, token);
      console.log("[StorefrontToken] Token saved in DB for shop:", shop);
    } else {
      console.log("[StorefrontToken] PriceChangeDB.saveStorefrontToken not implemented, skipping DB save.");
    }
    return token;
  } catch (error) {
    console.error("[StorefrontToken] ensureStorefrontTokenForShop failed:", error.message);
    throw error;
  }
}

/**
 * xml2js output shape varies (legacy flat envelope vs SOAP with Envelops / namespaces).
 * Finds the SAP cart payload object that carries line_items (and usually TotalShipping).
 */
function extractSapCartData(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const stack = [parsed];
  const seen = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (seen.has(node)) continue;
    seen.add(node);
    const li = node.line_items;
    if (
      li &&
      typeof li === "object" &&
      li.line_item !== undefined &&
      li.line_item !== null
    ) {
      return node;
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return null;
}

export const getCheckout = async (shop, cartbody) => {
  try {
    console.log("========== [getCheckout] START ==========");
    console.log("[getCheckout] shop:", shop);
    logRedisConnectionFromEnv("PriceChangeHelper");

    const cartData = cartbody?.data || cartbody;
    console.log("[getCheckout] cart token:", cartData?.token);
    console.log("[getCheckout] cart item count:", cartData?.items?.length);
    console.log("[getCheckout] customer_id:", cartData?.customer_id);

    const response = await getSession(shop);
    console.log("[getCheckout] session:", response.flag, !!response.session);

    if (!response.session) {
      return checkoutFailure(shop, "no_session");
    }

    const session = response.session;
    const lineItems = cartData?.items || [];

    if (!cartData?.customer_id) {
      return checkoutFailure(shop, "customer_not_logged_in");
    }

    const custId = cartData.customer_id;
    const productSkus = await filterCartLineItems(lineItems);

    if (productSkus.length === 0) {
      console.log("[getCheckout] No SKUs on cart lines — proceeding to checkout without discount");
      return checkoutSuccess(shop, { priceMap: {}, discountValue: 0 });
    }

    const skus = lineItems.map((item) => String(item.sku || "").trim()).filter(Boolean);
    console.log("[getCheckout] Loading prices from Redis for SKUs:", skus);

    const redisResult = await fetchCartPricesFromRedis(session, custId, skus, {
      triggerSapIfMissing: true,
      maxPollRetries: 3,
      lineItems,
    });
    console.log("[getCheckout] Redis result:", redisResult);

    const priceMap = redisResult.priceMap || {};
    const sapPriceMap = redisResult.sapPriceMap || {};
    if (!Object.keys(priceMap).length) {
      return checkoutFailure(shop, "no_prices", { redisResult });
    }

    const totals = summarizeCartVsRedis(lineItems, priceMap);
    console.log("[getCheckout] Cart subtotal:", totals.cartSubtotal, "Redis subtotal:", totals.redisSubtotal);

    const sapProducts = redisPriceMapToSapProducts(lineItems, sapPriceMap);
    const discountValue = roundMoney(calculateDiscountedPrice(lineItems, sapProducts));
    console.log("[getCheckout] Discount amount (cart − SAP Redis):", discountValue);
    console.log("[getCheckout] SAP price map (>0 only):", sapPriceMap);

    const zeroOrMissingSap = skus.filter((sku) => {
      const item = lineItems.find((line) => String(line.sku || line.variant_sku || "").trim() === sku);
      const cartUnit = item ? Number(item.price) / 100 : null;
      return !isUsableSapUnitPrice(sapPriceMap[sku], cartUnit);
    });
    if (zeroOrMissingSap.length > 0) {
      console.log(
        "[getCheckout] Lines with SAP/Redis 0, missing, or higher than Shopify (no discount on those lines):",
        zeroOrMissingSap
      );
    }

    const MIN_DISCOUNT = 0.01;
    if (discountValue < MIN_DISCOUNT) {
      console.log(
        "[getCheckout] No checkout discount — savings below minimum or cart already at/below SAP price"
      );
      return checkoutSuccess(shop, {
        priceMap,
        sapPriceMap,
        discountValue: 0,
        cartSubtotal: totals.cartSubtotal,
        redisSubtotal: totals.redisSubtotal,
        redisKeyPrefix: redisResult.redisKeyPrefix,
        checkoutMode: "standard",
      });
    }

    try {
      const discountCode = await createDiscount(session, custId, discountValue);
      console.log("[getCheckout] Created discount code:", discountCode);
      return checkoutSuccess(shop, {
        priceMap,
        discountCode,
        discountValue,
        cartSubtotal: totals.cartSubtotal,
        redisSubtotal: totals.redisSubtotal,
        redisKeyPrefix: redisResult.redisKeyPrefix,
        checkoutMode: "discount_code",
      });
    } catch (discountError) {
      console.error("[getCheckout] createDiscount failed:", discountError.message);
      return checkoutSuccess(shop, {
        priceMap,
        discountValue,
        cartSubtotal: totals.cartSubtotal,
        redisSubtotal: totals.redisSubtotal,
        checkoutMode: "standard",
        discountError: discountError.message,
      });
    }
  } catch (error) {
    console.error("[getCheckout] Unhandled error:", error?.stack || error);
    return checkoutFailure(shop, "exception", { error: error.message });
  }
}; 



/** Escape text for use inside XML element content */
function escapeXml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Build <name>value</name> for scalar values; skip null/undefined */
function buildXmlElement(name, value) {
  if (value === null || value === undefined) return "";
  return `<${name}>${escapeXml(value)}</${name}>`;
}

/** Build <item>...</item> from an object (e.g. { id, sku, qty, plant } or { role, number }) */
function buildItemXml(item) {
  let out = "";
  for (const [k, v] of Object.entries(item)) {
    if (v !== null && v !== undefined && v !== "") {
      out += buildXmlElement(k, v);
    }
  }
  return out;
}

/** Convert payload { productPriceUpdateCollection: { ... } } to SAP XML request body */
function buildProductPriceUpdateCollectionXml(payLoad) {
  const root = payLoad.productPriceUpdateCollection;
  if (!root) return "";

  let xml = "<productPriceUpdateCollection>";
  xml += buildXmlElement("simulationid", root.simulationid);

  if (root.product_skus && root.product_skus.item) {
    const items = Array.isArray(root.product_skus.item) ? root.product_skus.item : [root.product_skus.item];
    xml += "<product_skus>";
    for (const item of items) {
      xml += "<item>" + buildItemXml(item) + "</item>";
    }
    xml += "</product_skus>";
  }

  if (root.customer && root.customer.item) {
    const items = Array.isArray(root.customer.item) ? root.customer.item : [root.customer.item];
    xml += "<customer>";
    for (const item of items) {
      xml += "<item>" + buildItemXml(item) + "</item>";
    }
    xml += "</customer>";
  }

  if (root.discounts && root.discounts.item) {
    const items = Array.isArray(root.discounts.item) ? root.discounts.item : [root.discounts.item];
    xml += "<discounts>";
    for (const item of items) {
      xml += "<item>" + buildItemXml(item) + "</item>";
    }
    xml += "</discounts>";
  }

  xml += "</productPriceUpdateCollection>";
  return xml;
}

async function storefrontGraphqlForCart(shop, query, variables, tokenOverride = null) {
  const token =
    tokenOverride ||
    process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN ||
    process.env.STOREFRONT_ACCESS_TOKEN;
  if (!token) {
    throw new Error("SHOPIFY_STOREFRONT_ACCESS_TOKEN (or STOREFRONT_ACCESS_TOKEN) not set");
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
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Storefront API ${res.status}: ${text}`);
  }
  const json = JSON.parse(text);
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  return json.data;
}

function resolveCartIdFromBody(cartbody) {
  const data = cartbody?.data || cartbody || {};
  const raw =
    data.cartId ||
    data.cart_id ||
    data.cartToken ||
    data.cart_token ||
    data.token ||
    null;
  console.log("[CartTransform] resolveCartIdFromBody — raw token/id:", raw);
  return raw;
}

async function applySapPricesToCart(session, cartbody, sapProducts, totalTaxAmountFromSap = 0) {
  console.log("[CartTransform] applySapPricesToCart — start", {
    shop: session?.shop,
    sapProductCount: sapProducts?.length,
    totalTaxAmountFromSap,
  });

  const cartIdRaw = resolveCartIdFromBody(cartbody);
  if (!cartIdRaw) {
    console.log("[CartTransform] FAIL — no cart token in body (expected cart.js token field)");
    return { updated: 0, reason: "missing_cart_id" };
  }

  const cartId = String(cartIdRaw).startsWith("gid://")
    ? String(cartIdRaw)
    : `gid://shopify/Cart/${String(cartIdRaw)}`;

  console.log("[CartTransform] Storefront cart id used for query:", cartId);
  console.log(
    "[CartTransform] NOTE: Ajax cart.js token often is NOT a valid Storefront Cart GID — query may return empty"
  );

  const CART_QUERY = `
    query CartById($id: ID!) {
      cart(id: $id) {
        id
        lines(first: 250) {
          nodes {
            id
            attributes {
              key
              value
            }
            merchandise {
              __typename
              ... on ProductVariant {
                id
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
        userErrors { field message }
      }
    }
  `;

  const CART_LINES_ADD_MUTATION = `
    mutation CartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
      cartLinesAdd(cartId: $cartId, lines: $lines) {
        cart { id }
        userErrors { field message }
      }
    }
  `;

  const PRODUCT_VARIANT_LOOKUP_QUERY = `
    query ProductVariantLookup($id: ID!) {
      product(id: $id) {
        id
        title
        variants(first: 1) {
          nodes {
            id
          }
        }
      }
    }
  `;

  const callStorefrontWithFallback = async (query, variables) => {
    try {
      return await storefrontGraphqlForCart(session.shop, query, variables);
    } catch (err) {
      const msg = String(err?.message || "");
      if (!msg.includes("SHOPIFY_STOREFRONT_ACCESS_TOKEN")) {
        throw err;
      }
      console.log("[CartTransform] Storefront token missing from env. Trying fallback token creation.");
      const fallbackToken = await ensureStorefrontTokenForShop(
        session.shop,
        session.adminAccessToken || session.accessToken
      );
      const preview = `${String(fallbackToken).slice(0, 6)}...${String(fallbackToken).slice(-4)}`;
      console.log("[CartTransform] Fallback storefront token created:", preview);
      return await storefrontGraphqlForCart(session.shop, query, variables, fallbackToken);
    }
  };

  let data;
  try {
    data = await callStorefrontWithFallback(CART_QUERY, { id: cartId });
  } catch (queryErr) {
    console.error("[CartTransform] FAIL — CartById query error:", queryErr.message);
    return { updated: 0, reason: "cart_query_error", error: queryErr.message };
  }

  const lines = data?.cart?.lines?.nodes || [];
  console.log("[CartTransform] CartById returned line count:", lines.length);

  if (!lines.length) {
    console.log("[CartTransform] FAIL — cart empty or invalid GID (use cart/change.js from browser instead)");
    return { updated: 0, reason: "cart_empty_or_not_found", cartId };
  }

  const sapBySku = new Map();
  for (const item of sapProducts || []) {
    const sku = String(item?.sku || "").trim();
    const qty = Number(item?.quantity || 0);
    const total = Number(item?.totalitemprice || 0);
    if (!sku || !Number.isFinite(total) || qty <= 0) continue;
    const unit = total / qty;
    if (!isUsableSapUnitPrice(unit)) continue;
    sapBySku.set(sku, unit);
  }
  console.log("[CartTransform] Redis unit prices by SKU:", Object.fromEntries(sapBySku));

  const updateLines = lines
    .map((line) => {
      const sku = String(line?.merchandise?.sku || "").trim();
      const sapUnitPrice = sapBySku.get(sku);
      const shopifyUnit = Number(line?.merchandise?.price ?? line?.cost?.amountPerQuantity?.amount);
      if (!isUsableSapUnitPrice(sapUnitPrice, Number.isFinite(shopifyUnit) ? shopifyUnit : null)) {
        console.log("[CartTransform] No usable SAP price (missing or >= Shopify) for cart line SKU:", sku, "lineId:", line.id);
        return null;
      }
      return {
        id: line.id,
      };
    })
    .filter(Boolean);

  const taxAmount = Number(totalTaxAmountFromSap || 0);
  if (taxAmount > 0) {
    const taxProductGid = `gid://shopify/Product/${TAX_PRODUCT_ID}`;
    const variantLookup = await callStorefrontWithFallback(PRODUCT_VARIANT_LOOKUP_QUERY, {
      id: taxProductGid,
    });
    const taxVariantGid = variantLookup?.product?.variants?.nodes?.[0]?.id || null;
    if (!taxVariantGid) {
      console.warn("[CartTransform] Tax product variant not found — skipping tax line:", taxProductGid);
    } else {
      console.log("[CartTransform] Tax variant id:", taxVariantGid);
      const existingTaxLine = lines.find(
        (line) => String(line?.merchandise?.id || "") === taxVariantGid
      );
      if (existingTaxLine) {
        updateLines.push({
          id: existingTaxLine.id,
        });
      } else {
        const addData = await callStorefrontWithFallback(CART_LINES_ADD_MUTATION, {
          cartId,
          lines: [
            {
              merchandiseId: taxVariantGid,
              quantity: 1,
            },
          ],
        });
        const addErrs = addData?.cartLinesAdd?.userErrors || [];
        if (addErrs.length) {
          console.error("[CartTransform] cartLinesAdd userErrors:", addErrs);
        } else {
          console.log("[CartTransform] Tax line added, sap_price:", taxAmount);
        }
      }
    }
  } else {
    console.log("[CartTransform] Skipping tax line (amount is 0)");
  }

  if (!updateLines.length) {
    console.log("[CartTransform] FAIL — no cart lines matched Redis SKUs");
    return { updated: 0, reason: "no_matching_lines", cartId };
  }

  console.log("[CartTransform] Updating", updateLines.length, "lines with sap_price");

  const updateData = await callStorefrontWithFallback(
    CART_LINES_UPDATE_MUTATION,
    { cartId, lines: updateLines }
  );
  const errs = updateData?.cartLinesUpdate?.userErrors || [];
  if (errs.length) {
    console.error("[CartTransform] cartLinesUpdate userErrors:", errs);
    return { updated: 0, reason: "user_errors", errors: errs };
  }
  console.log("[CartTransform] sap_price attributes updated on lines:", updateLines.length);
  return { updated: updateLines.length, reason: "ok" };
}

async function clientApi(shopifyCustomerId, shop) {
  console.log("========== [clientApi] SAP REQUEST START ==========");
  console.log("[clientApi] shop:", shop, "shopifyCustomerId:", shopifyCustomerId);

  const key = process.env.ENCRYPTION_KEY;
  const apiURL = process.env.CLIENT_API_URL;
  console.log("[clientApi] CLIENT_API_URL:", apiURL);
  console.log("[clientApi] ENCRYPTION_KEY present?:", !!key);

  if (!apiURL || !key) {
    console.error("[clientApi] CLIENT_API_URL or ENCRYPTION_KEY is not set — cannot call SAP");
    return 0;
  }

  const xmlBody = buildSapRootCustomerXml(shopifyCustomerId);

  try {
    console.log("[clientApi] >>> OUTGOING POST", apiURL);
    console.log("[clientApi] >>> OUTGOING HEADERS:", { "Content-Type": "application/xml", Accept: "application/xml" });
    console.log("[clientApi] >>> OUTGOING BODY:\n", xmlBody);

    const response = await fetch(apiURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/xml",
        Accept: "application/xml",
      },
      body: xmlBody,
    });

    const responseText = await response.text();
    console.log("[clientApi] <<< INCOMING status:", response.status, response.statusText);
    console.log("[clientApi] <<< INCOMING headers:", Object.fromEntries(response.headers.entries()));
    console.log("[clientApi] <<< INCOMING body (full):\n", responseText);

    if (!response.ok) {
      console.error("[clientApi] SAP returned non-OK status");
    }

    const responseData = await convertXmlToJson(responseText);
    console.log("[clientApi] <<< PARSED JSON:", JSON.stringify(responseData, null, 2));
    console.log("========== [clientApi] SAP REQUEST END ==========");

    return responseData;
  } catch (error) {
    console.error("[clientApi] <<< REQUEST FAILED:", error?.stack || error);
    console.log("========== [clientApi] SAP REQUEST END (error) ==========");
    return null;
  }
}

async function convertXmlToJson(xmlPayload) {
  console.log("[convertXmlToJson] Incoming XML payload:", xmlPayload);
  return new Promise((resolve, reject) => {
    const parser = new xml2js.Parser({ explicitArray: false });
    parser.parseString(xmlPayload, (err, result) => {
      if (err) {
        console.error("[convertXmlToJson] XML parse error:", err && err.stack ? err.stack : err);
        console.error("[convertXmlToJson] Offending XML payload (first 500 chars):", String(xmlPayload).slice(0, 500));
        reject(err);
      } else {
        resolve(result);
      }
    });
  });
}

async function filterCartLineItems(arr) {
  const filteredItems = await Promise.all(
    arr.map(async (obj, index) => {
      const { sku, quantity } = obj;


      if (sku) {
        return { id: index + 1, sku, qty: quantity, plant: null };
      } else {
        return null;
      }
    })
  );

  const result = filteredItems.filter((item) => item !== null);

  return result;
}

function filterMetaFields(arr) {
  console.log("Customer meta fields");
  const metaFieldsKeysArray = [
    process.env.CUSTOMER_ROLE,
    process.env.SOLD_TO_NUMBER,
    process.env.SHIP_TO_NUMBER,
    'sap_account_number',
    'customerid'
  ];

  return arr.reduce((filteredArr, obj) => {
    if (metaFieldsKeysArray.includes(obj.key)) {
      filteredArr.push({ key: obj.key, value: obj.value });
    }
    return filteredArr;
  }, []);
}

function handleMissingValues(inputArray, defaultSoldToNumber) {
  return inputArray;
}

function PreppareCustData(array, object) {
  console.log("Now we are preparing customer data");
  const newData = [];
  const roleWE = array.find(
    (item) =>
      item.key === customerRoleFiled && item.value.includes(custRoleShipTo)
  );

  const roleAG = array.find(
    (item) =>
      item.key === customerRoleFiled && item.value.includes(custRoleSoldTo)
  );

  const soldToNumber = array.find((item) => item.key === soldToNumberField);
  const shipToNumber = array.find((item) => item.key === soldToNumberField);

  if (roleWE) {
    const { address1, city, zip, province_code, country_code } = object || {};
    newData.push({
      role: custRoleShipTo,
      number: shipToNumber ? shipToNumber.value : "SHIPTO",
      ...(object && { address1, city, zip, province_code, country_code }),
    });
  }

  if (roleAG && soldToNumber) {
    newData.push({
      role: custRoleSoldTo,
      number: soldToNumber.value,
    });
  }

  return newData;
}

function createProductPriceUpdateCollection(
  simulationId,
  productSkus,
  customer,
  discounts
) {

  const productPriceUpdateCollection = {
    simulationid: simulationId,
    product_skus: { item: productSkus },
    customer: { item: customer },
  };

  if (discounts && discounts.length > 0) {
    productPriceUpdateCollection.discounts = { item: discounts };
  }

  return productPriceUpdateCollection;
}

function roundMoney(amount) {
  return Math.round(Number(amount) * 100) / 100;
}

/** Compare cart.js line prices (cents) with Redis unit prices (dollars). */
export function summarizeCartVsRedis(lineItems, priceMap) {
  let cartSubtotal = 0;
  let redisSubtotal = 0;

  for (const item of lineItems || []) {
    const sku = String(item.sku || item.variant_sku || "").trim();
    const qty = Number(item.quantity) || 1;
    const cartUnit = Number(item.price) / 100;
    if (!Number.isFinite(cartUnit)) continue;

    cartSubtotal += cartUnit * qty;
    const redisUnit = priceMap[sku];
    if (isUsableSapUnitPrice(redisUnit, cartUnit)) {
      redisSubtotal += Number(redisUnit) * qty;
    } else {
      redisSubtotal += cartUnit * qty;
    }
  }

  return {
    cartSubtotal: roundMoney(cartSubtotal),
    redisSubtotal: roundMoney(redisSubtotal),
    discount: roundMoney(Math.max(0, cartSubtotal - redisSubtotal)),
  };
}

function calculateDiscountedPrice(cartItems, redisProducts) {
  let totalDiscount = 0;

  try {
    for (const itemA of cartItems || []) {
      const sku = String(itemA.sku || itemA.variant_sku || "").trim();
      const matchingItemB = (redisProducts || []).find((itemB) => itemB.sku === sku);

      if (matchingItemB) {
        const totalItemPrice = matchingItemB.totalitemprice;
        const quantity = matchingItemB.quantity || 1;
        const priceOfOneItem = totalItemPrice / quantity;
        const cartItemPrice = Number(itemA.price) / 100;

        if (!isUsableSapUnitPrice(priceOfOneItem, cartItemPrice)) continue;

        if (priceOfOneItem < cartItemPrice) {
          totalDiscount += Math.abs(cartItemPrice - priceOfOneItem) * quantity;
        }
      }
    }

    return totalDiscount;
  } catch (error) {
    console.error("[getCheckout] Error calculating discount:", error);
    return 0;
  }
}

async function createDiscount(session, customerId, discountValue) {
  const shop = session.shop;
  const accessToken = session.accessToken || session.access_token;
  if (!shop || !accessToken) {
    throw new Error("Missing shop or access token for discount creation");
  }

  const customerIdNum = Number(String(customerId).replace(/\D/g, ""));
  if (!Number.isFinite(customerIdNum)) {
    throw new Error(`Invalid customer id for discount: ${customerId}`);
  }

  const amount = roundMoney(discountValue);
  if (amount < 0.01) {
    throw new Error("Discount amount too small");
  }

  const randomString = Math.random().toString(36).substring(2, 10).toUpperCase();
  const priceRuleTitle = `${randomString}`;
  const discountCode = `${randomString}`;

  const currentDateTime = new Date().toISOString();
  const endsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  try {
    const priceRuleResponse = await fetch(`https://${shop}/admin/api/2024-01/price_rules.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken
      },
      body: JSON.stringify({
        price_rule: {
          title: priceRuleTitle,
          target_type: "line_item",
          target_selection: "all",
          allocation_method: "across",
          value_type: "fixed_amount",
          value: `-${amount.toFixed(2)}`,
          customer_selection: "prerequisite",
          prerequisite_customer_ids: [customerIdNum],
          usage_limit: 1,
          starts_at: currentDateTime,
          ends_at: endsAt,
        }
      })
    });

    const priceRuleData = await priceRuleResponse.json();

    if (!priceRuleResponse.ok) {
      throw new Error(`Failed to create price rule: ${priceRuleData.errors || priceRuleResponse.statusText}`);
    }

    const priceRuleId = priceRuleData.price_rule.id;

    const discountCodeResponse = await fetch(
      `https://${shop}/admin/api/2024-01/price_rules/${priceRuleId}/discount_codes.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken
        },
        body: JSON.stringify({
          discount_code: {
            code: discountCode
          }
        })
      }
    );

    const discountCodeData = await discountCodeResponse.json();

    if (!discountCodeResponse.ok) {
      throw new Error(`Failed to create discount code: ${discountCodeData.errors || discountCodeResponse.statusText}`);
    }
    return discountCodeData.discount_code.code;

  } catch (error) {
    console.error("Error in creating discount:", error);
    throw error;
  }
}
