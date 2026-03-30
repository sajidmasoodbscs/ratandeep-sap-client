import crypto from "crypto";

const verifyProxy = (req, res, next) => {
  console.log("===== VERIFY PROXY MIDDLEWARE =====");
  console.log("Request Method:", req.method);
  console.log("Request Path:", req.path);
  console.log("Request URL:", req.url);
  console.log("Request Query:", req.query);
  console.log("===================================");

  if (req.path === '/call-webhook' || req.path.endsWith('/call-webhook') ||
    req.path === '/sapcall' || req.path.endsWith('/sapcall')) {
    console.log("Skipping proxy verification for:", req.path);
    res.locals.user_shop = req.query.shop;
    return next();
  }

  console.log(
    "Verify proxy is calling and env is ",
    process.env.SHOPIFY_API_SECRET
  );
  const { signature } = req.query;

  if (!req._parsedUrl || !req._parsedUrl.query) {
    console.log("No query string found in request");
    return res.status(400).json({ error: "Missing query parameters" });
  }

  const queryURI = req._parsedUrl.query
    .replace("/?", "")
    .replace(/&signature=[^&]*/, "")
    .split("&")
    .map((x) => decodeURIComponent(x))
    .sort()
    .join("");

  const calculatedSignature = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET)
    .update(queryURI, "utf-8")
    .digest("hex");

  if (calculatedSignature === signature) {
    res.locals.user_shop = req.query.shop;
    next();
  } else {
    console.log("Signature verification failed. Expected:", calculatedSignature, "Got:", signature);
    res.sendStatus(401);
  }
};

export default verifyProxy;
