# One confirmation covers a bounded series of Memory Image loads

The write-safety invariant says no message that writes Memories is sent unless the session has a verified backup and the maintainer has confirmed. Until the `load-pacing` probe, every write asked on its own. That probe loads a Memory Image dozens of times: with the defaults, seven settings three times each, plus a load to put the backup back. A confirmation and a Protect OFF instruction for every load would make the maintainer answer the same question over and over. People stop reading a prompt they have answered twenty times, so asking every time would weaken the check it is meant to be.

So the runner lets a probe ask once for a series (`ProbeContext.beginMemoryImageLoads`). The question names the most loads the series may send and the most Memories any one load changes against the backup. The maintainer sets Protect OFF once. Every other part of the invariant stays as it was, and the runner, not the probe, enforces the limits:

- A series is refused, sending nothing, without a verified backup, just as a single write is.
- The loader sends at most the number of loads that was confirmed, and throws on the next one.
- It loads only the Memory Images named when the series was confirmed. Any other image throws, so the confirmed count of changed Memories stays true.
- However the probe ends, the runner loads the backup back if the unit may not hold it, and checks it with a dump.

## Consequences

- "Confirmed before any write" now means each write is covered by a confirmation that names it, not that each write gets its own prompt. Single writes (`loadMemoryImage`, `writeProgramToAddress`) still ask every time; `loadMemoryImage` is a series of one.
- A probe should only use a series when it loads the same few images many times. A probe that writes something new on each step asks each time.
- The count includes any load the probe makes to put the backup back itself. A probe that may need more loads than it asked for gets an error and falls back on the runner's restore.
- A series can only ask for Protect OFF, not Protect ON. If a probe ever needs a series with Protect ON, extend the API on purpose instead of working around it.
- The runner's own restore is not part of any series. It needs no confirmation, as before, because it puts back the backup the maintainer already holds on disk.
