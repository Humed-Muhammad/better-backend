/// <reference path="../pb_data/types.d.ts" />

/**
 * Allows 4-digit PINs instead of 8-character passwords.
 *
 * PocketBase's password field defaults to a minimum of 8 characters, which
 * rejects a PIN outright. Shop staff sign in at a counter, many times a day,
 * so the app uses a phone-style PIN; see
 * docs/decisions/0009-four-digit-pin.md for the security trade-off and the
 * mitigation that is deliberately not built yet.
 */

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const password = users.fields.find((f) => f.name === "password");

    password.min = 4;

    app.save(users);
  },
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const password = users.fields.find((f) => f.name === "password");

    password.min = 8;

    app.save(users);
  },
);
