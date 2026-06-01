export const SAP_WEBHOOK_URL =
  "https://webhooks.appseconnectapi.com/52f38dc4-a9b1-4eab-b3fd-4ce3890e1b83/bc0958e5-c79b-429c-92c0-ccc370e6cff2_default";

const METAFIELD_KEYS = [
  "sap_account_number",
  "customerid",
  process.env.SOLD_TO_NUMBER,
].filter(Boolean);

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

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** SAP request body: Shopify customer id inside &lt;Root&gt;&lt;customer&gt;&lt;id&gt;…&lt;/id&gt;&lt;/customer&gt;&lt;/Root&gt; */
export function buildSapRootCustomerXml(shopifyCustomerId) {
  console.log("[SAP] buildSapRootCustomerXml — shopifyCustomerId:", shopifyCustomerId);
  const id = escapeXml(normalizeShopifyCustomerId(shopifyCustomerId) || "");
  const xml = `<Root>
    <customer>
        <id>${id}</id>
    </customer>
</Root>`;
  console.log("[SAP] buildSapRootCustomerXml — built XML:\n", xml);
  return xml;
}

/**
 * Fetch SAP account number from customer metafields (for Redis keys).
 * SAP API XML uses Shopify customer id; Redis uses metafield value.
 */
export async function fetchSapIdFromCustomerMetafields(session, shopifyCustId) {
  const ownerId = normalizeShopifyCustomerId(shopifyCustId);
  console.log("[SAP] fetchSapIdFromCustomerMetafields — start", {
    shop: session?.shop,
    shopifyCustId,
    ownerId,
    lookupKeys: METAFIELD_KEYS,
  });

  if (!session?.shop || !ownerId) {
    console.log("[SAP] fetchSapIdFromCustomerMetafields — missing session.shop or ownerId");
    return null;
  }

  const url = `https://${session.shop}/admin/api/2023-07/metafields.json?metafield[owner_id]=${ownerId}&metafield[owner_resource]=customers`;
  console.log("[SAP] fetchSapIdFromCustomerMetafields — GET", url);
  console.log("[SAP] fetchSapIdFromCustomerMetafields — access token present:", !!session.accessToken);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": session.accessToken,
        "Content-Type": "application/json",
      },
    });

    console.log("[SAP] fetchSapIdFromCustomerMetafields — response status:", response.status);

    if (!response.ok) {
      const errText = await response.text();
      console.log("[SAP] fetchSapIdFromCustomerMetafields — non-OK body:", errText?.slice(0, 500));
      return null;
    }

    const customerMetaFields = await response.json();
    const metafields = customerMetaFields.metafields || [];
    console.log(
      "[SAP] fetchSapIdFromCustomerMetafields — metafield count:",
      metafields.length
    );

    for (const m of metafields) {
      console.log("[SAP] fetchSapIdFromCustomerMetafields — metafield:", {
        id: m.id,
        namespace: m.namespace,
        key: m.key,
        value: m.value,
      });
    }

    const sapMetafield = metafields.find(
      (m) =>
        METAFIELD_KEYS.includes(m.key) ||
        m.key === "sap_account_number" ||
        m.key === "customerid" ||
        (process.env.SOLD_TO_NUMBER && m.key === process.env.SOLD_TO_NUMBER)
    );

    if (sapMetafield?.value) {
      console.log("[SAP] fetchSapIdFromCustomerMetafields — matched key:", sapMetafield.key, "value:", sapMetafield.value);
      return String(sapMetafield.value).trim();
    }

    console.log(
      "[SAP] fetchSapIdFromCustomerMetafields — no SAP id metafield. Keys seen:",
      metafields.map((m) => m.key)
    );
    return null;
  } catch (error) {
    console.error("[SAP] fetchSapIdFromCustomerMetafields — error:", error.message);
    return null;
  }
}

export async function postSapWebhook(xmlBody, label = "SAP") {
  console.log(`[SAP] postSapWebhook — ${label} — URL:`, SAP_WEBHOOK_URL);
  console.log(`[SAP] postSapWebhook — ${label} — request body:\n`, xmlBody);

  const response = await fetch(SAP_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/xml" },
    body: xmlBody,
  });

  const responseText = await response.text();
  console.log(`[SAP] postSapWebhook — ${label} — status:`, response.status);
  console.log(`[SAP] postSapWebhook — ${label} — response:\n`, responseText);

  return { ok: response.ok, status: response.status, text: responseText };
}
