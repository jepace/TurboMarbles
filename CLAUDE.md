# TurboMarbles — Developer Notes for Claude

## Project Overview
Turn-based multiplayer marble racing game for 2–6 players. Players roll two dice and move marbles around a board, with shortcuts via star spaces and a center hub. First to get all 4 marbles home wins.

## How to Run
```
npm start          # production
npm run dev        # nodemon watch mode
```

For internet-facing deployment, set these environment variables:
```
HOST=127.0.0.1          # bind to loopback only; put nginx/caddy in front for TLS
ORIGIN=https://example.com  # enables WebSocket origin checking (reject other origins)
PORT=8080               # default (server.js's own fallback when PORT is unset)
```

## Running Tests
Always run tests after code changes:
```
node test/engine.mjs      # GameEngine unit tests (no server needed)
node test/manager.mjs     # GameManager unit tests (no server needed)
node test/cli.mjs         # CLI helper unit tests (no server needed)
node test/endgame.mjs     # endgame table + robot endgame play (no server needed)
node test/thinker.mjs     # robot background thinking: deadline / fallback guarantees (no server needed)
node test/cube.mjs        # doubling cube: rules, scoring, robot cube decisions, rematch (no server needed)
node test/store.mjs       # players, device keys, link codes, games, stats (in-memory SQLite)
node test/accounts.mjs    # account actions + finished games recorded with analysis (no server needed)
node test/integration.mjs # integration tests (requires server running)
```

## Architecture
**Server-authoritative.** The server owns all game state and rules. The client only renders and sends user input.

- `src/GameEngine.js` — pure rule engine (no I/O, no WebSockets). All move validation, legal move computation, and state mutation lives here. Re-exports constants from `public/js/constants.js`.
- `src/GameManager.js` — WebSocket session/room management. Calls GameEngine. Handles connect/disconnect/reconnect.
- `src/RobotPlayer.js` — AI heuristics. Calls GameEngine's `allLegalMoves`, picks best move by score. Near home it switches to exact values from the endgame table.
- `src/EndgameTable.js` + `src/endgame-table.json` — precomputed endgame table (exact expected turns and finish-time distributions for every position within 12 squares of home). Rebuild with `node tools/build-endgame-table.mjs` after any rules change that affects movement near home.
- `src/DuelTable.js` + `src/duel-11.json.gz`, `src/duel-12.json.gz` — exact solutions of two-player endgames: both players down to their last marble (any home layout), and last marble vs two out (tidy homes). Used by the robot and the analysis page. Rebuild with `node tools/build-duel-table.mjs` (≈6 min for 11, longer for 12) after any rules change that affects movement; the build checks its move composition against the engine first.
- `src/RobotRollout.js`, `src/RobotThinker.js`, `src/robotThinkWorker.js` — late-game robot thinking: rollouts of its options in one background worker; `think()` always settles by the deadline (`config.robotThinkMs`, default 1500; 0 = off) and the robot falls back to its normal move. It only overrides the normal move when a rollout winner is clearly better.
- `src/Evaluator.js` + `src/evaluator-weights.json` — instant position evaluator (softmax over players: race, base, home, danger, to-move; exact duel tables when they apply; `evaluate1` = 1-ply over the next roll). Fitted by `tools/train-evaluator.mjs` (gen / fit). Used for the instant analysis pass and to pick which options get played out.
- `src/Store.js` — SQLite (built-in `node:sqlite`, Node 22.13+; disabled cleanly if missing): players, device keys (only hashes stored), link codes, finished games (roll records + analysis, gzipped), per-seat stats. `DATA_DIR` (rc.d: `/var/db/turbomarbles`; default `data/`).
- `src/Accounts.js` — account WebSocket actions (identify/register/rename/linkCode/redeemLink/signOutOthers/deleteAccount/profile/history/openGame), rate-limited per IP. Passwordless: the device key is the login; names are unique, and guests can't use a registered name.
- `src/server.js` — Express + WebSocket server entry point.
- `public/js/constants.js` — **single source of truth** for all board constants (`PLAYER_CONFIG`, `ARM_MAP`, `ALL_STARS`, etc.). Imported by GameEngine, board.js, main.js, and cli.mjs.
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
- **Left edge**: 6 spaces, running bottom→top. The top-most space is this player's own **star space** (08 in the diagram).
- **Bottom edge**: 5 spaces connecting left and right columns. Corner spaces are shared with the left/right edges. The **center space of the 5 is the start space** (where marbles exit from base). The space immediately **to the right of start** is the **home entry**.
- **Right edge**: 6 spaces, running top→bottom. Its top-most space is the **previous arm's star** (78 in the diagram) — the two columns do NOT meet; each U has two *different* stars at its top corners.
- **Stars are shared**: each star is simultaneously the top of one arm's left column and the top of the next arm's right column, sitting on the boundary between the two arms. The 6 stars form the inner star-track ring, and the main track zigzags: along a bottom row, up a column to a star, down the next arm's column, and so on.
- **Home corridor**: 4 slots inside the U, running bottom (slot 1, near bottom edge) → top (slot 4, level with the stars). Separate lane from the main track, between the two columns.
- **Base**: 1×4 row of slots outside the U opening (below the bottom edge), where marbles start the game.

### Special Zones
- **Star space**: Top corner of each U, shared between adjacent arms. Landing here grants access to the **star track** (inner ring connecting all 6 stars). Die=1 or 6 required to exit base; landing on own star enables star-track movement.
- **Center hub**: Single zone in the middle of the board. Reached by moving exactly 1 step past any star. Exit costs die=1, can emerge on any unblocked star.
- **Home**: 4 slots per player inside their arm's U corridor. Marbles can only move forward, cannot overshoot slot 4. Cannot be bumped once in home.

### Square Numbers (board, move log, feedback, tools)
Like backgammon, every player numbers the track from their own side: a
square's number is its walking distance to that player's home entry (0 = home
entry, 83 = start square) — `countdown` / `fromCountdown` / `locName` /
`parseLocName` in `public/js/constants.js`. Each player sees their own numbers
on the board (option "Numbers on board"); the move log, feedback and analysis
use the **mover's** numbers ("30/25 12/9"). Home slots are `h1`–`h4`; also
`hub` and `base`. Hovering a square shows every player's number for it. (The
old colour names, `spaceName`/`parseSpaceName`, are still accepted by the tools.)

## Game Rules Summary
- 2 dice per turn; each die moves one marble.
- Die=1 or 6 to exit base.
- Rolling a 6 earns an extra roll after the turn.
- Landing on an opponent's marble bumps it back to base.
- Own marbles block your own path.
- Passing your own home is never forced: walking past your home entry, or hopping along the star
  track off/past your approach star (the star just before your arm), is an optional move. A die
  whose only moves are optional can be skipped (Skip Die).
- First player with all 4 marbles in home wins.
- Optional doubling cube (2 players, money play; chosen when creating the room): double only at the
  start of your turn before rolling (not before an extra roll from a 6). Take → the cube doubles and
  is yours; only the owner redoubles. Drop → lose the cube's current value. A win scores the cube
  value, double for an **aggro** (loser has no marbles home). Every 2-player room keeps a money score
  across Rematches (without the cube a win is 1 point, an aggro 2); 3+ players: games won. Robot cube play: `src/CubeDecision.js` (exact duel tables, else played-out estimates;
  Janowski money-play formulas). Cube decisions are analysed too (`src/CubeAnalysis.js`): in-game feedback
  (`cubeFeedback`) and post-game rows with no double / double-take / double-drop equities.
- Jacoby rule (money play option): an aggro only counts double once the cube has been turned.
- Matches to N points (2 players; Crawford rule: no doubling in the first game after someone reaches
  N−1, then post-Crawford). Match score per room; Rematch continues the match, then starts a new one.
  Cube decisions in a match use a match equity table for this game (`src/MatchEquity.js`, from the
  measured 7.3% aggro rate; cube ownership valued like money play where the cube is alive), shown in equity units (EMG).
- Analysis numbers are all **equity** (decimals of the stake; losing a game = 1.0): a move's win-chance
  loss x shows as 2x; errors 0.06–0.20, blunders ≥ 0.20, for moves and cube alike. Plain chances
  (hit, finish next turn) stay percentages.

## Do Not Change Without Asking
- The board shape described above — it has been carefully specified and previous attempts to "improve" it broke the layout.
- The server-authoritative model — clients must never compute or trust their own move validation.


## Wire Protocol Notes

All WebSocket messages are JSON. Key conventions:

- Every `{ event: 'error' }` message includes a `code` string field (e.g. `UNKNOWN_ACTION`, `ILLEGAL_MOVE`, `MISSING_FIELDS`).
- The `rolled` event and the `legalMoves` event both use `moves` as the field name for the legal-moves object (keyed by die index string: `{ "0": [...], "1": [...] }`).
- Unknown `action` values receive `{ event: 'error', code: 'UNKNOWN_ACTION' }` rather than being silently dropped.

