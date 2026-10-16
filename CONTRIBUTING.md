# Contributing to syncify

Thanks for your interest in contributing! Bug reports, fixes, and new sync modules are all welcome.

## Getting started

```sh
git clone https://github.com/ThanhKhoaIT/syncify.git
cd syncify
npm install
npm run dev -- --help
```

See README.md "Setup" for configuring `.syncifyrc.json` and `.env`.

## Before opening a PR

- Run `npm run typecheck` — there is no test suite yet, so this is the only automated check.
- For CLI-facing changes, exercise the command with `npm run dev -- <args>`. Start with a dry run (no `--live`), then test `--live` against a **Dev store only**. Never point a test at a real Production store as the destination.
- Keep PRs focused: one fix or feature per PR, without unrelated refactors.

## Safety model is non-negotiable

syncify is one-way (Production → Dev) by design, enforced by several independent layers (see README.md "Safety model"):

- read-only Production token
- role-enforced `ShopifyClient` (`.mutate()` throws on a `prod` client)
- config-time checks in `resolveConfig()`
- live destination guard in `assertSafeToWrite()`
- interactive confirmation
- dry-run by default
- no `--from`/`--to` flags on `sync`

PRs that weaken, bypass, or add an override to any of these layers won't be merged. Store domains live only in `.syncifyrc.json` and tokens only in `.env` — don't add a second place to configure either.

## Adding or changing a sync module

Follow the existing contract in `src/sync/<resource>.ts` (described in CLAUDE.md "Sync module contract"):

- Export `async function sync<Resource>(ctx: SyncContext): Promise<SyncResult>`.
- Make no Dev API calls when `!ctx.live`.
- Match Dev records by a stable handle so re-runs update instead of duplicating.
- Report per-item `userErrors` through `notes.push(...)` instead of throwing.
- Paginate every connection that can exceed one page.
- Register new resources in `RUNNERS`, `RESOURCE_ORDER`, and `RESOURCE_LABELS` (`src/commands/sync.ts`), and in `RESOURCE_SCOPES` (`src/scopes.ts`) if they need Admin API scopes. Keep README.md scope lists in sync.

## Reporting issues

Please include the syncify version (`syncify --version`), the command you ran, and the relevant lines from `syncify.log`. Redact tokens and any store data you don't want public.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
