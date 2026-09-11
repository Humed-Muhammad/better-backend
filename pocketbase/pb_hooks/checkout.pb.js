/// <reference path="../pb_data/types.d.ts" />

/**
 * POST /api/pos/checkout
 *
 * Records a complete sale — the sale, its line items, and the stock changes —
 * in a single transaction.
 *
 * Why this exists rather than three client requests:
 *
 * 1. **Atomicity.** A client that crashed between creating the sale and
 *    decrementing stock left inventory permanently wrong. Here either the
 *    whole sale lands or none of it does.
 * 2. **Idempotency.** Offline devices retry. The client generates a
 *    `clientRef` per sale; replaying it returns the original sale instead of
 *    creating a duplicate.
 * 3. **Authority.** Prices come from the catalogue on the server, not from the
 *    request, so a modified client cannot sell at a price it invented.
 *
 * Body: { clientRef, status, customer?, note?, soldAt?, amount?, lines: [{item, quantity}] }
 *
 * **Lineless debts.** A shop often owes-book predates the app, or covers goods
 * that were never in the catalogue. Such a debt may be sent with no lines and
 * an explicit `amount`. This is the one case where the server takes a figure
 * from the client, and it is deliberately narrow:
 *
 * - only when `status` is `debt` — a *paid* sale still prices from the
 *   catalogue, so no one can sell at a price they invented;
 * - it records money **owed to the shop**, which the shop is asserting itself;
 * - no stock moves, because nothing left the shelves through this path.
 */
routerAdd("POST", "/api/pos/checkout", (e) => {
  const auth = e.auth;

  if (!auth) {
    throw new UnauthorizedError("Sign in to record a sale.");
  }

  const shopId = auth.getString("shop");

  if (!shopId) {
    throw new BadRequestError("Your account is not linked to a shop.");
  }

  const body = new DynamicModel({
    clientRef: "",
    status: "",
    customer: "",
    note: "",
    soldAt: "",
    amount: 0,
    lines: [],
  });
  e.bindBody(body);

  const clientRef = (body.clientRef || "").trim();
  const status = body.status === "debt" ? "debt" : "paid";
  const lines = Array.isArray(body.lines) ? body.lines : [];

  if (!clientRef) {
    throw new BadRequestError("clientRef is required so retries stay safe.");
  }

  // A lineless sale is only meaningful as a manually recorded debt.
  const manualAmount = Number(body.amount) || 0;
  const isManualDebt = lines.length === 0 && status === "debt";

  if (lines.length === 0 && !isManualDebt) {
    throw new BadRequestError("A sale needs at least one line.");
  }

  if (isManualDebt && !(manualAmount > 0)) {
    throw new BadRequestError("A recorded debt needs an amount above zero.");
  }

  if (status === "debt" && !body.customer) {
    throw new BadRequestError("A debt sale needs a customer.");
  }

  // Idempotency: a retry of an already-recorded sale returns the original.
  const existing = arrayOf(new DynamicModel({ id: "" }));
  $app.db()
    .select("id")
    .from("sales")
    .where($dbx.hashExp({ shop: shopId, clientRef: clientRef }))
    .limit(1)
    .all(existing);

  if (existing.length > 0) {
    const saleRecord = $app.findRecordById("sales", existing[0].id);
    return e.json(200, { sale: saleRecord, duplicate: true });
  }

  let created = null;

  $app.runInTransaction((txApp) => {
    // Resolve every line against the catalogue first: the server decides the
    // price and name, and an unknown or foreign item aborts the whole sale.
    const resolved = [];

    for (const line of lines) {
      const quantity = Number(line.quantity);

      if (!isFinite(quantity) || quantity <= 0) {
        throw new BadRequestError("Every line needs a positive quantity.");
      }

      const item = txApp.findRecordById("items", String(line.item));

      if (item.getString("shop") !== shopId) {
        throw new ForbiddenError("That item belongs to another shop.");
      }

      resolved.push({ item: item, quantity: quantity });
    }

    if (body.customer) {
      const customer = txApp.findRecordById("customers", String(body.customer));

      if (customer.getString("shop") !== shopId) {
        throw new ForbiddenError("That customer belongs to another shop.");
      }
    }

    // A manual debt has no lines to price, so its amount is the one the shop
    // asserted. Everything else is still priced from the catalogue.
    let total = manualAmount;

    if (!isManualDebt) {
      total = 0;

      for (const entry of resolved) {
        total += entry.item.getFloat("price") * entry.quantity;
      }
    }

    const salesCollection = txApp.findCollectionByNameOrId("sales");
    const sale = new Record(salesCollection);
    sale.set("shop", shopId);
    sale.set("cashier", auth.id);
    sale.set("total", total);
    sale.set("status", status);
    sale.set("customer", body.customer || "");
    sale.set("note", body.note || "");
    sale.set("clientRef", clientRef);

    // Offline sales carry the time they actually happened, not upload time.
    if (body.soldAt) {
      sale.set("soldAt", body.soldAt);
    }

    txApp.save(sale);

    const lineCollection = txApp.findCollectionByNameOrId("sale_items");

    for (const entry of resolved) {
      const saleLine = new Record(lineCollection);
      saleLine.set("sale", sale.id);
      saleLine.set("item", entry.item.id);
      // Snapshot: the receipt must stay truthful after a later rename/reprice.
      saleLine.set("name", entry.item.getString("name"));
      saleLine.set("price", entry.item.getFloat("price"));
      saleLine.set("quantity", entry.quantity);
      txApp.save(saleLine);

      // Stock moves by a delta. Concurrent sales from several devices each
      // subtract their own amount instead of overwriting a stale total.
      // Stock is allowed to go negative: that is a real signal to recount,
      // and refusing a sale the shop already made would be worse.
      entry.item.set("stock", entry.item.getFloat("stock") - entry.quantity);
      txApp.save(entry.item);
    }

    created = sale;
  });

  return e.json(200, { sale: created, duplicate: false });
});

/**
 * POST /api/pos/settle — marks every unpaid debt sale for a customer as paid.
 *
 * Server-side so that settling many sales is one atomic action: a partial
 * settle would leave a customer owing a confusing remainder.
 */
routerAdd("POST", "/api/pos/settle", (e) => {
  const auth = e.auth;

  if (!auth) {
    throw new UnauthorizedError("Sign in to settle a debt.");
  }

  const shopId = auth.getString("shop");
  const body = new DynamicModel({ customer: "", sale: "" });
  e.bindBody(body);

  if (!body.customer && !body.sale) {
    throw new BadRequestError("Provide a customer or a sale to settle.");
  }

  const settledAt = new DateTime().string();
  let settled = 0;

  $app.runInTransaction((txApp) => {
    const filter = body.sale
      ? "shop = {:shop} && id = {:sale} && status = 'debt'"
      : "shop = {:shop} && customer = {:customer} && status = 'debt'";

    const open = txApp.findRecordsByFilter("sales", filter, "-created", 0, 0, {
      shop: shopId,
      customer: body.customer,
      sale: body.sale,
    });

    for (const sale of open) {
      sale.set("status", "paid");
      sale.set("settledAt", settledAt);
      txApp.save(sale);
      settled++;
    }
  });

  return e.json(200, { settled: settled });
});
