export const PriceChangeDB = {
  shopify_session: "shopify_sessions",
  Settings: "settings",
  ProductSKUs: "product_skus",
  db: null,

  byShop: async function (shopDomain) {
    console.log("We are inside of database function to get session");
    const query = `
      SELECT * FROM public.${this.shopify_session}
      WHERE shop ='${shopDomain}';
    `;
    const result = await this.db.client.query(query);
    console.log("Response from database is =>", result);

    return result;
  },

  ensureSettingsColumns: async function () {
    if (!this.db?.client) return;
    const alterCols = [
      "ADD COLUMN IF NOT EXISTS Shop_name VARCHAR(255)",
      "ADD COLUMN IF NOT EXISTS Redis_host VARCHAR(512)",
      "ADD COLUMN IF NOT EXISTS Redis_port VARCHAR(32)",
      "ADD COLUMN IF NOT EXISTS Redis_password VARCHAR(512)",
      "ADD COLUMN IF NOT EXISTS Redis_username VARCHAR(255)",
    ];
    for (const alter of alterCols) {
      try {
        await this.db.client.query(`ALTER TABLE public.${this.Settings} ${alter}`);
      } catch (e) {
        // Table might not exist yet; ignore
      }
    }
  },
  createSettingTable: async function () {
    console.log("We are inside in create function");

    const query = `CREATE TABLE IF NOT EXISTS ${this.Settings} (
      ID SERIAL PRIMARY KEY NOT NULL,
    Shop VARCHAR ( 255 ) UNIQUE NOT NULL,
    Shop_name VARCHAR ( 255 ),
    Api_url VARCHAR (1024),
    Default_sold_to_number int,
    Redis_host VARCHAR ( 512 ),
    Redis_port VARCHAR ( 32 ),
    Redis_password VARCHAR ( 512 ),
    Redis_username VARCHAR ( 255 ),
    Created_on TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
    Last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`;
    try {
      const result = await this.db.client.query(query);
      console.log("Response from database is =>", result);
      // Add new columns to existing tables (no-op if already exist)
      const alterCols = [
        "ADD COLUMN IF NOT EXISTS Shop_name VARCHAR(255)",
        "ADD COLUMN IF NOT EXISTS Redis_host VARCHAR(512)",
        "ADD COLUMN IF NOT EXISTS Redis_port VARCHAR(32)",
        "ADD COLUMN IF NOT EXISTS Redis_password VARCHAR(512)",
        "ADD COLUMN IF NOT EXISTS Redis_username VARCHAR(255)",
      ];
      for (const alter of alterCols) {
        await this.db.client.query(`ALTER TABLE public.${this.Settings} ${alter}`).catch(() => {});
      }
      return result;
    } catch (error) {
      return "Error in database is =>" + error;
    }
  },
  InsertShopEntry: async function (shop) {
    if (!shop) return null;
    console.log("Ensuring shop entry in settings table for:", shop);
    const query = `INSERT INTO public.${this.Settings} (shop, api_url, default_sold_to_number)
    VALUES ($1, null, null)
    ON CONFLICT (shop) DO NOTHING`;
    try {
      const result = await this.db.client.query(query, [shop]);
      return result;
    } catch (error) {
      console.error("Error in InsertShopEntry:", error);
      return null;
    }
  },
  UpdateApiUrl: async function (shop, apiUrl) {
    console.log("We are inside of update api URL");
    if (shop && apiUrl) {
      const query = `UPDATE public.${this.Settings} SET api_url = '${apiUrl}', Last_updated = CURRENT_TIMESTAMP WHERE shop = '${shop}' RETURNING *`;
      try {
        const result = await this.db.client.query(query);
        const rows = result.rows || (Array.isArray(result) ? result : []);
        console.log("Database response for API URL update:", JSON.stringify(rows));
        return rows;
      } catch (error) {
        console.error("Error updating API URL:", error);
        return "Error in database during api url update is =>" + error;
      }
    } else {
      console.log("** API Url undefined ** ");
      return "** API Url undefined ** ";
    }
  },
  UpdateSoldToNumber: async function (shop, soldToNumber) {
    console.log("We are inside of update sold To Number");
    if (shop && soldToNumber) {
      const query = `UPDATE public.${this.Settings} SET default_sold_to_number = '${soldToNumber}',Last_updated=CURRENT_TIMESTAMP WHERE shop = '${shop}'`;
      try {
        const result = await this.db.client.query(query);
        console.log(
          "Response from database is by update sold to number in setting table =>",
          result
        );
        return result;
      } catch (error) {
        return "Error in database during sold to number update is =>" + error;
      }
    } else {
      console.log("** sold to number undefined ** ");
      return "** sold to number undefined ** ";
    }
  },
  UpdateRedisCredentials: async function (shop, { shopName, host, port, password, username }) {
    console.log("We are inside of update Redis credentials");
    if (!shop) {
      console.log("** shop undefined **");
      return "** shop undefined **";
    }

    // Ensure shop entry exists first
    await this.InsertShopEntry(shop);

    const setParts = [];
    const values = [];
    let i = 1;
    if (shopName !== undefined) {
      setParts.push(`Shop_name = $${i++}`);
      values.push(shopName == null ? null : String(shopName));
    }
    if (host !== undefined) {
      setParts.push(`Redis_host = $${i++}`);
      values.push(host == null ? null : String(host));
    }
    if (port !== undefined) {
      setParts.push(`Redis_port = $${i++}`);
      values.push(port == null ? null : String(port));
    }
    if (password !== undefined) {
      setParts.push(`Redis_password = $${i++}`);
      values.push(password == null ? null : String(password));
    }
    if (username !== undefined) {
      setParts.push(`Redis_username = $${i++}`);
      values.push(username == null ? null : String(username));
    }
    if (setParts.length === 0) return "Nothing to update";
    setParts.push("Last_updated = CURRENT_TIMESTAMP");
    
    // Add shop as the last value
    values.push(shop);
    const query = `UPDATE public.${this.Settings} SET ${setParts.join(", ")} WHERE shop = $${i} RETURNING *`;
    console.log("Executing Update Query:", query, "with values:", values);
    try {
      const result = await this.db.client.query(query, values);
      const rows = result.rows || (Array.isArray(result) ? result : []);
      console.log("Database update result rows:", JSON.stringify(rows));
      return rows;
    } catch (error) {
      console.error("Error in database during Redis credentials update:", error);
      return "Error in database during Redis credentials update is =>" + error;
    }
  },
  Getsettings: async function (shop) {
    console.log("We are inside of get settings function");
    if (shop) {
      // Ensure row exists so frontend gets consistent empty fields instead of null
      await this.InsertShopEntry(shop);
      
      const query = `SELECT shop, Shop_name as shop_name, api_url, default_sold_to_number, Redis_host as redis_host, Redis_port as redis_port, Redis_password as redis_password, Redis_username as redis_username FROM public.${this.Settings} WHERE shop = $1`;
      try {
        const result = await this.db.client.query(query, [shop]);
        if (result && result.rows) {
          return result.rows;
        }
        if (Array.isArray(result)) {
          return result;
        }
        return [];
      } catch (error) {
        console.error("Error in Getsettings:", error);
        return [];
      }
    } else {
      console.log("** shop undefined ** ");
      return [];
    }
  },

  createProductSKUsTable: async function () {
    console.log("We are inside create product SKUs table function");
    const query = `CREATE TABLE IF NOT EXISTS ${this.ProductSKUs} (
      ID SERIAL PRIMARY KEY NOT NULL,
      skus VARCHAR(255) NOT NULL,
      Created_on TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`;
    try {
      const result = await this.db.client.query(query);
      console.log("Response from database create product SKUs table =>", result);
      return result;
    } catch (error) {
      return "Error in database create product SKUs table is =>" + error;
    }
  },

  insertProductSKU: async function (sku) {
    console.log("We are inside insert product SKU function");
    if (sku) {
      // Check if SKU already exists
      const checkQuery = `SELECT * FROM public.${this.ProductSKUs} WHERE skus = '${sku.replace(/'/g, "''")}'`;
      const existing = await this.db.client.query(checkQuery);

      if (existing.rows && existing.rows.length > 0) {
        console.log(`SKU ${sku} already exists, skipping insert`);
        return { message: "SKU already exists", skipped: true };
      }

      const query = `INSERT INTO public.${this.ProductSKUs} (skus)
        VALUES ('${sku.replace(/'/g, "''")}')`;
      try {
        const result = await this.db.client.query(query);
        console.log("Response from database insert product SKU =>", result);
        return result;
      } catch (error) {
        return "Error in database insert product SKU is =>" + error;
      }
    } else {
      console.log("** SKU undefined ** ");
      return "** SKU undefined ** ";
    }
  },

  clearAllSKUs: async function () {
    console.log("We are inside clear all SKUs function");
    const query = `TRUNCATE TABLE public.${this.ProductSKUs}`;
    try {
      const result = await this.db.client.query(query);
      console.log("Response from database clear all SKUs =>", result);
      return result;
    } catch (error) {
      return "Error in database clear all SKUs is =>" + error;
    }
  },

  getAllProductSKUs: async function () {
    console.log("We are inside get all product SKUs function");
    console.log("Table name:", this.ProductSKUs);
    console.log("Database connection:", this.db ? "Available" : "NULL");

    if (!this.db) {
      console.error("Database connection is not initialized!");
      return [];
    }

    // Check different ways to access the client
    let client = null;
    if (this.db.client && typeof this.db.client.query === 'function') {
      client = this.db.client;
      console.log("Using db.client.query");
    } else if (this.db.query && typeof this.db.query === 'function') {
      client = this.db;
      console.log("Using db.query directly");
    } else {
      console.error("No query method available!");
      console.error("db.client:", this.db.client);
      console.error("db keys:", Object.keys(this.db));
      return [];
    }

    const query = `SELECT skus FROM public.${this.ProductSKUs} ORDER BY id`;
    console.log("Executing query:", query);

    try {
      const result = await client.query(query);
      console.log("Query executed successfully");
      console.log("Result type:", typeof result);
      console.log("Result keys:", result ? Object.keys(result) : "NULL");
      console.log("Is array:", Array.isArray(result));

      // Handle different result formats
      let rows = null;

      // Check if result is an array directly
      if (Array.isArray(result)) {
        console.log("Result is an array directly");
        rows = result;
      }
      // Check if result has a rows property (standard PostgreSQL format)
      else if (result && result.rows && Array.isArray(result.rows)) {
        console.log("Result has rows property");
        rows = result.rows;
      }
      // Check if result is an array-like object (numeric keys like '0', '1', '2', etc.)
      else if (result && typeof result === 'object' && !result.rows) {
        console.log("Result is array-like object, converting to array");
        // Check if it has numeric string keys (array-like)
        const keys = Object.keys(result);
        const hasNumericKeys = keys.length > 0 && keys.every(key => !isNaN(parseInt(key)));

        if (hasNumericKeys) {
          // Convert array-like object to array
          rows = Array.from({ length: keys.length }, (_, i) => result[i.toString()]).filter(item => item != null);
        } else {
          // Try to convert using Array.from
          rows = Array.from(result).filter(item => item != null);
        }
      }

      if (!rows || rows.length === 0) {
        console.error("No rows found in result");
        console.error("Result:", result);
        return [];
      }

      console.log("Number of rows:", rows.length);
      console.log("First row sample:", JSON.stringify(rows[0]));

      const skus = rows.map(row => {
        // Handle both object format {skus: "value"} and direct value
        if (typeof row === 'object' && row !== null) {
          return row.skus || row.SKUS || row.Sku || null;
        }
        return typeof row === 'string' ? row : null;
      }).filter(sku => sku != null && typeof sku === 'string' && sku.trim() !== '');

      console.log("Extracted SKUs:", skus);
      console.log("Total SKUs found:", skus.length);
      return skus;
    } catch (error) {
      console.error("Error in database get all product SKUs:");
      console.error("Error message:", error.message);
      console.error("Error stack:", error.stack);
      console.error("Full error:", error);
      return [];
    }
  },
};
