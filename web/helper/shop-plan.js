import fetch from 'node-fetch';
import { normalizeAdminSession } from './sap-api.js';

const PLUS_PLAN_NAMES = new Set([
  'shopify_plus',
  'plus_partner_sandbox',
  'unlimited', // legacy Plus-tier
]);

/**
 * @param {string} planName - Shopify REST shop.plan_name
 */
export function isShopifyPlusPlanName(planName) {
  if (!planName) return false;
  const normalized = String(planName).toLowerCase().trim();
  if (PLUS_PLAN_NAMES.has(normalized)) return true;
  return normalized.includes('plus');
}

/**
 * Load shop plan via Admin API (cached per request via caller).
 * Cart Transform at checkout requires Shopify Plus on most stores.
 */
export async function fetchShopPlan(session) {
  const admin = normalizeAdminSession(session);
  if (!admin) {
    console.warn('[ShopPlan] Missing shop or access token');
    return {
      ok: false,
      isShopifyPlus: false,
      planName: null,
      displayName: null,
      partnerDevelopment: false,
      error: 'invalid_session',
    };
  }

  const graphqlUrl = `https://${admin.shop}/admin/api/2024-10/graphql.json`;
  const query = `
    query ShopPlan {
      shop {
        plan {
          displayName
          partnerDevelopment
          shopifyPlus
        }
      }
    }
  `;

  try {
    const res = await fetch(graphqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': admin.accessToken,
      },
      body: JSON.stringify({ query }),
    });

    const text = await res.text();
    if (!res.ok) {
      console.warn('[ShopPlan] GraphQL HTTP', res.status, text.slice(0, 300));
      return await fetchShopPlanRest(admin);
    }

    const json = JSON.parse(text);
    if (json.errors?.length) {
      console.warn('[ShopPlan] GraphQL errors:', json.errors);
      return await fetchShopPlanRest(admin);
    }

    const plan = json.data?.shop?.plan;
    const isShopifyPlus = Boolean(plan?.shopifyPlus);
    const info = {
      ok: true,
      isShopifyPlus,
      planName: plan?.displayName || null,
      displayName: plan?.displayName || null,
      partnerDevelopment: Boolean(plan?.partnerDevelopment),
      source: 'graphql',
    };
    console.log('[ShopPlan]', admin.shop, info);
    return info;
  } catch (err) {
    console.warn('[ShopPlan] GraphQL failed:', err.message);
    return await fetchShopPlanRest(admin);
  }
}

async function fetchShopPlanRest(admin) {
  const url = `https://${admin.shop}/admin/api/2024-01/shop.json`;
  try {
    const res = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': admin.accessToken,
        'Content-Type': 'application/json',
      },
    });
    const json = await res.json();
    const planName = json.shop?.plan_name || null;
    const isShopifyPlus = isShopifyPlusPlanName(planName);
    const info = {
      ok: res.ok,
      isShopifyPlus,
      planName,
      displayName: planName,
      partnerDevelopment: planName === 'partner_test' || planName === 'plus_partner_sandbox',
      source: 'rest',
    };
    console.log('[ShopPlan] REST', admin.shop, info);
    return info;
  } catch (err) {
    console.error('[ShopPlan] REST failed:', err.message);
    return {
      ok: false,
      isShopifyPlus: false,
      planName: null,
      displayName: null,
      partnerDevelopment: false,
      error: err.message,
    };
  }
}
