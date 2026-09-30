/**
 * The harness's only way to ask the maintainer things. Probes and the session
 * never read the keyboard or print prompts directly, so tests can script the answers.
 */
export interface Operator {
  /** A yes/no question. */
  confirm(question: string): Promise<boolean>;
  /** Something to do on the unit, such as a front-panel key sequence. Resolves once the maintainer says it's done. */
  instruct(instruction: string): Promise<void>;
  /** A typed answer, such as an LED reading. Resolves with `defaultAnswer` when the maintainer enters nothing. */
  ask(question: string, defaultAnswer?: string): Promise<string>;
  /** Something the maintainer should know that needs no answer. */
  warn(message: string): void;
}
