import chalk from 'chalk';

// Defense in depth: never let a token leak into stdout/logs even by accident.
const TOKEN_PATTERN = /shpat_[a-zA-Z0-9]+/g;

function redact(message: string): string {
  return message.replace(TOKEN_PATTERN, '***REDACTED***');
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
  },
  step(message: string) {
    console.log(chalk.cyan(redact(message)));
  },
};

const RAINBOW = ['#ff0000', '#ff7f00', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#8b00ff'];
const BAR_WIDTH = 30;

export interface ProgressBar {
  tick(amount?: number): void;
  done(): void;
}

// Renders `label [rainbow bar] current/total` on one line via \r. Falls back
// to periodic plain log lines when stdout isn't a TTY (piped output, CI)
// instead of spamming carriage returns into a log file.
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
      bar += i < filled ? chalk.hex(RAINBOW[i % RAINBOW.length])('█') : chalk.dim('░');
    }
    process.stdout.write(`\r${label} [${bar}] ${current}/${total}`);
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
        process.stdout.write('\n');
      }
    },
  };
}
