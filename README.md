# syncify

CLI to sync a Shopify **Production** store into a **Dev** store: products &
variants (with metafields), theme, shop metafields, metaobjects, files
(images/videos/generic files), Online Store pages, navigation menus, and
basic discount codes. One-way only (Production → Dev), never the reverse.

## Setup

### Via Homebrew

```sh
brew tap ThanhKhoaIT/syncify https://github.com/ThanhKhoaIT/syncify.git
brew install syncify
```

The tap needs the explicit URL above (not just `brew tap ThanhKhoaIT/syncify`)
since this repo doesn't follow Homebrew's `homebrew-<name>` naming
convention — the formula lives in [`Formula/syncify.rb`](Formula/syncify.rb)
alongside the source.

### From source

```sh
npm install
npm run build
npm link   # optional: makes the `syncify` command available globally
```

```sh
syncify init
```

Prompts for the Production and Dev store domains and default resources,
writes `.syncifyrc.json` (this is where the store domains live — `.env`
holds only the two secret tokens), and scaffolds `.env` from `.env.example`.
Fill in `.env` with your Admin API tokens (see below), then:

```sh
syncify sync              # dry-run — prints what would change, writes nothing
syncify sync --live       # actually applies changes to the Dev store
```

## Authentication

Two separate custom apps, one per store — **do not reuse one app/token for
both**, since that's exactly what the [safety guards](#safety-model-why-an-accidental-proddev-swap-cant-happen)
below are designed to catch.

### Getting the Production token (`SHOPIFY_PROD_TOKEN`) — read-only

1. In the **Production** store admin, go to **Settings → Apps and sales
   channels → Develop apps**. (If you don't see "Develop apps", an admin
   needs to enable custom app development first, under the same page.)
2. Click **Create an app**, name it something identifiable, e.g.
   `syncify (prod, read-only)`.
3. Open the **Configuration** tab → **Admin API integration** → **Configure**.
4. Grant only these scopes, and nothing under a `write_*` heading:
   - `read_products`
   - `read_online_store_pages`
   - `read_discounts`
   - `read_metaobjects`
   - `read_metaobject_definitions`
   - `read_files`
   - `read_online_store_navigation`

   No scope is needed for shop-level or product-level metafields — Shopify
   doesn't have a `read_metafields`/`write_metafields` scope (that was
   removed). Metaobjects are a separate feature and do need the two scopes
   above — don't confuse the two.
5. Save, then go to the **API credentials** tab and click **Install app**
   (confirm the install).
6. Under **Admin API access token**, click **Reveal token once** and copy it
   immediately — Shopify only shows it this one time. Paste it into `.env` as
   `SHOPIFY_PROD_TOKEN`. The store's `*.myshopify.com` domain doesn't go in
   `.env` — it's `from.store` in `.syncifyrc.json`, set by `syncify init`
   (or `syncify config set from.store <domain>`).

### Getting the Dev token (`SHOPIFY_DEV_TOKEN`) — read-write

Repeat the same steps in the **Dev** store admin, naming the app e.g.
`syncify (dev, read-write)`, but grant the matching write scopes instead:

- `write_products`
- `write_online_store_pages`
- `write_discounts`
- `write_metaobjects`
- `write_metaobject_definitions`
- `write_files`
- `write_online_store_navigation`

(Same note as above — no `write_metafields` scope exists; shop and product
metafields don't need one, but metaobjects do.)

Copy the revealed token into `.env` as `SHOPIFY_DEV_TOKEN`. As above, the
Dev store's domain goes in `.syncifyrc.json`'s `to.store`, not `.env`.

> If you ever need to rotate a token, revoke the old one from the same
> **API credentials** tab (**Uninstall app** or delete it) and regenerate —
> don't leave old tokens active.

**Theme sync auth is separate.** `syncify theme` shells out to the `shopify`
CLI (`shopify theme pull` / `push`), which does not accept the Admin API
tokens above — it needs either `shopify auth login` run once per store, or a
[Theme Access](https://shopify.dev/docs/apps/build/theme-app-extensions/theme-access)
app password exported as `SHOPIFY_CLI_THEME_TOKEN`. Set this up before
running `syncify sync --resources theme`.

## Safety model (why an accidental Prod/Dev swap can't happen)

1. **Read-only Production token.** Even if every other guard failed, the
   Production custom app token has no write scopes — Shopify itself rejects
   any mutation.
2. **Code-level role enforcement** (`src/client.ts`): the client instance
   built for the `prod` role throws if `.mutate()` is ever called on it,
   regardless of caller logic.
3. **Config-time validation** (`src/config.ts`): refuses to run if
   `from.store === to.store`, if the two tokens are identical, or if
   `to.store` isn't in `guard.allowedDestinations`. Store domains have a
   single source of truth (`.syncifyrc.json`) — only the two secret tokens
   live in `.env` — so there's no separate "domain drift between two files"
   check to make; there's only one file to get right.
4. **Live destination guard** (`src/guard.ts`), run immediately before any
   write and **not skippable**: queries the Dev token's actual
   `shop.myshopifyDomain` and `shop.plan.displayName`, and aborts if the
   domain doesn't match config or the plan isn't in
   `guard.allowedDevPlanNames` (e.g. `Developer Preview`). A store on a paid
   plan can never be a write target — there is no override flag for this
   check.
5. **Interactive confirmation**, skippable only with `--yes`: you must type
   the destination domain back before a `--live` run proceeds. `--yes` skips
   only this step, never the plan-check guard. Right after, you get a final
   chance to pick/unpick which resources actually run (all pre-selected) —
   also skipped by `--yes`, which runs the full resolved list as-is.
6. **Dry-run by default.** `syncify sync` without `--live` never calls a
   mutation; it only reads from Production and reports counts.
7. **No `--from`/`--to` flags on `sync`.** Direction is only ever read from
   `.syncifyrc.json`, changed deliberately via `syncify config set`, so a
   typo'd CLI flag can't reverse the sync for a single run.

## Commands

```sh
syncify init [--from <domain>] [--to <domain>] [--resources <list>]
# resources: products, theme, metafields, metaobjects, content, discounts, files, menus
syncify config list
syncify config get <key>              # e.g. resources, guard.allowedDevPlanNames
syncify config set <key> <value>      # comma-separate list values
syncify sync [--resources <list>] [--live] [--yes]
syncify -h | --help                   # or: syncify <command> -h
```

`-h`/`--help` works at the top level and on every subcommand
(`syncify sync -h`, `syncify init -h`, etc.).

## Product title prefix

Every product pushed to Dev has its title prefixed (default `"[DEV] "`), so
synced products are unmistakable from real Dev-created ones at a glance —
matching is still by `handle`, so this doesn't affect idempotency. Change or
disable it:

```sh
syncify config set productTitlePrefix "[STAGING] "
syncify config set productTitlePrefix ""   # disable
```

## Logging

Per-resource console output stays to a summary line
(`products: planned=132 applied=130 skipped=2`). The detail behind that —
skipped fields, non-fatal per-item errors, known-limitation notes like
"only Online Store pages are synced" — is appended to `syncify.log` in the
current directory instead, timestamped, one run after another (gitignored).
Real failures (a thrown error that stops the run) still print to the
console as well as being logged.

If `syncify sync --resources theme` fails with something like `Section
type 'X' does not refer to an existing section file`, that's `shopify
theme push` validating a template on Production that references a section
file Production's own theme doesn't actually have — a pre-existing issue
on Production, not something the push introduced. The pulled theme is
deliberately left on disk when this happens (path printed in the error)
instead of being cleaned up, so you can inspect `<path>/templates/` against
`<path>/sections/` to confirm.

## Known limitations

- **Inventory levels** are not synced (would require mapping locations
  between the two stores).
- **Variant-level metafields** are not synced yet — shop-level and
  product-level metafields are.
- **Metaobject definition updates** aren't synced — only missing definitions
  are created on Dev; if a definition already exists there, changes to its
  fields on Production aren't propagated.
- **Metaobject reference fields** (`metaobject_reference`, `product_reference`,
  `file_reference`, etc.) are skipped — the GIDs they hold on Production
  don't resolve to the same records on Dev. Only scalar fields sync.
- **Blogs and articles** are not synced yet — only Online Store pages.
- **Navigation menus**: URL-based items (HTTP links, Frontpage, Search,
  Catalog) sync as-is. Items linking to a Product, Collection, Page, or Blog
  are resolved by handle — the matching record is looked up on Dev and
  substituted in, on a `--live` run (not verified during dry-run, since that
  would mean writes-adjacent reads happening before you've confirmed
  anything). If no record with that handle exists on Dev yet, the item is
  skipped and logged — sync the referenced resource first (e.g.
  `--resources products` before `--resources menus`) and it'll resolve on
  the next run. Items linking to an article, metaobject, shop policy,
  customer account page, or "all collections" are always skipped along with
  their sub-items — no reliable cross-store equivalent to resolve to.
- **Discount codes** only cover basic percentage/fixed-amount codes (BXGY,
  free shipping, and automatic discounts are skipped and logged). This sync
  is not idempotent: re-running will attempt to recreate codes and fail on
  duplicates.
- **Files** (`GenericFile`, `MediaImage`, `Video`, `Model3d`) have no stable
  handle to match on, so this sync is **not idempotent**: re-running will
  create duplicate files on Dev.
- GraphQL mutation input shapes (`ProductSetInput`, `DiscountCodeBasicInput`,
  `MetaobjectDefinitionCreateInput`, `MetaobjectUpsertInput`,
  `MenuItemCreateInput`, `MenuItemUpdateInput`, etc.) are
  pinned to API version `2026-07` (the latest stable version as of writing)
  in `src/client.ts` but should be verified against a live schema
  introspection before the first real run — Shopify revises these across
  versions. Check [shopify.dev/docs/api/usage/versioning](https://shopify.dev/docs/api/usage/versioning)
  periodically — Shopify retires versions ~12 months after release, and an
  app targeting a retired version silently "falls forward" to whatever the
  oldest still-accessible version is, rather than erroring.
