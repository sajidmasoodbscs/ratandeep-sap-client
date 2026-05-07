import 'dotenv/config';

import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import xml2js from 'xml2js';
import { PriceChangeDB } from '../price-change-db.js';

const customerRoleFiled = process.env.CUSTOMER_ROLE;
const soldToNumberField = process.env.SOLD_TO_NUMBER;
const custRoleShipTo = process.env.CUSTOMER_ROLE_SHIP_TO;
const custRoleSoldTo = process.env.CUSTOMER_ROLE_SOLD_TO;
const TAX_VARIANT_ID = "10522189955374";

export const getSession = async (shopName) => {
  let response = {
    flag: true,
    session: null,
  };
  try {
    const sessionObject = await PriceChangeDB.byShop(shopName);

    if (sessionObject) {
      response.session = sessionObject[0];
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
    const response = await getSession(shop);

    console.log("response", response)

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
          console.log(`[PriceChangeHelper] Resolving SAP Customer ID for shop: ${session.shop}, customerId: ${custId}`);
          const sapCustomerId = await getSapCustomerIdLocal(session, custId);
          console.log(`[PriceChangeHelper] Result of SAP Customer ID lookup: ${sapCustomerId}`);

          if (!sapCustomerId) {
            console.log("[PriceChangeHelper] No SAP Customer ID found. Aborting process.");
            return "/cart";
          }

          var custFilteredMetaFields = [
            { key: process.env.SOLD_TO_NUMBER, value: sapCustomerId },
            { key: process.env.SHIP_TO_NUMBER, value: sapCustomerId },
            { key: process.env.CUSTOMER_ROLE, value: JSON.stringify([process.env.CUSTOMER_ROLE_SHIP_TO, process.env.CUSTOMER_ROLE_SOLD_TO]) }
          ];

          if (custFilteredMetaFields.length >= 1) {
            const customer = PreppareCustData(
              custFilteredMetaFields,
              filtereAddress
            );

            console.log(
              "Simulation id befor send to createProductPriceUpdateCollection=>",
              simulationId
            );
            const productPriceUpdateCollection =
              createProductPriceUpdateCollection(
                simulationId,
                productSkus,
                customer
              );


            const apiResponse = await clientApi(
              productPriceUpdateCollection,
              shop
            );
            console.log("Response from client api=>", apiResponse);

            let cartItemsFromSap;
            let sapProducts;
            let shippingCost;
            let totalTaxAmountFromSap;
            let lineItemsFromSap;
            try {
              console.log("[clientApi] API response received:", apiResponse);
              cartItemsFromSap = extractSapCartData(apiResponse);

              if (cartItemsFromSap && cartItemsFromSap.line_items) {
                shippingCost = cartItemsFromSap.TotalShipping;
                totalTaxAmountFromSap = Number(cartItemsFromSap.TotalTaxAmount || 0);

                lineItemsFromSap = cartItemsFromSap.line_items.line_item;
                if (Array.isArray(lineItemsFromSap)) {
                  sapProducts = lineItemsFromSap;
                } else {
                  sapProducts = [lineItemsFromSap];
                }

                if (sapProducts && sapProducts.length) {
                  // Cart pricing is applied by Cart Transform from cart line sap_price attributes.
                  // Here we only validate SAP pricing response and continue checkout flow.
                  console.log("[getCheckout] NEW CART TRANSFORM FLOW ACTIVE: discount-code path is bypassed.");
                  console.log(
                    "[getCheckout] SAP line items received. Proceeding with Cart Transform pricing.",
                    sapProducts.map((item) => ({
                      sku: item.sku,
                      quantity: item.quantity,
                      totalitemprice: item.totalitemprice,
                    }))
                  );
                  const sapProductsBySku = new Map(
                    sapProducts.map((item) => [String(item.sku || "").trim(), item])
                  );
                  const checkoutVsSap = lineItems.map((cartItem) => {
                    const sku = String(cartItem.sku || "").trim();
                    const sapItem = sapProductsBySku.get(sku);
                    const cartQty = Number(cartItem.quantity || 0);
                    const cartUnitPrice = Number(cartItem.price || 0) / 100;
                    const sapQty = Number(sapItem?.quantity || 0);
                    const sapTotal = Number(sapItem?.totalitemprice || 0);
                    const sapUnitPrice = sapQty > 0 ? sapTotal / sapQty : null;
                    return {
                      sku,
                      checkout_quantity: cartQty,
                      checkout_unit_price: cartUnitPrice,
                      sap_quantity: sapQty || null,
                      sap_totalitemprice: Number.isFinite(sapTotal) ? sapTotal : null,
                      sap_unit_price: Number.isFinite(sapUnitPrice) ? sapUnitPrice : null,
                    };
                  });
                  console.log("[getCheckout] CHECKOUT vs SAP price comparison per product:", checkoutVsSap);
                  try {
                    const applyResult = await applySapPricesToCart(
                      session,
                      cartbody,
                      sapProducts,
                      totalTaxAmountFromSap
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
                    console.error("[getCheckout] Failed to apply sap_price attributes:", applyError.message);
                    try {
                      const fallbackToken = await ensureStorefrontTokenForShop(
                        shop,
                        session.adminAccessToken || session.accessToken
                      );
                      const preview = `${String(fallbackToken).slice(0, 6)}...${String(fallbackToken).slice(-4)}`;
                      console.log("[getCheckout] Storefront token available after fallback creation:", preview);
                    } catch (tokenError) {
                      console.error("[getCheckout] Storefront token fallback creation failed:", tokenError.message);
                    }
                    return "/cart";
                  }
                  return `/checkout`;
                } else {
                  return "/cart";
                }
              } else {
                console.log(
                  "Error in client api call: no CART_DATA / line_items in parsed response",
                  apiResponse && typeof apiResponse === "object"
                    ? Object.keys(apiResponse)
                    : apiResponse
                );
                return "/cart";
              }
            } catch (error) {
              console.log(
                "Error in converting client API XML response to JSON =>",
                error
              );
              return "/cart";
            }
          } else {
            console.log("Meta fields for sold to number is not set");
            return "/cart";
          }
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

  const taxVariantGid = `gid://shopify/ProductVariant/${TAX_VARIANT_ID}`;
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

async function clientApi(productPriceUpdateCollection, shop) {

  let payLoad = {
    "productPriceUpdateCollection": productPriceUpdateCollection
  }

  console.log("[clientApi] Outgoing payload to SAP:", JSON.stringify(payLoad, null, 2));

  const key = process.env.ENCRYPTION_KEY;
  const apiURL = process.env.CLIENT_API_URL;
  console.log("[clientApi] SAP API URL:", apiURL);
  console.log("[clientApi] ENCRYPTION_KEY present?:", !!key);
  if (apiURL && key) {

    const xmlBody = buildProductPriceUpdateCollectionXml(payLoad);
    console.log("[clientApi] Outgoing XML body:", xmlBody);

    try {
      const response = await fetch(apiURL, {
        method: "POST",
        headers: {
          "Content-Type": "application/xml",
          "Accept": "application/xml"
        },
        body: xmlBody
      });

      console.log("[clientApi] SAP API response status:", response.status);
      const responseText = await response.text();
      console.log("[clientApi] Raw XML Response from SAP (first 500 chars):", responseText.slice(0, 500));
      console.log("[clientApi] Raw XML Response from SAP (full):", responseText);

      const responseData = await convertXmlToJson(responseText);
      console.log("[clientApi] Parsed JSON Response from SAP:", JSON.stringify(responseData, null, 2));

      return responseData;

    } catch (error) {
      console.error("[clientApi] Error while calling SAP API:", error && error.stack ? error.stack : error);
      console.error("[clientApi] Failed payload was:", JSON.stringify(payLoad, null, 2));
      console.error("[clientApi] SAP API URL at error time:", apiURL);
      return null;
    }

  } else {
    console.error("[clientApi] CLIENT_API_URL or ENCRYPTION_KEY is not set. apiURL:", apiURL, " keyPresent:", !!key);
    console.error("[clientApi] Payload that could not be sent:", JSON.stringify(payLoad, null, 2));
    return 0;
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

async function getSapCustomerIdLocal(session, custId) {
  const url = `https://${session.shop}/admin/api/2023-07/metafields.json?metafield[owner_id]=${custId}&metafield[owner_resource]=customers`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": session.accessToken,
        "Content-Type": "application/json",
      },
    });

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
