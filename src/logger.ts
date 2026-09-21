import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';

// Defense in depth: never let a token leak into stdout/logs even by accident.
const TOKEN_PATTERN = /shpat_[a-zA-Z0-9]+/g;

function redact(message: string): string {
  return message.replace(TOKEN_PATTERN, '***REDACTED***');
}

const LOG_PATH = resolve(process.cwd(), 'syncify.log');

// Best-effort — a logging failure should never crash the sync itself.
function appendToLogFile(message: string) {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${redact(message)}\n`, 'utf-8');
  } catch {
    // ignore
  }
}

export const logger = {
  info(message: string) {
    console.log(redact(message));
  },
  success(message: string) {
    console.log(chalk.green(redact(message)));
  },
  warn(message: string) {
    console.warn(chalk.yellow(redact(message)));
  },
  error(message: string) {
    console.error(chalk.red(redact(message)));
    appendToLogFile(`ERROR: ${message}`);
  },
  step(message: string) {
    console.log(chalk.cyan(redact(message)));
  },
  // Per-item notes (skipped fields, non-critical userErrors, known-limitation
  // caveats) — written to syncify.log instead of the console, so a run's
  // live output stays readable while the detail is still on record.
  file(message: string) {
    appendToLogFile(message);
  },
};

const BAR_WIDTH = 30;

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x: number) => Math.round(255 * x).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

export interface ProgressBar {
  tick(amount?: number): void;
  done(): void;
}

// Renders `label [rainbow bar] current/total` on one line via \r: every cell
// is colored from a red->violet hue sweep across the bar's position (not
// just the filled portion), with a lightning bolt at the leading edge.
// Falls back to periodic plain log lines when stdout isn't a TTY (piped
// output, CI) instead of spamming carriage returns into a log file.
export function createProgressBar(total: number, label: string): ProgressBar {
  if (total === 0) {
    return { tick() {}, done() {} };
  }

  const isTTY = Boolean(process.stdout.isTTY);
  const logEvery = Math.max(1, Math.floor(total / 10));
  let current = 0;

  function render() {
    const filled = Math.round((current / total) * BAR_WIDTH);
    let bar = '';
    for (let i = 0; i < BAR_WIDTH; i++) {
      const hue = (i / BAR_WIDTH) * 300;
      if (i === filled - 1 && filled < BAR_WIDTH) {
        bar += chalk.hex(hslToHex(hue, 100, 60)).bold('⚡');
      } else if (i < filled) {
        bar += chalk.hex(hslToHex(hue, 90, 55)).bold('▬');
      } else {
        bar += chalk.hex(hslToHex(hue, 60, 25))('▱');
      }
    }
    process.stdout.write(`\r${label} [${bar}] ${current}/${total}  `);
  }

  if (isTTY) render();

  return {
    tick(amount = 1) {
      current = Math.min(current + amount, total);
      if (isTTY) {
        render();
      } else if (current === total || current % logEvery === 0) {
        logger.info(`${label}: ${current}/${total}`);
      }
    },
    done() {
      current = total;
      if (isTTY) {
        render();
        process.stdout.write('\n\n');
      }
    },
  };
}
