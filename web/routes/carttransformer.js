import express from "express";
const router = express.Router();

router.post("/activate", async (req, res) => {
  console.log("[carttransformer] API route hit. Body:", req.body);
  const session = res.locals.shopify?.session;
  const shop = session?.shop;
  const adminAccessToken = session?.accessToken;
  const guid = req.body?.guid;
  const functionHandle =
    guid && String(guid).trim() ? String(guid).trim() : "vip-price-transform";

  // Basic validation for internship-level production code
  if (!shop || !adminAccessToken) {
    return res.status(400).json({ error: "Missing shop or access token" });
  }

  const query = `
      mutation ActivateCartTransform {
        cartTransformCreate(
          functionHandle: ${JSON.stringify(functionHandle)}
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

export default router;
