# Repo Memory

Persistent working memory for AI agents and maintainers. Read this before meaningful changes and update it after changes that matter.

## Project Summary

Monopoly is a pnpm-workspace React 18 and TypeScript multiplayer game. A shared host-authoritative engine runs in the local Node/Socket.IO server or production Cloudflare Durable Object; browsers only submit typed actions and render snapshots.

## Architecture

- `packages/game-engine` owns serializable rules, board data, turns, cards, trades, auctions, development, mortgages, and insolvency.
- `packages/shared-types` owns guest sessions, room state, and wire types.
- `apps/server` is the local Express + Socket.IO room authority.
- `apps/cloudflare-server` is the production Worker. One Durable Object owns one room, addressed by `idFromName(roomCode)`; a single `RoomLimiter` instance throttles room creation.
- `apps/web` is the Vite snapshot-driven board client with reconnecting Socket.IO/native WebSocket transports.
- The repository root now holds only workspace configuration; all code is under `apps/` and `packages/`.

## Decisions

- Browsers are never gameplay authorities; session-bound Node/Worker handlers supply actor identity to `GameEngine`.
- Node and Worker share the same snapshot/action protocol and 30-second disconnect grace behavior.
- Worker room codes are minted in the stateless entrypoint and used directly as the Durable Object name, so no registry or KV mapping is needed. A colliding code is detected by the object already holding a room, which 409s so the entrypoint retries.
- Monopol wins with all four Railroads plus one complete street group; Run-Down applies a persisted 30-second turn deadline.
- Building, selling, mortgaging and proposing trades are restricted to the owner's own `awaiting-roll` phase. Official rules allow them at any time, including during another player's turn; the engine covers the solvency case that matters by auto-liquidating in `raiseCash` when a debt cannot be paid. This is a deliberate divergence, not an oversight.
- The root PeerJS implementation was deleted in a dedicated cleanup commit once the workspace reached parity; git history is the reference if it is ever needed.
- The active edition is the classic UK/London board: London property and station names, UK Chance/Community Chest decks, and pound-denominated UI/history. Numeric prices, rents, and balances remain plain integers internally.

## Gotchas

- Node integration tests need permission to bind `127.0.0.1` in restricted sandboxes.
- Wrangler dry-runs may need access to its user-level log/config directory.
- `apps/web/.env.local` should use `socketio` with `http://localhost:4000` for local development.
- Production `ALLOWED_ORIGIN` must be changed from localhost to the actual Pages/custom origin.
- `.eslintrc.cjs` survives at the root but no package installs ESLint and there is no lint script, so it configures tooling that is not present. Wire it up or delete it; do not assume `pnpm lint` exists.
- The Worker's `/ws` upgrade requires `?room=CODE`. Without it the request cannot be routed to the right room's Durable Object and is rejected with 400. The Socket.IO transport ignores the parameter.
- The workspace is pinned to pnpm 9.12.3. If a Codex fallback runtime exposes pnpm 11, use `/opt/homebrew/bin/pnpm`; pnpm 11 may request an unintended `node_modules` purge.
- When changing coded-board grid track ratios, update the rotated left/right `.board-space-inner` dimensions as reciprocal geometry; leaving the former 2:1 dimensions on the 1.6:1 side tracks makes labels spill across the board.

## Commands

```bash
pnpm dev:server
pnpm dev
pnpm dev:worker
pnpm test
pnpm typecheck
pnpm build
```

## Change Log

<!-- Newest first. Record meaningful features, fixes, migrations, refactors, or dependency changes. -->

### 2026-08-09 — Claude

- Removed: The retired root PeerJS application — `src/`, `docs/`, `public/`, `index.html`, `vite.config.ts`, and the root `tsconfig.json` — totalling 226 tracked files and roughly 48 MB. This is the cleanup commit the migration had been deferring since 2026-07-11.
- Why: It was dead weight that no longer had a reader, and its stray `vite.config.ts` was actively harmful — Vitest walked up to it from every package and failed on an uninstalled plugin, which is what broke `pnpm test` repo-wide until per-package configs were added.
- Verified isolated before deleting: no workspace `tsconfig.json` extends the root one, nothing under `apps/` or `packages/` imports from root `src/`, the workspace globs cover only `apps/*` and `packages/*`, and root `tsconfig.json` was scoped to `"include": ["src"]`. The root `public/` belonged to the old Vite root; `apps/web` bundles its own assets from `apps/web/src/assets`.
- Kept: `.eslintrc.cjs`. Removing lint configuration is a separate decision, though no package currently installs ESLint.
- Validation: 34 engine + 6 Node + 2 Worker tests, workspace type-check, web production build, and Worker dry-run all pass after removal, and running dev servers were unaffected.

### 2026-08-09 — Claude

- Fixed: Card destinations resolve through `destinationById`, which picks the next matching space forward. `propertyById` was keyed by an id that is not unique — `chance` and `communitychest` each appear three times — so it silently kept whichever entry was last. No shipped card targets a repeated id, so this is hardening rather than a fixed live bug; behaviour is identical for every existing card.
- Fixed: `bankrupt` returns standing buildings to the bank's finite supply via `returnBuildings`. It previously zeroed `count` without crediting `bankSupply`, leaking houses and hotels out of play.
- Fixed: The Node server answers 404 for a missing room instead of 409 for every join failure. `RequestError` carries the status, so a full room and an in-progress game stay 409 and a blank name is 400.
- Fixed: `NativeSocket.on` keeps every handler instead of silently replacing the previous one, and reconnect uses exponential backoff with jitter capped at 15s rather than retrying every second forever.
- Fixed: The event feed names the player. Dice and card entries carry a `playerId` resolved against the live snapshot at render time, and report the space name rather than its index: "Alice rolled 4 + 6 and moved to Jail / Just Visiting".
- Changed: Renamed `useSession` to `startSession`. The `use` prefix made a plain callback look like a hook and would have tripped `react-hooks/rules-of-hooks` once lint is enforced.
- Files: `packages/game-engine/src/engine.ts`, `packages/game-engine/test/engine.test.ts`, `apps/server/src/index.ts`, `apps/server/src/index.test.ts`, `apps/web/src/socket.ts`, `apps/web/src/main.tsx`, `apps/web/src/GameView.tsx`, and `packages/shared-types/src/index.ts`.
- Validation: 34 engine + 6 Node + 2 Worker tests, type-check, web build, Worker dry-run. The bank-supply test was confirmed to fail against the previous implementation. A live two-player game showed both players named in the event feed with no console errors.

### 2026-08-09 — Claude

- Fixed: Board labels no longer clip. Every size inside the board is now expressed in `cqi` against `.board-stage` as a query container, replacing `vw` units that silently decoupled once the board stopped being sized by viewport width. At 1280x720 this took overflowing elements from 21 to 3, all of which are the intentionally rotated corner compositions that `overflow: hidden` clips by design.
- Fixed: The board fits the viewport. `max-width: min(100%, calc(100vh - 8rem))` on the square stage caps its height, so a 720p screen no longer has to scroll away from the sidebar to see Go and the bottom row.
- Changed: The eight names whose longest word cannot fit a cell carry soft hyphens, applied in `CodedBoard` so the engine's canonical names stay unbroken. `hyphens: auto` was tried first and measured to do nothing — identical text width with it on and off, since the browser has no hyphenation dictionary — which left `overflow-wrap` breaking words mid-syllable into "MARLBORO/UGH" and "COMM/UNITY".
- Fixed: The turn countdown no longer depends on the client clock. `RoomState.serverTime` accompanies the absolute deadline and the client tracks the offset, so a skewed clock cannot show a wrong or negative countdown.
- Fixed: Sessions moved from localStorage to sessionStorage, so each tab is its own player. A second tab previously adopted the first tab's identity, and leaving in one tab pulled the session from under the others. A reload still keeps the session.
- Fixed: Both transports now restrict CORS to `ALLOWED_ORIGIN` instead of reflecting any origin. `isAllowedOrigin` moved into `@monopoly/shared-types` so the Node server and the Worker cannot drift; `security.ts` re-exports it and keeps its tests.
- Fixed: `.env.example` is no longer swallowed by the `*.env.*` ignore rule, so the file the README tells contributors to copy is actually committed. Added `apps/server/.env.example` documenting `ALLOWED_ORIGIN` and `PORT`.
- Files: `apps/web/src/styles.css`, `apps/web/src/CodedBoard.tsx`, `apps/web/src/GameView.tsx`, `apps/web/src/main.tsx`, `apps/server/src/index.ts`, `apps/cloudflare-server/src/index.ts`, `apps/cloudflare-server/src/security.ts`, `packages/shared-types/src/index.ts`, `.gitignore`, and `README.md`.
- Validation: 32 engine + 5 Node + 2 Worker tests, type-check, web build, and Worker dry-run pass. Live two-player checks confirmed a second tab joins as its own player, zero label overflow and no horizontal scroll at both 1280x720 and 375px, and hyphenated names rendering as MARL-BOROUGH and NORTH-UMBER-LAND.
- Gotcha: Board typography must stay in `cqi`, not `vw`. The board is sized by viewport height, so a `vw`-based size inside it will not scale with the board and will overflow its cell.

### 2026-08-09 — Claude

- Changed: The Worker now shards one Durable Object per room via `idFromName(roomCode)`. Every room previously ran through a single object named `global` that persisted all rooms as one storage value, which serialized all concurrent games onto one request queue and would have hard-failed at Cloudflare's 128KB per-value limit as rooms accumulated.
- Changed: Room codes are minted in the stateless entrypoint and used as the object name, so no registry or KV mapping is needed. An object that already holds a room returns 409 and the entrypoint retries with a new code, up to five attempts.
- Changed: `/ws` now requires `?room=CODE` so the upgrade lands on the right object; `createGameSocket` takes the room code. Health, preflight, and origin rejection are answered in the entrypoint so they never spin up a room object.
- Fixed: Alarms are scheduled only when something is actually pending. `persist` previously always rearmed a 30-second alarm and `alarm` always called `persist`, so every room woke up every 30 seconds forever — including empty ones. `nextWakeup` returns the soonest of the turn deadline, disconnect grace expiry, and empty-room prune, or null to clear the alarm entirely.
- Changed: Room-creation throttling moved to a dedicated `RoomLimiter` Durable Object, because sharding removed the shared instance that held it. `MAX_ROOMS` was dropped from the Worker: it existed because all rooms shared one object's memory and storage, which is no longer true. Node keeps its cap.
- Added: `scheduling.ts` holds `nextWakeup` as a pure function with unit coverage, following the existing `security.ts` split for testable boundary logic.
- Files: `apps/cloudflare-server/src/index.ts`, `apps/cloudflare-server/src/scheduling.ts`, `apps/cloudflare-server/src/scheduling.test.ts`, `apps/cloudflare-server/wrangler.jsonc`, `apps/web/src/socket.ts`, and `apps/web/src/main.tsx`.
- Validation: A local `wrangler dev` ran a full two-player game — create, join, WebSocket join, ready, start, roll, dice broadcast, position update — plus per-room isolation, a 404 for an unknown room, a 400 for `/ws` without a code, and the 5-per-window creation limit holding across object boundaries. Alarm behaviour was measured with temporary logging since removed: 75 seconds idle in a lobby with everyone connected fired zero alarms, and a disconnect fired exactly one at the 30-second grace expiry.
- Gotcha: The Durable Object storage key changed from `rooms` (an array of every room) to `room` (this object's single room). No Cloudflare resources have ever been deployed, so there is no migration path and none was written. Adding one is required if that ever stops being true.
- Gotcha: `wrangler dev` must be run from `apps/cloudflare-server`; from the repo root it picks up the wrong config and reports a missing assets directory.

### 2026-08-09 — Claude

- Fixed: A card draw can no longer dereference a missing card. `replenishDeck` reshuffles the discard and, if both piles are somehow empty, rebuilds the full deck; the draw also returns early on a missing index. Normal play cannot empty both piles — only the single Get Out of Jail Free card is ever held back — so this hardens rehydration from persisted Durable Object state.
- Added: Every mode now has a stall backstop. Classic and Monopol declare no `turnTimer`, so one idle-but-connected player froze a room forever: disconnect removal never fires while the socket is open. `GameSnapshot.turnTimeoutSeconds` derives the effective deadline — 300s for an ordinary turn, 60s for an auction, with a mode's own shorter `turnTimer` still winning. Auctions get their own clock because they block every player, not just the current one.
- Changed: `turnRevision` is now bumped on auction bid and pass, so each auction action restarts the deadline rather than letting a lively auction be cut off mid-bidding. Its only consumer is the deadline-reset signal in both transports.
- Changed: Both transports track the timeout their current deadline was derived from, so entering or leaving an auction restarts the clock instead of inheriting the previous phase's remainder.
- Changed: The client shows the countdown only when the mode declares a `turnTimer` (Run-Down, a game rule) or when under 60s remain. Otherwise the idle backstop would render as a permanent five-minute clock in Classic.
- Added: Room creation is capped at 5 per client IP per minute and 500 rooms per server on both transports, returning 429 and 503. Rooms were previously allocated without limit — in memory on Node, and into Durable Object storage on the Worker.
- Files: `packages/game-engine/src/engine.ts`, `packages/game-engine/test/engine.test.ts`, `apps/server/src/index.ts`, `apps/server/src/index.test.ts`, `apps/cloudflare-server/src/index.ts`, and `apps/web/src/GameView.tsx`.
- Validation: 32 engine + 5 Node + 2 Worker tests, workspace type-check, web build, and Worker dry-run pass. The deck-exhaustion test was confirmed to fail with the original `TypeError` against the previous implementation, and a live Socket.IO room confirmed Classic now publishes a 300s deadline where it previously published none.
- Gotcha: The room-creation limiter is keyed by client IP, so every Node test shares one budget. `resetRoomCreationLimits()` is exported for a `beforeEach`; without it a flood test starves whatever runs after it.

### 2026-08-09 — Claude

- Fixed: A forced payment no longer liquidates a player's whole portfolio. `raiseCash`'s building-sale loop had no `break` (unlike the mortgage loop below it), so a player owing £50 sold every house they owned. Replaced with `sellBuildingsToRaise`, which sells one level at a time from the most developed property and stops the moment the debt is covered.
- Changed: Because a forced sale can now stop partway, it sells highest-level-first so colour groups stay even — matching the rule `sellBuilding` already enforces for voluntary sales. A hotel sold when the bank cannot supply its four replacement houses is sold whole for five half-costs.
- Fixed: Trade mortgage interest is charged to both sides. Only the `offered` side paid, so mortgaged properties moving the other direction transferred free. It also used `* 0.1`, which made Park Lane's £175 mortgage value charge £17.50; it now uses `Math.ceil(value / 10)`, consistent with `mortgage()`.
- Added: Regression coverage for both. Each was confirmed to fail against the previous implementation — the forced sale returned `[0, 0]` houses instead of `[3, 3]`, and the trade proposer paid nothing.
- Files: `packages/game-engine/src/engine.ts` and `packages/game-engine/test/engine.test.ts`.
- Validation: 29 engine + 4 Node + 2 Worker tests, workspace type-check, web production build, and Worker dry-run all pass.

### 2026-08-09 — Claude

- Fixed: `room:join` payloads are now fully type-checked before any room lookup. A non-string `roomCode` previously threw inside the Socket.IO handler and escaped as an `uncaughtException`, letting any connected client kill the Node process and every in-progress room. All socket handlers are additionally wrapped so a handler throw returns `SERVER_ERROR` instead of terminating the server.
- Fixed: `apps/web/index.html` was a bare `<div id="root">` with no document shell. The app rendered in quirks mode (`BackCompat`), resolved as `windows-1252` rather than UTF-8, and had no viewport meta, so mobile fell back to the 980px layout viewport and scaled the whole UI to roughly 40%. Added doctype, `lang`, charset, viewport, description, and title.
- Fixed: `pnpm test` failed at the first package. No package declared a Vitest config, so Vitest walked up to the retired root `vite.config.ts` and failed on the uninstalled `@vitejs/plugin-basic-ssl`. Added a `vitest.config.ts` to `packages/game-engine`, `apps/server`, and `apps/cloudflare-server`.
- Added: Regression coverage asserting six malformed `room:join` payloads each return `AUTH_FAILED` with the socket still connected and no `uncaughtException`.
- Files: `apps/server/src/index.ts`, `apps/server/src/index.test.ts`, `apps/web/index.html`, and three new `vitest.config.ts` files.
- Validation: `pnpm test` now runs all three packages (27 engine + 4 Node + 2 Worker). The new test was confirmed to fail against the old handler. Workspace type-check passes. A live two-player game confirmed `CSS1Compat`, UTF-8, a 375px mobile layout viewport, and board geometry unchanged at 796.078px square.
- Known-open from the same audit: forced sales liquidate every building (`raiseCash` lacks the `break` its mortgage loop has), trade mortgage interest is one-sided and can be fractional, card-deck exhaustion with an empty discard throws, non-timed modes and auctions have no stall deadline, neither backend rate-limits room creation, and the Worker routes all rooms through one Durable Object with a single storage value.

### 2026-07-13 — Codex

- Fixed: Replaced independent dice/card client state with one ordered presentation queue, so compound Chance movement waits for the card reveal and Continue action before hopping to its destination and presenting any follow-up utility roll.
- Changed: Authoritative card events now include trusted source/destination and jail movement metadata; card and dice sounds begin only when their queued presentation becomes active.
- Added: Deterministic coverage for the exact `dice → card → utility dice` event order and nearest-Utility movement metadata.
- Files: `packages/game-engine/src/engine.ts`, `packages/game-engine/test/engine.test.ts`, `apps/web/src/main.tsx`, and `apps/web/src/GameView.tsx`.
- Validation: 27 engine tests, web/engine/server type-checks, web production build, Worker dry-run, and whitespace checks pass. A deterministic live browser replay confirmed dice animation → hops to Chance → Chance modal → Continue → per-space hops to Electric Company → landing deed, with no browser console errors.

### 2026-07-13 — Codex

- Changed: Converted the canonical board to the classic UK/London edition with 22 London streets, King’s Cross/Marylebone/Fenchurch St./Liverpool St. stations, Super Tax, Brown/Light Blue/Pink/Orange/Red/Yellow/Green/Dark Blue groups, and pound-denominated UI/history.
- Changed: Replaced both decks with the supplied 16-card UK sets. Chance now contains two nearest-Station cards; Community Chest uses Birthday at £10 per player and School Fees at £50.
- Added: Engine data-integrity coverage for the exact property order, station names, tax name, complete card titles, duplicate nearest-Station Chance cards, and UK-specific Community Chest values.
- Files: `packages/game-engine/src/monopoly.json`, `packages/game-engine/src/engine.ts`, `packages/game-engine/test/engine.test.ts`, `apps/web/src/CodedBoard.tsx`, `apps/web/src/PropertyCard.tsx`, and `apps/web/src/GameView.tsx`.
- Validation: Live two-player browser review found zero board-space overflows; the board and Old Kent Road deed displayed pounds with no dollar remnants. Workspace type-check, 27 engine tests, 3 Node integration tests, 2 Worker tests, production builds, Worker dry-run, JSON-reference checks, and whitespace checks pass.

### 2026-07-13 — Codex

- Changed: Added a synchronized roll presentation pipeline: tumbling dice, a held final result, a doubles announcement, 190 ms per-space token hops, and a landing deed that animates outward from its board space before exposing Buy/Auction.
- Changed: Dice events are queued instead of overwritten, and the host now includes trusted `fromPosition`, `position`, `moved`, and `fromJail` metadata so clients animate movement without deriving gameplay state.
- Changed: Landing/card modals and roll/build/mortgage/trade controls remain locked until the active presentation queue finishes; compound card/utility rolls therefore retain their event order.
- Files: `packages/game-engine/src/engine.ts`, `packages/game-engine/test/engine.test.ts`, `apps/web/src/main.tsx`, `apps/web/src/GameView.tsx`, `apps/web/src/CodedBoard.tsx`, `apps/web/src/PropertyCard.tsx`, and `apps/web/src/styles.css`.
- Validation: Live two-player browser timing confirmed dice animation → final total → intermediate token positions → actor-only landing deed actions. Workspace type-check, 26 engine tests, 3 Node integration tests, 2 Worker tests, web/server builds, Worker dry-run, and whitespace checks pass.

### 2026-07-12 — Codex

- Fixed: Recalculated rotated left/right space wrappers for the board's 1.6:1 side-cell ratio, eliminating clipped labels and content spilling into adjacent spaces or the board center.
- Fixed: Tightened and repositioned Free Parking and Go To Jail corner compositions, and split Go's label, title, and straight arrow into independently positioned layers so all corner content remains contained.
- Why: The preceding board-ratio adjustment retained rotated dimensions designed for 2:1 side cells and visibly broke the generated board.
- Files: `apps/web/src/CodedBoard.tsx` and `apps/web/src/styles.css`.
- Validation: Live two-player browser inspection found zero space-inner bounding-box overflows; an owned, hovered Connecticut Avenue kept its player piece visible. Web production build, workspace type-check, 25 engine tests, 2 Worker tests, and whitespace checks pass.

### 2026-07-12 — Codex

- Fixed: Matched the coded board's track proportions to `board2.png`: corners now occupy about 13.1% instead of 15.4%, leaving wider regular spaces; token and ownership-gutter coordinates use the same ratio.
- Fixed: Rotated Go, Free Parking, Go To Jail, and the inner Jail artwork so each corner's visual top faces the board center; added the reference board's optional Mediterranean soft-hyphen break.
- Fixed: Players on space 10 now render inside Jail only when `isInJail`; ordinary landings render separately on the outer Visiting strip, with collision offsets grouped by zone.
- Fixed: Raised the pointer-transparent token layer above property hover/focus stacking so selectable property cells no longer hide player pieces.
- Why: Correct visual differences found against the supplied board reference and fix two player-token presentation defects.
- Files: `apps/web/src/CodedBoard.tsx` and `apps/web/src/styles.css`.
- Validation: Web production build, workspace type-check, 25 engine tests, 3 Node integration tests, 2 Worker security tests, and whitespace checks pass.

### 2026-07-12 — Codex

- Fixed: Coded street color bands now fill the complete width of horizontal spaces and complete height of rotated side spaces without padding gaps.
- Fixed: Property labels no longer break in the middle of words; the desktop board received a wider layout budget for longer names.
- Changed: Free Parking, Go, and Go To Jail content now angle 45 degrees toward their corners, while Jail uses the classic inner orange jail area plus outer Just/Visiting paths.
- Refined: Non-street spaces now have dedicated content padding. Go keeps a diagonal title with a larger, straight forward arrow; Free Parking and Go To Jail use larger equal-sized title words and icons; and the inner Jail label/art are larger.
- Why: Bring the generated board geometry and corner hierarchy closer to `board2.png` after reviewing the first live screenshot.
- Files: `apps/web/src/CodedBoard.tsx` and `apps/web/src/styles.css`.
- Validation: Web production build, workspace type-check, 25 engine tests, 3 Node integration tests, 2 Worker security tests, and whitespace checks pass.

### 2026-07-12 — Codex

- Changed: Replaced the photographed gameplay board with a reusable, data-driven 13×13 React/CSS board assembled from the engine's canonical 40 `boardSpaces`.
- Changed: Added shared coded variants for streets, railroads, utilities, Chance/Community Chest, taxes, and corners; labels, prices, color groups, owners, mortgages, houses, and hotels now render from live data.
- Changed: Preserved property deed clicks, the external ownership gutter, collision-balanced player tokens, and player highlighting while remapping them to exact coded-grid coordinates.
- Why: Make the board customizable and responsive without editing a monolithic image or duplicating gameplay data.
- Files: `apps/web/src/CodedBoard.tsx`, `apps/web/src/GameView.tsx`, `apps/web/src/styles.css`, `apps/web/src/assets.ts`, and `apps/web/src/assets/images/jail.png`.
- Validation: Web production build, workspace type-check, 25 engine tests, 3 Node integration tests, 2 Worker security tests, and whitespace checks pass. The former `board2.png` layer and transparent property hitboxes are no longer referenced by the active client.
- Follow-up: Perform a fresh two-browser visual check at desktop and mobile widths; the in-app localhost browser connection became unavailable during this change's live-room verification.

### 2026-07-12 — Codex

- Changed: Added synchronized last-roll dice display, broadcast Chance/Community Chest modals with deck-specific artwork, and deck identity on authoritative card events.
- Changed: Unowned landing snapshots now force the property deed open for every client; only the acting player sees Buy/Auction buttons at the bottom, replacing the duplicate sidebar landing controls.
- Fixed: Player-card selection now highlights the corresponding board token for three seconds and then clears automatically; repeated clicks restart the timer.
- Why: Make rolls and card effects visible to the room, centralize the property purchase decision on its deed, and prevent persistent token-selection state.
- Files: `packages/game-engine/src/engine.ts`, `packages/game-engine/test/engine.test.ts`, `apps/web/src/main.tsx`, `apps/web/src/GameView.tsx`, `apps/web/src/GameCard.tsx`, `apps/web/src/PropertyCard.tsx`, `apps/web/src/assets.ts`, and `apps/web/src/styles.css`.
- Validation: Live two-client checks confirmed identical dice, synchronized landing deeds with actor-only actions, three-second highlight expiry, and synchronized Chance presentation. Deterministic engine coverage verifies both Chance and Community Chest deck identities.
- Follow-up: Canonical JSON currently has 15 Chance cards because it includes only one nearest-Railroad card; classic Monopoly has two copies and 16 Chance cards total.

### 2026-07-12 — Codex

- Changed: Added clickable hit areas for all 28 purchasable board spaces and a local-only, accessible property-card modal based on the original `gallery/9.PNG` title-deed design.
- Changed: Added reusable dynamic templates for normal streets, all four railroads, and both utilities, including original rail/electric/water artwork, printed rents and costs, mortgage value, live owner, mortgage, and development status.
- Changed: Extended exported `BoardSpace` metadata with printed base and building rents so UI cards consume the engine's canonical board data rather than duplicating street values.
- Why: Let players inspect complete property rules directly from the board without changing or broadcasting gameplay state.
- Files: `packages/game-engine/src/engine.ts`, `apps/web/src/PropertyCard.tsx`, `apps/web/src/GameView.tsx`, `apps/web/src/assets.ts`, `apps/web/src/styles.css`, and three migrated image assets.
- Validation: Live board clicks verified Vermont Avenue, Reading Railroad, Electric Company, and owned Baltic Avenue; Escape/close restored focus to the clicked property. Web build, workspace type-check, whitespace check, and browser console checks passed.

### 2026-07-12 — Codex

- Fixed: Centered lone player icons on their board spaces and replaced the asymmetric collision offsets with balanced layouts for two through six players sharing a space.
- Changed: Gameplay player cards are now accessible toggle buttons; selecting one applies a color-matched animated focus ring to exactly that player's board icon, with reduced-motion support.
- Why: The previous collision table shifted the first token up and left even when no collision existed, and players had no quick way to locate a specific token.
- Files: `apps/web/src/GameView.tsx` and `apps/web/src/styles.css`.
- Validation: Live two-player measurements placed lone and grouped token centers within 0.01 px of the intended space center; card selection and highlight switching each targeted exactly one token. Web build, workspace type-check, whitespace check, and browser console checks passed.

### 2026-07-12 — Codex

- Fixed: Replaced equal-step board coordinates with geometry that accounts for `board2.png`'s oversized corner spaces, correcting both ownership-tag and token placement near every corner.
- Fixed: Matched ownership-tag length to the actual regular-space size and moved tags next to the board edge within the concentric gutter.
- Why: Equal division progressively displaced tags from their corresponding property cells, most visibly on lower left-side properties.
- Files: `apps/web/src/GameView.tsx`.
- Validation: Live two-player purchase of States Avenue; its left-side tag matched the cell's top, bottom, and center. Web build, workspace type-check, and whitespace check passed.

### 2026-07-12 — Codex

- Changed: Inset the artwork inside a transparent double-frame board stage and added a snapshot-driven ownership ring in the surrounding gutter.
- Changed: Every owned street, railroad, and utility renders a segment aligned with its board space using the owner's stable player color; mortgaged properties use a striped version of that color, and player cards use the same color key.
- Why: Make ownership legible at board scale without obscuring or modifying the supplied board artwork.
- Files: `apps/web/src/GameView.tsx` and `apps/web/src/styles.css`.
- Validation: web build, workspace type-check, whitespace check, and live two-player purchase flow. Buying Reading Railroad produced exactly one correctly labeled owner segment aligned with space 5.

### 2026-07-12 — Codex

- Changed: Replaced the CSS-recreated gameplay board with the supplied `public/board2.png` art and overlaid live player tokens at the corresponding 40 Monopoly board positions.
- Changed: Corrected token indexing so engine icon `0` (Player 1) renders `p1.png`, through engine icon `5` rendering `p6.png`; added the missing `p6.png` to the active Vite assets.
- Why: Use the original board visual exactly as intended and align visible player assets with the requested Player 1–6 naming convention.
- Files: `apps/web/src/GameView.tsx`, `apps/web/src/styles.css`, `apps/web/src/assets.ts`, and `apps/web/src/assets/images/board2.png` / `p6.png`.
- Validation: web build, workspace type-check, whitespace check, and a live two-player room. Browser inspection confirmed `/src/assets/images/board2.png` plus `/src/assets/images/p1.png` and `p2.png` load with no console errors.

### 2026-07-12 — Codex

- Changed: Migrated selected original visual/audio assets into the active Vite client: Josefin Sans and Courier Prime fonts, board/card artwork, player-token art, and compact gameplay sound effects.
- Why: Restore the original project’s visual character without reviving the retired PeerJS UI or making the 16 MB legacy music track part of the production bundle.
- Files: `apps/web/src/assets/`, `apps/web/src/assets.ts`, `apps/web/src/GameView.tsx`, `apps/web/src/main.tsx`, and `apps/web/src/styles.css`.
- Validation: web build, workspace type-check, 25 engine tests, 3 Node integration tests, 2 Worker boundary tests, and live two-player browser rendering passed with no console errors.

### 2026-07-12 — Codex

- Changed: Repaired saved-session reconnect/recovery, native WebSocket readiness/reconnect, lobby locking, multi-socket disconnect accounting, active-room pruning, host synchronization, Worker CORS/message validation, and Node/Worker event parity.
- Changed: Implemented doubles and third jail roll rules, complete-group rent, card movement/rent/data corrections, persisted decks, preset win/timer behavior, finite building inventory and sales, auctions, and automatic bankruptcy settlement.
- Changed: Replaced the workspace debug page with a responsive 40-space board, lobby, player/turn/property panels, landing/jail/build/mortgage controls, atomic trades, auctions, event history, countdown, and winner display.
- Validation: Two-browser create/join/ready/roll/buy/turn-handoff flow passed with no fresh-page console errors; 25 engine tests, 3 Node integrations, 2 Worker boundary tests, workspace type-check, web build, and Worker dry-run pass.
- Follow-up: Remove root PeerJS source, old lockfiles, and `docs/` in a dedicated cleanup commit after committing the workspace migration; add full Miniflare Durable Object persistence tests before production deployment.

### 2026-07-12 — Codex

- Changed: Restored lobby controls in the workspace frontend after an authoritative lobby snapshot arrives. Players can now toggle readiness, see every player's readiness state, and the lobby host can select a preset mode.
- Why: The first ready action creates the server engine and sends a `lobby` snapshot; the old conditional rendered neither the pre-engine Ready button nor any lobby controls once that happened.
- Files: `apps/web/src/main.tsx`.
- Validation: `pnpm --filter @monopoly/web build`; `pnpm --filter @monopoly/game-engine test` (12 tests).

### 2026-07-11 — Codex

- Changed: Added a tested host-authoritative `GameEngine`, breaking action/snapshot PeerJS protocol, official mortgage/building/trade rules, a snapshot-driven game screen, bot protocol migration, safe config example, and Vitest coverage.
- Why: Prevent clients from forging gameplay state and correct trade, card, mortgage, building, capacity/mode, disconnect, and winner-name injection defects.
- Files: `src/assets/gameEngine.ts`, `src/assets/server.ts`, `src/Pages/Home/monopoly.tsx`, bot files, tests, configuration/docs, and generated deploy assets.
- Follow-ups: Resolve the repository's unrelated ESLint backlog before treating `npm run lint` as a release gate.

### 2026-07-11 — Codex

- Changed: Added secure trade proposal/accept/reject controls, an authoritative event feed, `config.local.ts` overrides, text-only notifications, and additional card/trade engine tests.
- Why: Complete the usable client path for the authority protocol and remove the remaining dynamic HTML notification sink.
- Files: `src/Pages/Home/monopoly.tsx`, `src/components/notificator.tsx`, peer configuration files, tests, README, and generated deploy assets.
- Follow-ups: Full `npm run lint` still reports 40 legacy errors in unrelated Home/menu/settings/socket files; affected authority/UI files pass targeted lint.

### 2026-07-11 — Codex

- Changed: Extracted a transport-independent host controller and added fake-socket protocol tests; expanded engine tests to cover tax, railroad rent, doubles in jail, exact mortgage redemption, disabled trades, and disconnect cancellation.
- Why: Verify the authority boundary as well as individual rules, and catch arithmetic errors before release.
- Files: `src/assets/server.ts`, `src/assets/server.test.ts`, `src/assets/gameEngine.ts`, and `src/assets/gameEngine.test.ts`.
- Follow-ups: Interactive two-browser PeerJS testing still requires a browser automation runtime or manual deployment test.

### 2026-07-11 — Codex

- Changed: Began Kachuful-style workspace migration with shared engine/types packages, a local Express/Socket.IO room API, a Cloudflare Durable Object Worker, and a Vite guest-session client.
- Why: Move authority from PeerJS/browser hosting to a persistent, server-owned room model with Cloudflare Pages-compatible configuration.
- Files: `packages/*`, `apps/server`, `apps/cloudflare-server`, `apps/web`, workspace manifests, and README.
- Follow-ups: Add Miniflare Durable Object tests and complete the full board/trade UI migration before production deployment; no Cloudflare resources have been deployed.

### 2026-07-11 — Codex

- Changed: Added authoritative reconnect pausing, 30-second disconnect expiry, Durable Object alarm-driven cleanup, and basic property controls to the workspace frontend.
- Why: Complete server-owned room lifecycle behavior and prevent actions while the current player reconnects.
- Files: shared engine, Node server, Cloudflare Worker, and Vite web app.
- Follow-ups: The legacy root PeerJS source remains for reference until the workspace web client reaches full board/trade UI parity; Worker deployment has not been performed.
