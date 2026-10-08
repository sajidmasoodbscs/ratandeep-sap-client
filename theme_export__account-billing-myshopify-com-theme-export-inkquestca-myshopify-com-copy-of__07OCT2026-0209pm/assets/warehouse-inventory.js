(function () {

  let inventoryRunning = false;

  function loadWarehouseInventory() {

    const containers = document.querySelectorAll(
      '.collection-warehouse-stock[data-variant-id]'
    );

    if (!containers.length) return;

    containers.forEach(function (container) {

      if (container.dataset.inventoryLoading === 'true') return;
      if (container.dataset.inventoryLoaded === 'true') return;

      const variantId = container.dataset.variantId;

      if (!variantId) return;

      container.dataset.inventoryLoading = 'true';

      const url =
        '/apps/warehouse-inventory/inventory?variant_id=' +
        encodeURIComponent(variantId);

      fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        },
        cache: 'no-store'
      })

      .then(function (response) {
        if (!response.ok) {
          throw new Error('Inventory API HTTP ' + response.status);
        }

        return response.json();
      })

      .then(function (data) {

        if (!data.success || !data.locations) {
          container.innerHTML = '';
          return;
        }

        const locations = data.locations;

        /*
         * Warehouse mapping
         * AB = Edmonton
         * BC = Richmond
         * QC = St-Eustache
         */

        const warehouseMap = {

          AB: locations.find(function (warehouse) {
            return (warehouse.name || '')
              .toLowerCase()
              .includes('edmonton');
          }),

          BC: locations.find(function (warehouse) {
            return (warehouse.name || '')
              .toLowerCase()
              .includes('richmond');
          }),

          QC: locations.find(function (warehouse) {
            return (warehouse.name || '')
              .toLowerCase()
              .includes('st-eustache');
          })

        };

        let html = '';

        ['AB', 'BC', 'QC'].forEach(function (code) {

          const warehouse = warehouseMap[code];

          if (!warehouse) return;

          const available =
            Number(warehouse.available || 0);

          const incoming =
            Number(warehouse.incoming || 0);

          let status = '';
          let statusClass = '';

          if (available > 0) {

            status =
              '● In Stock (' + available + ')';

            statusClass = 'in-stock';

          } else if (incoming > 0) {

            status =
              '● Incoming (' + incoming + ')';

            statusClass = 'incoming';

          } else {

            status =
              '● B/O-Avail. To Purchase (0)';

            statusClass = 'backorder';

          }

          html += `
            <div class="collection-warehouse-row">

              <span class="collection-warehouse-name">
                ${code}
              </span>

              <span class="collection-stock-status ${statusClass}">
                ${status}
              </span>

            </div>
          `;

        });

        container.innerHTML = html;

        container.dataset.inventoryLoaded = 'true';
        container.dataset.inventoryLoading = 'false';

      })

      .catch(function (error) {

        console.error(
          '[WAREHOUSE CARD]',
          error
        );

        container.dataset.inventoryLoading = 'false';

        container.innerHTML =
          '<span class="collection-warehouse-loading">Inventory unavailable</span>';

      });

    });

  }


  /*
   * Initial page load
   */

  if (document.readyState === 'loading') {

    document.addEventListener(
      'DOMContentLoaded',
      loadWarehouseInventory
    );

  } else {

    loadWarehouseInventory();

  }


  /*
   * Shopify AJAX / filter / search updates
   */

  document.addEventListener(
    'shopify:section:load',
    function () {
      setTimeout(loadWarehouseInventory, 100);
    }
  );


  /*
   * Detect product grid replacement
   *
   * This handles facets.js AJAX filtering/search.
   */

  const observer = new MutationObserver(function (mutations) {

    let productGridChanged = false;

    mutations.forEach(function (mutation) {

      if (!mutation.addedNodes.length) return;

      mutation.addedNodes.forEach(function (node) {

        if (node.nodeType !== 1) return;

        if (
          node.matches &&
          (
            node.matches('.product-grid-container') ||
            node.matches('#ProductGridContainer') ||
            node.matches('.collection-warehouse-stock') ||
            node.querySelector('.collection-warehouse-stock')
          )
        ) {
          productGridChanged = true;
        }

      });

    });

    if (productGridChanged) {

      setTimeout(function () {
        loadWarehouseInventory();
      }, 150);

    }

  });


  observer.observe(document.body, {
    childList: true,
    subtree: true
  });


})();