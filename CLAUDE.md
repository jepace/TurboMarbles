# TurboMarbles — Developer Notes for Claude

## Project Overview
Turn-based multiplayer marble racing game for 2–6 players. Players roll two dice and move marbles around a board, with shortcuts via star spaces and a center hub. First to get all 4 marbles home wins.

## How to Run
```
npm start          # production
npm run dev        # nodemon watch mode
```

## Running Tests
Always run tests after code changes:
```
node test/engine.mjs      # GameEngine unit tests (no server needed)
node test/manager.mjs     # GameManager unit tests (no server needed)
node test/integration.mjs # integration tests (requires server running)
```

## Architecture
**Server-authoritative.** The server owns all game state and rules. The client only renders and sends user input.

- `src/GameEngine.js` — pure rule engine (no I/O, no WebSockets). All move validation, legal move computation, and state mutation lives here.
- `src/GameManager.js` — WebSocket session/room management. Calls GameEngine. Handles connect/disconnect/reconnect.
- `src/RobotPlayer.js` — AI heuristics. Calls GameEngine's `allLegalMoves`, picks best move by score.
- `src/server.js` — Express + WebSocket server entry point.
- `public/js/board.js` — **Canvas renderer only.** `computeLayout()` calculates all space pixel positions. `drawBoard()` renders everything. No game logic here.
- `public/js/main.js` — UI controller. Handles WebSocket events, marble animation, game log.
- `public/js/socket.js` — thin WebSocket client wrapper.
- `cli.mjs` — standalone terminal client. ASCII board renderer, interactive play via readline.

## Board Layout

### The Shape
The board has **6 arms**, each a **U-shape**, arranged in a circle (60° apart) so the U openings face outward and the bottoms of adjacent Us connect to form a continuous ring.

```

          [CS]

[08*]     [H4]      [78*]
[07]      [H3]      [79]
[06]      [H2]      [80]
[05]      [H1]      [81]
[04]                [82]
[03] [02] [01] [84] [83]

   [B1] [B2] [B3] [B4]

where:
01-08, 78-84 are the spaces on the track
* indicates that space is on the star track
CS is the center space
H1 - H4 is the Home corridor
B1 - B4 is the Base
01 is the Start space for this player
84 is the entry to Home space for this player

```

### Anatomy of One U-arm
- **Left edge**: 6 spaces, running bottom→top. The top-most space is the **star space** (apex).
- **Bottom edge**: 5 spaces connecting left and right columns. Corner spaces are shared with the left/right edges. The **center space of the 5 is the start space** (where marbles exit from base). The space immediately **to the right of start** is the **home entry**.
- **Right edge**: 6 spaces, running top→bottom. Top-most is also the star (the two edges meet at the apex).
- **Home corridor**: 4 slots inside the U, running bottom (slot 1, near bottom edge) → top (slot 4, near star). Separate lane from the main track, between the two columns.
- **Base**: 1×4 row of slots outside the U opening (below the bottom edge), where marbles start the game.

### Special Zones
- **Star space**: Top of each arm. Landing here grants access to the **star track** (inner ring connecting all 6 stars). Die=1 or 6 required to exit base; landing on own star enables star-track movement.
- **Center hub**: Single zone in the middle of the board. Reached by moving exactly 1 step past any star. Exit costs die=1, can emerge on any unblocked star.
- **Home**: 4 slots per player inside their arm's U corridor. Marbles can only move forward, cannot overshoot slot 4. Cannot be bumped once in home.

## Game Rules Summary
- 2 dice per turn; each die moves one marble.
- Die=1 or 6 to exit base.
- Rolling a 6 earns an extra roll after the turn.
- Landing on an opponent's marble bumps it back to base.
- Own marbles block your own path.
- First player with all 4 marbles in home wins.

## Do Not Change Without Asking
- The board shape described above — it has been carefully specified and previous attempts to "improve" it broke the layout.
- The server-authoritative model — clients must never compute or trust their own move validation.

---

## Architect's Review — Open Issues

The following problems were identified in a full codebase review. They are prioritized by impact.
Do not close an item until the fix is verified by tests.

### P1 — Correctness

- **Race condition: undo after commit** (`GameManager.js`).
  A client can send `undo` after both dice are used if `readyToCommit` is in flight.
  The server has no guard; `_undoStack` can be popped against an already-committed turn.
  Fix: reject `undo` when `phase === 'COMMITTED'` (or equivalent); add a test that sends
  undo and commit in the same tick.

- **No bounds validation on incoming move fields** (`GameManager.js` `handleMove`).
  `toSpace`, `toSlot`, `dieIndex` are passed straight through to `applyMove` after only a
  legal-set membership check. A crafted message with `dieIndex: 999` could throw or
  corrupt state. Fix: validate numeric fields against known ranges before the lookup.

- **Unknown actions silently dropped** (`server.js` dispatch).
  An unrecognised `action` string produces no response to the sender. Clients that typo an
  action name get no feedback. Fix: send `{ event: 'error', code: 'UNKNOWN_ACTION' }` for
  unrecognised actions.

### P2 — Maintainability (constants duplication)

- **`PLAYER_CONFIG`, `ARM_MAP`, `ALL_STARS` are duplicated in four files**:
  `src/GameEngine.js`, `public/js/board.js`, `public/js/main.js`, `cli.mjs`.
  The CLI even comments that its copy "mirrors GameEngine.js … display only", which is
  precisely the kind of comment that signals the duplication is known and unresolved.
  Fix: export a `PROTOCOL` object from `GameEngine.js`; import it in `board.js` and
  `main.js`; bundle or inline it for `cli.mjs` (or import via the same path).
  **Do not touch the board shape or numbering while doing this.**

- **Inconsistent `legalMoves` field name on the wire**.
  The `rolled` event carries `legalMoves` (plural); the subsequent per-move `legalMoves`
  event carries `moves`. Both `main.js` and `cli.mjs` compensate by accessing both field
  names. Pick one name and use it everywhere; update both clients and the test fixtures.

- **Error messages lack a `code` field** in half of the code paths.
  `GameManager.js` line 226 sends `{ event:'error', code:'ILLEGAL_MOVE', message }`;
  `server.js` sends `{ event:'error', message }` with no code. Clients can't branch on
  error type reliably. Fix: add a `code` string to every error emission.

### P3 — Observability

- **No logging on socket send errors**.
  Both `sendTo` and `broadcast` swallow all exceptions with a bare `catch {}`.
  Silent failures hide bugs: an OOM error looks the same as a closed socket.
  Fix: log unexpected errors (`err.code !== 'ERB_CLOSED'` or similar) at minimum.

- **No server-side logging of illegal move attempts**.
  Cheating or bugs produce a silent `{ event:'error', code:'ILLEGAL_MOVE' }` to the
  sender only. Add a server-side `console.warn` with room, player, and move details.

### P4 — Test coverage gaps

- **`undo`/`commit` edge cases** are not tested:
  - undo with empty `_undoStack`
  - commit when `diceUsed = [true, false]`
  - two undos in a row (should restore earlier snapshot)

- **`cli.mjs` has zero tests**.
  The ASCII board geometry (`buildSpaceGrid`) is testable in isolation — no server needed.
  The move description formatter (`describeMove`) is pure — add at least a table-driven test
  covering all 7 move types.

- **Concurrent-action stress path** is untested.
  Two clients sending `move` in the same event-loop tick. The integration test is sequential;
  add one test that interleaves sends.

### P5 — Minor / cosmetic

- **Test entry-point paths are stale** in the original CLAUDE.md (`test-engine.mjs`,
  `test-manager.mjs`, `test.mjs`). The actual files are under `test/`. Fixed above.

- **`cli.mjs` board redraws on every `marbleMoved` event**, including events for other
  players mid-roll. This floods the terminal during robot turns. Rate-limit redraws to
  one per turn boundary (`turnChanged`) except when it's the human's own marble moving.

- **Robot win-score constant** (`RobotPlayer.js` line 49) is `10000` with no comment.
  Name it `WIN_SCORE` and add a comment explaining why it must dominate all other scores.

