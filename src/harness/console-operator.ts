import { createInterface } from 'node:readline/promises';
import type { Operator } from './operator.js';

export interface ConsoleOperator extends Operator {
  close(): void;
}

/**
 * The maintainer at the terminal. Ctrl-C calls `onInterrupt` instead of quitting, and
 * aborting `signal` cancels the question being asked.
 */
export function createConsoleOperator(options: { signal?: AbortSignal; onInterrupt?: () => void } = {}): ConsoleOperator {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  // While a prompt is open, the terminal delivers Ctrl-C to readline rather than as a process signal.
  if (options.onInterrupt) terminal.on('SIGINT', options.onInterrupt);
  const question = (text: string) => terminal.question(text, { signal: options.signal ?? new AbortController().signal });

  return {
    async confirm(prompt) {
      for (;;) {
        const answer = (await question(`${prompt} (y/n) `)).trim().toLowerCase();
        if (answer === 'y' || answer === 'yes') return true;
        if (answer === 'n' || answer === 'no') return false;
      }
    },
    async instruct(instruction) {
      await question(`${instruction}\nPress Enter when done. `);
    },
    async ask(prompt, defaultAnswer) {
      const answer = await question(defaultAnswer === undefined ? `${prompt}: ` : `${prompt} [${defaultAnswer}]: `);
      return answer.trim() === '' && defaultAnswer !== undefined ? defaultAnswer : answer;
    },
    warn(message) {
      console.warn(`WARNING: ${message}`);
    },
    close() {
      terminal.close();
    },
  };
}
