# syncify

CLI to sync a Shopify **Production** store into a **Dev** store: products &
variants (with metafields), collections, theme, shop metafields,
metaobjects, files (images/videos/generic files), Online Store pages, blogs
& articles, navigation menus, and basic discount codes. One-way only
(Production → Dev), never the reverse.

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

Two separate apps, one per store — **do not reuse one app/token for both**,
since that's exactly what the [safety guards](#safety-model-why-an-accidental-proddev-swap-cant-happen)
below are designed to catch.

Shopify stopped allowing new **legacy custom apps** (the static-token flow
below) as of **2026-01-01** — existing ones keep working fine, no need to
migrate anything that already works. If you're setting this up fresh and
don't already have custom apps for these two stores, use **Option B**
instead.

### Option A: legacy custom app (`SHOPIFY_PROD_TOKEN`) — read-only, existing apps only

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
   above — don't confuse the two. `read_online_store_pages` despite the
   name also covers `Blog`/`Article` — no separate scope needed for those.
5. Save, then go to the **API credentials** tab and click **Install app**
   (confirm the install).
6. Under **Admin API access token**, click **Reveal token once** and copy it
   immediately — Shopify only shows it this one time. Paste it into `.env` as
   `SHOPIFY_PROD_TOKEN`. The store's `*.myshopify.com` domain doesn't go in
   `.env` — it's `from.store` in `.syncifyrc.json`, set by `syncify init`
   (or `syncify config set from.store <domain>`).

Repeat for the **Dev** store (`SHOPIFY_DEV_TOKEN`, naming the app e.g.
`syncify (dev, read-write)`), but grant the matching write scopes instead:

- `write_products`
- `write_online_store_pages`
- `write_discounts`
- `write_metaobjects`
- `write_metaobject_definitions`
- `write_files`
- `write_online_store_navigation`

(Same note as above — no `write_metafields` scope exists; shop and product
metafields don't need one, but metaobjects do.)

Copy each revealed token into `.env` (`SHOPIFY_PROD_TOKEN`/`SHOPIFY_DEV_TOKEN`).
Store domains don't go in `.env` — they're `from.store`/`to.store` in
`.syncifyrc.json`, set by `syncify init` (or `syncify config set from.store
<domain>`).

> If you ever need to rotate a token, revoke the old one from the same
> **API credentials** tab (**Uninstall app** or delete it) and regenerate —
> don't leave old tokens active.

### Option B: Dev Dashboard app (`SHOPIFY_*_CLIENT_ID`/`_CLIENT_SECRET`) — required for new apps

Required for any app created on or after 2026-01-01. Same scope lists as
Option A above (read-only set for Production, write set for Dev) — only the
creation flow and credential shape differ:

1. Go to [dev.shopify.com/dashboard](https://dev.shopify.com/dashboard) →
   **Create app** → **Start from Dev Dashboard**. Name it (e.g.
   `syncify (prod, read-only)` / `syncify (dev, read-write)`) and create.
2. In the **Versions** tab: set **App URL** to
   `https://shopify.dev/apps/default-app-home` (no embedded UI needed),
   pick the newest webhooks API version, and add the scopes for that role
   (Production's read-only list, or Dev's write list). Click **Release**.
3. From the **Home** tab, **Install app** on the target store.
4. In **Settings**, copy the **Client ID** and **Client secret** into `.env`
   as `SHOPIFY_PROD_CLIENT_ID`/`SHOPIFY_PROD_CLIENT_SECRET` (or the `DEV`
   equivalents) — leave `SHOPIFY_PROD_TOKEN`/`SHOPIFY_DEV_TOKEN` unset.

Unlike Option A's permanent token, these don't work directly — `syncify`
exchanges them for a short-lived (24h) Admin API access token itself, once
at the start of each run, via Shopify's [client credentials
grant](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant).
Nothing else about how you use `syncify` changes; this is purely an
authentication detail handled internally by `src/config.ts`.

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
# resources: products, theme, metafields, metaobjects, content, discounts, files, menus, articles, collections
syncify config list
syncify config get <key>              # e.g. resources, guard.allowedDevPlanNames
syncify config set <key> <value>      # comma-separate list values
syncify sync [--resources <list>] [--live] [--yes]
syncify -h | --help                   # or: syncify <command> -h
```

`-h`/`--help` works at the top level and on every subcommand
(`syncify sync -h`, `syncify init -h`, etc.).

Resources always run in a fixed, dependency-safe order regardless of how
you list or select them: `products → collections → content → articles →
metafields → metaobjects → discounts → files → theme → menus`. `menus`
resolves Product/Collection/Page/Blog references by handle on Dev, and
`collections` resolves manual membership the same way via products — both
need those resources to already exist on Dev to resolve correctly, so they
always run last.

Resources run one at a time, in that order, each with its own live progress
bar. `src/client.ts` retries rate-limited requests (HTTP 429 or a GraphQL
`THROTTLED` error) with exponential backoff, up to 5 attempts.

## Scope check

Before any resource runs, `syncify` queries both tokens'
`currentAppInstallation.accessScopes` and confirms each has the scopes the
selected resources actually need (e.g. `read_discounts` on Production if
`discounts` is selected, `write_files` on Dev if `files` is selected) —
aborting with a clear list of what's missing rather than letting the run
fail partway through on whichever resource happens to hit the permission
gap first. Not skippable by `--yes` (it's a configuration problem, not a
destination-safety confirmation). See "Getting the Production/Dev token"
above for the full scope lists per resource.

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

## Page templates and sections

A page's *assignment* to a custom template (`templateSuffix`, e.g. a page
using `page.contact.json` instead of the default `page.json`) is part of
the `content` resource and syncs with the page. The template file itself —
and the sections/blocks it references — are **theme files**, not part of
the Page resource, so they only exist on Dev if the `theme` resource is
also synced:

```sh
syncify sync --resources theme,content --live
```

Sync `content` alone and a page assigned to a custom template will still
create fine on Dev, but Shopify falls back to the default page template
until the matching theme file exists there too.

**Section settings that reference a Production-only resource by ID** — an
`image_picker` or `video` setting in a section's JSON typically stores a
`gid://shopify/...` reference, which only exists on Production. `theme push`
can hard-reject the push for a file with a broken `video` reference (error:
`Setting 'video' value does not point to an applicable shopify-hosted video
resource`), or silently leave an `image_picker` setting empty. Unlike
product/collection/page menu links, there's no stable handle to resolve
these against (same root problem as the Files resource — no stable
cross-store identity for media), so this can't be auto-fixed. Work around a
hard-rejecting file with `themeIgnorePatterns` in `.syncifyrc.json`:

```sh
syncify config set themeIgnorePatterns "templates/page.our-story.json,templates/index.json"
```

Passed straight through as `--ignore <pattern>` flags to `shopify theme
push` (wildcards allowed) — the listed files are skipped so the rest of the
theme still pushes, at the cost of those specific files staying stale on
Dev until manually updated.

## Known limitations

- **Inventory levels** are not synced (would require mapping locations
  between the two stores).
- **Variant-level metafields** are not synced yet — shop-level,
  product-level, and page-level metafields are.
- **Product images** are reconciled on every sync: Dev's current media is
  deleted and Production's current images re-attached fresh via
  `productDeleteMedia`/`productCreateMedia` (media has no stable cross-store
  handle to diff against, unlike products/pages/collections, so full
  replace is the only way to keep it accurate rather than just correct on
  first creation). **Any image added directly on Dev — not synced from
  Production — is wiped on the next sync.** Video and 3D model media are
  not synced, only images.
- **Collections**: automated (rule-based) collections sync their rules
  directly, so Dev resolves membership on its own. Manual collections'
  member products are reconciled on every sync (added/removed, diffed by
  product handle — a stable identifier, so `products` should sync first for
  new products to resolve). Removal runs as an async Shopify job, so it may
  lag slightly past when the run finishes. Collection metafields are not
  synced. Uses the deprecated `ruleSet`/`collectionAddProducts`/
  `collectionRemoveProducts` fields rather than Shopify's newer
  `sources`/`inclusion` API, since the latter's exact shape isn't fully
  documented — verify against schema introspection before the first live
  run if this breaks after a Shopify API update.
- **Metaobject definition updates** aren't synced — only missing definitions
  are created on Dev; if a definition already exists there, changes to its
  fields on Production aren't propagated.
- **Metaobject reference fields** (`metaobject_reference`, `product_reference`,
  `file_reference`, etc.) are skipped — the GIDs they hold on Production
  don't resolve to the same records on Dev. Only scalar fields sync.
- **Blogs and articles** (`articles` resource): matched by handle (blogs) and
  by blog-handle + article-handle (articles), so re-running is idempotent.
  Article images, comments, and article-level metafields are not synced.
  Menu items of type `ARTICLE` still aren't resolved (see Navigation menus
  below) even though articles now sync — that resolution isn't implemented
  yet.
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
  `MenuItemCreateInput`, `MenuItemUpdateInput`, `BlogCreateInput`,
  `ArticleCreateInput`, `ArticleUpdateInput`, etc.) are
  pinned to API version `2026-07` (the latest stable version as of writing)
  in `src/client.ts` but should be verified against a live schema
  introspection before the first real run — Shopify revises these across
  versions. Check [shopify.dev/docs/api/usage/versioning](https://shopify.dev/docs/api/usage/versioning)
  periodically — Shopify retires versions ~12 months after release, and an
  app targeting a retired version silently "falls forward" to whatever the
  oldest still-accessible version is, rather than erroring.
