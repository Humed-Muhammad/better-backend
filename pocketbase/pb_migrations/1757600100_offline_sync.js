/// <reference path="../pb_data/types.d.ts" />

/**
 * Offline sync support.
 *
 * - `sales.clientRef`: the device-generated id for a sale, unique per shop.
 *   It makes upload retries idempotent — a queued sale replayed after a
 *   timeout resolves to the sale already recorded instead of duplicating it.
 * - `sales.soldAt`: when the sale actually happened. A sale queued offline
 *   and uploaded hours later must report the real time, not the upload time.
 * - `items.updateRule` reverts to managers/owners only. Stock now moves
 *   exclusively through the transactional checkout hook, so the previous
 *   blocklist rule (which failed open for any newly added field) is gone.
 */

migrate(
  (app) => {
    const sales = app.findCollectionByNameOrId("sales");

    sales.fields.add(new TextField({ name: "clientRef", max: 64 }));
    sales.fields.add(new DateField({ name: "soldAt" }));

    // Unique per shop, not globally: two shops may generate the same id.
    // The partial clause keeps pre-existing rows (empty clientRef) valid.
    sales.addIndex(
      "idx_sales_shop_clientref",
      true,
      "shop, clientRef",
      "clientRef != ''",
    );

    app.save(sales);

    const items = app.findCollectionByNameOrId("items");
    items.updateRule =
      "@request.auth.id != '' && shop = @request.auth.shop && (@request.auth.role = 'owner' || @request.auth.role = 'manager')";
    app.save(items);
  },
  (app) => {
    const sales = app.findCollectionByNameOrId("sales");
    sales.removeIndex("idx_sales_shop_clientref");

    for (const field of ["clientRef", "soldAt"]) {
      const found = sales.fields.find((f) => f.name === field);
      if (found) {
        sales.fields.removeById(found.id);
      }
    }

    app.save(sales);
  },
);
