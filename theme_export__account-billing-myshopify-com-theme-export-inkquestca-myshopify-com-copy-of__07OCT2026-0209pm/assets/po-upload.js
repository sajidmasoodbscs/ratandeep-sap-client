/* PO Upload storefront logic — 100% client-side, no server.
 *
 * Flow:
 *   1. On load: fetch the catalog index (po-catalog-index.json theme asset).
 *   2. Customer picks/drops a PO file. It is parsed right in the browser:
 *      XLS/XLSX via SheetJS, PDF via pdf.js.
 *      All parser libraries are bundled with the theme / store files —
 *      nothing is loaded from third-party CDNs, nothing to install.
 *   3. POMatch (po-match.js) finds product codes + quantities per line and
 *      matches them against the catalog index: matched / ambiguous / unmatched.
 *   4. "Add matched items to cart" -> resolve each handle through the
 *      public /products/{handle}.js storefront endpoint. The variant whose
 *      SKU matches the PO file's SKU is used (exact SKU-to-SKU match).
 *      Items that are out of stock are offered as backorder items first —
 *      the customer chooses whether to add them.
 *   5. POST the items to /cart/add.js, then go to /cart.
 * Nothing is ever added to the cart without the customer pressing the button.
 * The PO file never leaves the customer's browser.
 */
(function () {
  "use strict";

  var ACCEPTED = [".pdf", ".xls", ".xlsx"];
  var MAX_BYTES = 10 * 1024 * 1024;

  var CATALOG = null;
  var ALL_PRODUCTS = [];

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function normSku(s) {
    return String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  var scriptCache = {};
  function loadScript(src, kind) {
    if (scriptCache[src]) return scriptCache[src];
    scriptCache[src] = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () {
        reject(new Error("Could not load the " + (kind || "file parser") + ". Check your connection and try again."));
      };
      document.head.appendChild(s);
    });
    return scriptCache[src];
  }

  // Fetch a same-origin blob: URL for a worker script so `new Worker()`
  // never depends on cross-origin script loading.
  var workerUrlCache = {};
  function workerUrl(src) {
    if (workerUrlCache[src]) return workerUrlCache[src];
    workerUrlCache[src] = fetch(src).then(function (resp) {
      if (!resp.ok) throw new Error("worker");
      return resp.text();
    }).then(function (text) {
      return URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
    });
    return workerUrlCache[src];
  }

  function readFile(file, asText) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(new Error("Could not read the file.")); };
      if (asText) r.readAsText(file);
      else r.readAsArrayBuffer(file);
    });
  }

  function extOf(name) {
    name = name.toLowerCase();
    var i = name.lastIndexOf(".");
    return i === -1 ? "" : name.slice(i);
  }

  // ---- section ------------------------------------------------------------

  function init(section) {
    var indexUrl = section.getAttribute("data-index-url") || "";
    // Parser libraries bundled with the theme / store files (no third-party CDN).
    var XLSX_URL = section.getAttribute("data-xlsx-url") || "";
    var PDFJS_URL = section.getAttribute("data-pdfjs-url") || "";
    var PDFJS_WORKER_URL = section.getAttribute("data-pdfjs-worker-url") || "";
    var TESS_URL = section.getAttribute("data-tesseract-url") || "";
    var TESS_WORKER_URL = section.getAttribute("data-tesseract-worker-url") || "";
    // The worker derives exact filenames from these base URLs, so we pass the
    // full theme-asset URLs and strip the filename in JS.
    var TESS_CORE_URL = (section.getAttribute("data-tesseract-core-file-url") || "").replace(/\/[^\/]*$/, "");
    var TESS_LANG_URL = (section.getAttribute("data-tesseract-lang-file-url") || "").replace(/\/[^\/]*$/, "");

    var dropzone = $("[data-po-dropzone]", section);
    var fileInput = $("[data-po-input]", section);
    var status = $("[data-po-status]", section);
    var results = $("[data-po-results]", section);
    var matchedBody = $("[data-po-matched]", section);
    var ambWrap = $("[data-po-ambiguous-wrap]", section);
    var ambBody = $("[data-po-ambiguous]", section);
    var unWrap = $("[data-po-unmatched-wrap]", section);
    var unBody = $("[data-po-unmatched]", section);
    var addBtn = $("[data-po-add]", section);
    var cartNote = $("[data-po-cart-note]", section);
    var detailsWrap = $("[data-po-details]", section);
    var poNumberInput = $("[data-po-number]", section);
    var shipToRow = $("[data-po-shipto-row]", section);
    var shipToText = $("[data-po-shipto]", section);

    function setStatus(msg, isError) {
      status.hidden = !msg;
      status.textContent = msg || "";
      status.classList.toggle("po-upload__status--error", !!isError);
    }

    if (typeof POMatch === "undefined") {
      setStatus("The PO upload scripts did not load. Please refresh the page.", true);
      dropzone.style.display = "none";
      return;
    }
    if (!indexUrl) {
      setStatus("The product catalog for PO upload is missing. Please contact the store.", true);
      dropzone.style.display = "none";
      return;
    }

    // ---- file parsers: each resolves to [items, skipped] -------------------

    function parseSpreadsheet(file) {
      var ext = extOf(file.name);
      var read = ext === ".csv" ? readFile(file, true) : readFile(file, false);
      return read.then(function (data) {
        return loadScript(XLSX_URL, "spreadsheet reader").then(function () {
          var wb = ext === ".csv"
            ? XLSX.read(data, { type: "string" })
            : XLSX.read(data, { type: "array" });
          var ws = wb.Sheets[wb.SheetNames[0]];
          var rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
          var res = POMatch.rows_to_items(rows, CATALOG);
          res.push(rows);
          return res;
        });
      });
    }

    // Group pdf.js text items into visual lines using their Y coordinates.
    // (Joining all items with spaces collapses multi-line POs into one line,
    // so only the first product code on the page was ever extracted.)
    // Extract ship-to from a multi-column PDF header (e.g.
    // "SUPPLIER SHIP TO BILL TO") using x positions. Finds the SHIP TO
    // header, bounds its column by neighboring headers, and reads the
    // text below within that column.
    function extractShipToColumn(pagesItems) {
      for (var p = 0; p < pagesItems.length; p++) {
        var items = pagesItems[p];
        var ship = null, i;
        for (i = 0; i < items.length; i++) {
          if (/ship/i.test(items[i].str) && !/ship\s*to/i.test(items[i].str)) continue;
          if (/\bship\s*to\b/i.test(items[i].str)) { ship = items[i]; break; }
          // "SHIP" + "TO" as two adjacent items
          if (/^\s*ship\s*$/i.test(items[i].str) && i + 1 < items.length &&
              /^\s*to:?\s*$/i.test(items[i + 1].str) &&
              Math.abs(items[i + 1].y - items[i].y) < 3) { ship = items[i]; break; }
        }
        if (!ship) continue;
        var lineY = ship.y;
        var headers = items.filter(function (it) {
          return Math.abs(it.y - lineY) < 4 && it.str.trim();
        }).sort(function (a, b) { return a.x - b.x; });
        var idx = headers.indexOf(ship);
        var leftX = ship.x;
        var rightX = (idx + 1 < headers.length) ? headers[idx + 1].x : 1e9;
        var colItems = items.filter(function (it) {
          return it.y < lineY - 4 && it.x >= leftX - 8 && it.x < rightX - 8 && it.str.trim();
        });
        var lines = [];
        colItems.forEach(function (it) {
          var placed = false, j;
          for (j = 0; j < lines.length; j++) {
            if (Math.abs(lines[j].y - it.y) < 3) { lines[j].items.push(it); placed = true; break; }
          }
          if (!placed) lines.push({ y: it.y, items: [it] });
        });
        lines.sort(function (a, b) { return b.y - a.y; });
        // Stop at the products table header.
        var out = [];
        for (var k = 0; k < Math.min(6, lines.length); k++) {
          lines[k].items.sort(function (a, b) { return a.x - b.x; });
          var t = lines[k].items.map(function (o) { return o.str; }).join(" ").trim();
          // Stop at the products table or any PO form header row
          // (Reference / PO Date / Expected Arrival etc. are not address).
          if (/^(activity|products?|qty|item|reference|contact|vendor)\b/i.test(t)) break;
          if (/\bpo\s*date\b|\bexpected\s*arrival\b/i.test(t)) break;
          if (t) out.push(t);
        }
        if (out.length) return out.join(", ");
      }
      return "";
    }

    function pdfItemsToLines(items) {
      var rows = [];
      (items || []).forEach(function (it) {
        var str = it.str;
        if (!str || !str.trim()) return;
        var t = it.transform || [0, 0, 0, 0, 0, 0];
        var x = t[4], y = t[5], placed = false;
        for (var i = 0; i < rows.length; i++) {
          if (Math.abs(rows[i].y - y) < 3) {
            rows[i].items.push({ x: x, str: str });
            var n = rows[i].items.length;
            rows[i].y = (rows[i].y * (n - 1) + y) / n;
            placed = true;
            break;
          }
        }
        if (!placed) rows.push({ y: y, items: [{ x: x, str: str }] });
      });
      rows.sort(function (a, b) { return b.y - a.y; });
      return rows.map(function (r) {
        r.items.sort(function (a, b) { return a.x - b.x; });
        return r.items.map(function (o) { return o.str; }).join(" ");
      });
    }

    function parsePdf(file) {
      return readFile(file, false).then(function (buf) {
        return loadScript(PDFJS_URL, "PDF reader").then(function () {
          /* global pdfjsLib */
          return workerUrl(PDFJS_WORKER_URL);
        }).then(function (wUrl) {
          pdfjsLib.GlobalWorkerOptions.workerSrc = wUrl;
          return pdfjsLib.getDocument({ data: buf }).promise;
        }).then(function (pdf) {
          var jobs = [];
          for (var p = 1; p <= pdf.numPages; p++) {
            jobs.push(pdf.getPage(p).then(function (page) {
              return page.getTextContent();
            }).then(function (tc) {
              // Keep positioned items for column-aware ship-to extraction.
              var pos = tc.items.map(function (it) {
                var t = it.transform || [0, 0, 0, 0, 0, 0];
                return { x: t[4], y: t[5], str: it.str };
              });
              return { lines: pdfItemsToLines(tc.items).join("\n"), pos: pos };
            }));
          }
          return Promise.all(jobs);
        }).then(function (pages) {
          var text = pages.map(function (pg) { return pg.lines; }).join("\n");
          var res = POMatch.extract_items_from_text(text, CATALOG);
          res.push(text);
          // Column-aware ship-to for multi-column headers.
          var colShip = extractShipToColumn(pages.map(function (pg) { return pg.pos; }));
          if (colShip) res.push(colShip);
          return res;
        });
      });
    }

    function parseImage(file, setStatus) {
      setStatus("Reading the photo — this can take up to a minute…", false);
      return readFile(file, false).then(function (buf) {
        return loadScript(TESS_URL, "photo reader").then(function () {
          /* global Tesseract */
          return workerUrl(TESS_WORKER_URL);
        }).then(function (wUrl) {
          return Tesseract.recognize(new Blob([buf]), "eng", {
            workerPath: wUrl,
            corePath: TESS_CORE_URL,
            langPath: TESS_LANG_URL
          });
        }).then(function (res) {
          var text = (res && res.data && res.data.text) || "";
          return POMatch.extract_items_from_text(text, CATALOG);
        });
      });
    }

    function parseFile(file, setStatus) {
      var ext = extOf(file.name);
      if (ext === ".pdf") return parsePdf(file);
      return parseSpreadsheet(file); // .xls .xlsx
    }

    // ---- backorder dialog ---------------------------------------------------

    var boOverlay = document.createElement("div");
    boOverlay.className = "po-upload__bo-overlay";
    boOverlay.hidden = true;
    boOverlay.innerHTML =
      '<div class="po-upload__bo-dialog" role="dialog" aria-modal="true">' +
      "<h3>Some items are out of stock</h3>" +
      "<p>These items are not in stock right now. Tick the ones you still want to add as <strong>backorder</strong> items.</p>" +
      '<div data-po-bo-list></div>' +
      '<div class="po-upload__bo-actions">' +
      '<button type="button" data-po-bo-add>Add to cart</button>' +
      '<button type="button" data-po-bo-skip>Skip these items</button>' +
      "</div></div>";
    section.appendChild(boOverlay);
    var boList = $("[data-po-bo-list]", boOverlay);

    function askBackorder(backordered, done) {
      boList.innerHTML = "";
      backordered.forEach(function (r, i) {
        var row = document.createElement("label");
        row.className = "po-upload__bo-row";
        row.innerHTML =
          '<input type="checkbox" data-po-bo-check="' + i + '" checked> ' +
          "<span><strong>" + esc(r.code) + "</strong> — " + esc(r.title) +
          " (qty " + r.quantity + ")</span>";
        boList.appendChild(row);
      });
      boOverlay.hidden = false;
      function close() { boOverlay.hidden = true; }
      $("[data-po-bo-add]", boOverlay).onclick = function () {
        var chosen = [];
        $all("[data-po-bo-check]", boOverlay).forEach(function (cb) {
          if (cb.checked) chosen.push(backordered[parseInt(cb.getAttribute("data-po-bo-check"), 10)]);
        });
        close();
        done(chosen);
      };
      $("[data-po-bo-skip]", boOverlay).onclick = function () {
        close();
        done([]);
      };
    }

    // ---- catalog ----------------------------------------------------------

    dropzone.style.display = "none";
    setStatus("Loading product catalog…", false);
    fetch(indexUrl).then(function (resp) {
      if (!resp.ok) throw new Error("catalog");
      return resp.json();
    }).then(function (idx) {
      CATALOG = idx;
      ALL_PRODUCTS = POMatch.all_products(idx);
      setStatus("", false);
      dropzone.style.display = "";
    }).catch(function () {
      setStatus("Could not load the product catalog. Please refresh the page.", true);
    });

    function validFile(file) {
      var okExt = ACCEPTED.indexOf(extOf(file.name)) !== -1;
      if (!okExt) { setStatus("That file type is not accepted. Please upload a PDF or Excel (.xls/.xlsx) file.", true); return false; }
      if (file.size > MAX_BYTES) { setStatus("That file is larger than 10 MB. Please upload a smaller file.", true); return false; }
      return true;
    }

    function process(file) {
      if (!CATALOG) { setStatus("The catalog is still loading — please wait a moment.", true); return; }
      setStatus("Reading your PO, please wait…", false);
      results.hidden = true;
      parseFile(file, setStatus).then(function (pair) {
        var data = POMatch.build_response(pair[0], CATALOG, ALL_PRODUCTS, pair[1]);
        var details = null;
        if (pair[2] !== undefined) {
          details = (typeof pair[2] === "string")
            ? POMatch.extract_po_details(pair[2], null)
            : POMatch.extract_po_details(null, pair[2]);
          // Column-aware ship-to (PDF multi-column headers) overrides.
          if (pair[3]) details.ship_to = pair[3];
        }
        render(data, details);
      }).catch(function (err) {
        setStatus(err && err.message ? err.message : "Could not read that file.", true);
      });
    }

    function qtyCell(qty, assumed) {
      return '<input type="number" min="1" max="9999" value="' + qty + '" data-po-qty aria-label="Quantity">' +
        (assumed ? ' <span class="po-upload__assumed" title="Quantity was not shown on your PO, assumed 1">qty assumed</span>' : "");
    }

    function render(data, details) {
      setStatus("", false);
      matchedBody.innerHTML = "";
      ambBody.innerHTML = "";
      unBody.innerHTML = "";

      // PO details (number + ship-to) extracted from the file.
      if (details && (details.po_number || details.ship_to)) {
        detailsWrap.hidden = false;
        poNumberInput.value = details.po_number || "";
        shipToText.textContent = details.ship_to || "";
        shipToRow.style.display = details.ship_to ? "" : "none";
      } else {
        detailsWrap.hidden = true;
      }

      (data.matched || []).forEach(function (m) {
        var tr = document.createElement("tr");
        tr.innerHTML =
          "<td><strong>" + esc(m.code) + "</strong></td>" +
          "<td>" + esc(m.title) + "</td>" +
          "<td>" + qtyCell(m.qty, m.qty_assumed) + "</td>" +
          '<td><button type="button" data-po-remove title="Remove">×</button></td>';
        tr.dataset.handle = m.handle;
        tr.dataset.code = m.code;
        matchedBody.appendChild(tr);
      });

      (data.ambiguous || []).forEach(function (a) {
        var tr = document.createElement("tr");
        var opts = a.candidates.map(function (c) {
          return '<option value="' + esc(c.handle) + '">' + esc(c.title) + "</option>";
        }).join("");
        tr.innerHTML =
          "<td><strong>" + esc(a.code) + "</strong><br><small>" + esc(a.reason) + "</small></td>" +
          '<td><select data-po-choice>' + opts + "</select></td>" +
          "<td>" + qtyCell(a.qty, a.qty_assumed) + "</td>";
        tr.dataset.code = a.code;
        ambBody.appendChild(tr);
      });
      ambWrap.hidden = !(data.ambiguous || []).length;

      // Unmatched lines are not displayed (per store owner: show products only).
      unWrap.hidden = true;

      results.hidden = false;
      var hasRows = (data.matched || []).length + (data.ambiguous || []).length;
      addBtn.disabled = !hasRows;
      if (!hasRows) setStatus("No products found in this file. If it's a scanned PDF, please use a PDF with selectable text or an Excel file.", true);
      results.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    // Collect confirmed rows: {handle, code, qty, row}
    function confirmedItems() {
      var items = [];
      $all("tr", matchedBody).forEach(function (tr) {
        var qty = parseInt($("[data-po-qty]", tr).value, 10);
        if (qty > 0) items.push({ handle: tr.dataset.handle, code: tr.dataset.code, qty: qty, row: tr });
      });
      $all("tr", ambBody).forEach(function (tr) {
        var qty = parseInt($("[data-po-qty]", tr).value, 10);
        var handle = $("[data-po-choice]", tr).value;
        if (qty > 0 && handle) items.push({ handle: handle, code: tr.dataset.code, qty: qty, row: tr });
      });
      return items;
    }

    function moveToUnmatched(tr, reason) {
      var code = tr.dataset ? tr.dataset.code : "";
      var title = tr.cells && tr.cells[1] ? tr.cells[1].textContent : "";
      var ntr = document.createElement("tr");
      ntr.innerHTML = "<td>" + esc((code ? code + " - " : "") + title) + "</td><td>" + esc(reason) + "</td>";
      unBody.appendChild(ntr);
      unWrap.hidden = false;
      tr.remove();
    }

    addBtn.addEventListener("click", function () {
      var items = confirmedItems();
      if (!items.length) { setStatus("Nothing to add.", true); return; }
      addBtn.disabled = true;
      cartNote.hidden = false;
      cartNote.textContent = "Checking items on the store…";

      // Resolve each handle to a variant via the storefront JSON.
      // ONLY the variant whose SKU exactly matches the PO file's SKU is used
      // (exact SKU-to-SKU match). No fallbacks: if the exact SKU is absent
      // from the live variants, the item is NOT added (goes to failed).
      var lookups = items.map(function (it) {
        return fetch("/products/" + it.handle + ".js")
          .then(function (resp) {
            if (!resp.ok) throw new Error("missing");
            return resp.json();
          })
          .then(function (p) {
            var variants = p.variants || [];
            var want = normSku(it.code);
            var v = want && variants.find(function (x) { return normSku(x.sku) === want; });
            if (!v) throw new Error("missing");
            return { id: v.id, quantity: it.qty, available: !!v.available, title: p.title, code: it.code, item: it };
          })
          .catch(function () { return { failed: it }; });
      });

      Promise.all(lookups).then(function (resolved) {
        var inStock = [], backordered = [], failed = [];
        resolved.forEach(function (r) {
          if (r.failed) failed.push(r);
          else if (r.available) inStock.push(r);
          else backordered.push(r);
        });
        failed.forEach(function (r) {
          moveToUnmatched(r.failed.row, "Not available on the store right now.");
        });

        function finish(ready) {
          if (!ready.length) {
            cartNote.textContent = "None of the items could be added.";
            addBtn.disabled = false;
            return;
          }
          cartNote.textContent = "Adding items to your cart…";
          var poNum = (poNumberInput && poNumberInput.value || "").trim();
          fetch("/cart/add.js", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              items: ready.map(function (r) { return { id: r.id, quantity: r.quantity }; })
            })
          })
            .then(function (resp) {
              if (!resp.ok) throw new Error("cart");
              // Transfer the PO number to the cart page's PO field (cart note).
              if (!poNum) { window.location.href = "/cart"; return null; }
              return fetch("/cart.js").then(function (r) { return r.json(); }).then(function (cart) {
                var note = cart.note || "";
                if (note.indexOf(poNum) === -1) {
                  note = (note ? note + "\n" : "") + "PO Number: " + poNum;
                }
                return fetch("/cart/update.js", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ note: note })
                });
              }).then(function () { window.location.href = "/cart"; });
            })
            .catch(function () {
              cartNote.textContent = "Could not add items to the cart. Please try again.";
              addBtn.disabled = false;
            });
        }

        if (backordered.length) {
          cartNote.textContent = "";
          cartNote.hidden = true;
          askBackorder(backordered, function (chosen) {
            cartNote.hidden = false;
            finish(inStock.concat(chosen));
          });
        } else {
          finish(inStock);
        }
      });
    });

    matchedBody.addEventListener("click", function (e) {
      if (e.target.hasAttribute("data-po-remove")) e.target.closest("tr").remove();
    });

    dropzone.addEventListener("click", function (e) {
      // Don't open the file dialog when the sample PO link is clicked.
      if (e.target.closest(".po-upload__sample a")) return;
      if (e.target !== fileInput) fileInput.click();
    });
    fileInput.addEventListener("change", function () {
      if (fileInput.files[0] && validFile(fileInput.files[0])) process(fileInput.files[0]);
      fileInput.value = "";
    });
    ["dragover", "dragenter"].forEach(function (ev) {
      dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.add("po-upload__dropzone--over"); });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.remove("po-upload__dropzone--over"); });
    });
    dropzone.addEventListener("drop", function (e) {
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f && validFile(f)) process(f);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    $all(".po-upload").forEach(init);
  });
})();
