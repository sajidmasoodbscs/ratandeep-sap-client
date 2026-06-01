export const SAP_WEBHOOK_URL =
  "https://webhooks.appseconnectapi.com/52f38dc4-a9b1-4eab-b3fd-4ce3890e1b83/bc0958e5-c79b-429c-92c0-ccc370e6cff2_default";

/** Keys used elsewhere in this app (custom.sold_to_number, etc.) */
const SAP_METAFIELD_KEYS = [
  "sap_account_number",
  "customerid",
  "sold_to_number",
  "sold-to-number",
  process.env.SOLD_TO_NUMBER,
  process.env.SHIP_TO_NUMBER,
].filter(Boolean);

export function logRedisConnectionFromEnv(context = "Redis") {
  const redisString = process.env.REDIS_STRING?.trim();
  if (!redisString) {
    console.warn(`[${context}] REDIS_STRING is not set`);
    return;
  }
  try {
    const url = new URL(redisString);
    const user = url.username ? decodeURIComponent(url.username) : "";
    const safeUrl = `${url.protocol}//${user ? `${user}:***@` : ""}${url.hostname}:${url.port || "6379"}`;
    console.log(`[${context}] REDIS_STRING (password redacted):`, safeUrl);
    console.log(`[${context}] REDIS_STRING host:`, url.hostname, "port:", url.port || "6379");
  } catch (e) {
    console.warn(`[${context}] REDIS_STRING is set but invalid:`, e.message);
  }
}

export function normalizeShopifyCustomerId(custId) {
  console.log("[SAP] normalizeShopifyCustomerId — input:", custId);
  if (custId == null || custId === "") {
    console.log("[SAP] normalizeShopifyCustomerId — empty input, returning null");
    return null;
  }
  const raw = String(custId).trim();
  const gidMatch = raw.match(/\/Customer\/(\d+)\s*$/i);
  const normalized = gidMatch ? gidMatch[1] : raw;
  console.log("[SAP] normalizeShopifyCustomerId — output:", normalized);
  return normalized;
}

export function toCustomerGid(shopifyCustId) {
  const numeric = normalizeShopifyCustomerId(shopifyCustId);
  if (!numeric) return null;
  if (String(shopifyCustId).includes("gid://")) return String(shopifyCustId).trim();
  return `gid://shopify/Customer/${numeric}`;
}

/** Normalize DB session row (snake_case) for Admin API calls */
export function normalizeAdminSession(session) {
  if (!session) return null;
  const shop = session.shop || session.Shop;
  const accessToken =
    session.accessToken ||
    session.access_token ||
    session.accesstoken ||
    session.adminAccessToken ||
    session.admin_access_token;
  console.log("[SAP] normalizeAdminSession — shop:", shop, "token present:", !!accessToken);
  if (!shop || !accessToken) return null;
  return { shop, accessToken };
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildSapRootCustomerXml(shopifyCustomerId) {
  console.log("[SAP] buildSapRootCustomerXml — shopifyCustomerId:", shopifyCustomerId);
  const id = escapeXml(normalizeShopifyCustomerId(shopifyCustomerId) || "");
  const xml = `<Root>
    <customer>
        <id>${id}</id>
    </customer>
</Root>`;
  console.log("[SAP] buildSapRootCustomerXml — outgoing XML:\n", xml);
  return xml;
}

function metafieldKeyMatches(key) {
  if (!key) return false;
  const k = String(key).toLowerCase();
  return SAP_METAFIELD_KEYS.some(
    (candidate) => candidate && String(candidate).toLowerCase() === k
  ) || ["sap_account_number", "customerid", "sold_to_number"].includes(k);
}

function pickSapValueFromMetafields(metafields) {
  for (const m of metafields || []) {
    if (m?.value && metafieldKeyMatches(m.key)) {
      return { value: String(m.value).trim(), key: m.key, namespace: m.namespace };
    }
  }
  return null;
}

async function fetchMetafieldsRest(adminSession, ownerId) {
  const url = `https://${adminSession.shop}/admin/api/2024-01/metafields.json?metafield[owner_id]=${ownerId}&metafield[owner_resource]=customer`;
  console.log("[SAP] REST metafields — GET", url);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": adminSession.accessToken,
      "Content-Type": "application/json",
    },
  });

  const text = await response.text();
  console.log("[SAP] REST metafields — status:", response.status);
  if (!response.ok) {
    console.log("[SAP] REST metafields — error body:", text.slice(0, 500));
    return { ok: false, metafields: [], error: text };
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    console.log("[SAP] REST metafields — JSON parse error:", e.message);
    return { ok: false, metafields: [], error: "invalid_json" };
  }

  const metafields = json.metafields || [];
  console.log("[SAP] REST metafields — count:", metafields.length);
  for (const m of metafields) {
    console.log("[SAP] REST metafield:", { namespace: m.namespace, key: m.key, value: m.value });
  }
  return { ok: true, metafields };
}

async function fetchMetafieldsGraphql(adminSession, shopifyCustId) {
  const gid = toCustomerGid(shopifyCustId);
  if (!gid) return { ok: false, metafields: [] };

  const query = `
    query CustomerMetafields($id: ID!) {
      customer(id: $id) {
        id
        metafields(first: 50) {
          edges {
            node {
              namespace
              key
              value
            }
          }
        }
      }
    }
  `;

  const url = `https://${adminSession.shop}/admin/api/2024-01/graphql.json`;
  console.log("[SAP] GraphQL metafields — POST", url, "customer:", gid);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": adminSession.accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: { id: gid } }),
  });

  const text = await response.text();
  console.log("[SAP] GraphQL metafields — status:", response.status);
  console.log("[SAP] GraphQL metafields — body:", text.slice(0, 800));

  if (!response.ok) return { ok: false, metafields: [] };

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, metafields: [] };
  }

  if (json.errors?.length) {
    console.log("[SAP] GraphQL errors:", json.errors);
    return { ok: false, metafields: [] };
  }

  const edges = json.data?.customer?.metafields?.edges || [];
  const metafields = edges.map((e) => ({
    namespace: e.node.namespace,
    key: e.node.key,
    value: e.node.value,
  }));

  console.log("[SAP] GraphQL metafields — count:", metafields.length);
  for (const m of metafields) {
    console.log("[SAP] GraphQL metafield:", m);
  }

  return { ok: true, metafields };
}

/**
 * Redis key prefix: prefer customer metafield SAP/sold-to id; fallback to Shopify customer id.
 */
export async function resolveRedisKeyPrefix(session, shopifyCustId) {
  const shopifyCustomerId = normalizeShopifyCustomerId(shopifyCustId);
  console.log("[SAP] resolveRedisKeyPrefix — start", { shopifyCustId, shopifyCustomerId });

  const adminSession = normalizeAdminSession(session);
  if (!adminSession) {
    console.warn("[SAP] resolveRedisKeyPrefix — invalid session (missing shop or access token)");
    if (shopifyCustomerId) {
      return {
        prefix: shopifyCustomerId,
        source: "shopify_fallback_no_session",
        shopifyCustomerId,
      };
    }
    return { prefix: null, source: "none", shopifyCustomerId };
  }

  const ownerIds = [...new Set([shopifyCustomerId, String(shopifyCustId).trim()].filter(Boolean))];

  for (const ownerId of ownerIds) {
    const rest = await fetchMetafieldsRest(adminSession, ownerId);
    const picked = pickSapValueFromMetafields(rest.metafields);
    if (picked) {
      console.log("[SAP] resolveRedisKeyPrefix — using REST metafield", picked);
      return {
        prefix: picked.value,
        source: "metafield_rest",
        metafieldKey: picked.key,
        shopifyCustomerId,
      };
    }
  }

  const gql = await fetchMetafieldsGraphql(adminSession, shopifyCustId);
  const pickedGql = pickSapValueFromMetafields(gql.metafields);
  if (pickedGql) {
    console.log("[SAP] resolveRedisKeyPrefix — using GraphQL metafield", pickedGql);
    return {
      prefix: pickedGql.value,
      source: "metafield_graphql",
      metafieldKey: pickedGql.key,
      shopifyCustomerId,
    };
  }

  if (shopifyCustomerId) {
    console.warn(
      "[SAP] resolveRedisKeyPrefix — no SAP metafield found; falling back to Shopify customer id for Redis keys"
    );
    return {
      prefix: shopifyCustomerId,
      source: "shopify_fallback",
      shopifyCustomerId,
    };
  }

  return { prefix: null, source: "none", shopifyCustomerId };
}

/** @deprecated Use resolveRedisKeyPrefix */
export async function fetchSapIdFromCustomerMetafields(session, shopifyCustId) {
  const { prefix } = await resolveRedisKeyPrefix(session, shopifyCustId);
  return prefix;
}

export async function postSapWebhook(xmlBody, label = "SAP") {
  console.log(`[SAP] postSapWebhook — ${label} — URL:`, SAP_WEBHOOK_URL);
  console.log(`[SAP] postSapWebhook — ${label} — OUTGOING XML:\n`, xmlBody);

  const response = await fetch(SAP_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/xml" },
    body: xmlBody,
  });

  const responseText = await response.text();
  console.log(`[SAP] postSapWebhook — ${label} — INCOMING status:`, response.status);
  console.log(`[SAP] postSapWebhook — ${label} — INCOMING body:\n`, responseText);

  return { ok: response.ok, status: response.status, text: responseText };
}
