# Pipeline contracts

Lists the invariants of the generative pipeline that cost money or silently corrupt
provenance when they are broken. Each invariant is stated with the failure it prevents,
because most of them were written down after that failure happened.

These implement the system design in
[`../history/vn-generator-report.md`](../history/vn-generator-report.md).

Every invariant has moved into code, each as a `contract({...})` declaration beside the
code that enforces it
([`../plans/contracts-into-code-and-workflows.md`](../plans/contracts-into-code-and-workflows.md)),
and this page is about to be deleted. `pnpm contracts <query>` lists them.
`packages/contracts/contracts.json` holds every one's summary (id, rule, subjects) and the
subject map, and `packages/contracts/contracts/<area>.json` holds the full records of one
area, so a reader opens the summary file and then the one shard it needs. The last one to
move, a storyboard's frame and page forms, is `prompts.pagePanels`
(`pnpm contracts prompts.pagePanels`). [`../../CLAUDE.md`](../../CLAUDE.md) describes the
package layering, and [`packages.md`](packages.md) describes it package by package.
