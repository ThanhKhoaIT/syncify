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
