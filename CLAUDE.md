# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`syncify` is a Node/TypeScript CLI that syncs a Shopify **Production** store into a **Dev** store — one-way only (Production → Dev, never the reverse). It's published to npm-less Homebrew via a tap formula that lives in this same repo (`Formula/syncify.rb`), not a separate `homebrew-*` repo.

## Commands

```sh
npm run dev              # tsx src/index.ts — run the CLI directly from source, no build step
npm run build             # tsc -> dist/
npm run typecheck         # tsc --noEmit
npm run start              # node dist/index.js (after build)
```

There is no test suite and no lint script configured — `typecheck` is the only automated check. Verify changes by running `npm run typecheck` and, for CLI-facing changes, exercising the command via `npm run dev -- <args>` against real store config (`.syncifyrc.json` + `.env`, see README "Setup").

### Release ritual (only when explicitly asked to tag/release)

1. Bump `version` in `package.json` (and regenerate `package-lock.json`'s version fields via `npm install --package-lock-only`)
2. Commit the bump, `git tag -a vX.Y.Z`, push commit + tag
3. `gh release create vX.Y.Z`
4. Update `Formula/syncify.rb`'s `tag:`/`revision:` (revision = the commit SHA the tag points to), commit, push
5. Verify with `brew upgrade syncify && brew test syncify` (may need `cd $(brew --repo thanhkhoait/homebrew-syncify) && git fetch && git reset --hard origin/main` first if the local tap clone is stale)

## Architecture

### Safety model — the reason most of the code exists

The whole design centers on making an accidental Prod→Dev direction-reversal or wrong-destination write structurally impossible, via multiple independent layers (each documented in more detail in README.md "Safety model"):

1. **Read-only Production token** — the Production custom app is granted only `read_*` scopes; Shopify itself rejects any mutation.
2. **Code-level role enforcement** (`src/client.ts`) — a `ShopifyClient` is constructed with `role: 'prod' | 'dev'`; `.mutate()` throws immediately if called on a `'prod'`-role client, regardless of what caller code does.
3. **Config-time validation** (`src/config.ts` `resolveConfig()`) — refuses to run if `from.store === to.store`, if `to.store` isn't in `guard.allowedDestinations`, or if the resolved tokens are identical.
4. **Live destination guard** (`src/guard.ts` `assertSafeToWrite()`) — runs immediately before any write, not skippable: queries the Dev token's actual `shop.myshopifyDomain`/`shop.plan.displayName` and aborts if they don't match config or the plan isn't in `guard.allowedDevPlanNames`. The plan check has no `--yes`/`--live` override.
5. **Interactive confirmation** — typing the destination domain back, skippable only via `--yes` (the plan-check guard above is never skippable).
6. **Dry-run by default** — `syncify sync` without `--live` never calls a mutation.
7. **No `--from`/`--to` flags on `sync`** — direction only ever comes from `.syncifyrc.json`, changed deliberately via `syncify config set`.

Store domains have a single source of truth (`.syncifyrc.json`); only the two secret tokens live in `.env`. When touching auth/guard code, preserve this separation — don't introduce a second place a domain or token could be configured.

### Sync module contract

Each resource lives in `src/sync/<resource>.ts` and exports a single `async function sync<Resource>(ctx: SyncContext): Promise<SyncResult>` (`SyncContext`/`SyncResult` defined in `src/types.ts`). All of them follow the same shape:

1. Page through the Production GraphQL query, collecting all nodes.
2. If `!ctx.live`, return a `SyncResult` with `applied: 0` and a dry-run note — no Dev API calls at all.
3. Otherwise, page through the equivalent Dev query to build a handle→id map (idempotency: matching by a stable handle so re-running updates instead of duplicating), then upsert each item against `ctx.dev`.
4. Per-item failures (a mutation's `userErrors`) are logged via `notes.push(...)` and counted as skipped — they never throw and abort the whole resource's sync. A thrown exception, by contrast, does abort the resource (this exception-vs-userError distinction is a known gap, not yet fully closed — per-item try/catch isolation around individual mutation calls hasn't been added).

New sync modules should follow this exact pattern rather than introducing a different return/error shape.

`src/commands/sync.ts` wires the modules into `RUNNERS` (keyed by resource name) and `RESOURCE_ORDER` — resources always run in that fixed order regardless of CLI/config selection order, because `menus` and `collections` resolve references by handle against records that must already exist on Dev (see the comment above `RESOURCE_ORDER` for the exact dependency reasoning). Adding a new resource means updating both `RUNNERS` and `RESOURCE_ORDER` (and `RESOURCE_LABELS`), plus `src/scopes.ts`'s `RESOURCE_SCOPES` if it needs Admin API scopes.

### Notes / logging

Per-item diagnostic detail (skipped fields, non-fatal `userErrors`, known-limitation caveats) is **not** accumulated in memory — it's written to `syncify.log` immediately as it happens, via the `Notes` class (`src/notes.ts`), which wraps `logger.file()`. `SyncResult.noteCount` only carries the count back for the end-of-run console summary line; the actual message text never comes back in-memory. This means an interrupted/crashed run doesn't lose diagnostic detail, and `tail -f syncify.log` shows failures live. When adding a note anywhere in a sync module, `notes.push(message)` on the module's `Notes` instance — never reintroduce an in-memory `notes: string[]` array or a deferred `notes.forEach(...)` write.

`src/metafieldBatcher.ts` takes a shared `Notes` instance via its constructor (passed in from whichever sync module owns it) rather than keeping its own buffer, so errors from batched `metafieldsSet` calls are attributed and written immediately too.

### Batching

Only two Shopify mutations actually support batching independent items into one call — confirmed against Shopify's docs, not assumed:
- `metafieldsSet` (25/call) — `src/metafieldBatcher.ts`, used by `products.ts` and `content.ts` to batch across *different* owners.
- `fileCreate` (250/call, batched here at 50) — `src/sync/files.ts`.

Metaobjects, discounts, pages, articles, menus, and collections have no bulk mutation — those stay one API call per item.

### Other key files

- `src/client.ts` — `ShopifyClient`, pins the Admin API version (`2026-07`), handles rate-limit retry/backoff (HTTP 429 and GraphQL `THROTTLED`, exponential backoff, 5 attempts).
- `src/config.ts` — loads `.syncifyrc.json` + `.env`, resolves Admin API tokens (supports both a static legacy token and the Dev Dashboard client-credentials exchange), does the config-time safety checks.
- `src/guard.ts` — the live pre-write destination guard + interactive confirmation.
- `src/scopes.ts` — single source of truth for which Admin API scope each resource needs (`RESOURCE_SCOPES`); the runtime pre-flight scope check and `syncify init-apps`'s generated app configs both derive from it — keep README.md's scope lists in sync if this changes.
- `src/logger.ts` — console logging (with token redaction via `TOKEN_PATTERN`) and the rainbow terminal progress bar.
- GraphQL mutation input shapes (`ProductSetInput`, `MetaobjectUpsertInput`, etc.) are pinned to a specific API version but Shopify revises these across versions — verify against schema introspection before relying on an unverified shape in new code (existing modules already have `NOTE:` comments flagging this where relevant).

## Known limitations worth knowing before changing related code

Full list is in README.md "Known limitations" — the ones most likely to matter when editing sync modules:
- Inventory levels and variant-level metafields are not synced.
- Product images are fully reconciled (delete + re-create) every sync since media has no stable cross-store handle — same root problem affects `files.ts` (not idempotent, re-running duplicates files).
- Metaobject reference-type fields are dropped (both definitions and entries); metaobject definition *updates* aren't synced, only creation of missing ones.
- Discount codes: only basic percentage/fixed-amount, and not idempotent.
- Menu items resolve by handle against Dev records that must already exist (hence `menus` runs last in `RESOURCE_ORDER`).
