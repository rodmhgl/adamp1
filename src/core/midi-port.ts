/**
 * A MIDI connection to one unit: one output to send on, one input to listen to.
 * Shaped after Web MIDI so the PWA can back it with MIDIInput/MIDIOutput (ADR 0001).
 * It knows nothing about the MP-1.
 */
export interface MidiPort {
  send(bytes: Uint8Array): void;
  /** Registers a listener for every received message. Returns a function that removes it. */
  onMessage(listener: (message: MidiMessage) => void): () => void;
}

export interface MidiMessage {
  bytes: Uint8Array;
  /** Milliseconds on the `performance.now()` clock, as Web MIDI's event `timeStamp` is. */
  timestamp: number;
}
