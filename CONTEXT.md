# ADA - MP-1 Editor

An editor and librarian for the ADA MP-1 MIDI Programmable Tube Preamp. The vocabulary follows the MP-1 manual so that users and code use the words printed on the unit.

## Language

### The unit

**Program**:
One complete set of the eleven MP-1 parameter values (overdrives, master gain, EQ, effects loop, chorus, voicing).
_Avoid_: Patch, preset, sound

**Memory**:
One of the 128 numbered storage places (1–128) on the MP-1 that each hold one Program.
_Avoid_: Slot, location, register

**Working Register**:
The MP-1's live edit buffer: the Program currently sounding, including unstored changes.
_Avoid_: Edit buffer, current program

**Preset**:
One of the 29 factory Programs held in the MP-1's ROM. Never used for user Programs.
_Avoid_: Factory patch, default

**Voicing**:
The Program parameter choosing Solid State, Distortion Tube or Clean Tube.
_Avoid_: Channel, mode

**Display Value**:
A parameter value as the MP-1's front-panel LED readout shows it (e.g. Overdrive 4.8, Bass −6 dB); the only form users see.
_Avoid_: Raw value, MIDI value (in user-facing contexts)

**Protect**:
The unit setting that, while on, makes the MP-1 refuse incoming Memory Images.
_Avoid_: Write protect, lock

### Librarian

**Memory Image**:
The complete, ordered contents of all 128 Memories of one unit, as a backup or a restore.
_Avoid_: Bank, dump, backup (as a noun for the data)

**Library**:
An unordered collection of any number of named Programs kept on the computer, independent of any unit.
_Avoid_: Bank, collection, set list

**Program Name**:
A label the editor attaches to a Program. The MP-1 itself stores no names.
_Avoid_: Title, patch name

### Global settings

**MIDI Map**:
The unit's table assigning each External Program Number to a Memory, or to OUT (bypass).
_Avoid_: Program map, patch map

**External Program Number**:
A program number received over MIDI (1–128), before the MIDI Map translates it to a Memory.
_Avoid_: MIDI program (unqualified)
