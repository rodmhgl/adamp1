import type { MidiMessage, MidiPort } from '../../core/midi-port.js';

/** One expected request and the replies the port sends back when it arrives. */
export interface ScriptStep {
  expect: number[];
  reply: number[][];
}

/**
 * A fake MIDI port for tests. It checks each sent message against the next
 * scripted request and answers with that step's reply bytes.
 * An empty `reply` simulates a unit that stays silent.
 */
export class ScriptedPort implements MidiPort {
  readonly sent: number[][] = [];
  readonly unexpected: number[][] = [];
  private readonly listeners = new Set<(message: MidiMessage) => void>();

  constructor(private readonly script: ScriptStep[]) {}

  send(bytes: Uint8Array): void {
    const message = [...bytes];
    this.sent.push(message);
    const step = this.script.shift();
    if (!step || !sameBytes(step.expect, message)) {
      this.unexpected.push(message);
      return;
    }
    for (const reply of step.reply) {
      queueMicrotask(() => this.deliver(reply));
    }
  }

  onMessage(listener: (message: MidiMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private deliver(bytes: number[]): void {
    for (const listener of this.listeners) {
      listener({ bytes: Uint8Array.from(bytes), timestamp: performance.now() });
    }
  }
}

function sameBytes(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
