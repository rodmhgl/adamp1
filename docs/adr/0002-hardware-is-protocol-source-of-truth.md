# The real MP-1, not the manual, is the protocol source of truth

The MP-1 manual's MIDI section is wrong in places. The unit actually uses undocumented SysEx commands (08–0B) instead of the documented 06/07. The manufacturer ID is always `0D`. Byte 0 of a Program is Overdrive 1, not Overdrive 2. The manual's Display Value tables also contradict each other. So protocol behaviour and Display Values are defined by captures and LED readings from a real MP-1 v2.x, recorded in the project's protocol doc. The simulator is built from that doc. Code that disagrees with the manual is deliberate; check the protocol doc before "fixing" it.

## Consequences

- Only captures from our own unit are committed as test fixtures. Third-party captures (e.g. the 1995 Amiga archive) are used locally for cross-checking only.
- v1 supports MP-1 v2.x firmware only. The protocol layer keeps a model/firmware seam for the MP-1 Classic later.
