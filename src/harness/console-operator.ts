import { createInterface } from 'node:readline/promises';
import type { Operator } from './operator.js';

export interface ConsoleOperator extends Operator {
  close(): void;
}

/** The maintainer at the terminal. */
export function createConsoleOperator(): ConsoleOperator {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });

  return {
    async confirm(question) {
      for (;;) {
        const answer = (await terminal.question(`${question} (y/n) `)).trim().toLowerCase();
        if (answer === 'y' || answer === 'yes') return true;
        if (answer === 'n' || answer === 'no') return false;
      }
    },
    async instruct(instruction) {
      await terminal.question(`${instruction}\nPress Enter when done. `);
    },
    async ask(question, defaultAnswer) {
      const answer = await terminal.question(defaultAnswer === undefined ? `${question}: ` : `${question} [${defaultAnswer}]: `);
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
