import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncContext, SyncResult } from '../types.js';
import { logger } from '../logger.js';
import { Notes } from '../notes.js';

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

interface CapturedResult {
  code: number;
  output: string;
}

// Same as run(), but also captures stdout/stderr (while still streaming it
// live to the terminal) so the caller can inspect it after the process
// exits — needed to auto-detect which file broke a `theme push`.
function runCaptured(cmd: string, args: string[]): Promise<CapturedResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => resolvePromise({ code: code ?? 1, output }));
  });
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const THEME_FILE_PATTERN = /^(sections|snippets|templates|layout|config|locales|assets|blocks)\/[^\s│]+\.\w+$/;

// Parses `shopify theme push`'s boxed error output (╭─ error ─╮ ... ╰─╯) for
// theme file paths mentioned inside any error box, regardless of which line
// they're on — best-effort, since the exact format isn't guaranteed stable
// across CLI versions or error types. Returns [] if nothing recognizable is
// found, which the caller treats as "can't auto-recover".
function extractFailedFilePaths(output: string): string[] {
  const paths = new Set<string>();
  let inErrorBox = false;

  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(ANSI_PATTERN, '').trim();

    if (/^╭─+\s*error/i.test(line)) {
      inErrorBox = true;
      continue;
    }
    if (inErrorBox && /^╰/.test(line)) {
      inErrorBox = false;
      continue;
    }
    if (inErrorBox && line.startsWith('│')) {
      const content = line.replace(/^│/, '').replace(/│$/, '').trim();
      if (THEME_FILE_PATTERN.test(content)) {
        paths.add(content);
      }
    }
  }

  return [...paths];
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
  const notes = new Notes('theme');
  const tmpDir = mkdtempSync(join(tmpdir(), 'syncify-theme-'));

  try {
    logger.step(`Pulling live theme from ${ctx.config.prodStore} (read-only)...`);
    await run('shopify', ['theme', 'pull', '--store', ctx.config.prodStore, '--path', tmpDir, '--live']);

    if (!ctx.live) {
      notes.push('Dry-run: theme pulled locally to inspect, not pushed to dev store.');
      rmSync(tmpDir, { recursive: true, force: true });
      return { resource: 'theme', planned: 1, applied: 0, skipped: 0, noteCount: notes.length };
    }

    const ignorePatterns = [...ctx.config.themeIgnorePatterns];
    if (ignorePatterns.length > 0) {
      notes.push(`Skipping push of ${ignorePatterns.length} file pattern(s) (themeIgnorePatterns): ${ignorePatterns.join(', ')}`);
    }

    // --live selects the target (the store's published theme, matching what
    // --live pulled from Production); --allow-live is the separate
    // permission gate required to push to it non-interactively. Both are
    // required — shopify CLI rejects a non-interactive push with neither a
    // target flag (--live/--development/--theme/--unpublished) specified.
    const pushArgs = (extraIgnores: string[]) => [
      'theme',
      'push',
      '--store',
      ctx.config.devStore,
      '--path',
      tmpDir,
      '--live',
      '--allow-live',
      ...[...ignorePatterns, ...extraIgnores].flatMap((p) => ['--ignore', p]),
    ];

    logger.step(`Pushing theme to ${ctx.config.devStore}...`);
    let pushResult = await runCaptured('shopify', pushArgs([]));

    if (pushResult.code !== 0 && ctx.config.themeAutoSkipOnError) {
      const failedPaths = extractFailedFilePaths(pushResult.output).filter((p) => !ignorePatterns.includes(p));

      if (failedPaths.length > 0) {
        logger.warn(`\nTheme push failed — retrying with ${failedPaths.length} broken file(s) skipped: ${failedPaths.join(', ')}`);
        notes.push(
          `Auto-skipped ${failedPaths.length} broken theme file(s) on retry (themeAutoSkipOnError): ${failedPaths.join(', ')}. ` +
            'These files are now stale on Dev — fix the underlying issue on Production and re-sync.'
        );

        pushResult = await runCaptured('shopify', pushArgs(failedPaths));
      } else {
        notes.push('themeAutoSkipOnError is on, but no recognizable file path could be parsed from the push failure — could not auto-retry.');
      }
    }

    if (pushResult.code !== 0) {
      throw new Error(`shopify theme push exited with code ${pushResult.code}`);
    }

    rmSync(tmpDir, { recursive: true, force: true });
    return { resource: 'theme', planned: 1, applied: 1, skipped: 0, noteCount: notes.length };
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
