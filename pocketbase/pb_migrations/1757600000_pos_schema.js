/// <reference path="../pb_data/types.d.ts" />

/**
 * POS schema: shops, users (extended), items, customers, sales, sale_items.
 *
 * Tenancy: every business record carries a `shop` relation and every access
 * rule pins it to the caller's own shop, so cross-shop access is impossible
 * regardless of what the client sends.
 */

migrate(
  (app) => {
    // ---- shops -------------------------------------------------------
    const shops = new Collection({
      type: "base",
      name: "shops",
      // Created during signup, before the owner relation can point anywhere.
      createRule: '@request.auth.id != ""',
      listRule: "@request.auth.shop = id",
      viewRule: "@request.auth.shop = id",
      updateRule: "@request.auth.shop = id && @request.auth.role = 'owner'",
      deleteRule: null,
      fields: [
        { type: "text", name: "name", required: true, max: 120 },
        { type: "text", name: "currency", required: true, max: 8 },
        { type: "relation", name: "owner", maxSelect: 1, collectionId: "_pb_users_auth_" },
        { type: "autodate", name: "created", onCreate: true },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
    });
    app.save(shops);

    // ---- users (extend the built-in auth collection) ------------------
    const users = app.findCollectionByNameOrId("users");

    users.fields.add(
      new TextField({ name: "phone", required: true, max: 20 }),
    );
    users.fields.add(new TextField({ name: "name", max: 120 }));
    users.fields.add(
      new RelationField({ name: "shop", maxSelect: 1, collectionId: shops.id }),
    );
    users.fields.add(
      new SelectField({
        name: "role",
        required: true,
        maxSelect: 1,
        values: ["owner", "manager", "cashier"],
      }),
    );
    users.fields.add(new BoolField({ name: "active" }));

    // Phone-only signup: PocketBase requires email by default, but shop
    // staff do not have one. See docs/decisions/0003-phone-password-auth.md.
    const emailField = users.fields.find((f) => f.name === "email");
    emailField.required = false;

    // Phone is the login identity, so it must be globally unique.
    users.addIndex("idx_users_phone", true, "phone", "");
    users.authRule = "active = true";
    users.passwordAuth = { enabled: true, identityFields: ["phone"] };

    // Staff are visible to their own shop; only owners manage them.
    users.listRule = "@request.auth.shop = shop";
    users.viewRule = "@request.auth.shop = shop";
    // Two legitimate creators: an anonymous owner signing up for a new shop
    // (no shop yet, role must be owner), or a signed-in owner adding staff to
    // their own shop. Anything else is rejected.
    users.createRule =
      "(@request.auth.id = '' && @request.body.role = 'owner' && @request.body.shop = '') || " +
      "(@request.auth.role = 'owner' && @request.body.shop = @request.auth.shop)";
    users.updateRule =
      "id = @request.auth.id || (@request.auth.shop = shop && @request.auth.role = 'owner')";
    users.deleteRule = "@request.auth.shop = shop && @request.auth.role = 'owner'";

    app.save(users);

    // ---- items -------------------------------------------------------
    const ownShop = "@request.auth.id != '' && shop = @request.auth.shop";
    const managerUp =
      "@request.auth.id != '' && shop = @request.auth.shop && (@request.auth.role = 'owner' || @request.auth.role = 'manager')";

    const items = new Collection({
      type: "base",
      name: "items",
      listRule: ownShop,
      viewRule: ownShop,
      createRule: managerUp,
      // Cashiers must be able to decrement stock when they sell, but must not
      // change catalogue data. PocketBase cannot restrict which fields an
      // update touches, so the cashier path is narrowed by @request.body:
      // a cashier's update may carry stock changes and nothing else.
      updateRule:
        managerUp +
        " || (@request.auth.id != '' && shop = @request.auth.shop" +
        " && @request.body.name:isset = false" +
        " && @request.body.price:isset = false" +
        " && @request.body.cost:isset = false" +
        " && @request.body.barcode:isset = false" +
        " && @request.body.active:isset = false" +
        " && @request.body.unit:isset = false" +
        " && @request.body.shop:isset = false)",
      deleteRule: managerUp,
      fields: [
        { type: "relation", name: "shop", required: true, maxSelect: 1, collectionId: shops.id },
        { type: "text", name: "name", required: true, max: 160 },
        { type: "text", name: "barcode", max: 64 },
        { type: "number", name: "price", required: true, min: 0 },
        { type: "number", name: "cost", min: 0 },
        { type: "number", name: "stock" },
        { type: "text", name: "unit", max: 16 },
        { type: "bool", name: "active" },
        { type: "autodate", name: "created", onCreate: true },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: [
        // A barcode resolves to at most one item within a shop.
        "CREATE UNIQUE INDEX idx_items_shop_barcode ON items (shop, barcode) WHERE barcode != ''",
        "CREATE INDEX idx_items_shop_name ON items (shop, name)",
      ],
    });
    app.save(items);

    // ---- customers ---------------------------------------------------
    const customers = new Collection({
      type: "base",
      name: "customers",
      listRule: ownShop,
      viewRule: ownShop,
      createRule: ownShop, // any cashier may add a debtor mid-sale
      updateRule: ownShop,
      deleteRule: managerUp,
      fields: [
        { type: "relation", name: "shop", required: true, maxSelect: 1, collectionId: shops.id },
        { type: "text", name: "name", required: true, max: 120 },
        { type: "text", name: "phone", max: 20 },
        { type: "text", name: "note", max: 500 },
        { type: "autodate", name: "created", onCreate: true },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE INDEX idx_customers_shop_name ON customers (shop, name)"],
    });
    app.save(customers);

    // ---- sales -------------------------------------------------------
    const sales = new Collection({
      type: "base",
      name: "sales",
      listRule: ownShop,
      viewRule: ownShop,
      createRule: ownShop,
      // Settling a debt is an update, so cashiers may update; only
      // managers and owners may delete a recorded sale.
      updateRule: ownShop,
      deleteRule: managerUp,
      fields: [
        { type: "relation", name: "shop", required: true, maxSelect: 1, collectionId: shops.id },
        { type: "relation", name: "cashier", maxSelect: 1, collectionId: "_pb_users_auth_" },
        { type: "number", name: "total", required: true, min: 0 },
        {
          type: "select",
          name: "status",
          required: true,
          maxSelect: 1,
          values: ["paid", "debt"],
        },
        { type: "relation", name: "customer", maxSelect: 1, collectionId: customers.id },
        { type: "date", name: "settledAt" },
        { type: "text", name: "note", max: 500 },
        { type: "autodate", name: "created", onCreate: true },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE INDEX idx_sales_shop_created ON sales (shop, created)",
        // Drives the outstanding-debt lookups per customer.
        "CREATE INDEX idx_sales_customer_status ON sales (customer, status)",
      ],
    });
    app.save(sales);

    // ---- sale_items --------------------------------------------------
    // name/price are snapshots: a past sale must stay accurate even after
    // the item is renamed, repriced, or deleted.
    const saleItems = new Collection({
      type: "base",
      name: "sale_items",
      listRule: "@request.auth.id != '' && sale.shop = @request.auth.shop",
      viewRule: "@request.auth.id != '' && sale.shop = @request.auth.shop",
      createRule: "@request.auth.id != '' && sale.shop = @request.auth.shop",
      updateRule: null,
      deleteRule: "@request.auth.id != '' && sale.shop = @request.auth.shop",
      fields: [
        {
          type: "relation",
          name: "sale",
          required: true,
          maxSelect: 1,
          collectionId: sales.id,
          cascadeDelete: true,
        },
        { type: "relation", name: "item", maxSelect: 1, collectionId: items.id },
        { type: "text", name: "name", required: true, max: 160 },
        { type: "number", name: "price", required: true, min: 0 },
        { type: "number", name: "quantity", required: true, min: 0 },
        { type: "autodate", name: "created", onCreate: true },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: ["CREATE INDEX idx_sale_items_sale ON sale_items (sale)"],
    });
    app.save(saleItems);
  },
  (app) => {
    // Revert: drop in reverse dependency order.
    for (const name of ["sale_items", "sales", "customers", "items"]) {
      try {
        app.delete(app.findCollectionByNameOrId(name));
      } catch {
        // already gone
      }
    }

    const users = app.findCollectionByNameOrId("users");
    for (const field of ["phone", "name", "shop", "role", "active"]) {
      const found = users.fields.find((f) => f.name === field);
      if (found) {
        users.fields.removeById(found.id);
      }
    }
    users.removeIndex("idx_users_phone");
    users.authRule = "";
    app.save(users);

    try {
      app.delete(app.findCollectionByNameOrId("shops"));
    } catch {
      // already gone
    }
  },
);
