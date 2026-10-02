# The real MP-1, not the manual, is the protocol source of truth

The MP-1 manual's MIDI section is wrong in places. The unit actually uses undocumented SysEx commands (08–0B) instead of the documented 06/07. The manufacturer ID is always `0D`. Byte 0 of a Program is Overdrive 1, not Overdrive 2. The manual's Display Value tables also contradict each other. So protocol behaviour and Display Values are defined by captures and LED readings from a real MP-1 v2.x, recorded in the project's protocol doc, `docs/protocol.md`. The simulator is built from that doc. Code that disagrees with the manual is deliberate; check the protocol doc before "fixing" it.

## Consequences

- Only captures from our own unit are committed as test fixtures, in `src/harness/testing/captures/`. Harness sessions write to the gitignored `harness-sessions/`, so captures are copied from there deliberately. Third-party captures (e.g. the 1995 Amiga archive) are used locally for cross-checking only.
- v1 supports MP-1 v2.x firmware only. The protocol layer keeps a model/firmware seam for the MP-1 Classic later.
- The source-of-truth unit must run Level 2 (v2.x) firmware. Level 1 firmware has no SysEx: the manual (§7.2) lists SysEx upload/download and real-time parameter access as Level 2 features.

## Findings

- **2026-09-30: the maintainer's unit is v1.38 (Level 1).** At power-up it shows "ADA" and then "138"; the first digit is the software level. The unit receives Program Change. It ignored the Working Register request (08), and so did the BooleanEffect editor. The USB-MIDI interface was checked in both directions (its input saw traffic from the MP-1's MIDI THRU), so the cable is not the cause. Hardware acceptance (#14) and captured fixtures (#15) wait for a v2.x EPROM, which is expected around 2026-10-07. The `documented-commands` probe (#11) checks whether v1.38 answers the manual's 06/07 messages.
- **2026-09-30: v1.38 ignores the manual's documented commands.** The `documented-commands` probe sent Get Parameters (07) and Set Parameters (06) to the Working Register on channel 1. It tried manufacturer IDs 0D and 00 with device numbers 00 and 01. None of the eight variants got a reply within 3000 ms, and the display did not change. On a rerun while playing through the unit, the audio never dropped, so Set Parameters did not silently set Master Gain to 0. v1.38 ignores these messages completely. Rerun this probe after the v2.x upgrade.
