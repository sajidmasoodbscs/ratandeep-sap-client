(function(){
  const cfg = window.RD_INVOICES;
  if (!cfg || !cfg.loggedIn) return;

  const tbody = document.getElementById('rdInvoiceTableBody');
  const pager = document.getElementById('rdInvoicePager');
  const pagerInfo = document.getElementById('rdInvoicePagerInfo');
  const prevBtn = document.getElementById('rdInvoicePrev');
  const nextBtn = document.getElementById('rdInvoiceNext');
  const modal = document.getElementById('rdInvoiceModal');
  const preview = document.getElementById('rdInvoicePreview');
  const closeBtn = document.getElementById('rdInvoiceClose');
  const pdfBtn = document.getElementById('rdInvoiceDownloadPdf');
  const searchInput = document.getElementById('rdInvoiceSearch');
  const dateFromInput = document.getElementById('rdInvoiceDateFrom');
  const dateToInput = document.getElementById('rdInvoiceDateTo');
  const balanceSelect = document.getElementById('rdInvoiceBalance');
  const clearFiltersBtn = document.getElementById('rdInvoiceFilterClear');
  const statsEl = document.getElementById('rdInvoiceStats');
  const outstandingEl = document.getElementById('rdInvoiceOutstanding');
  const invoiceCountEl = document.getElementById('rdInvoiceCount');
  const overviewOutstandingEl = document.getElementById('rdOverviewOutstanding');

  let page = 1;
  const pageSize = cfg.pageSize || 20;
  let totalPages = 1;
  let currentInvoice = null;
  let filterTimer = null;

  // PDF line capacity (header repeats each page; totals only on last).
  // No empty filler rows — real lines only; CSS pins "continued" to page bottom.
  const FULL_PAGE_LINES = 16;
  const LAST_PAGE_LINES = 11;

  function getFilters(){
    return {
      q: searchInput ? String(searchInput.value || '').trim() : '',
      dateFrom: dateFromInput ? String(dateFromInput.value || '').trim() : '',
      dateTo: dateToInput ? String(dateToInput.value || '').trim() : '',
      balance: balanceSelect ? String(balanceSelect.value || '').trim() : ''
    };
  }

  function buildListUrl(nextPage){
    const filters = getFilters();
    let url = cfg.proxyBase + '?page=' + encodeURIComponent(nextPage) +
      '&page_size=' + encodeURIComponent(pageSize);
    if (filters.q) url += '&q=' + encodeURIComponent(filters.q);
    if (filters.dateFrom) url += '&date_from=' + encodeURIComponent(filters.dateFrom);
    if (filters.dateTo) url += '&date_to=' + encodeURIComponent(filters.dateTo);
    if (filters.balance) url += '&balance=' + encodeURIComponent(filters.balance);
    return url;
  }

  function scheduleFilterReload(){
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(function(){
      loadPage(1);
    }, 300);
  }

  const DEFAULT_COMPANY = {
    company_name: 'INK QUEST',
    street_address1: '14617 134 Ave NW',
    street_address2: 'Edmonton, AB T5L 4S9',
    telephone: '(780) 454-4321',
    fax: '(780) 452-5405',
    tax_registration_no: '',
    returns_clause: 'No returns without our written permission (RMA).',
    overdue_clause: '2% per month (24% annual) will be charged on overdue accounts.',
    claims_clause: 'All claims must be made within 5 days after receipt of goods.',
    surcharge_clause: 'A 3% charge may apply for any credit card bill payment'
  };

  function escapeHtml(value){
    return String(value == null ? '' : value)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#039;');
  }

  function money(value, currency){
    if (value === null || value === undefined || value === '') return '';
    const number = parseFloat(value);
    if (isNaN(number)) return escapeHtml(value);
    try {
      return new Intl.NumberFormat('en-CA', {
        style: 'currency',
        currency: currency || 'CAD'
      }).format(number);
    } catch (e) {
      return escapeHtml(String(value));
    }
  }

  function formatDate(value){
    if (!value) return '';
    const raw = String(value).slice(0, 10);
    const parts = raw.split('-');
    if (parts.length !== 3) return escapeHtml(raw);
    const d = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]));
    if (isNaN(d.getTime())) return escapeHtml(raw);
    return escapeHtml(d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC'
    }));
  }

  function addressLines(address){
    if (!address) return '';
    return [
      address.name,
      address.address1,
      [address.city, address.province, address.postal].filter(Boolean).join(', '),
      address.country
    ].filter(Boolean).map(escapeHtml).join('<br>');
  }

  function qty(value){
    if (value === null || value === undefined || value === '') return '';
    return escapeHtml(value);
  }

  function resolveCompany(invoice){
    const c = invoice && invoice.company ? invoice.company : {};
    return {
      logo_url: c.logo_url || cfg.logoUrl || '',
      company_name: c.company_name || DEFAULT_COMPANY.company_name,
      street_address1: c.street_address1 || DEFAULT_COMPANY.street_address1,
      street_address2: c.street_address2 || DEFAULT_COMPANY.street_address2,
      telephone: c.telephone || DEFAULT_COMPANY.telephone,
      fax: c.fax || DEFAULT_COMPANY.fax,
      tax_registration_no: c.tax_registration_no || invoice.tax_registration_no || DEFAULT_COMPANY.tax_registration_no,
      returns_clause: c.returns_clause || DEFAULT_COMPANY.returns_clause,
      overdue_clause: c.overdue_clause || DEFAULT_COMPANY.overdue_clause,
      claims_clause: c.claims_clause || DEFAULT_COMPANY.claims_clause,
      surcharge_clause: c.surcharge_clause || DEFAULT_COMPANY.surcharge_clause
    };
  }

  function companyAddressHtml(company){
    const lines = [];
    if (company.street_address1) lines.push(escapeHtml(company.street_address1));
    if (company.street_address2) lines.push(escapeHtml(company.street_address2));
    const phoneFax = [
      company.telephone ? ('Tel: ' + company.telephone) : '',
      company.fax ? ('Fax: ' + company.fax) : ''
    ].filter(Boolean).join(' | ');
    if (phoneFax) lines.push(escapeHtml(phoneFax));
    if (!lines.length) return '&nbsp;';
    return lines.join('<br>');
  }

  /**
   * Split lines for PDF so non-last pages are full (FULL_PAGE_LINES)
   * and the last page leaves room for the totals footer (LAST_PAGE_LINES).
   */
  function chunkLinesForPdf(lines){
    if (!lines.length) return [[]];
    if (lines.length <= LAST_PAGE_LINES) return [lines.slice()];

    const chunks = [];
    let remaining = lines.slice();

    while (remaining.length > LAST_PAGE_LINES) {
      // Keep enough for a last page with footer
      const take = Math.min(FULL_PAGE_LINES, remaining.length - LAST_PAGE_LINES);
      if (take <= 0) break;
      chunks.push(remaining.slice(0, take));
      remaining = remaining.slice(take);
    }
    chunks.push(remaining);
    return chunks;
  }

  function renderLineRows(pageLines, currency){
    return pageLines.map(function(line){
      return '<tr>' +
        '<td class="num">' + qty(line.qty_ordered) + '</td>' +
        '<td class="num">' + qty(line.qty_shipped) + '</td>' +
        '<td class="num">' + qty(line.qty_backorder) + '</td>' +
        '<td class="item">' + escapeHtml(line.item_number || '') + '</td>' +
        '<td class="item">' + escapeHtml(line.description || '').replace(/\n/g, '<br>') + '</td>' +
        '<td class="money">' + (line.unit_price == null || line.unit_price === '' ? '' : money(line.unit_price, currency)) + '</td>' +
        '<td class="num">' + escapeHtml(line.uom || '') + '</td>' +
        '<td class="money">' + money(line.extended_price, currency) + '</td>' +
      '</tr>';
    }).join('');
  }

  function buildPageHeader(invoice, company, logo, pageNo, pageCount){
    return '<div class="rd-erp-header">' +
        '<div>' + logo + '</div>' +
        '<div class="rd-erp-company">' +
          '<p class="rd-erp-company-name">' + escapeHtml(company.company_name) + '</p>' +
          '<div class="rd-erp-company-addr">' + companyAddressHtml(company) + '</div>' +
        '</div>' +
        '<div class="rd-erp-doc">' +
          '<h1 class="rd-erp-doc-title">Invoice</h1>' +
          '<table class="rd-erp-meta-box">' +
            '<tr><th>Date</th><td>' + formatDate(invoice.invoice_date) + '</td></tr>' +
            '<tr><th>Page</th><td>' + pageNo + (pageCount > 1 ? (' of ' + pageCount) : '') + '</td></tr>' +
            '<tr><th>Invoice Number</th><td>' + escapeHtml(invoice.invoice_number || '') + '</td></tr>' +
          '</table>' +
        '</div>' +
      '</div>' +
      '<table class="rd-erp-parties"><tbody><tr>' +
        '<td><div class="rd-erp-party-label">Sold To:</div><div class="rd-erp-party-box">' + addressLines(invoice.sold_to) + '</div></td>' +
        '<td><div class="rd-erp-party-label">Ship To:</div><div class="rd-erp-party-box">' + addressLines(invoice.ship_to) + '</div></td>' +
      '</tr></tbody></table>' +
      '<table class="rd-erp-strip"><thead><tr>' +
        '<th>Customer No.</th><th>Order Date</th><th>Order No.</th><th>Salesperson</th><th>PO Number</th><th>Ship Via</th><th>Terms</th>' +
      '</tr></thead><tbody><tr>' +
        '<td>' + escapeHtml(invoice.customer_no || '') + '</td>' +
        '<td>' + formatDate(invoice.order_date) + '</td>' +
        '<td>' + escapeHtml(invoice.order_no || '') + '</td>' +
        '<td>' + escapeHtml(invoice.salesperson || '') + '</td>' +
        '<td>' + escapeHtml(invoice.po_number || '') + '</td>' +
        '<td>' + escapeHtml(invoice.ship_via || '') + '</td>' +
        '<td>' + escapeHtml(invoice.terms || '') + '</td>' +
      '</tr></tbody></table>';
  }

  /** GST / legal / tax / totals — last page only (and single-page View). */
  function buildTotalsFooter(company, invoice, taxRows, currency){
    return '<table class="rd-erp-footer"><tbody><tr>' +
        '<td class="col-legal"><div class="rd-erp-legal">' +
          '<div class="gst-row"><strong>GST/HST No.:</strong> <span>' + escapeHtml(company.tax_registration_no || '') + '</span></div>' +
          '<ul>' +
            '<li>' + escapeHtml(company.returns_clause) + '</li>' +
            '<li>' + escapeHtml(company.overdue_clause) + '</li>' +
            '<li>' + escapeHtml(company.claims_clause) + '</li>' +
            '<li>' + escapeHtml(company.surcharge_clause) + '</li>' +
          '</ul>' +
        '</div></td>' +
        '<td class="col-tax"><div class="rd-erp-tax">' +
          '<div class="rd-erp-tax-title">Tax summary:</div>' +
          '<table class="rd-erp-tax-table"><tbody>' + taxRows + '</tbody></table>' +
        '</div></td>' +
        '<td class="col-totals"><table class="rd-erp-totals"><tbody>' +
          '<tr><th>Subtotal</th><td>' + money(invoice.subtotal, currency) + '</td></tr>' +
          '<tr><th>Total sales tax</th><td>' + money(invoice.total_tax, currency) + '</td></tr>' +
          '<tr><th>Total amount</th><td>' + money(invoice.total_amount, currency) + '</td></tr>' +
          '<tr><th>Less payment</th><td>' + money(invoice.less_payment, currency) + '</td></tr>' +
          '<tr class="grand"><th>Amount due</th><td>' + money(invoice.amount_due, currency) + '</td></tr>' +
        '</tbody></table></td>' +
      '</tr></tbody></table>';
  }

  function buildItemsTable(pageLines, currency){
    return '<table class="rd-erp-items">' +
      '<colgroup>' +
        '<col class="c-qty"><col class="c-qty"><col class="c-qty"><col class="c-item"><col class="c-desc"><col class="c-price"><col class="c-uom"><col class="c-ext">' +
      '</colgroup>' +
      '<thead><tr>' +
        '<th>Qty.<br>Ord.</th><th>Qty.<br>Shp.</th><th>Qty.<br>B/O</th><th>Item Number</th><th>Description</th><th>Unit Price</th><th>UOM</th><th>Extended Price</th>' +
      '</tr></thead><tbody>' + renderLineRows(pageLines, currency) + '</tbody>' +
    '</table>';
  }

  /**
   * @param {object} invoice
   * @param {{ forPdf?: boolean }} [options]
   *  View (forPdf false): one continuous page, header once, footer once at end.
   *  PDF (forPdf true): paginate lines, repeat header each page, footer only on last page.
   */
  function buildInvoiceHtml(invoice, options){
    options = options || {};
    const forPdf = !!options.forPdf;
    const lines = Array.isArray(invoice.lines) ? invoice.lines : [];
    const taxLines = Array.isArray(invoice.tax_lines) ? invoice.tax_lines : [];
    const currency = invoice.currency || 'CAD';
    const company = resolveCompany(invoice);
    const logo = company.logo_url
      ? '<img class="rd-erp-logo" src="' + escapeHtml(company.logo_url) + '" alt="' + escapeHtml(company.company_name) + '">'
      : '<div class="rd-erp-logo-fallback">' + escapeHtml(company.company_name) + '</div>';

    const taxRows = taxLines.map(function(tax){
      return '<tr><td>' + escapeHtml(tax.code || '') + '</td><td>' + money(tax.amount, currency) + '</td></tr>';
    }).join('') +
      '<tr><td>Tax Exempt Code</td><td>' + escapeHtml(invoice.tax_exempt_code || '') + '</td></tr>';

    // On-screen View: single document, no repeated headers
    if (!forPdf) {
      return '<div class="rd-erp-doc-wrap">' +
        '<div class="rd-erp-page rd-erp-page-last">' +
          buildPageHeader(invoice, company, logo, 1, 1) +
          buildItemsTable(lines, currency) +
          buildTotalsFooter(company, invoice, taxRows, currency) +
        '</div>' +
      '</div>';
    }

    // PDF download: paginate with repeated headers; footer only on last page.
    // Real line rows only — no empty filler cells.
    const chunks = chunkLinesForPdf(lines);
    const pageCount = chunks.length;

    return '<div class="rd-erp-doc-wrap">' + chunks.map(function(pageLines, idx){
      const pageNo = idx + 1;
      const isLast = pageNo === pageCount;
      return '<div class="rd-erp-page' + (isLast ? ' rd-erp-page-last' : '') + '">' +
        buildPageHeader(invoice, company, logo, pageNo, pageCount) +
        buildItemsTable(pageLines, currency) +
        (isLast
          ? buildTotalsFooter(company, invoice, taxRows, currency)
          : '<div class="rd-erp-continued">Invoice continued on next page …</div>') +
      '</div>';
    }).join('') + '</div>';
  }

  async function fetchJson(url){
    console.log('[RD Invoices] request', {
      url: url,
      customerId: cfg.customerId,
      loggedIn: cfg.loggedIn
    });
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    });
    const body = await res.json().catch(function(){ return {}; });
    console.log('[RD Invoices] response', {
      url: url,
      status: res.status,
      ok: res.ok,
      body: body
    });
    if (!res.ok) {
      const err = new Error(body.error || ('Request failed (' + res.status + ')'));
      err.status = res.status;
      throw err;
    }
    return body;
  }

  function renderEmpty(){
    tbody.innerHTML =
      '<tr><td colspan="6"><div class="rd-invoice-empty">' +
        '<h3>No invoices</h3>' +
        '<p>There are no invoices for your account right now.</p>' +
        '<button type="button" class="rd-invoice-refresh" id="rdInvoiceRefresh">Refresh</button>' +
      '</div></td></tr>';
    if (pager) pager.hidden = true;
    const refreshBtn = document.getElementById('rdInvoiceRefresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function(){
        loadPage(1);
      });
    }
  }

  function updateStats(meta){
    meta = meta || {};
    if (statsEl) {
      statsEl.hidden = false;
      statsEl.removeAttribute('hidden');
      statsEl.style.display = '';
    }
    if (invoiceCountEl) {
      invoiceCountEl.textContent = meta.total != null ? String(meta.total) : '0';
    }
    var outstandingText = '—';
    if (meta.outstanding_balance != null && meta.outstanding_balance !== '') {
      outstandingText = money(meta.outstanding_balance, meta.outstanding_currency || 'CAD');
    } else if (meta.total === 0) {
      outstandingText = money('0.00', meta.outstanding_currency || 'CAD');
    }
    if (outstandingEl) outstandingEl.innerHTML = outstandingText;
    if (overviewOutstandingEl) overviewOutstandingEl.innerHTML = outstandingText;
  }

  function setPdfButtonState(invoice){
    if (!pdfBtn) return;
    const ok = invoice && invoice.downloadable !== false;
    pdfBtn.disabled = !ok;
    pdfBtn.title = ok
      ? 'Download PDF'
      : 'Invoice cannot be downloaded — required totals missing';
    pdfBtn.style.opacity = ok ? '' : '0.45';
    pdfBtn.style.pointerEvents = ok ? '' : 'none';
  }

  function renderRows(invoices){
    if (!invoices.length) {
      renderEmpty();
      return;
    }

    tbody.innerHTML = invoices.map(function(inv){
      const canDownload = inv.downloadable !== false;
      const pdfBtnHtml = canDownload
        ? '<button type="button" class="rd-invoice-action send" title="Download PDF" data-invoice-pdf="' + escapeHtml(inv.id) + '">PDF</button>'
        : '<button type="button" class="rd-invoice-action send" title="Not downloadable" disabled style="opacity:.45;cursor:not-allowed;">PDF</button>';

      return '<tr>' +
        '<td><div class="rd-invoice-number">' + escapeHtml(inv.invoice_number) + '</div></td>' +
        '<td>' + formatDate(inv.invoice_date) + '</td>' +
        '<td><div class="rd-invoice-order">' + escapeHtml(inv.order_no) + '</div></td>' +
        '<td class="rd-invoice-total">' + money(inv.total_amount, inv.currency) + '</td>' +
        '<td class="rd-invoice-total">' + money(inv.amount_due, inv.currency) + '</td>' +
        '<td><div class="rd-invoice-actions">' +
          '<button type="button" class="rd-invoice-action" title="View Invoice" data-invoice-id="' + escapeHtml(inv.id) + '">View</button>' +
          pdfBtnHtml +
        '</div></td>' +
      '</tr>';
    }).join('');

    tbody.querySelectorAll('[data-invoice-id]').forEach(function(btn){
      btn.addEventListener('click', function(){
        openInvoice(btn.getAttribute('data-invoice-id'));
      });
    });
    tbody.querySelectorAll('[data-invoice-pdf]').forEach(function(btn){
      btn.addEventListener('click', function(){
        downloadInvoicePdf(btn.getAttribute('data-invoice-pdf'));
      });
    });
  }

  function updatePager(meta){
    if (!pager || !meta) return;
    totalPages = meta.totalPages || 1;
    page = meta.page || 1;
    pager.hidden = !meta.total;
    pagerInfo.textContent = meta.total
      ? ('Page ' + page + ' of ' + totalPages + ' - ' + meta.total + ' invoices')
      : '';
    prevBtn.disabled = page <= 1;
    nextBtn.disabled = page >= totalPages;
  }

  async function loadPage(nextPage){
    page = nextPage;
    if (statsEl) {
      statsEl.hidden = false;
      statsEl.removeAttribute('hidden');
    }
    tbody.innerHTML = '<tr><td colspan="6"><div class="rd-invoice-loading">Loading invoices...</div></td></tr>';
    try {
      const result = await fetchJson(buildListUrl(page));
      const rows = Array.isArray(result.data) ? result.data : [];
      renderRows(rows);
      const meta = result.meta || { page: 1, totalPages: 1, total: rows.length };
      updatePager(meta);
      updateStats(meta);
    } catch (err) {
      console.error('Invoice list load failed', err);
      renderEmpty();
      updateStats({ total: 0, outstanding_balance: null });
      if (outstandingEl) {
        outstandingEl.textContent = '—';
        outstandingEl.title = 'Could not load balance (' + (err && err.message ? err.message : 'error') + ')';
      }
    }
  }

  function renderInvoiceDetail(invoice){
    if (!invoice) {
      modal.classList.remove('active');
      return;
    }
    currentInvoice = invoice;
    // View modal: single continuous layout (no repeated headers / mid-doc footers)
    preview.innerHTML = buildInvoiceHtml(invoice, { forPdf: false });
    setPdfButtonState(invoice);
    modal.classList.add('active');
  }

  function getInvoicePrintCss(){
    return [
      '@page{size:letter portrait;margin:0.3in;}',
      'html,body{margin:0;padding:0;background:#fff;color:#111;font-family:Arial,Helvetica,sans-serif;font-size:10px;line-height:1.3;}',
      '.rd-erp-doc-wrap{width:100%;}',
      // Fill printable letter height so the bordered page (and table) reach the bottom
      '.rd-erp-page{border:1px solid #222;padding:8px;background:#fff;box-sizing:border-box;height:10.4in;max-height:10.4in;display:flex;flex-direction:column;overflow:hidden;}',
      '.rd-erp-page + .rd-erp-page{page-break-before:always;break-before:page;margin-top:0;}',
      // Push continuation / footer to bottom of the page box without fake table rows
      '.rd-erp-continued{margin-top:auto;padding-top:8px;font-style:italic;font-size:10px;flex:0 0 auto;}',
      '.rd-erp-footer{margin-top:auto !important;}',
      '.rd-erp-header{display:grid;grid-template-columns:96px 1fr 170px;gap:8px;align-items:start;margin-bottom:6px;page-break-inside:avoid;break-inside:avoid;flex:0 0 auto;}',
      '.rd-erp-logo{width:88px;height:auto;max-height:90px;object-fit:contain;display:block;}',
      '.rd-erp-logo-fallback{width:88px;min-height:60px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;letter-spacing:.04em;color:#5b2d91;border:1px solid #ddd;}',
      '.rd-erp-company{text-align:center;padding-top:2px;}',
      '.rd-erp-company-name{font-size:16px;font-weight:700;letter-spacing:.18em;margin:0 0 4px;}',
      '.rd-erp-company-addr{display:inline-block;border:1px solid #bbb;background:#f3f3f3;padding:4px 8px;font-size:9px;line-height:1.35;min-width:200px;text-align:center;}',
      '.rd-erp-doc{text-align:right;}',
      '.rd-erp-doc-title{margin:0 0 4px;font-size:24px;font-weight:700;letter-spacing:-.02em;}',
      '.rd-erp-meta-box{border:1px solid #222;border-collapse:collapse;width:100%;font-size:9px;}',
      '.rd-erp-meta-box th,.rd-erp-meta-box td{border:1px solid #222;padding:2px 5px;text-align:left;vertical-align:top;}',
      '.rd-erp-meta-box th{background:#f0f0f0;font-weight:700;white-space:nowrap;width:42%;}',
      '.rd-erp-parties{width:100%;border-collapse:collapse;margin-bottom:6px;table-layout:fixed;page-break-inside:avoid;break-inside:avoid;flex:0 0 auto;}',
      '.rd-erp-parties>tbody>tr>td{width:50%;vertical-align:top;padding:0;}',
      '.rd-erp-parties>tbody>tr>td:first-child{padding-right:4px;}',
      '.rd-erp-parties>tbody>tr>td:last-child{padding-left:4px;}',
      '.rd-erp-party-label{font-size:10px;font-weight:700;margin-bottom:2px;}',
      '.rd-erp-party-box{border:1px solid #999;background:#e8e8e8;min-height:56px;padding:6px 8px;font-size:10px;line-height:1.35;}',
      '.rd-erp-strip{width:100%;border-collapse:collapse;margin-bottom:0;table-layout:fixed;page-break-inside:avoid;break-inside:avoid;flex:0 0 auto;}',
      '.rd-erp-strip th,.rd-erp-strip td{border:1px solid #222;padding:2px 3px;font-size:8px;text-align:left;vertical-align:top;word-break:break-word;}',
      '.rd-erp-strip th{background:#f0f0f0;font-weight:700;}',
      '.rd-erp-items{width:100%;border-collapse:collapse;margin-top:0;table-layout:fixed;flex:1 1 auto;}',
      '.rd-erp-items thead{display:table-header-group;}',
      '.rd-erp-items tr{page-break-inside:avoid;break-inside:avoid;}',
      '.rd-erp-items th,.rd-erp-items td{border:1px solid #222;padding:3px 4px;font-size:9px;vertical-align:top;}',
      '.rd-erp-items th{background:#f0f0f0;font-weight:700;text-align:center;line-height:1.15;}',
      '.rd-erp-items td.num{text-align:center;white-space:nowrap;}',
      '.rd-erp-items td.money{text-align:right;white-space:nowrap;}',
      '.rd-erp-items td.item{text-align:left;word-break:break-word;}',
      '.rd-erp-items col.c-qty{width:6%;}',
      '.rd-erp-items col.c-item{width:12%;}',
      '.rd-erp-items col.c-desc{width:38%;}',
      '.rd-erp-items col.c-price{width:11%;}',
      '.rd-erp-items col.c-uom{width:7%;}',
      '.rd-erp-items col.c-ext{width:12%;}',
      '.rd-erp-footer{width:100%;border-collapse:collapse;margin-top:8px;table-layout:fixed;page-break-inside:avoid;break-inside:avoid;flex:0 0 auto;}',
      '.rd-erp-footer>tbody>tr>td{vertical-align:top;padding:0 6px 0 0;}',
      '.rd-erp-footer>tbody>tr>td:last-child{padding-right:0;padding-left:6px;}',
      '.rd-erp-footer td.col-legal{width:38%;}',
      '.rd-erp-footer td.col-tax{width:32%;}',
      '.rd-erp-footer td.col-totals{width:30%;}',
      '.rd-erp-legal{font-size:10px;line-height:1.45;}',
      '.rd-erp-legal .gst-row{margin-bottom:8px;}',
      '.rd-erp-legal .gst-row span{display:inline-block;border:1px solid #bbb;background:#f3f3f3;padding:2px 6px;min-width:90px;}',
      '.rd-erp-legal ul{margin:0;padding-left:16px;}',
      '.rd-erp-legal li{margin-bottom:4px;}',
      '.rd-erp-tax{font-size:10px;}',
      '.rd-erp-tax-title{font-weight:700;margin-bottom:4px;}',
      '.rd-erp-tax-table{width:100%;border-collapse:collapse;}',
      '.rd-erp-tax-table td{border:1px solid #bbb;padding:3px 6px;}',
      '.rd-erp-tax-table td:last-child{text-align:right;background:#f7f7f7;width:45%;}',
      '.rd-erp-totals{border-collapse:collapse;width:100%;font-size:10px;}',
      '.rd-erp-totals th,.rd-erp-totals td{border:1px solid #222;padding:4px 6px;}',
      '.rd-erp-totals th{text-align:left;font-weight:700;background:#fff;}',
      '.rd-erp-totals td{text-align:right;background:#f7f7f7;white-space:nowrap;}',
      '.rd-erp-totals tr.grand th,.rd-erp-totals tr.grand td{font-weight:800;background:#eee;}'
    ].join('');
  }

  function printCurrentInvoice(){
    if (!currentInvoice) return;

    // PDF uses paginated HTML (repeated headers; footer only on last page)
    var pdfHtml = buildInvoiceHtml(currentInvoice, { forPdf: true });

    var oldFrame = document.getElementById('rdInvoicePrintFrame');
    if (oldFrame && oldFrame.parentNode) oldFrame.parentNode.removeChild(oldFrame);

    var iframe = document.createElement('iframe');
    iframe.id = 'rdInvoicePrintFrame';
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('title', 'Invoice print');
    document.body.appendChild(iframe);

    var win = iframe.contentWindow;
    var doc = iframe.contentDocument || (win && win.document);
    if (!doc || !win) return;

    doc.title = (currentInvoice && currentInvoice.invoice_number)
      ? ('Invoice ' + currentInvoice.invoice_number)
      : 'Invoice';

    var styleEl = doc.createElement('style');
    styleEl.appendChild(doc.createTextNode(getInvoicePrintCss()));
    doc.head.appendChild(styleEl);
    doc.body.innerHTML = pdfHtml;

    var cleaned = false;
    var cleanup = function(){
      if (cleaned) return;
      cleaned = true;
      setTimeout(function(){
        var frame = document.getElementById('rdInvoicePrintFrame');
        if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
      }, 800);
    };

    var triggerPrint = function(){
      try {
        win.focus();
        if (typeof win.onafterprint !== 'undefined') {
          win.onafterprint = cleanup;
        }
        win.print();
        setTimeout(cleanup, 2000);
      } catch (err) {
        console.error('Invoice print failed', err);
        cleanup();
      }
    };

    var waitForAssets = function(){
      var images = Array.prototype.slice.call(doc.images || []);
      if (!images.length) {
        setTimeout(triggerPrint, 50);
        return;
      }
      var remaining = images.length;
      var done = function(){
        remaining -= 1;
        if (remaining <= 0) setTimeout(triggerPrint, 50);
      };
      images.forEach(function(img){
        if (img.complete) done();
        else {
          img.addEventListener('load', done);
          img.addEventListener('error', done);
        }
      });
    };

    setTimeout(waitForAssets, 30);
  }

  async function openInvoice(id){
    preview.innerHTML = '<div class="rd-invoice-loading">Loading invoice...</div>';
    modal.classList.add('active');
    try {
      const result = await fetchJson(cfg.proxyBase + '/' + encodeURIComponent(id));
      if (!result || !result.data) {
        modal.classList.remove('active');
        return;
      }
      renderInvoiceDetail(result.data);
    } catch (err) {
      console.error('Invoice detail load failed', err);
      modal.classList.remove('active');
      preview.innerHTML = '';
      currentInvoice = null;
    }
  }

  async function downloadInvoicePdf(id){
    try {
      if (!currentInvoice || String(currentInvoice.id) !== String(id)) {
        preview.innerHTML = '<div class="rd-invoice-loading">Preparing PDF...</div>';
        modal.classList.add('active');
        const result = await fetchJson(cfg.proxyBase + '/' + encodeURIComponent(id) + '?download=1');
        if (!result || !result.data) {
          modal.classList.remove('active');
          return;
        }
        if (result.data.downloadable === false) {
          preview.innerHTML = '<div class="rd-invoice-error">This invoice is missing required totals and cannot be downloaded.</div>';
          setPdfButtonState(result.data);
          return;
        }
        renderInvoiceDetail(result.data);
      } else if (!modal.classList.contains('active')) {
        modal.classList.add('active');
      }
      if (currentInvoice && currentInvoice.downloadable === false) {
        setPdfButtonState(currentInvoice);
        return;
      }
      setTimeout(printCurrentInvoice, 50);
    } catch (err) {
      console.error('Invoice PDF prepare failed', err);
      if (err && err.status === 422) {
        preview.innerHTML = '<div class="rd-invoice-error">This invoice is missing required totals and cannot be downloaded.</div>';
        modal.classList.add('active');
        return;
      }
      modal.classList.remove('active');
    }
  }

  if (prevBtn) {
    prevBtn.addEventListener('click', function(){
      if (page > 1) loadPage(page - 1);
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener('click', function(){
      if (page < totalPages) loadPage(page + 1);
    });
  }
  if (closeBtn) {
    closeBtn.addEventListener('click', function(){
      modal.classList.remove('active');
    });
  }
  if (modal) {
    modal.addEventListener('click', function(event){
      if (event.target === modal) modal.classList.remove('active');
    });
  }
  if (pdfBtn) {
    pdfBtn.addEventListener('click', function(){
      if (currentInvoice && currentInvoice.id) {
        downloadInvoicePdf(currentInvoice.id);
      } else {
        printCurrentInvoice();
      }
    });
  }

  if (searchInput) {
    searchInput.addEventListener('input', scheduleFilterReload);
  }
  if (dateFromInput) {
    dateFromInput.addEventListener('change', function(){ loadPage(1); });
  }
  if (dateToInput) {
    dateToInput.addEventListener('change', function(){ loadPage(1); });
  }
  if (balanceSelect) {
    balanceSelect.addEventListener('change', function(){ loadPage(1); });
  }
  if (clearFiltersBtn) {
    clearFiltersBtn.addEventListener('click', function(){
      if (searchInput) searchInput.value = '';
      if (dateFromInput) dateFromInput.value = '';
      if (dateToInput) dateToInput.value = '';
      if (balanceSelect) balanceSelect.value = '';
      loadPage(1);
    });
  }

  // Show stats shell immediately so UI is not blank before fetch
  if (statsEl) {
    statsEl.hidden = false;
    statsEl.removeAttribute('hidden');
  }

  loadPage(1);
})();
