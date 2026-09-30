# ADA - MP-1 Editor

A free, open-source (GPL-3.0) editor and librarian for the ADA MP-1 MIDI Programmable Tube Preamp. It runs in the browser (Chrome or Edge, via Web MIDI) on Windows, macOS and Linux.

> **Unofficial and not affiliated with, endorsed by or supported by ADA Signal Processors, Inc.** "ADA" and "MP-1" are used only to identify the hardware this editor works with. The project uses none of ADA's logos or artwork. All trademarks belong to their owners.

## Reference manuals

The MP-1 manuals are published by ADA Signal Processors, Inc. and are not redistributed here. For local development, put the PDFs in the repo root, where `.gitignore` excludes them.

## Protocol harness

A command-line tool (Node 20+) that questions a real MP-1 over a USB-MIDI interface, so the protocol can be confirmed against the hardware (see `docs/adr/0002-hardware-is-protocol-source-of-truth.md`).

```sh
npm install
npm run harness -- --list-ports
npm run harness -- --in "<input port>" --out "<output port>" --channel 1 [--timeout 3000]
```

The second command requests the Working Register and prints the eleven raw parameter values, or explains why no valid reply arrived.

Development: `npm test` runs the tests (no hardware needed) and `npm run typecheck` checks types. `src/core` must stay framework-free with no Node-only dependencies, so the browser app can reuse it; its own typecheck config has no Node types to enforce that.
