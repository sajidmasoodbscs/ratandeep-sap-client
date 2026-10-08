/* PO Upload matching logic — pure functions, no DOM, no network.
 *
 * Ported 1:1 from backend/main.py + scripts/build_index.py so the
 * client-side module behaves exactly like the tested server version.
 * Works in the browser (window.POMatch) and in Node (module.exports).
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.POMatch = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var STOPWORDS = {};
  ["BLACK","CYAN","MAGENTA","YELLOW","TRICOLOR","TRI-COLOR","COLOR","COLOUR","TONER","INK","CARTRIDGE","DRUM","IMAGING","FUSER","MAINTENANCE","KIT","PACK","COMBO","TWIN","SINGLE","ORIGINAL","COMPATIBLE","REMANUFACTURED","REFURBISHED","HIGH","STANDARD","REGULAR","EXTRA","ULTRA","YIELD","CAPACITY","VALUE","MULTIPACK","PRINTER","PAPER","TRAY","ROLLER","WASTE","BOTTLE","BELT","TRANSFER","DEVELOPER","LASER","INKJET","SERIES"].forEach(function (w) { STOPWORDS[w] = 1; });

  var JUNK_TOKEN = /^(\d+[A-Z]?K|\d+PK|\d+P|\d+ST|\d+ND|\d+RD|\d+TH)$/; // 10K (page yield), 2PK (pack), 650P
  var PACK_SUFFIX = /^\d{1,3}(BX|PKS|PK|CTN|CT|PCS|PC|EA)$/;
  var BARE_3DIGIT = /^\d{3}$/;
  var BRAND_WORDS = {};
  ["CANON","HP","BROTHER","XEROX","LEXMARK","SAMSUNG","EPSON","DELL","OKI","OKIDATA","KYOCERA","RICOH","SHARP","TOSHIBA","KONICA","MINOLTA","PANASONIC","DYMO","PANTUM"].forEach(function (w) { BRAND_WORDS[w] = 1; });

  var CODE_PATTERNS = [
    /^\d{4}[A-Z]\d{3}$/,          // 8278B006, 5098C001 (Canon)
    /^\d{3}R\d{5}$/,              // 106R02778 (Xerox)
    /^[A-Z]{2,3}\d{3,4}[A-Z]{0,2}$/, // CF403X, TN450, PG245XL, DR630
    /^[A-Z]{3,4}\d{3,4}[A-Z]{0,2}$/, // PGI2200XL, T410XL, MLTD119S
    /^\d{2,3}[A-Z]{1,2}$/,        // 410A, 05X, 312X
    /^\d{3}$/,                    // 046, 119 (brand-preceded only)
    /^[A-Z]\d{4}[A-Z]$/,          // W1380X, C3734A
    /^[A-Z]\d[A-Z]\d{2}[A-Z]{1,2}$/, // T6M14AN (HP ink)
    /^SU\d{3}[A-Z]$/,             // SU864A (Samsung)
    /^T\d{3}[A-Z]*\d{3}[A-Z]$/,   // T410XL120S, T060320S (Epson)
    /^\d{2}[A-Z]\d[A-Z0-9]{3}$/,  // 82K1HY0 (Lexmark)
    /^[A-Z]\d{3}[A-Z]{2}\d$/,     // C331HC0 (Lexmark)
    /^[A-Z]\d{3}[A-Z]\d{2}[A-Z]$/, // T650H11A (Lexmark)
    /^\d{2}[A-Z]\d{4}$/           // 58D1000 (Lexmark)
  ];

  function stripPunct(t) { return t.replace(/^[,\;:()\[\]"']+|[,\;:()\[\]"']+$/g, ""); }

  function normalize(code) {
    return String(code == null ? "" : code).toUpperCase().replace(/[\s\-/_.]/g, "");
  }

  function looks_like_code(token) {
    var t = stripPunct(String(token).trim());
    if (!t || t.length > 14 || t.length < 3) return false;
    if (STOPWORDS[t]) return false;
    if (JUNK_TOKEN.test(t)) return false;
    return CODE_PATTERNS.some(function (p) { return p.test(t); });
  }

  function brand_preceded(tokens, i) {
    if (i <= 0) return false;
    return !!BRAND_WORDS[stripPunct(tokens[i - 1].toUpperCase())];
  }

  function extract_codes(title) {
    var found = [];
    // Blank out parenthetical phrases like "(100 Rolls per Case)".
    var clean = String(title).replace(/\([^)]*[a-z][^)]*\)/g, " ");
    clean = clean.replace(/\b\d+\s+[Rr]olls\s+[Pp]er\s+[Cc]ase\b/g, " ");
    // 1) parenthetical codes: (8278B006), (T212XL220-S) — skip lowercase phrases
    var pm = /\(([A-Za-z0-9][A-Za-z0-9\-/ ]{2,16})\)/g, m;
    while ((m = pm.exec(title)) !== null) {
      var candidate = m[1].trim();
      if (/[a-z]/.test(candidate)) continue;
      var parts = [candidate].concat(candidate.split(/[\s/]+/));
      for (var j = 0; j < parts.length; j++) {
        var norm = normalize(parts[j]);
        if (PACK_SUFFIX.test(norm)) continue;
        if (BARE_3DIGIT.test(norm)) continue;
        if (looks_like_code(norm)) found.push(norm);
      }
    }
    // 2) plain tokens
    var tokens = clean.split(/[\s/]+/);
    for (var i = 0; i < tokens.length; i++) {
      var norm2 = normalize(stripPunct(tokens[i]));
      if (BARE_3DIGIT.test(norm2) && !brand_preceded(tokens, i)) continue;
      if (looks_like_code(norm2)) found.push(norm2);
    }
    return found;
  }

  // ------------------------------------------------------------ quantities

  var QTY_UNITS = "(?:ea|pcs?|each|ctn|ctns|box|boxes|pk|pks|pack|packs|set|sets|cs|lot)";
  var RE_QTY_LABELED = new RegExp("(?:qty|quantity|qn?ty)\\s*[:\\-]?\\s*(\\d{1,5})", "i");
  var RE_QTY_UNIT_G = new RegExp("(\\d{1,5})\\s+" + QTY_UNITS + "\\b", "gi");
  var RE_QTY_X = /(?:^|\s)[x×]\s*(\d{1,5})\b|\b(\d{1,5})\s*[x×](?:\s|$)/;

  function guess_qty(line, code_token) {
    var m = RE_QTY_LABELED.exec(line);
    if (m) return [parseInt(m[1], 10), false];
    // Find "5 EACH" style quantities, but skip unit prices like "50.00 EACH"
    // (where the digits are the cents of a decimal price, not a quantity).
    RE_QTY_UNIT_G.lastIndex = 0;
    while ((m = RE_QTY_UNIT_G.exec(line)) !== null) {
      var before = m.index > 0 ? line.charAt(m.index - 1) : "";
      var after = line.charAt(m.index + m[0].length);
      if (before === "." || before === "," || /\d/.test(before) || after === ".") continue;
      return [parseInt(m[1], 10), false];
    }
    m = RE_QTY_X.exec(line);
    if (m) return [parseInt(m[1] || m[2], 10), false];
    // Bare quantity right before a price ("OEM20N1HK-SF 4 $190.41") —
    // no need to anchor on the product code first.
    var ptoks = line.split(/\s+/), qi;
    for (qi = 0; qi < ptoks.length - 1; qi++) {
      if (/^\d{1,5}$/.test(ptoks[qi]) && /^\$?\d[\d,]*\.\d{2}$/.test(ptoks[qi + 1])) {
        return [parseInt(ptoks[qi], 10), false];
      }
    }
    var tokens = line.split(/\s+/);
    if (code_token && tokens.length > 1 && /^\d+$/.test(tokens[0]) && line.indexOf(code_token) !== -1)
      return [parseInt(tokens[0], 10), false];
    if (code_token && tokens.length > 1 && /^\d+$/.test(tokens[tokens.length - 1]))
      return [parseInt(tokens[tokens.length - 1], 10), false];
    // "CF362A 32 200.00" style: qty is the bare integer right after the code,
    // especially when a decimal price follows it. Also handles
    // "C331HC0 OEMC331HC0-SF 2 $138.21" (qty after an SKU token).
    if (code_token) {
      var ci = -1;
      for (var k = 0; k < tokens.length; k++) {
        if (normalize(tokens[k]) === normalize(code_token)) { ci = k; break; }
      }
      if (ci !== -1) {
        // Strong signal: bare int followed by a price within a few tokens.
        for (var j = ci + 1; j < Math.min(ci + 4, tokens.length); j++) {
          if (/^\d{1,5}$/.test(tokens[j]) && /^\$?\d[\d,]*\.\d{2}$/.test(tokens[j + 1] || ""))
            return [parseInt(tokens[j], 10), false];
        }
        // Lenient: bare int immediately after the code.
        if (ci + 1 < tokens.length && /^\d{1,5}$/.test(tokens[ci + 1])) {
          var afterNext = tokens[ci + 2] || "";
          if (/^\d+\.\d{2}$/.test(afterNext) || ci + 1 === tokens.length - 1 || !/^\d/.test(afterNext))
            return [parseInt(tokens[ci + 1], 10), false];
        }
      }
    }
    return [1, true];
  }

  var HEADER_LINE_WORDS = ["purchase order","purchaseorder","p.o.","bill to","billto","ship to","shipto","order date","po number","po #","po#","subtotal","total","thank you","page "];

  function looks_like_header_line(line) {
    var low = line.toLowerCase();
    return HEADER_LINE_WORDS.some(function (w) { return low.indexOf(w) !== -1; });
  }

  // Prefer the candidate code with the best catalog match:
  // an exact single-product match beats an ambiguous one, which beats no match.
  // When several codes tie (e.g. a parenthetical list of color variants like
  // "(20N1HK0 20N1HC0 20N1HM0 20N1HY0)"), the description picks the winner.
  function pick_best_code(codes, catalog, line) {
    var best = codes[0], bestScore = -1, i, tied = [];
    for (i = 0; i < codes.length; i++) {
      var entry = catalog[normalize(codes[i])];
      var score = !entry ? 0 : (entry.length === 1 ? 2 : 1);
      if (score > bestScore) { bestScore = score; best = codes[i]; tied = [codes[i]]; }
      else if (score === bestScore) tied.push(codes[i]);
    }
    if (tied.length > 1 && line) {
      var seen = {}, handleToCode = {}, cands = [];
      tied.forEach(function (cd) {
        (catalog[normalize(cd)] || []).forEach(function (p) {
          if (!seen[p[0]]) { seen[p[0]] = 1; handleToCode[p[0]] = cd; cands.push(p); }
        });
      });
      var win = disambiguate_by_desc(line, cands, tied);
      if (win) return handleToCode[win[0]];
    }
    return best;
  }

  var PRICE_RE = /\$\s?\d[\d,]*\.\d{2}/;

  // Longest catalog key that is a strict prefix of the token, e.g.
  // token "LC501XLBK" -> key "LC501XL". Lets PO lines that spell the
  // full color-suffixed code match the catalog's base-code entry.
  var _prefixKeys = null, _prefixFor = null;
  function prefix_catalog_key(nc, catalog) {
    if (!/\d/.test(nc)) return null;
    if (_prefixFor !== catalog) {
      _prefixKeys = Object.keys(catalog).filter(function (k) { return k.length >= 4; })
        .sort(function (a, b) { return b.length - a.length; });
      _prefixFor = catalog;
    }
    for (var i = 0; i < _prefixKeys.length; i++) {
      var k = _prefixKeys[i];
      if (nc.length > k.length && nc.indexOf(k) === 0) return k;
    }
    return null;
  }

  // Resolve a raw token to a catalog key: exact match first, then the
  // longest key that prefixes the token.
  function catalog_key_for(nc, catalog) {
    if (catalog[nc]) return nc;
    return prefix_catalog_key(nc, catalog);
  }

  function extract_items_from_text(text, catalog) {
    var found = [], skipped = [];
    // Merge wrapped continuation lines back into their product row.
    // Supplier POs wrap the description across several visual lines while
    // the SKU/qty/price sit on the first line:
    //   "Original HP 923e OEM HP923EBK 3 $75.35 5% $237.35"
    //   "4K0T7LN Black Ink"
    //   "Cartridge High Yield"
    // Without merging, the type/color words needed for disambiguation
    // ("Black", "Original") are lost and the row can never auto-match.
    // Worse, a continuation line holding a color-variant code (e.g.
    // "20N1HC0") becomes a phantom item matching the WRONG variant.
    function is_product_row(t) {
      if (!PRICE_RE.test(t)) return false;
      var toks = t.split(/[\s,;|/()]+/), i;
      for (i = 0; i < toks.length; i++) {
        var raw = stripPunct(toks[i]);
        if (raw.length < 3 || /[$%]/.test(raw)) continue;
        var nc = normalize(raw);
        if (looks_like_code(nc) || (catalog && catalog[nc])) return true;
        // SKU-ish token: letters + digits, e.g. "OEM20N1HK-SF", "LC501XLOEMBK"
        if (/[A-Z]/.test(nc) && /\d/.test(nc) && nc.length >= 6) return true;
      }
      return false;
    }
    function is_junk_line(t) {
      return looks_like_header_line(t) || /powered by/i.test(t) ||
             /^(reference|notes?|cost summary)\b/i.test(t);
    }
    var merged = [];
    var lastIsRow = false;
    String(text).split(/\r?\n/).forEach(function (raw) {
      var t = raw.trim();
      if (!t) { merged.push(raw); lastIsRow = false; return; }
      if (lastIsRow && !PRICE_RE.test(t) && !is_junk_line(t)) {
        merged[merged.length - 1] += " " + t;
        return;
      }
      if (t.indexOf("(") === 0 && merged.length && !lastIsRow) {
        merged[merged.length - 1] += " " + t;
        return;
      }
      merged.push(raw);
      lastIsRow = is_product_row(t);
    });
    merged.forEach(function (raw) {
      var line = raw.trim();
      if (!line || line.length < 3) return;
      // Ignore parenthetical reference fragments (e.g. "(508A, #508A," or
      // "CF362AC)") — they're description text, not products. Blank an
      // unbalanced "(" to end-of-line, or start-of-line to an unbalanced ")".
      var forCodes = line;
      var oi = forCodes.indexOf("("), ci2 = forCodes.indexOf(")");
      if (oi !== -1 && ci2 === -1) forCodes = forCodes.slice(0, oi);
      else if (ci2 !== -1 && (oi === -1 || ci2 < oi)) forCodes = forCodes.slice(ci2 + 1);
      var codes = extract_codes(forCodes);
      // Catalog-aware: also accept tokens that are directly catalog codes
      // even if they don't match manufacturer code patterns (e.g. internal
      // SKUs like IQLASCE255X). Spaces/dashes are ignored by normalize.
      // A token that merely extends a catalog key (e.g. "LC501XLBK" for
      // key "LC501XL") resolves to that key.
      var prefixUsed = {};
      if (catalog) {
        forCodes.split(/[\s,;|/()]+/).forEach(function (tok) {
          var nc = normalize(stripPunct(tok));
          if (nc.length < 4) return;
          var key = catalog_key_for(nc, catalog);
          if (key && codes.indexOf(key) === -1) {
            codes.push(key);
            if (key !== nc) prefixUsed[key] = 1;
          }
        });
      }
      if (!codes.length) {
        if (!looks_like_header_line(line))
          skipped.push({ text: line.slice(0, 200), reason: "no product code found on this line" });
        return;
      }
      var code = pick_best_code(codes, catalog || {}, line);
      var code_token = null;
      var toks = line.split(/[\s,;|]+/);
      for (var i = 0; i < toks.length; i++) {
        var ntc = normalize(toks[i]);
        if (looks_like_code(ntc) || (catalog && catalog[ntc])) { code_token = toks[i].trim(); break; }
      }
      var qa = guess_qty(line, code_token);
      found.push({ code: code, qty: qa[0], desc: line.slice(0, 400),
                   qty_assumed: qa[1], via_prefix: !!prefixUsed[normalize(code)],
                   codes: codes });
    });
    return [found, skipped];
  }

  // --------------------------------------------------------------- matching

  var FUZZY_STOP = {};
  ["the","and","for","with","from","original","compatible","toner","ink","cartridge","cartridges","black","cyan","magenta","yellow","color","colour","high","standard","regular","extra","ultra","yield","pack","combo","remanufactured"].forEach(function (w) { FUZZY_STOP[w] = 1; });

  function word_set(s, extra_stop) {
    var words = {};
    (String(s).toLowerCase().match(/[a-z0-9]+/g) || []).forEach(function (w) {
      if (FUZZY_STOP[w] || (extra_stop && extra_stop[w])) return;
      words[w] = 1;
    });
    return words;
  }

  function fuzzy_suggestions(desc, all_products, limit) {
    limit = limit || 3;
    var words = {}, n = 0;
    (String(desc).toLowerCase().match(/[a-z0-9]+/g) || []).forEach(function (w) {
      if (FUZZY_STOP[w] || /^\d+$/.test(w)) return;
      if (looks_like_code(normalize(w))) return;
      if (!words[w]) { words[w] = 1; n++; }
    });
    if (!n) return [];
    var min_shared = n <= 3 ? 2 : 1;
    var scored = [];
    all_products.forEach(function (p) {
      var tw = word_set(p.title);
      var shared = 0;
      Object.keys(words).forEach(function (w) { if (tw[w]) shared++; });
      if (shared >= min_shared && shared / n >= 0.5) scored.push([shared / n, p]);
    });
    scored.sort(function (a, b) { return b[0] - a[0]; });
    return scored.slice(0, limit).map(function (s) { return { title: s[1].title, handle: s[1].handle }; });
  }

  // Disambiguate multiple catalog matches using the PO line description.
  // Scores candidates by type (Original/Compatible/Remanufactured),
  // color, and brand extracted from the description. Auto-matches only
  // when one candidate clearly outscores the rest.
  // Score ambiguous candidates against the PO line description.
  // Type = 3 pts, color = 2 pts, brand = 1 pt. Auto-matches only when one
  // candidate clearly wins. When several codes tied (pass them in), a final
  // coverage tie-break prefers the product mentioning the most line codes
  // (e.g. a universal "85A/35A/36A" compatible).
  function disambiguate_by_desc(desc, candidates, codes) {
    var d = String(desc || "").toUpperCase();
    var type = null, color = null, brand = null;
    if (/\bORIGINAL\b|\bOEM\b/.test(d)) type = "ORIGINAL";
    else if (/\bREMANUFACTURED\b|\bREMAN[A-Z]*\b|\bREFURBISHED\b/.test(d)) type = "REMANUFACTURED";
    else if (/\bCOMPATIBLE\b|\bGENERIC\b/.test(d)) type = "COMPATIBLE";
    if (/\bBLACK\b/.test(d)) color = "BLACK";
    else if (/\bCYAN\b/.test(d)) color = "CYAN";
    else if (/\bMAGENTA\b/.test(d)) color = "MAGENTA";
    else if (/\bYELLOW\b/.test(d)) color = "YELLOW";
    var brands = ["HP","LEXMARK","XEROX","BROTHER","CANON","SAMSUNG","EPSON","DELL","OKI","OKIDATA","KYOCERA","RICOH","SHARP","TOSHIBA","PANTUM","DYMO"];
    for (var i = 0; i < brands.length; i++) {
      if (d.indexOf(brands[i]) !== -1) { brand = brands[i]; break; }
    }
    if (!type && !color && !brand) return null;
    var scored = candidates.map(function(p) {
      var t = String(p[1] || "").toUpperCase();
      var s = 0;
      if (type === "ORIGINAL" && t.indexOf("ORIGINAL") !== -1) s += 3;
      else if (type === "COMPATIBLE" && t.indexOf("COMPATIBLE") !== -1) s += 3;
      else if (type === "REMANUFACTURED" && (t.indexOf("REMANUFACTURED") !== -1 || t.indexOf("REMAN") !== -1)) s += 3;
      if (color && t.indexOf(color) !== -1) s += 2;
      if (brand && t.indexOf(brand) !== -1) s += 1;
      return [s, p];
    });
    scored.sort(function(a, b) { return b[0] - a[0]; });
    if (!scored.length || scored[0][0] < 3) return null;
    var topScore = scored[0][0], tied = [], k;
    for (k = 0; k < scored.length; k++) {
      if (scored[k][0] === topScore) tied.push(scored[k][1]);
    }
    if (tied.length === 1) return tied[0];
    // Pack-size tie-break: "2 PACK" in the description prefers pack
    // products, otherwise prefer single cartridges.
    var packRe = /(\d+\s*PK\b|\d+\s*PACK|TWIN|COMBO|MULTIPACK)/;
    var dPack = packRe.test(d);
    var packTied = tied.filter(function (p) {
      return packRe.test(String(p[1] || "").toUpperCase()) === dPack;
    });
    if (packTied.length === 1) return packTied[0];
    // Coverage tie-break: prefer the product whose title mentions the
    // most of the line's codes.
    if (codes && codes.length > 1) {
      var normCodes = codes.map(function (c) { return normalize(c); });
      var covScored = tied.map(function (p) {
        var t = normalize(String(p[1] || ""));
        var cov = 0, ci;
        for (ci = 0; ci < normCodes.length; ci++) {
          if (normCodes[ci] && t.indexOf(normCodes[ci]) !== -1) cov++;
        }
        return [cov, p];
      });
      covScored.sort(function(a, b) { return b[0] - a[0]; });
      if (covScored[0][0] >= 2 && (covScored.length < 2 || covScored[0][0] > covScored[1][0])) {
        return covScored[0][1];
      }
    }
    return null;
  }

  // Title-based automatch for when the PO SKU isn't in the catalog.
  // Pulls code-like tokens from the description, collects catalog
  // candidates for each, and uses disambiguate_by_desc to pick one.
  function title_automatch(desc, catalog) {
    var seen = {}, candidates = [];
    String(desc || "").split(/[\s,;|/()]+/).forEach(function (tok) {
      var nc = normalize(stripPunct(tok));
      if (nc.length < 4) return;
      var key = catalog_key_for(nc, catalog);
      if (key && !seen[key]) {
        seen[key] = 1;
        catalog[key].forEach(function (p) { candidates.push(p); });
      }
    });
    if (!candidates.length) return null;
    // De-dupe by handle
    var seenH = {}, uniq = [];
    candidates.forEach(function (p) { if (!seenH[p[0]]) { seenH[p[0]] = 1; uniq.push(p); } });
    if (uniq.length === 1) return uniq[0];
    return disambiguate_by_desc(desc, uniq);
  }

  function match_item(item, catalog, all_products) {
    var code = normalize(item.code);
    var entry = catalog[code];
    if (!entry) {
      // SKU not in catalog: try title-based matching. Extract code-like
      // tokens from the description, gather candidates, and disambiguate
      // by type/color/brand.
      var titlePick = title_automatch(item.desc, catalog);
      if (titlePick) {
        return ["matched", {
          code: item.code, title: titlePick[1], handle: titlePick[0],
          qty: item.qty, qty_assumed: item.qty_assumed, confidence: "medium"
        }];
      }
      var reason = "code not found in catalog";
      if (item.qty_assumed) reason += "; quantity not shown, assumed 1";
      return ["unmatched", {
        text: item.desc, code_guess: item.code, qty: item.qty,
        qty_assumed: item.qty_assumed, reason: reason,
        suggestions: fuzzy_suggestions(item.desc, all_products)
      }];
    }
    // Pass 1: exact file-SKU == website variant SKU (spaces/dashes ignored
    // by normalize). An exact SKU hit always wins over title-alias matches.
    var skuHits = [];
    for (var i = 0; i < entry.length; i++) {
      var pSku = entry[i].length > 2 ? normalize(entry[i][2]) : "";
      if (pSku && pSku === code) skuHits.push(entry[i]);
    }
    var seenH = {};
    skuHits = skuHits.filter(function (p) { if (seenH[p[0]]) return false; seenH[p[0]] = 1; return true; });
    if (skuHits.length === 1) {
      return ["matched", {
        code: item.code, title: skuHits[0][1], handle: skuHits[0][0],
        qty: item.qty, qty_assumed: item.qty_assumed, confidence: "high"
      }];
    }
    if (skuHits.length > 1) {
      var skuPick = disambiguate_by_desc(item.desc, skuHits);
      if (skuPick) {
        return ["matched", {
          code: item.code, title: skuPick[1], handle: skuPick[0],
          qty: item.qty, qty_assumed: item.qty_assumed, confidence: "medium"
        }];
      }
    }
    if (entry.length > 1) {
      var pick = disambiguate_by_desc(item.desc, entry, item.codes);
      if (pick) {
        return ["matched", {
          code: item.code, title: pick[1], handle: pick[0],
          qty: item.qty, qty_assumed: item.qty_assumed, confidence: "medium"
        }];
      }
      return ["ambiguous", {
        code: item.code, qty: item.qty, qty_assumed: item.qty_assumed,
        reason: "code matches " + entry.length + " products -- please pick one",
        candidates: entry.map(function (p) { return { title: p[1], handle: p[0] }; })
      }];
    }
    return ["matched", {
      code: item.code, title: entry[0][1], handle: entry[0][0],
      qty: item.qty, qty_assumed: item.qty_assumed,
      confidence: item.via_prefix ? "medium" : "high"
    }];
  }

  function build_response(items, catalog, all_products, skipped) {
    var matched = [], unmatched = [], ambiguous = [];
    items.forEach(function (item) {
      var r = match_item(item, catalog, all_products);
      ({ matched: matched, unmatched: unmatched, ambiguous: ambiguous })[r[0]].push(r[1]);
    });
    (skipped || []).forEach(function (s) {
      var isNoise = s.reason.indexOf("no product code") === 0;
      unmatched.push({ text: s.text, code_guess: null, qty: null, qty_assumed: false, reason: s.reason, suggestions: [], ignored: isNoise });
    });
    return { matched: matched, unmatched: unmatched, ambiguous: ambiguous };
  }

  // ------------------------------------------------------------ spreadsheets

  var HEADER_CODE_WORDS = ["sku", "code", "item", "part", "model", "product", "#", "mpn"];
  var HEADER_QTY_WORDS = ["qty", "quantity", "qnty", "each", "amount"];
  var PRICE_WORDS = ["price", "val", "value", "total", "amount", "cost", "subtotal", "extended", "amt"];

  function header_has(row, words) {
    return row.some(function (c) {
      var low = String(c).toLowerCase();
      return words.some(function (w) { return low.indexOf(w) !== -1; });
    });
  }

  function rows_to_items(rows, catalog) {
    function clean(c) { return c == null ? "" : String(c).trim(); }
    rows = rows.map(function (r) { return r.map(clean); })
               .filter(function (r) { return r.some(function (c) { return c !== ""; }); });
    if (!rows.length) return [[], []];
    // Find the header row: scan the first few rows for one containing
    // code/qty header words (a title row like "PO 12345" may sit above it).
    var header_idx = -1;
    for (var hi = 0; hi < Math.min(5, rows.length); hi++) {
      var hh = rows[hi].map(function (c) { return c.toLowerCase(); });
      if (header_has(hh, HEADER_CODE_WORDS) || header_has(hh, HEADER_QTY_WORDS)) { header_idx = hi; break; }
    }
    var header, has_header, data;
    if (header_idx !== -1) {
      header = rows[header_idx].map(function (c) { return c.toLowerCase(); });
      has_header = true;
      data = rows.slice(header_idx + 1);
    } else {
      header = rows[0].map(function (c) { return c.toLowerCase(); });
      has_header = false;
      var first = rows[0];
      var looks_data = first.some(function (c) {
        return looks_like_code(normalize(c)) || /^\d{1,5}$/.test(c);
      });
      if (!looks_data) has_header = true;
      data = has_header ? rows.slice(1) : rows;
    }
    var ncols = Math.max.apply(null, rows.map(function (r) { return r.length; }));
    function col_vals(i) {
      return data.filter(function (r) { return i < r.length; }).map(function (r) { return r[i]; });
    }
    var code_col = null, qty_col = null, i, c;
    if (has_header) {
      for (i = 0; i < header.length; i++) {
        c = header[i];
        if (code_col === null && HEADER_CODE_WORDS.some(function (w) { return c.indexOf(w) !== -1; })) code_col = i;
        if (qty_col === null && HEADER_QTY_WORDS.some(function (w) { return c.indexOf(w) !== -1; })) qty_col = i;
      }
    }
    if (code_col === null) {
      var best = 0, best_n = -1;
      for (i = 0; i < ncols; i++) {
        if (has_header && i < header.length &&
            PRICE_WORDS.some(function (w) { return header[i].indexOf(w) !== -1; })) continue;
        // A column the header calls "Qty" is the quantity column, never the
        // code column — otherwise a qty like 120 (also a Canon code) hijacks
        // the row and the real code in the description is never found.
        if (has_header && qty_col !== null && i === qty_col) continue;
        // Count cells that are catalog codes or look like codes, so a column
        // of internal SKUs (which may not match code patterns) still wins.
        var n = col_vals(i).filter(function (v) {
          var nc = normalize(v);
          return catalog[nc] || looks_like_code(nc);
        }).length;
        if (n > best_n) { best = i; best_n = n; }
      }
      code_col = best_n > 0 ? best : 0;
    }
    if (qty_col === null) {
      var qbest = 0, qbest_n = -1;
      for (i = 0; i < ncols; i++) {
        if (i === code_col) continue;
        // Never pick a price/amount column as the quantity column.
        if (has_header && i < header.length &&
            PRICE_WORDS.some(function (w) { return header[i].indexOf(w) !== -1; })) continue;
        var qn = col_vals(i).filter(function (v) { return /^\d{1,5}$/.test(v); }).length;
        if (qn > qbest_n) { qbest = i; qbest_n = qn; }
      }
      qty_col = qbest_n > 0 ? qbest : null;
    }
    var items = [], skipped = [];
    data.forEach(function (r) {
      if (code_col >= r.length) return;
      var code = normalize(r[code_col]);
      // A value that's directly a catalog code (e.g. an internal SKU) is
      // accepted even if it doesn't match manufacturer code patterns.
      var fbViaPrefix = false;
      if (!catalog[code] && !looks_like_code(code)) {
        var text = r.filter(function (x) { return x; }).join(" | ");
        var fb = null;
        extract_codes(text).forEach(function (x) {
          if (fb === null) {
            var kk = catalog_key_for(normalize(x), catalog);
            if (kk) { fb = kk; fbViaPrefix = (kk !== normalize(x)); }
          }
        });
        // Last resort: a token that merely extends a catalog key
        // (e.g. "LC501XLBK" for key "LC501XL").
        if (fb === null) {
          text.split(/[\s,;|/()]+/).forEach(function (tok) {
            if (fb !== null) return;
            var nc2 = normalize(stripPunct(tok));
            if (nc2.length < 6) return;
            var k2 = prefix_catalog_key(nc2, catalog);
            if (k2) { fb = k2; fbViaPrefix = true; }
          });
        }
        if (fb === null) {
          if (text) skipped.push({ text: text.slice(0, 200), reason: "no product code found on this row" });
          return;
        }
        code = normalize(fb);
      }
      var qty = 1, assumed = true;
      if (qty_col !== null && qty_col < r.length) {
        var qm = /^(\d{1,5})$/.exec(r[qty_col]);
        if (qm) { qty = parseInt(qm[1], 10); assumed = false; }
      }
      items.push({ code: code, qty: qty, desc: r.filter(function (x) { return x; }).join(" | ").slice(0, 400), qty_assumed: assumed, via_prefix: fbViaPrefix });
    });
    return [items, skipped];
  }

  // Extract PO number and ship-to address from free text (PDF) or
  // spreadsheet rows (Excel). Returns { po_number, ship_to }.
  function extract_po_details(text, rows) {
    var po_number = "", ship_to = "";
    var lines = [];
    if (text) lines = String(text).split(/\r?\n/);
    else if (rows) lines = rows.map(function (r) { return r.join(" ").trim(); });
    var i, j, m;
    // PO number: "PO# 12345", "PO Number: ABC", "Purchase Order 35444", etc.
    for (i = 0; i < lines.length && !po_number; i++) {
      m = lines[i].match(/(?:P\.?\s*O\.?\s*(?:#|N[oO]\.?|Number)?|Purchase\s+Order)\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-\/]{1,30})/i);
      if (m) {
        var cand = m[1].replace(/[.,;:]+$/, "");
        // Avoid grabbing words like "PO Box" or bare labels.
        if (!/^(box|number|#)$/i.test(cand)) po_number = cand;
      }
    }
    // Ship-to: capture the lines following a "Ship To" / "Deliver To" label.
    // The label must start the line; multi-column headers like
    // "SUPPLIER SHIP TO BILL TO" are skipped (unreliable from flat text).
    for (i = 0; i < lines.length && !ship_to; i++) {
      var lm = lines[i].match(/^\s*(ship\s*to|deliver\s*to)\s*[:\-]?\s*(.*)$/i);
      if (lm && !/supplier|bill\s*to|p\.?\s*o\.?\s*(no|#|number)/i.test(lines[i].replace(lm[1], " "))) {
        var addr = [];
        var same = (lm[2] || "").trim();
        if (same) addr.push(same);
        for (j = i + 1; j < Math.min(i + 7, lines.length); j++) {
          var l = lines[j].trim();
          if (!l) { if (addr.length) break; else continue; }
          if (/^(bill\s*to|payment|products?\b|reference|notes?\b|cost\s+summary|supplier\b)/i.test(l)) break;
          addr.push(l);
        }
        if (addr.length) ship_to = addr.join(", ");
      }
    }
    return { po_number: po_number, ship_to: ship_to };
  }

  return {
    normalize: normalize,
    looks_like_code: looks_like_code,
    extract_codes: extract_codes,
    guess_qty: guess_qty,
    rows_to_items: rows_to_items,
    extract_items_from_text: extract_items_from_text,
    extract_po_details: extract_po_details,
    match_item: match_item,
    build_response: build_response,
    fuzzy_suggestions: fuzzy_suggestions,
    all_products: function (catalog) {
      var seen = {}, out = [];
      Object.keys(catalog).forEach(function (code) {
        catalog[code].forEach(function (p) {
          if (!seen[p[0]]) { seen[p[0]] = 1; out.push({ handle: p[0], title: p[1] }); }
        });
      });
      return out;
    }
  };
});
