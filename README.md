# syncify

CLI to sync a Shopify **Production** store into a **Dev** store: products &
variants, theme, shop metafields, Online Store pages, and basic discount
codes. One-way only (Production → Dev), never the reverse.

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
writes `.syncifyrc.json`, and scaffolds `.env` from `.env.example`. Fill in
`.env` with your Admin API tokens (see below), then:

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
   - `read_metafields`
   - `read_discounts`
5. Save, then go to the **API credentials** tab and click **Install app**
   (confirm the install).
6. Under **Admin API access token**, click **Reveal token once** and copy it
   immediately — Shopify only shows it this one time. Paste it into `.env` as
   `SHOPIFY_PROD_TOKEN`. Set `SHOPIFY_PROD_STORE` to the store's
   `*.myshopify.com` domain (shown at the top of the admin, or in
   **Settings → Domains**).

### Getting the Dev token (`SHOPIFY_DEV_TOKEN`) — read-write

Repeat the same steps in the **Dev** store admin, naming the app e.g.
`syncify (dev, read-write)`, but grant the matching write scopes instead:

- `write_products`
- `write_online_store_pages`
- `write_metafields`
- `write_discounts`

Copy the revealed token into `.env` as `SHOPIFY_DEV_TOKEN`, and set
`SHOPIFY_DEV_STORE` to the Dev store's `*.myshopify.com` domain.

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
   `to.store` isn't in `guard.allowedDestinations`.
4. **Live destination guard** (`src/guard.ts`), run immediately before any
   write and **not skippable**: queries the Dev token's actual
   `shop.myshopifyDomain` and `shop.plan.displayName`, and aborts if the
   domain doesn't match config or the plan isn't in
   `guard.allowedDevPlanNames` (e.g. `Developer Preview`). A store on a paid
   plan can never be a write target — there is no override flag for this
   check.
5. **Interactive confirmation**, skippable only with `--yes`: you must type
   the destination domain back before a `--live` run proceeds. `--yes` skips
   only this step, never the plan-check guard.
6. **Dry-run by default.** `syncify sync` without `--live` never calls a
   mutation; it only reads from Production and reports counts.
7. **No `--from`/`--to` flags on `sync`.** Direction is only ever read from
   `.syncifyrc.json`, changed deliberately via `syncify config set`, so a
   typo'd CLI flag can't reverse the sync for a single run.

## Commands

```sh
syncify init [--from <domain>] [--to <domain>] [--resources <list>]
syncify config list
syncify config get <key>              # e.g. resources, guard.allowedDevPlanNames
syncify config set <key> <value>      # comma-separate list values
syncify sync [--resources <list>] [--live] [--yes]
syncify -h | --help                   # or: syncify <command> -h
```

`-h`/`--help` works at the top level and on every subcommand
(`syncify sync -h`, `syncify init -h`, etc.).

## Known limitations

- **Inventory levels** are not synced (would require mapping locations
  between the two stores).
- **Product/variant metafields** are not synced yet — only shop-level
  metafields.
- **Blogs, articles, and navigation menus** are not synced yet — only Online
  Store pages.
- **Discount codes** only cover basic percentage/fixed-amount codes (BXGY,
  free shipping, and automatic discounts are skipped and logged). This sync
  is not idempotent: re-running will attempt to recreate codes and fail on
  duplicates.
- GraphQL mutation input shapes (`ProductSetInput`, `DiscountCodeBasicInput`,
  etc.) are pinned to API version `2024-10` in `src/client.ts` but should be
  verified against a live schema introspection before the first real run —
  Shopify revises these across versions.
