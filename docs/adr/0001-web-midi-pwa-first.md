# Web MIDI PWA first, native shell only if needed

The editor ships first as a browser app (PWA) talking to the MP-1 through Web MIDI with SysEx, not as a Tauri or other native desktop app. A PWA needs no installer or code signing and runs on Windows, Mac and Linux in Chromium browsers. An existing MP-1 editor already proves that Web MIDI SysEx works with this unit. The core (Program model, Display Value tables, SysEx protocol, simulator) is framework-agnostic TypeScript, and MIDI I/O sits behind a small port interface. A Tauri shell can be added later without touching the core.

## Consequences

- Safari has no Web MIDI, and Firefox gates it behind a permission add-on. Users on those browsers are unsupported until a native shell exists.
- The Tauri entries were removed from `.gitignore` deliberately. Don't restore them unless the native shell is actually started.
