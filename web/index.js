import 'dotenv/config';
import bodyParser from 'body-parser';
import express from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import serveStatic from 'serve-static';
import { decrypt } from './middleware/Decryption.js';
import { encrypt } from './middleware/Encryption.js';
import verifyProxy from './middleware/verifyProxy.js';
import { PriceChangeDB } from './price-change-db.js';
import proxyRouter from './routes/app_proxy/index.js';
import carttransformerRouter from './routes/carttransformer.js';
import shopify from './shopify.js';
import webhookHandlers from './webhook-handlers.js';
import cors from 'cors';
import { logRedisConnectionFromEnv } from './helper/sap-api.js';

let query;
const STATIC_PATH =
  process.env.NODE_ENV === "production"
    ? `${process.cwd()}/frontend/dist`
    : `${process.cwd()}/frontend/`;

const app = express();

app.use((req, res, next) => {
  console.log(`[DEBUG] Incoming Request: ${req.method} ${req.url}`);
  next();
});

// Enable CORS for all routes - make all endpoints public and handle preflight
app.use(cors({
  origin: (origin, callback) => callback(null, true),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'ngrok-skip-browser-warning']
}));
app.options('*', cors());

const bodyParserPrewiring = (app) => {
  // save a raw (unprocessed) version of 'body' to 'rawBody'
  function parseVerify(req, res, buf, encoding) {
    if (buf && buf.length) {
      req.rawBody = buf.toString(encoding || "utf8");
    }
  }

  app.use(
    bodyParser.json({
      verify: parseVerify,
      limit: "10mb",
    })
  );

  app.use(
    bodyParser.urlencoded({
      extended: true,
      verify: parseVerify,
      limit: "10mb",
    })
  );
};
// const app = express();
// Webhooks must be handled BEFORE the global body parser because shopify.processWebhooks
// needs to read the raw request stream to verify the HMAC signature.
app.post(
  shopify.config.webhooks.path,
  shopify.processWebhooks({ webhookHandlers })
);

// Initialize body parser for all subsequent routes
bodyParserPrewiring(app);

// Proxy routes for storefront
app.use("/apps/sap-price-test", proxyRouter);

app.get(shopify.config.auth.path, shopify.auth.begin());

app.get(
  shopify.config.auth.callbackPath,
  async (req, res, next) => {
    console.log("Request data during instalation is =>", req.query.shop);
    console.log("Create database table call back function called");
    const databaseTableCreate = await PriceChangeDB.createSettingTable();
    console.log(
      "Response from createtabel fucntion in idex file =>",
      databaseTableCreate
    );
    const insertShopInSetting = await PriceChangeDB.InsertShopEntry(
      req.query.shop
    );
    console.log("Shop entry in setting response =>", insertShopInSetting);
    next();
  },
  shopify.auth.callback(),
  shopify.redirectToShopifyOrAppRoot()
);

// Webhook handler logic is already registered above.
// No need for redundant body assignment which can disrupt the stream.

app.use("/api/*", shopify.validateAuthenticatedSession());

// app.use(express.json()); // Removed redundant body parser which was causing "stream is not readable" error

app.get("/api/customers", async (req, res) => {
  console.log("#############################################  \n\n");
  console.log(" ** API Called**");

  console.log("Customer request received");
  try {
    // Session is built by the OAuth process
    const customers = await shopify.api.rest.Customer.all({
      session: res.locals.shopify.session,
    });

    const idsArray = customers.data.map((customer) => customer.id);
    // console.log("Ids array is =>", idsArray);

    // Session is built by the OAuth process
    let filteredMetaField = [];
    let result = {};
    for (let i = 0; i < idsArray.length; i++) {
      const metaFields = await shopify.api.rest.Metafield.all({
        session: res.locals.shopify.session,
        metafield: { owner_id: idsArray[i], owner_resource: "customer" },
      });

      if (metaFields.data.length > 0) {
        let array = metaFields.data;
        const hasSoldToNumber = array.some(
          (metafield) =>
            metafield.key === "sold_to_number" ||
            metafield.key === "customerid" ||
            metafield.key === "sap_account_number"
        );
        if (hasSoldToNumber) {
          for (const metafield of array) {
            if (metafield.key === "sold_to_number" || metafield.key === "customerid" || metafield.key === "sap_account_number") {
              console.log("Found SAP/Customer ID metafield:", metafield.key);
              result["sold_to_number"] = metafield.value;
              result["customer_id"] = metafield.owner_id;
              filteredMetaField.push(result);
              result = {};
              break; // Use the first one found
            }
          }
        } else {
          result["sold_to_number"] = 1000;
          result["customer_id"] = idsArray[i];
          filteredMetaField.push(result);
          result = {};
        }
      } else {
        result["sold_to_number"] = 1000;
        result["customer_id"] = idsArray[i];
        filteredMetaField.push(result);
        result = {};
      }
    }

    // const newfilteredMetaField=new Map(filteredMetaField.map(item =>[item.sold_to_number,item.customer_id]));
    // console.log("Filtered Meta Filed Array =>", filteredMetaField, "\n\n");

    const customersArray = customers.data.map((item) => ({
      id: item.id,
      verified_email: item.verified_email
        ? "Email Verified"
        : "Email Not Verified",
      orders_count: item.orders_count,
      total_spent: item.total_spent,
    }));

    const combinedData = customersArray.map((itemB) => {
      const isMatch = filteredMetaField.find(
        (itemA) => itemA.customer_id == itemB.id
      );
      if (isMatch) {
        return {
          ...itemB,
          sold_to_number: isMatch.sold_to_number,
        };
      }
      return itemB;
    });

    // console.log("Combined data of customers arrays is in array of json =>", combinedData)

    const customerDataWithSoldTo = combinedData.map((obj) =>
      Object.values(obj)
    );

    // console.log("Combined data of customers arrays is in array of arrays =>", customerDataWithSoldTo)

    // console.log("#############################################\n\n");
    // console.log("Customer are =>",customers.data,"\n\n");
    // console.log("#############################################\n\n");
    console.log(" ** Response has been sent successfully called** \n\n");
    console.log("#############################################\n\n");

    res.status(200).json({
      message: "Cusomer List Found",
      Customers: customerDataWithSoldTo,
    });
  } catch (error) {
    res
      .status(500)
      .json({ error: "Internal Server Error", message: error.message });
  }
});

function doesSoldToNumberExist(metafieldsArray) {
  return metafieldsArray.some(
    (metafield) =>
      metafield.key === "sold_to_number" ||
      metafield.key === "customerid" ||
      metafield.key === "sap_account_number"
  );
}
app.use("/api/carttransformer", shopify.validateAuthenticatedSession(), carttransformerRouter);
app.get("/api/customersdata", async (req, res) => {
  console.log("Customer request received");

  try {
    let settings = await PriceChangeDB.Getsettings(
      res.locals.shopify.session.shop
    );
    const defaultSoldToNumber = settings[0]?.default_sold_to_number;
    // Session is built by the OAuth process

    const customers = await shopify.api.rest.Customer.all({
      session: res.locals.shopify.session,
    });

    const customersData = customers.data;

    const idsArray = customersData.map((customer) => customer.id);

    // const customerIdsString = customerIds.join(",");

    // // Pass the string in the API call

    // const customersWithEmails = await shopify.api.rest.Customer.all({
    //   session: res.locals.shopify.session,
    //   ids: customerIdsString,
    // });

    console.log("Now customer new date=>", customersWithEmails);

    console.log("id's of customers are=>", idsArray);

    const metafieldsPromises = idsArray.map(async (customerId) => {
      const metaFields = await shopify.api.rest.Metafield.all({
        session: res.locals.shopify.session,
        metafield: { owner_id: customerId, owner_resource: "customer" },
      });
      return { customerId, metaFields: metaFields.data };
    });

    const metafieldsData = await Promise.all(metafieldsPromises);

    const filteredMetaField = metafieldsData.map(
      ({ customerId, metaFields }) => {
        const soldToMetafield = metaFields.find(
          (metafield) =>
            metafield.key === "sold_to_number" ||
            metafield.key === "customerid" ||
            metafield.key === "sap_account_number"
        );
        const soldToNumber = soldToMetafield
          ? soldToMetafield.value
          : defaultSoldToNumber;
        return { customer_id: customerId, sold_to_number: soldToNumber };
      }
    );

    const customersArray = customersData.map((item) => ({
      customer_id: item.id,
      customer_name: item.first_name + " " + item.last_name,
      customer_email: item.email,
      customer_verified_email: item.verified_email
        ? "Email Verified"
        : "Email Not Verified",
      customer_orders_count: item.orders_count,
      customer_total_spent: item.total_spent,
    }));

    const combinedData = customersArray.map((itemB) => {
      const isMatch = filteredMetaField.find(
        (itemA) => itemA.customer_id === itemB.customer_id
      );
      if (isMatch) {
        return {
          ...itemB,
          sold_to_number: isMatch.sold_to_number,
        };
      }
      return itemB;
    });

    console.log(" ** Response has been sent successfully called** \n\n");
    res
      .status(200)
      .json({ message: "Customer List Found", Customers: combinedData });
  } catch (error) {
    res
      .status(500)
      .json({ error: "Internal Server Error", message: error.message });
  }
});

app.post("/api/savesoldto", async (req, res) => {
  try {
    // Session is built by the OAuth process

    const metafield = new shopify.api.rest.Metafield({
      session: res.locals.shopify.session,
    });
    metafield.customer_id = req.body.customerId;
    metafield.namespace = "custom";
    metafield.key = "sold_to_number";
    metafield.value = req.body.soldToNumber;
    metafield.type = "number_integer";
    const metafieldCreated = await metafield.save({
      update: true,
    });
  } catch (error) {
    console.log("Error in update meta field =>", error);
  }
  console.log("Request from front end");
  console.log("Req from sold to number api =>", req.body);
  res.status(200).send({ message: "Response Received from sold to api" });
});

app.put("/api/apiurlupdate", async (req, res) => {
  try {
    const key = Buffer.from(
      process.env.ENCRYPTION_KEY ? process.env.ENCRYPTION_KEY : "",
      "hex"
    );
    const apiURL = req.body.apiUrl;
    const encryptedURL = encrypt(apiURL, key);
    const updateApiUrl = await PriceChangeDB.UpdateApiUrl(
      res.locals.shopify.session.shop,
      encryptedURL
    );
    console.log(" ** Response has been sent **");
    res
      .status(200)
      .json({ message: "API Sccessfully Called", data: updateApiUrl });
  } catch (error) {
    res
      .status(500)
      .json({ error: "Internal Server Error", message: error.message });
  }
});

app.put("/api/soldtoupdate", async (req, res) => {
  try {
    const updateSoldTo = await PriceChangeDB.UpdateSoldToNumber(
      res.locals.shopify.session.shop,
      req.body.soldToNumber
    );
    console.log(" ** Response has been sent **");
    res.status(200).json({
      message: "Sold to Number Update API Sccessfully Called",
      data: updateSoldTo,
    });
  } catch (error) {
    console.log("Error in sold to number update API call => ", error);
    res
      .status(500)
      .json({ error: "Internal Server Error", message: error.message });
  }
});

app.put("/api/redis-settings", async (req, res) => {
  try {
    const shop = res.locals.shopify.session.shop;
    const { host, port, password, username } = req.body || {};
    let shopNameFromShopify = shop;
    try {
      const shopResponse = await shopify.api.rest.Shop.all({
        session: res.locals.shopify.session,
      });
      const shopData = shopResponse?.shop ?? shopResponse?.data?.[0];
      shopNameFromShopify = shopData?.name ?? shop;
    } catch (_) {}
    const update = await PriceChangeDB.UpdateRedisCredentials(shop, {
      shopName: shopNameFromShopify,
      host: host ?? null,
      port: port != null ? String(port) : null,
      password: password ?? null,
      username: username ?? null,
    });
    res.status(200).json({
      message: "Redis settings saved successfully",
      data: update,
    });
  } catch (error) {
    console.log("Error in redis settings update API call => ", error);
    res
      .status(500)
      .json({ error: "Internal Server Error", message: error.message });
  }
});


app.post("/api/carttransformer", async (req, res) => {
  console.log("[carttransformer] API route hit. Body:", req.body);
  const session = res.locals.shopify?.session;
  const shop = session?.shop;
  const adminAccessToken = session?.accessToken;
  const guid = req.body?.guid;
  const functionHandle = guid && String(guid).trim() ? String(guid).trim() : "imap-pricing";
 
  // Basic validation for internship-level production code
  if (!shop || !adminAccessToken) {
    return res.status(400).json({ error: "Missing shop or access token" });
  }
 
  const query = `
    mutation ActivateCartTransform {
      cartTransformCreate(
        functionHandle: "${functionHandle}"
      ) {
        cartTransform {
          id
          functionId
          blockOnFailure
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
 
  try {
    console.log("[carttransformer] Requested functionHandle:", functionHandle);
    const response = await fetch(
      `https://${shop}/admin/api/2026-04/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": adminAccessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
      },
    );
 
    const result = await response.json();
 
    // Fixed Error Handling Logic
    if (result.errors) {
      console.error("[GraphQL Error]:", result.errors);
      return res.status(500).json({ errors: result.errors });
    }
 
    if (response.ok) {
      console.log("Cart Transformer activated successfully:", result.data);
      return res.status(200).json(result.data);
    } else {
      console.error("Failed to activate Cart Transformer:", result);
      return res
        .status(500)
        .json({ error: "Failed to activate Cart Transformer" });
    }
  } catch (error) {
    console.error("[Server Error]:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/api/getsettings", async (req, res) => {
  try {
    const shop = res.locals.shopify.session.shop;
    let settings = await PriceChangeDB.Getsettings(shop);
    const key = Buffer.from(
      process.env.ENCRYPTION_KEY ? process.env.ENCRYPTION_KEY : "",
      "hex"
    );

    let shopNameFromShopify = null;
    try {
      const shopResponse = await shopify.api.rest.Shop.all({
        session: res.locals.shopify.session,
      });
      const shopData = shopResponse?.shop ?? shopResponse?.data?.[0];
      shopNameFromShopify = shopData?.name ?? shop;
    } catch (_) {
      shopNameFromShopify = shop;
    }
    if (settings.length > 0) {
      settings[0].shop_name = shopNameFromShopify;
      await PriceChangeDB.UpdateRedisCredentials(shop, { shopName: shopNameFromShopify });
    }

    const apiURL = settings[0]?.api_url ? settings[0].api_url : null;
    if (apiURL && key) {
      settings[0].api_url = decrypt(apiURL, key);
      res.status(200).json({
        message: "Get settings API Sccessfully Called",
        data: settings,
      });
    } else {
      const payload = settings.length
        ? settings
        : [{
            shop,
            shop_name: shopNameFromShopify,
            api_url: null,
            default_sold_to_number: null,
            redis_host: null,
            redis_port: null,
            redis_password: null,
            redis_username: null,
          }];
      res.status(200).json({
        message: settings.length ? "API URL not found" : "Get settings API Sccessfully Called",
        data: payload,
      });
    }
  } catch (error) {
    console.log("Error in get settings from update API call => ", error);
    res
      .status(500)
      .json({ error: "Internal Server Error", message: error.message });
  }
});

app.post("/api/sync-products", async (req, res) => {
  try {
    const session = res.locals.shopify.session;

    await PriceChangeDB.createProductSKUsTable();

    await PriceChangeDB.clearAllSKUs();

    console.log("Starting product sync for shop:", session.shop);

    let allProducts = [];
    let pageInfo = null;
    let hasNextPage = true;
    let pageCount = 0;

    while (hasNextPage) {
      const params = {
        session: session,
        limit: 250,
      };

      if (pageInfo) {
        params.page_info = pageInfo;
      }

      console.log(`Fetching products with params:`, JSON.stringify({ limit: params.limit, hasPageInfo: !!params.page_info }));
      
      const products = await shopify.api.rest.Product.all(params);
      
      if (!products || !products.data) {
        console.error("No product data received from Shopify API");
        break;
      }
      
      allProducts = allProducts.concat(products.data);

      if (products.pageInfo && products.pageInfo.hasNextPage) {
        pageInfo = products.pageInfo.nextPageUrl ?
          new URL(products.pageInfo.nextPageUrl).searchParams.get('page_info') : null;
        hasNextPage = !!pageInfo;
      } else {
        hasNextPage = false;
      }

      pageCount++;
      console.log(`Fetched page ${pageCount}, total products so far: ${allProducts.length}`);
    }

    console.log(`Total products fetched: ${allProducts.length}`);

    const skusSet = new Set();
    let totalVariants = 0;

    for (const product of allProducts) {
      if (product.variants && product.variants.length > 0) {
        for (const variant of product.variants) {
          if (variant.sku && variant.sku.trim() !== '') {
            skusSet.add(variant.sku.trim());
            totalVariants++;
          }
        }
      }
    }

    const uniqueSKUs = Array.from(skusSet);
    console.log(`Found ${uniqueSKUs.length} unique SKUs from ${totalVariants} variants`);

    let insertedCount = 0;
    let skippedCount = 0;

    for (const sku of uniqueSKUs) {
      const result = await PriceChangeDB.insertProductSKU(sku);
      if (result && result.skipped) {
        skippedCount++;
      } else {
        insertedCount++;
      }
    }

    console.log(`Sync complete. Inserted: ${insertedCount}, Skipped: ${skippedCount}`);

    res.status(200).json({
      message: "Products synced successfully",
      totalProducts: allProducts.length,
      totalVariants: totalVariants,
      uniqueSKUs: uniqueSKUs.length,
      inserted: insertedCount,
      skipped: skippedCount
    });
  } catch (error) {
    console.error("Error syncing products:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: error.message
    });
  }
});

app.post("/api/create-tax-product", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const product = new shopify.api.rest.Product({ session });
    product.title = "tax";
    product.variants = [{ price: "0.00" }];
    await product.save({ update: true });

    return res.status(200).json({
      message: "Tax product created successfully",
      productId: product.id,
      title: product.title,
    });
  } catch (error) {
    console.error("Error creating tax product:", error);
    return res.status(500).json({
      error: "Internal Server Error",
      message: error.message,
    });
  }
});

app.get("/api/list-all-products", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    let allProducts = [];
    let pageInfo = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const params = { session, limit: 250 };
      if (pageInfo) {
        params.page_info = pageInfo;
      }

      const products = await shopify.api.rest.Product.all(params);
      const batch = products?.data || [];
      allProducts = allProducts.concat(batch);

      if (products?.pageInfo?.hasNextPage && products.pageInfo.nextPageUrl) {
        pageInfo = new URL(products.pageInfo.nextPageUrl).searchParams.get("page_info");
        hasNextPage = !!pageInfo;
      } else {
        hasNextPage = false;
      }
    }

    return res.status(200).json({
      message: "Products fetched successfully",
      count: allProducts.length,
      products: allProducts,
    });
  } catch (error) {
    console.error("Error listing products:", error);
    return res.status(500).json({
      error: "Internal Server Error",
      message: error.message,
    });
  }
});

app.post("/api/update-tax-product-title", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const query = `
      mutation UpdateTaxProductTitle($input: ProductInput!) {
        productUpdate(input: $input) {
          product {
            id
            title
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      input: {
        id: "gid://shopify/Product/10522189955374",
        title: "Tax Amount",
      },
    };

    const response = await fetch(`https://${session.shop}/admin/api/2026-04/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": session.accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    const result = await response.json();
    const userErrors = result?.data?.productUpdate?.userErrors || [];
    if (!response.ok || result.errors?.length || userErrors.length) {
      return res.status(500).json({
        error: "Failed to update tax product title",
        message:
          userErrors[0]?.message ||
          result?.errors?.[0]?.message ||
          "Unknown Shopify error",
      });
    }

    return res.status(200).json({
      message: "Tax product title updated successfully",
      product: result.data.productUpdate.product,
    });
  } catch (error) {
    console.error("Error updating tax product title:", error);
    return res.status(500).json({
      error: "Internal Server Error",
      message: error.message,
    });
  }
});

app.use(shopify.cspHeaders());
app.use(serveStatic(STATIC_PATH, { index: false }));

app.use("/*", shopify.ensureInstalledOnShop(), async (_req, res, _next) => {
  return res
    .status(200)
    .set("Content-Type", "text/html")
    .send(readFileSync(join(STATIC_PATH, "index.html")));
});

const shop = "your-store.myshopify.com";
const accessToken = "your-access-token";

async function removeExpiredDiscounts() {
  try {
    const now = new Date();

    const priceRulesResponse = await axios.get(
      `https://${shop}/admin/api/2023-01/price_rules.json`,
      {
        headers: {
          "X-Shopify-Access-Token": accessToken,
        },
      }
    );

    const priceRules = priceRulesResponse.data.price_rules;

    const expiredPriceRules = priceRules.filter((rule) => {
      return rule.ends_at && new Date(rule.ends_at) <= now;
    });

    console.log(`Found ${expiredPriceRules.length} expired discount(s)`);

    for (const rule of expiredPriceRules) {
      await axios.delete(
        `https://${shop}/admin/api/2023-01/price_rules/${rule.id}.json`,
        {
          headers: {
            "X-Shopify-Access-Token": accessToken,
          },
        }
      );
      console.log(`Deleted expired discount: ${rule.title}`);
    }
  } catch (error) {
    console.error("Error removing expired discounts:", error.response?.data || error.message);
  }
}

const PORT = parseInt(process.env.PORT || process.env.BACKEND_PORT || "8081", 10);

app.listen(PORT, async () => {
  console.log(`App listening on port ${PORT}`);
  logRedisConnectionFromEnv("Server");
  console.log("[Server] CLIENT_API_URL:", process.env.CLIENT_API_URL || "(not set)");
  console.log("[Server] ENCRYPTION_KEY present:", !!process.env.ENCRYPTION_KEY);
  try {
    await PriceChangeDB.createSettingTable();
    await PriceChangeDB.ensureSettingsColumns();
    console.log("Settings table ready (migration applied if needed).");
  } catch (e) {
    console.error("Settings table init:", e.message);
  }
  try {
    shopify.api.webhooks.addHandlers(webhookHandlers);
    console.log("Webhook handlers registered (incl. ORDERS_CREATE). Subscriptions are created per shop on install/OAuth.");
  } catch (e) {
    console.error("Webhook addHandlers:", e.message);
  }
});
