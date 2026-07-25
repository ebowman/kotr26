# Beads persistence: PARKED — read before touching .beads here

*(This note exists as a file because bd itself cannot accept writes in this repo
right now — see below. Normally this would be a bead. Delete this file once the
follow-up bead described at the bottom is created and this repo's bd works.)*

Parked during the 2026-07-25 fleet persistence rollout (FlöDo epic `beads-in2a`;
follow-ups `beads-jhcl` and bug `beads-h7bo`, both in FlöDo's beads DB).

## Current state
- Origin (github.com/ebowman/kotr26) already carries `refs/dolt/data` with real
  data: **27 issues, prefix `hq`** (26 closed, 1 open: `hq-nab` "Round 1: audit + fixes"),
  pushed from a previous machine/session. The local `.beads/` was only a skeleton;
  the remote DB was cloned down during the rollout.
- **bd 1.1.0 refuses to write**: "refusing to auto-apply 7 pending schema migrations
  to a remote-backed database (v46 -> v53): migrating clones independently forks
  the schema (#4259)". Reads work (read-only mode on v46); every write is blocked.
  This is upstream-intentional for clones — the fix path is to migrate the
  *authoritative* copy, not this clone.
- Already done (commit 7bf7beb): `sync.remote` set in `.beads/config.yaml`,
  `.beads/.gitignore` extended. Config only — no data surgery.

## Cross-repo clue (important)
stock-picker has a mystery embedded sub-dolt at `.beads/embeddeddolt/hq` (last
touched 2026-07-11). Same `hq` prefix as this repo's DB. It is plausibly a stray
copy of *this* database sitting in the wrong project — possibly the very copy that
originally pushed refs/dolt/data to kotr26's origin, which would make IT the
schema-authoritative lineage. Resolve jointly with stock-picker's `SP-4hf` bead:
compare `dolt log` / issue sets between stock-picker's `embeddeddolt/hq` and this
repo's cloned DB before migrating either.

## To finish
1. Resolve the hq provenance question above (jointly with stock-picker `SP-4hf`).
2. Get a bd that can migrate this DB: `brew upgrade beads` and retry, or follow
   upstream guidance for migrating remote-backed clones (the authoritative copy
   migrates first, then clones re-pull). Track via `beads-h7bo` in FlöDo's DB.
3. Safety before any attempt: `tar czf <scratch>/kotr26-beads.tar.gz -C ~/src/kotr26 .beads`.
   Never `bd init` here (can destroy); never force-push `refs/dolt/data`.
4. Once bd opens the DB read-write: verify `bd info` count = 27, backend embedded,
   tracked `.beads/metadata.json` says "embedded".
5. `bd dolt push` after any changes; round-trip verify via scratch clone + `bd bootstrap`.
6. Create a proper bead with this content and delete this file.
