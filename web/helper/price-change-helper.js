import 'dotenv/config';

import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import xml2js from 'xml2js';
import { PriceChangeDB } from '../price-change-db.js';

const customerRoleFiled = process.env.CUSTOMER_ROLE;
const soldToNumberField = process.env.SOLD_TO_NUMBER;
const custRoleShipTo = process.env.CUSTOMER_ROLE_SHIP_TO;
const custRoleSoldTo = process.env.CUSTOMER_ROLE_SOLD_TO;

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
            let lineItemsFromSap;
            let jsonPayload = null;
            try {
              console.log("[clientApi] API response received:", apiResponse);
              if (
                apiResponse &&
                apiResponse.envelope.ZAPPSECONNECT_SALES_ORD_SIMUL.CART_DATA
                  .line_items
              ) {
                cartItemsFromSap =
                  apiResponse.envelope.ZAPPSECONNECT_SALES_ORD_SIMUL.CART_DATA;
                shippingCost =
                  apiResponse.envelope.ZAPPSECONNECT_SALES_ORD_SIMUL.CART_DATA
                    .TotalShipping;

                lineItemsFromSap = cartItemsFromSap.line_items.line_item;
                if (Array.isArray(lineItemsFromSap)) {
                  sapProducts = cartItemsFromSap.line_items.line_item;
                } else {
                  sapProducts = [lineItemsFromSap];
                }

                if (sapProducts) {

                  const discountValue = await calculateDiscountedPrice(
                    lineItems,
                    sapProducts
                  );

                  if (discountValue > 0) {

                    try {
                      const discountCode = await createDiscount(session, custId, discountValue);
                      console.log("Generated Discount Code:", discountCode);
                      if (discountCode) {
                        return `/checkout?discount=${discountCode}`;
                      } else {
                        console.log("error in discount code generate");
                        return "/cart";
                      }

                    } catch (error) {
                      console.error("Error in create discount", error.message);
                      return "/cart";
                    }

                  } else {
                    console.log("Discount amount 0. normal checkout");
                    return `/checkout`;
                  }

                } else {
                  return "/cart";
                }

              } else {
                console.log(
                  "Error in client api call and error is =>",
                  jsonPayload?.envelope?.ZAPPSECONNECT_SALES_ORD_SIMUL
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

    const sapMetafield = metafields.find(m => m.key === 'sap_customer_id' || m.key === 'customerid' || m.key === process.env.SOLD_TO_NUMBER);

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
    'sap_customer_id',
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
