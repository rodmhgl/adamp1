# ADA - MP-1 Editor

A free, open-source (GPL-3.0) editor and librarian for the ADA MP-1 MIDI Programmable Tube Preamp. It runs in the browser (Chrome or Edge, via Web MIDI) on Windows, macOS and Linux.

The MP-1 must run **Level 2 (v2.x) firmware**. At power-up the display shows "ADA" and then a three-digit number, and the first digit is the software level. Level 1 units (for example v1.38) don't respond to SysEx, so no editor can read or write them.

> **Unofficial and not affiliated with, endorsed by or supported by ADA Signal Processors, Inc.** "ADA" and "MP-1" are used only to identify the hardware this editor works with. The project uses none of ADA's logos or artwork. All trademarks belong to their owners.

## Reference manuals

The MP-1 manuals are published by ADA Signal Processors, Inc. and are not redistributed here. For local development, put the PDFs in the repo root, where `.gitignore` excludes them.

## Protocol harness

A command-line tool (Node 20+) that questions a real MP-1 over a USB-MIDI interface, so the protocol can be confirmed against the hardware (see `docs/adr/0002-hardware-is-protocol-source-of-truth.md`).

```sh
npm install
npm run harness -- --list-ports
npm run harness -- [--probe <name> | --all] [--in "<input port>" --out "<output port>" --channel 1] [--timeout 3000]
```

Without `--in`, `--out` and `--channel`, the harness lists the ports and asks for them and the channel. It remembers the choice and offers it as the default next time. Each session starts by asking for the firmware version from the power-up display, and warns if it isn't v2.x.

The default probe, `connectivity`, requests the Working Register and prints the eleven raw parameter values, or explains why no valid reply arrived. `--probe documented-commands` sends the manual's Get/Set Parameters (07/06) messages to the Working Register and records any reply. It sets Master Gain in the Working Register to 0; recall the program to restore it. `--all` runs only the probes that leave the unit as it was, so it skips `documented-commands`. `npm run harness -- --help` lists the probes.

Each session writes to a new folder under `harness-sessions/` (ignored by git): `capture.log` has every MIDI message sent and received, timestamped, byte by byte, and `report.json` has the firmware version and each probe's verdict and evidence.

Run the harness from Windows, macOS or native Linux. WSL2 can't see USB MIDI devices.

Development: `npm test` runs the tests (no hardware needed) and `npm run typecheck` checks types. `src/core` must stay framework-free with no Node-only dependencies, so the browser app can reuse it; its own typecheck config has no Node types to enforce that.
