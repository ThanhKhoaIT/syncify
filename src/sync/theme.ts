import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncContext, SyncResult } from '../types.js';
import { logger } from '../logger.js';

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

/**
 * Shells out to the `shopify` CLI rather than reimplementing the Asset API.
 *
 * IMPORTANT: this requires the `shopify` CLI to already be authenticated for
 * both stores (`shopify auth login` / theme access) — the Admin API custom
 * app tokens used elsewhere in syncify are NOT accepted by `shopify theme`
 * commands, which use their own OAuth or a Theme Access app password. See
 * README.md "Theme sync auth" for setup.
 */
export async function syncTheme(ctx: SyncContext): Promise<SyncResult> {
  const notes: string[] = [];
  const tmpDir = mkdtempSync(join(tmpdir(), 'syncify-theme-'));

  try {
    logger.step(`Pulling live theme from ${ctx.config.prodStore} (read-only)...`);
    await run('shopify', ['theme', 'pull', '--store', ctx.config.prodStore, '--path', tmpDir, '--live']);

    if (!ctx.live) {
      notes.push('Dry-run: theme pulled locally to inspect, not pushed to dev store.');
      rmSync(tmpDir, { recursive: true, force: true });
      return { resource: 'theme', planned: 1, applied: 0, skipped: 0, notes };
    }

    logger.step(`Pushing theme to ${ctx.config.devStore}...`);
    await run('shopify', ['theme', 'push', '--store', ctx.config.devStore, '--path', tmpDir, '--allow-live']);

    rmSync(tmpDir, { recursive: true, force: true });
    return { resource: 'theme', planned: 1, applied: 1, skipped: 0, notes };
  } catch (err) {
    // Deliberately NOT cleaned up on failure — a "Section type 'X' does not
    // refer to an existing section file" error usually means Production's
    // own theme has a template referencing a section file that doesn't
    // exist in it (check <tmpDir>/sections/ against the template named in
    // the error) — a pre-existing issue on Production, not something this
    // push introduced. Leaving the pulled copy here is the only way to
    // actually inspect it after the fact.
    logger.error(`Theme sync failed. Pulled theme left at ${tmpDir} for inspection (not auto-deleted).`);
    throw err;
  }
}
