# Better Backend

PocketBase server for the BetterTrack POS app.

## Run

```bash
npm run db        # http://127.0.0.1:8090
npm run db:reset  # wipe pb_data and re-apply migrations
```

On first start the migrations in `pocketbase/pb_migrations/` create every
collection, then PocketBase prints a link to create the first superuser.
Admin dashboard: http://127.0.0.1:8090/_/

## Schema

Collections: `shops`, `users`, `items`, `customers`, `sales`, `sale_items`.

Schema and access rules are defined in code, not the dashboard, so they are
version-controlled and reproducible. Edit the migration, then `npm run db:reset`.

Full documentation lives in the app repo's Obsidian vault at
`BetterTrack/docs/` — see `docs/architecture/data-model.md`.
