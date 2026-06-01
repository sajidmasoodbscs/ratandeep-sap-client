import 'dotenv/config';

import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import xml2js from 'xml2js';
import { PriceChangeDB } from '../price-change-db.js';
import { logRedisConnectionFromEnv } from './sap-api.js';
import {
  fetchCartPricesFromRedis,
  redisPriceMapToSapProducts,
} from './redis-pricing.js';

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
    console.log("************* Price simulation is running... *************");
    console.log("shop =>", shop);
    logRedisConnectionFromEnv("PriceChangeHelper");
    console.log("[PriceChangeHelper] cartbody:", JSON.stringify(cartbody, null, 2));
    const response = await getSession(shop);

    console.log("[PriceChangeHelper] getSession flag:", response.flag, "has session:", !!response.session);

    if (response.session) {
      const session = response.session;
      const simulationId = uuidv4();
      const lineItems = cartbody.data.items;
      if (cartbody.data.customer_id) {
        const custId = cartbody.data.customer_id;
        const customerAdresses = cartbody.data.customer_adresses
          ? cartbody.data.customer_adresses
          : null;
        let filtereAddress = null;

        if (customerAdresses) {
          const defaultTrueObject = customerAdresses.find(
            (item) => item.default === true
          );

          if (defaultTrueObject) {
            const { address1, city, zip, province_code, country_code } =
              defaultTrueObject;
            filtereAddress = {
              address1,
              city,
              zip,
              province_code,
              country_code,
            };
          }
        }

        const productSkus = await filterCartLineItems(lineItems);

        if (productSkus.length !== 0) {
          const skus = lineItems
            .map((item) => String(item.sku || "").trim())
            .filter(Boolean);

          console.log("[PriceChangeHelper] Cart Transform flow — loading prices from Redis (not CLIENT_API_URL)");
          const redisResult = await fetchCartPricesFromRedis(session, custId, skus, {
            triggerSapIfMissing: true,
          });

          console.log("[PriceChangeHelper] Redis pricing result:", redisResult);

          if (!redisResult.ok || !Object.keys(redisResult.priceMap).length) {
            console.error("[PriceChangeHelper] No Redis prices for cart. Aborting checkout.");
            return "/cart";
          }

          const sapProducts = redisPriceMapToSapProducts(lineItems, redisResult.priceMap);
          if (!sapProducts.length) {
            console.error("[PriceChangeHelper] No matching SKUs between cart and Redis. Aborting.");
            return "/cart";
          }

          console.log("[getCheckout] Applying Redis prices to cart sap_price attributes for Cart Transform");
          try {
            const applyResult = await applySapPricesToCart(
              session,
              cartbody,
              sapProducts,
              0
            );
            console.log("[getCheckout] Cart Transform sap_price apply result:", applyResult);
            if (!applyResult || applyResult.updated <= 0) {
              console.error(
                "[getCheckout] sap_price not written to cart lines, stopping checkout redirect.",
                applyResult
              );
              return "/cart";
            }
          } catch (applyError) {
            console.error("[getCheckout] Failed to apply Redis sap_price attributes:", applyError.message);
            return "/cart";
          }

          return `/checkout`;
        } else {
          console.log("All items in the cart are without sku's");

          return "/checkout";
        }
      } else {
        console.log(
          "\n\n Customer not logged in. So we don't have the default address.\n We cannot make SAP API CALL. Process stopped. \n\n"
        );
        return "/cart";
      }
    } else {
      console.log("Error in database Connection.");
      return "/cart";
    }
  } catch (error) {
    console.error("Error in background execution:", error);
    return "/cart";
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
  const data = cartbody?.data || {};
  return (
    data.cartId ||
    data.cart_id ||
    data.cartToken ||
    data.cart_token ||
    data.token ||
    null
  );
}

async function applySapPricesToCart(session, cartbody, sapProducts, totalTaxAmountFromSap = 0) {
  const cartIdRaw = resolveCartIdFromBody(cartbody);
  if (!cartIdRaw) {
    console.log("[CartTransform] No cart id/token found in request body. Cannot write sap_price attributes.");
    return { updated: 0, reason: "missing_cart_id" };
  }

  const cartId = String(cartIdRaw).startsWith("gid://")
    ? String(cartIdRaw)
    : `gid://shopify/Cart/${String(cartIdRaw)}`;

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

  const data = await callStorefrontWithFallback(CART_QUERY, { id: cartId });
  const lines = data?.cart?.lines?.nodes || [];
  if (!lines.length) {
    console.log("[CartTransform] Cart not found or no lines for cartId:", cartId);
    return { updated: 0, reason: "cart_empty_or_not_found" };
  }

  const sapBySku = new Map();
  for (const item of sapProducts || []) {
    const sku = String(item?.sku || "").trim();
    const qty = Number(item?.quantity || 0);
    const total = Number(item?.totalitemprice || 0);
    if (!sku || !Number.isFinite(total) || qty <= 0) continue;
    sapBySku.set(sku, total / qty);
  }

  const updateLines = lines
    .map((line) => {
      const sku = String(line?.merchandise?.sku || "").trim();
      const sapUnitPrice = sapBySku.get(sku);
      if (!Number.isFinite(sapUnitPrice)) return null;
      return {
        id: line.id,
        attributes: [{ key: "sap_price", value: String(sapUnitPrice) }],
      };
    })
    .filter(Boolean);

  const taxProductGid = `gid://shopify/Product/${TAX_PRODUCT_ID}`;
  const variantLookup = await callStorefrontWithFallback(PRODUCT_VARIANT_LOOKUP_QUERY, {
    id: taxProductGid,
  });
  const taxVariantGid = variantLookup?.product?.variants?.nodes?.[0]?.id || null;
  if (!taxVariantGid) {
    console.error("[CartTransform] Could not resolve variant for tax product:", taxProductGid);
    return { updated: 0, reason: "tax_variant_not_found" };
  }
  console.log("[CartTransform] Resolved tax variant id:", taxVariantGid);
  const taxAmount = Number(totalTaxAmountFromSap || 0);
  const existingTaxLine = lines.find(
    (line) => String(line?.merchandise?.id || "") === taxVariantGid
  );

  if (existingTaxLine) {
    const currentTaxSapPrice = (existingTaxLine.attributes || []).find(
      (attr) => attr.key === "sap_price"
    )?.value;
    if (currentTaxSapPrice !== String(taxAmount)) {
      updateLines.push({
        id: existingTaxLine.id,
        attributes: [{ key: "sap_price", value: String(taxAmount) }],
      });
    }
  } else {
    const addData = await callStorefrontWithFallback(CART_LINES_ADD_MUTATION, {
      cartId,
      lines: [
        {
          merchandiseId: taxVariantGid,
          quantity: 1,
          attributes: [{ key: "sap_price", value: String(taxAmount) }],
        },
      ],
    });
    const addErrs = addData?.cartLinesAdd?.userErrors || [];
    if (addErrs.length) {
      console.error("[CartTransform] cartLinesAdd userErrors for tax line:", addErrs);
      return { updated: 0, reason: "tax_line_add_user_errors", errors: addErrs };
    }
    console.log("[CartTransform] Tax line added to cart with sap_price:", taxAmount);
  }

  if (!updateLines.length) {
    console.log("[CartTransform] No matching cart lines by SKU to set sap_price.");
    return { updated: 0, reason: "no_matching_lines" };
  }

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

function calculateDiscountedPrice(A, B) {
  let totalDiscount = 0;

  try {
    A.forEach((itemA) => {

      let matchingItemB = B.find((itemB) => itemB.sku === itemA.sku);

      if (matchingItemB) {
        let totalItemPrice = matchingItemB.totalitemprice;
        let quantity = matchingItemB.quantity;

        let priceOfOneItem = totalItemPrice / quantity;
        let cartItemPrice = itemA.price / 100;

        if (priceOfOneItem < cartItemPrice) {
          let discountValue = Math.abs(cartItemPrice - priceOfOneItem);
          totalDiscount += discountValue * quantity;
        }
      }
    });

    return totalDiscount;
  } catch (error) {
    console.error("Error in calculating total discount:", error);
    return 0;
  }
}

async function createDiscount(session, customerId, discountValue) {
  const { shop, accessToken } = session;

  const randomString = Math.random().toString(36).substring(2, 10).toUpperCase();
  const priceRuleTitle = `Sap-Discount-${randomString}`;
  const discountCode = `DISCOUNT-${randomString}`;

  const currentDateTime = new Date().toISOString();

  const now = new Date();
  const endsAt = new Date(now.getTime() + 60 * 60 * 1000);

  try {
    const priceRuleResponse = await fetch(`https://${shop}/admin/api/2023-01/price_rules.json`, {
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
          value: `-${discountValue}`, 
          customer_selection: "prerequisite",
          prerequisite_customer_ids: [customerId],
          usage_limit: 1,
          starts_at: currentDateTime,
          ends_at: endsAt.toISOString(),
        }
      })
    });

    const priceRuleData = await priceRuleResponse.json();

    if (!priceRuleResponse.ok) {
      throw new Error(`Failed to create price rule: ${priceRuleData.errors || priceRuleResponse.statusText}`);
    }

    const priceRuleId = priceRuleData.price_rule.id;

    const discountCodeResponse = await fetch(
      `https://${shop}/admin/api/2023-01/price_rules/${priceRuleId}/discount_codes.json`,
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
