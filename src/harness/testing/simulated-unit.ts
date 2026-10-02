import type { MidiMessage, MidiPort } from '../../core/midi-port.js';
import { memoryImage, workingRegisterProgram } from './frames.js';

/** One piece of a message as the interface passes it on. */
export interface Chunk {
  bytes: number[];
  /** False for the chunk a SysEx message starts with. */
  continuation: boolean;
  /** Since the previous chunk was sent. */
  msSincePrevious: number;
}

export interface SimulatedUnitOptions {
  /** The Memory Image the unit holds: 128 Programs of 11 values. Defaults to all zeros. */
  image?: number[][];
  /** The Program sounding in the Working Register: 11 values. Defaults to all zeros. */
  workingRegister?: number[];
  /** What the unit makes of a Program written to the Working Register, e.g. clamping a value. Defaults to taking it as sent. */
  applies?(program: number[]): number[];
  /** 0-based. Defaults to 0. */
  wireChannel?: number;
  /** Whether the USB-MIDI interface loses a chunk. Defaults to never. */
  drops?(chunk: Chunk): boolean;
}

const PROGRAM_LENGTH = 11;

/**
 * A fake unit behind a fake USB-MIDI interface, for probes that send the same message in
 * chunks. It reassembles SysEx from whatever chunks the interface doesn't drop, answers a
 * Memory Image request (0A) with a dump of what it holds, and takes a Memory Image load
 * (0B) only when the frame arrives whole, with a matching checksum. It answers a Working
 * Register request (08) with the Program it holds and takes a Program addressed to 7F (09);
 * anything else it ignores.
 * The checks are worked out here, independently of the codec, as in frames.ts.
 */
export class SimulatedUnitPort implements MidiPort {
  /** Every chunk sent, in order, including those the interface dropped. */
  readonly sent: number[][] = [];
  /** How many Memory Image loads the unit took. */
  loads = 0;
  image: number[][];
  workingRegister: number[];
  private readonly applies: (program: number[]) => number[];
  private readonly wireChannel: number;
  private readonly drops: (chunk: Chunk) => boolean;
  private readonly listeners = new Set<(message: MidiMessage) => void>();
  private incoming: number[] | undefined;
  private lastSentAt = -Infinity;

  constructor({
    image = Array.from({ length: 128 }, () => Array<number>(PROGRAM_LENGTH).fill(0)),
    workingRegister = Array<number>(PROGRAM_LENGTH).fill(0),
    applies = (program) => program,
    wireChannel = 0,
    drops = () => false,
  }: SimulatedUnitOptions = {}) {
    this.image = image;
    this.workingRegister = workingRegister;
    this.applies = applies;
    this.wireChannel = wireChannel;
    this.drops = drops;
  }

  send(bytes: Uint8Array): void {
    const chunk = [...bytes];
    this.sent.push(chunk);
    const now = performance.now();
    const msSincePrevious = now - this.lastSentAt;
    this.lastSentAt = now;
    if (this.drops({ bytes: chunk, continuation: chunk[0] !== 0xf0, msSincePrevious })) return;

    for (const byte of chunk) {
      if (byte === 0xf0) this.incoming = [byte];
      else if (this.incoming) this.incoming.push(byte);
      if (byte === 0xf7 && this.incoming) {
        this.receive(this.incoming);
        this.incoming = undefined;
      }
    }
  }

  onMessage(listener: (message: MidiMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private receive(message: number[]): void {
    const [, id, channel, command, fixed] = message;
    if (id !== 0x0d || channel !== this.wireChannel || fixed !== 0x01) return;
    const body = message.slice(1, -2);
    const sum = body.reduce((total, byte) => total + byte, 0);
    if ((128 - (sum % 128)) % 128 !== message[message.length - 2]) return;

    const payload = message.slice(5, -2);
    if (command === 0x0a && payload.length === 0) {
      const dump = memoryImage(this.wireChannel, this.image);
      queueMicrotask(() => this.deliver(dump));
    } else if (command === 0x08 && payload.length === 0) {
      const reply = workingRegisterProgram(this.wireChannel, this.workingRegister);
      queueMicrotask(() => this.deliver(reply));
    } else if (command === 0x09 && payload[0] === 0x7f && payload.length === 1 + PROGRAM_LENGTH) {
      this.workingRegister = this.applies(payload.slice(1));
    } else if (command === 0x0b && payload.length === 128 * PROGRAM_LENGTH) {
      this.image = Array.from({ length: 128 }, (_, i) => payload.slice(i * PROGRAM_LENGTH, (i + 1) * PROGRAM_LENGTH));
      this.loads++;
    }
  }

  private deliver(bytes: number[]): void {
    for (const listener of this.listeners) {
      listener({ bytes: Uint8Array.from(bytes), timestamp: performance.now() });
    }
  }
}
