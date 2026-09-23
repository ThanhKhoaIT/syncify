import { logger } from './logger.js';

// Array-like collector for a resource's notes. Pushing a note writes it to
// syncify.log immediately — not deferred until the whole resource finishes
// — so an interrupted or crashed run doesn't lose diagnostic detail, and
// `tail -f syncify.log` shows failures as they happen instead of all at
// once at the end.
export class Notes {
  private count = 0;

  constructor(private readonly resource: string) {}

  push(message: string): number {
    this.count += 1;
    logger.file(`${this.resource}: ${message}`);
    return this.count;
  }

  get length(): number {
    return this.count;
  }
}
