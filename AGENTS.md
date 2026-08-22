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

Update `MEMORY.md` after meaningful architecture, feature, rule, dependency, or deployment changes. Keep its architecture and commands current and add a concise dated change-log entry.

<!-- vault-memory-setup:start -->
## Vault memory
Before starting work, read these files for project context:
- /Users/maruti/Documents/Projects/_meta/conventions.md
- /Users/maruti/Documents/Projects/_meta/preferences.md
- /Users/maruti/Documents/Projects/_notes/rdoshi13-Monopoly/overview.md
- /Users/maruti/Documents/Projects/_notes/rdoshi13-Monopoly/decisions.md
- /Users/maruti/Documents/Projects/_notes/rdoshi13-Monopoly/gotchas.md

Also read `MEMORY.md` in this repo for prior context; it stays the detailed
project memory and change log (see the memory protocol above).

When you make a significant decision or hit a gotcha worth remembering,
append it to the matching file above. Format:

## YYYY-MM-DD — short title
1-3 sentences. Newest entries at the top.
<!-- vault-memory-setup:end -->
