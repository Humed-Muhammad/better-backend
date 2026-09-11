/// <reference path="../pb_data/types.d.ts" />

/**
 * Server-side translation overrides.
 *
 * The app ships with complete Amharic and English strings, so it works on
 * first launch and offline. This collection layers corrections on top: a bad
 * phrase can be fixed for every shop from the admin dashboard without
 * releasing an app update.
 *
 * Global by design — wording is the product's, not each shop's. Adding a
 * nullable `shop` relation later would allow per-shop overrides without
 * reshaping this.
 */

migrate(
  (app) => {
    const translations = new Collection({
      type: "base",
      name: "translations",
      // Readable by anyone signed in; only superusers may edit, via the
      // admin dashboard.
      listRule: '@request.auth.id != ""',
      viewRule: '@request.auth.id != ""',
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        // Dotted key matching the bundled strings, e.g. "cart.markPaid".
        { type: "text", name: "key", required: true, max: 120 },
        {
          type: "select",
          name: "locale",
          required: true,
          maxSelect: 1,
          values: ["am", "en"],
        },
        { type: "text", name: "value", required: true, max: 1000 },
        { type: "autodate", name: "created", onCreate: true },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_translations_key_locale ON translations (key, locale)",
        // The client pulls only rows newer than its last sync.
        "CREATE INDEX idx_translations_updated ON translations (updated)",
      ],
    });

    app.save(translations);
  },
  (app) => {
    try {
      app.delete(app.findCollectionByNameOrId("translations"));
    } catch {
      // already gone
    }
  },
);
