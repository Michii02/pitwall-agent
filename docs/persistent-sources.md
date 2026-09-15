# Persistent source profiles (candidate agent 1.0.2)

The manager remembers one logical profile per PC/PlayStation/Xbox platform locally.
Profiles are not hardware serial identities. Native verified F1 25 player participants
provide detected platform; unknown/unverified formats do not invent metadata. Input
remains unknown and never blocks capture. Existing supported UDP capture is retained.

Known profiles are persisted atomically in the agent data directory and restore
offline after restart. New accepted packet streams supply current health. Source
locks reject competing active senders before capture/live/overlay processing. A new
UID needs fresh session context; unfinished old captures are conservatively abandoned.
The existing 60-second silence timeout is not replaced by this checkpoint.

`CAPTURE_PLATFORM_OVERRIDE=true` enables the advanced explicit `CAPTURE_PLATFORM`
override. Leave override absent/false for verified automatic platform switching.
Layout overrides never produce detected platform. Raw forwarding is unchanged and
still forwards conflict/malformed datagrams to configured external applications.

QA: `npm test`, `npm run typecheck`, `npm run build`.
Integration scoped lint (with app checkout available): invoke the application's
`node_modules/eslint/bin/eslint.js` from this checkout using its
`eslint.agent.config.mjs`, targeting `src/sources/manager.ts tests/sources.test.ts`.

Candidate implementation awaits real PC/console/controller session validation.
Build does not replace the running companion or imply a validated release. See the
application's `docs/persistent-source-checkpoint.md` for complete test and limitation
details before installation/integration. No production-ready claim or master merge.
