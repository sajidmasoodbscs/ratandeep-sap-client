import { BillingInterval } from "@shopify/shopify-api";
import { shopifyApp } from "@shopify/shopify-app-express";
import { restResources } from "@shopify/shopify-api/rest/admin/2024-10";
import { createPostgreSQLSessionStorage } from './db-config/dbconfig.js'; 
import { PriceChangeDB } from "./price-change-db.js";

const sessionDataBase=await createPostgreSQLSessionStorage();
PriceChangeDB.db = sessionDataBase;

const billingConfig = {
  "My Shopify One-Time Charge": {
    amount: 5.0,
    currencyCode: "USD",
    interval: BillingInterval.OneTime,
  },
};

const SHOPIFY_API_VERSION = "2024-10";

const shopify = shopifyApp({
  api: {
    apiVersion: SHOPIFY_API_VERSION,
    restResources,
    future: {
      customerAddressDefaultFix: true,
      lineItemBilling: true,
      unstable_managedPricingSupport: true,
    },
    billing: undefined,
  },
  auth: {
    path: "/api/auth",
    callbackPath: "/api/auth/callback",
  },
  webhooks: {
    path: "/api/webhooks",
  },
    sessionStorage: sessionDataBase,
});

export default shopify;
