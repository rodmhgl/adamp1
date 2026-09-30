import JZZ from 'jzz';
import type { MidiMessage, MidiPort } from '../core/midi-port.js';

export interface PortNames {
  inputs: string[];
  outputs: string[];
}

export interface OpenedPort extends MidiPort {
  close(): Promise<void>;
}

/** Node MIDI access through JZZ, which exposes the same model as Web MIDI (ADR 0001). */
export async function openMidi() {
  const engine = await JZZ({ sysex: true });
  const info = engine.info() as { inputs: { name: string }[]; outputs: { name: string }[] };

  return {
    ports(): PortNames {
      return {
        inputs: info.inputs.map((port) => port.name),
        outputs: info.outputs.map((port) => port.name),
      };
    },

    async open(inputName: string, outputName: string): Promise<OpenedPort> {
      const input = await engine.openMidiIn(inputName);
      const output = await engine.openMidiOut(outputName);
      const listeners = new Set<(message: MidiMessage) => void>();
      input.connect((message: ArrayLike<number>) => {
        const received: MidiMessage = { bytes: Uint8Array.from(message), timestamp: performance.now() };
        for (const listener of listeners) listener(received);
      });

      return {
        send(bytes) {
          output.send([...bytes]);
        },
        onMessage(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async close() {
          await input.close();
          await output.close();
        },
      };
    },

    async close(): Promise<void> {
      await engine.close();
    },
  };
}
