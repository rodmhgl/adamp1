import type { Operator } from '../operator.js';

/** Scripted acknowledgement of an `instruct`. */
export const DONE = Symbol('done');

/** Scripted acknowledgement of an `instruct` after doing something on the unit, such as a front-panel change. */
export interface DoneAfter {
  doneAfter: () => void;
}

/** Acknowledges an `instruct` after running `action`, e.g. making a `ScriptedPort` emit what the unit would send. */
export function doneAfter(action: () => void): DoneAfter {
  return { doneAfter: action };
}

/** One scripted reply: the answer to an `ask`, the choice for a `confirm`, or `DONE` (or `doneAfter`) for an `instruct`. */
export type OperatorAnswer = string | boolean | typeof DONE | DoneAfter;

/** Everything the harness put to the operator, in order. */
export type OperatorEvent =
  | { kind: 'ask'; question: string; defaultAnswer?: string }
  | { kind: 'confirm'; question: string }
  | { kind: 'instruct'; instruction: string }
  | { kind: 'warn'; message: string };

/**
 * A fake operator for tests. It answers from a script, in order, and records every
 * question, instruction and warning. An empty-string answer to `ask` takes the default,
 * as pressing Enter does. It throws when the script runs out or doesn't fit the question.
 */
export class ScriptedOperator implements Operator {
  readonly events: OperatorEvent[] = [];

  constructor(private readonly script: OperatorAnswer[]) {}

  async ask(question: string, defaultAnswer?: string): Promise<string> {
    this.events.push({ kind: 'ask', question, ...(defaultAnswer !== undefined && { defaultAnswer }) });
    const answer = this.next(question);
    if (typeof answer !== 'string') throw new Error(`Scripted ${String(answer)} for ask: ${question}`);
    return answer === '' ? (defaultAnswer ?? '') : answer;
  }

  async confirm(question: string): Promise<boolean> {
    this.events.push({ kind: 'confirm', question });
    const answer = this.next(question);
    if (typeof answer !== 'boolean') throw new Error(`Scripted "${String(answer)}" for confirm: ${question}`);
    return answer;
  }

  async instruct(instruction: string): Promise<void> {
    this.events.push({ kind: 'instruct', instruction });
    const answer = this.next(instruction);
    if (typeof answer === 'object') return answer.doneAfter();
    if (answer !== DONE) throw new Error(`Scripted ${String(answer)} for instruct: ${instruction}`);
  }

  warn(message: string): void {
    this.events.push({ kind: 'warn', message });
  }

  private next(prompt: string): OperatorAnswer {
    if (this.script.length === 0) throw new Error(`Operator script ran out at: ${prompt}`);
    return this.script.shift()!;
  }
}
