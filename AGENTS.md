# Monopoly Repository Guide

## Active architecture

- `apps/web`: React 18 + Vite client. It renders authoritative snapshots and sends typed actions.
- `apps/server`: local Express + Socket.IO room server.
- `apps/cloudflare-server`: production Worker with one Durable Object authority.
- `packages/game-engine`: transport-independent Monopoly rules and serializable state.
- `packages/shared-types`: room, session, and wire types.
- Root `src/` is retired PeerJS migration reference and is not part of the pnpm workspace. Do not add active fixes there.

## Workflow

1. Read `MEMORY.md` before meaningful changes.
2. Treat every browser payload as untrusted; actor identity comes only from the authenticated guest session.
3. Put gameplay mutations in `packages/game-engine`, not UI or transport handlers.
4. Keep Node and Worker room semantics aligned and add deterministic tests for changed behavior.
5. Run `pnpm test`, `pnpm typecheck`, and relevant production builds.
6. Push only to `git@github.com-personal:rdoshi13/Monopoly.git`, never upstream.

## Configuration

- Local web values belong in ignored `apps/web/.env.local`; use `apps/web/.env.example` as the template.
- Production uses `VITE_API_BASE`, `VITE_SOCKET_BASE`, and the Worker `ALLOWED_ORIGIN` variable.
- Do not commit session tokens, credentials, or deployment-specific secrets.

## Memory protocol

Two memory files, split by what you are recording. Never write the same thing to both.

- **`MEMORY.md`** (this repo, tracked in git) — architecture, commands, and the dated
  change log. Update it after meaningful architecture, feature, rule, dependency, or
  deployment changes, and keep its architecture and commands current.
- **The vault notes** (machine-local, outside this repo; paths under "Vault memory" below)
  — `decisions.md` for a significant decision and why, `gotchas.md` for a known issue,
  dead end, or workaround.

Vault entry format, newest at the top:

```
## YYYY-MM-DD — short title
1-3 sentences.
```

Decisions and gotchas already recorded in `MEMORY.md` stay there — do not migrate them.
New ones go to the vault.

<!-- vault-memory-setup:start -->
## Vault memory
Before starting work, read these files for project context:
- /Users/maruti/Documents/Projects/_meta/conventions.md
- /Users/maruti/Documents/Projects/_meta/preferences.md
- /Users/maruti/Documents/Projects/_notes/rdoshi13-Monopoly/overview.md
- /Users/maruti/Documents/Projects/_notes/rdoshi13-Monopoly/decisions.md
- /Users/maruti/Documents/Projects/_notes/rdoshi13-Monopoly/gotchas.md

Also read `MEMORY.md` in this repo — it holds the architecture, commands, and the
change log, plus the decisions and gotchas recorded before the vault existed.

See "Memory protocol" above for which file to write to.
<!-- vault-memory-setup:end -->
