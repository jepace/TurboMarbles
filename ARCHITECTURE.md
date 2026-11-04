# TurboMarbles — Architecture Reference

This document is the authoritative technical reference. It reflects the actual
current codebase. (The older `DESIGN.md` is preserved as historical context but
contains outdated data — see the note at the top of that file.)

---

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser                              │
│                                                             │
│  main.js (UI controller)        board.js (canvas renderer) │
│       ↕ DOM events                    ↕ drawBoard()         │
│  socket.js (WebSocket wrapper)                              │
└──────────────────────────┬──────────────────────────────────┘
                           │ WebSocket (JSON)
┌──────────────────────────▼──────────────────────────────────┐
│                Node.js app (port 3000)                      │
│                                                             │
│  server.js   ← Express static files + WebSocket dispatch   │
│       ↓                                                     │
│  GameManager.js  ← Room registry, session management,      │
│                    disconnect timers, robot scheduling      │
│       ↓                                                     │
│  GameEngine.js   ← Pure rule engine. No I/O.               │
│       ↓                                                     │
│  RobotPlayer.js  ← Heuristic AI. Calls allLegalMoves +     │
│                    applyMove.                               │
└─────────────────────────────────────────────────────────────┘
```

**Key principle: server-authoritative.** The server re-derives all legal moves
before applying any client-submitted move. Clients never trust their own computed
moves. Clients render state received from the server.

**No persistence.** All game state is in memory. Restarting the server destroys
all active rooms. There is no database.

**No build step.** Vanilla ES modules, HTML5 Canvas. No bundler, no transpiler.

---

## File Reference

| File | Purpose |
|------|---------|
| `src/server.js` | Entry point. Express static serving + WebSocket server. Dispatches incoming messages to GameManager. |
| `src/GameEngine.js` | Pure rule engine. All legal move computation and state mutation. No I/O. |
| `src/GameManager.js` | Room lifecycle (create/join/start/finish), session tracking, disconnect/reconnect, robot scheduling, undo/commit. |
| `src/RobotPlayer.js` | Heuristic AI. Scores all legal moves and picks the best. |
| `public/index.html` | Single-page app. All screens (landing, lobby, game) are divs toggled with `display`. |
| `public/style.css` | All CSS. |
| `public/js/main.js` | UI controller. Handles WebSocket events, marble selection, click-to-move, animation, game log. |
| `public/js/board.js` | Canvas renderer. `computeLayout()` calculates pixel positions once. `drawBoard()` renders frame. No game logic. |
| `public/js/board-spec.md` | **Read this instead of board.js** for board geometry. Space numbering, geometry constants, position formulas. |
| `public/js/socket.js` | Thin WebSocket wrapper. Exposes `connect()`, `send()`, `on(event, handler)`. |
| `test/engine.mjs` | GameEngine unit tests (~140 assertions). No server needed. |
| `test/manager.mjs` | GameManager unit tests (~60 assertions). No server needed. |

---

## Data Model

### Room (server-side, never sent to clients directly)

```js
{
  id: string,            // internal room ID
  code: string,          // 4-char join code (e.g. "KFMQ")
  hostId: string,        // playerId of the host (slot 0)
  totalPlayers: number,  // 2–6
  state: 'lobby' | 'playing' | 'finished',
  slots: [               // fixed-size array, one per totalPlayers
    {
      index: number,          // 0-based player index
      playerId: string|null,  // assigned on join; 'robot-N' for robots
      name: string|null,
      color: string,          // from ARM_MAP → PLAYER_CONFIG (e.g. 'yellow')
      isRobot: boolean,
      ws: WebSocket|null,     // null when disconnected
    }
  ],
  game: GameState|null,  // null until startGame()
  disconnectTimers: Map<playerIndex, TimeoutId>,
  robotTurnTimer: TimeoutId|null,
}
```

### GameState (the engine's state object)

```js
{
  players: [
    {
      id: string,        // playerId
      name: string,
      color: string,     // arm-mapped color name
      isRobot: boolean,
      index: number,     // 0-based
      config: {          // from PLAYER_CONFIG[ARM_MAP[n][i]]
        color: string,
        start: number,   // track space where marbles exit base (1–84)
        star: number,    // this player's star space (8/22/36/50/64/78)
        homeEntry: number, // last track space before home corridor
      },
      marbles: [
        {
          id: number,           // 0–3
          zone: 'base'|'track'|'home'|'center',
          space: number|null,   // track space (1–84) when zone='track'
          slot: number|null,    // home slot (1–4) when zone='home'
          starEligible: boolean,// true when sitting on a star (enables star track)
        }
      ]
    }
  ],
  turnIndex: number,          // index of current player
  phase: 'IN_TURN'|'AWAITING_MOVE'|'EXTRA_ROLL'|'GAME_OVER',
  dice: [number, number]|null, // null before roll
  diceUsed: [boolean, boolean],
  winner: number|null,        // playerIndex of winner, or null

  // Undo support (set by GameManager, read by handleUndo)
  _undoStack: Array<{marbles, diceUsed}>,
  _rollSnapshot: Array<Array<marble>>,  // snapshot at roll time
  _humanMadeMove: boolean,
}
```

### publicState (what clients receive)

The server strips internal fields and sends:

```js
{
  players: [{ index, name, color, isRobot, marbles }],
  turnIndex, phase, dice, diceUsed
}
```

Clients never see `config`, `id`, `_undoStack`, etc.

---

## ARM_MAP — Player-to-Arm Mapping

Players are assigned arms based on player count to maximize visual spacing:

```js
ARM_MAP = {
  2: [0, 3],           // opposite arms (yellow, white)
  3: [0, 2, 4],        // evenly spaced (yellow, pink, green)
  4: [0, 1, 3, 4],     // (yellow, orange, white, green)
  5: [0, 1, 2, 3, 4],  // first five
  6: [0, 1, 2, 3, 4, 5], // all six
}
```

**Important:** `playerIndex 1` in a 2-player game uses arm 3 (white, start=43),
NOT arm 1 (orange, start=15). Always use `player.config.start` (not
`PLAYER_CONFIG[playerIndex]`) when you need a player's board positions.

### PLAYER_CONFIG (indexed by arm, 0–5)

| Arm | Color  | Start | Star | HomeEntry |
|-----|--------|-------|------|-----------|
| 0   | yellow | 1     | 8    | 84        |
| 1   | orange | 15    | 22   | 14        |
| 2   | pink   | 29    | 36   | 28        |
| 3   | white  | 43    | 50   | 42        |
| 4   | green  | 57    | 64   | 56        |
| 5   | blue   | 71    | 78   | 70        |

`homeEntry` for arm `a` = `a*14` = the last space of the previous arm.
Marbles cross `homeEntry` to redirect into the home corridor.

---

## Turn Phase State Machine

```
      startGame()
          │
          ▼
       IN_TURN  ◄─────────────────────────────────────────┐
          │                                               │
          │ handleRoll()                                  │
          ▼                                               │
    AWAITING_MOVE ──► (both dice used, human moved)       │
          │           → readyToCommit broadcast           │
          │           → handleCommit() → commitTurn()     │
          │                                               │
          │         (both dice used, robot or no moves)   │
          │           → commitTurn() immediately          │
          │                                               │
          ▼                                               │
       commitTurn()                                       │
          │                                               │
          ├──► earnsExtraRoll? ──► EXTRA_ROLL ──► IN_TURN ┤
          │                                               │
          └──► nextTurn() ─────────────────────────────► ─┘
                                          (unless GAME_OVER)
```

**Room state** (separate from game phase):
- `lobby` → players joining, host can add robots
- `playing` → game in progress
- `finished` → `gameOver` event emitted

---

## WebSocket Protocol

All messages are JSON. Connection is established when the user first clicks
Create or Join.

### Client → Server Actions

| `action` | Fields | Description |
|----------|--------|-------------|
| `createRoom` | `name`, `totalPlayers` | Create a new room (2–6 players) |
| `joinRoom` | `code`, `name` | Join an existing room by 4-char code |
| `addRobot` | — | (Host only) Fill an empty slot with a robot |
| `startGame` | — | (Host only) Start the game once all slots are filled |
| `roll` | — | Roll both dice (only during IN_TURN or EXTRA_ROLL phase) |
| `move` | `move` object | Submit a move (see move format below) |
| `forfeitDie` | `dieIndex` | Forfeit a die with no legal moves (0 or 1) |
| `undo` | — | Undo the last move this turn |
| `commit` | — | Commit the turn and advance to next player |
| `reconnect` | `roomId`, `playerIndex`, `reconnectToken` | Rejoin after disconnect |

**Move object format:**
```js
{
  type: 'exitBase'|'move'|'moveHome'|'moveStar'|'enterCenter'|'exitCenter',
  dieIndex: 0|1,
  marbleId: 0|1|2|3,
  toZone: 'track'|'home'|'center',  // required
  toSpace: number,                   // for track destinations
  toSlot: number,                    // for home destinations
  toStar: number,                    // for exitCenter (the target star space)
}
```

### Server → Client Events

**Lobby events:**

| `event` | Fields | Who receives |
|---------|--------|--------------|
| `roomCreated` | `roomId`, `code`, `reconnectToken`, `color` | Host only |
| `joinedRoom` | `roomId`, `playerIndex`, `lobbyState`, `reconnectToken` | Joiner only |
| `playerJoined` | `playerIndex`, `name`, `color`, `isRobot?` | All others |
| `playerLeft` | `playerIndex` | All (lobby only) |
| `error` | `message` | Requester only |

**Game start:**

| `event` | Fields | Who receives |
|---------|--------|--------------|
| `gameStarted` | `gameState` | All players |

**In-turn events (broadcast to all):**

| `event` | Fields | Description |
|---------|--------|-------------|
| `rolled` | `playerIndex`, `dice`, `legalMoves` | Dice rolled. `legalMoves` only included for the active player. |
| `marbleMoved` | `playerIndex`, `marbleId`, `from`, `to`, `path` | A marble moved. `path` is array of waypoints for animation. |
| `marbleBumped` | `ownerIndex`, `marbleId`, `from` | A marble was sent to base. Always precedes the mover's `marbleMoved`. |
| `dieForfeit` | `dieIndex` | A die was auto-forfeited (no legal moves). |
| `turnSkipped` | `playerIndex` | Player had zero legal moves; turn auto-skipped. |
| `readyToCommit` | `playerIndex` | Human player used both dice; waiting for Commit. |
| `extraRoll` | `playerIndex` | Player rolled a 6; gets bonus roll. |
| `turnChanged` | `playerIndex` | Next player's turn begins. |
| `gameOver` | `winnerIndex` | All 4 marbles in home. |

**Unicast events (to one client only):**

| `event` | Fields | Description |
|---------|--------|-------------|
| `legalMoves` | `moves`, `diceUsed` | Updated legal moves after each die use. Active player only. |
| `error` | `code`, `message` | Invalid move or action rejection. |

**Undo/reconnect events:**

| `event` | Fields | Who receives |
|---------|--------|-------------|
| `undone` | `gameState` | All (full state resync) |
| `reconnected` | `gameState` | Reconnecting player only |
| `playerDisconnected` | `playerIndex`, `timeoutMs` | All |
| `playerReconnected` | `playerIndex` | All others |
| `robotTookOver` | `playerIndex` | All |

---

## Move Types (GameEngine)

| Type | From zone | Die required | Description |
|------|-----------|-------------|-------------|
| `exitBase` | base | 1 or 6 | Move marble from base to player's start space |
| `move` | track | any | Normal clockwise movement on main track; may redirect into home |
| `moveHome` | home | any | Advance within home corridor; no overshoot past slot 4 |
| `enterCenter` | track | stepsToStar + 1 | Divert into center hub via a star |
| `exitCenter` | center | 1 | Exit to any unblocked star; marble becomes starEligible. No other die moves a marble out of the hub. |
| `moveStar` | track (starEligible) | any | Travel K stars on the inner star ring (K ≤ die; blocked by own marbles), then optionally continue on main track. K = 6 with a 6 is a full lap back to the starting star. |

---

## Key Invariants

- **Own marbles block you** — you cannot move through or land on a space occupied
  by one of your own marbles. This applies to main track and star track.
- **Opponents are passable on star track** — when traversing the inner star ring,
  opponent marbles on stars do not block. Only your own do.
- **Bumping** — landing on an opponent's marble (track, star, or center) sends it
  to their base. Bumped marble: `zone='base'`, `space=null`, `slot=null`,
  `starEligible=false`.
- **Home is safe** — marbles in home cannot be bumped.
- **No overshoot** — a marble cannot advance past slot 4 in home. The die is
  forfeited for that marble if it would overshoot.
- **Exact home entry** — the `homeEntry` space counts as 0 steps into home.
  A marble crossing `homeEntry` on step 3 of a die=5 move enters slot 2.
- **Win = all 4 marbles in home zone** — not necessarily slot 4. Any slot counts.

---

## Undo / Commit Flow

- On each `roll`, the server saves `_rollSnapshot` (full marble positions).
- On each `applyMove`, a snapshot of `{marbles, diceUsed}` is pushed to `_undoStack`.
- `handleUndo` pops `_undoStack` and restores marble positions + diceUsed.
- `handleCommit` is only accepted when both dice are used; calls `commitTurn()`.
- Robots auto-commit; humans must explicitly commit (or have turn auto-advanced
  if they had no legal moves).

---

## Disconnect / Reconnect

1. Player disconnects → `sessions.delete(ws._id)`, `slot.ws = null`.
2. In lobby: slot cleared immediately, `playerLeft` broadcast, room deleted if empty.
3. In game: `playerDisconnected` broadcast, 2-minute timer starts.
4. Within 2 minutes: player sends `reconnect` with `roomId`, `playerIndex`,
   `reconnectToken` → timer cancelled, `reconnected` event + full gameState sent.
5. After 2 minutes: `slot.isRobot = true`, `robotTookOver` broadcast. Reconnect
   now rejected with `'Slot not available'`.

---

## Robot Player

`RobotPlayer.js` exports `robotTakeTurn(game, playerIndex, applyCallback)`.

Score priorities (higher = preferred):
| Move type | Score |
|-----------|-------|
| Win move (last marble to home, all others in home) | 10000 |
| Bump opponent | 800 |
| Advance toward home | 600 + slot×40 |
| Enter home | 550 + slot×40 |
| Exit base | 400 |
| Exit center (bump) | 750 |
| Exit center (no bump) | 300 + progress |
| Enter center | 250 |
| Normal move | 200 + progress |

The robot always uses both dice. If a die has no legal moves, it's forfeited.

---

## Board Space Numbering

84 total spaces, numbered 1–84 clockwise. 6 arms × 14 spaces.
Arm `a` uses spaces `a*14+1` through `a*14+14`.

Within each arm (offsets from `base = a*14`):

| Offset | Description |
|--------|-------------|
| +1 | Start space (exit from base), center of the arm's bottom row |
| +2, +3 | Rest of the bottom row; +3 is the corner at the foot of the left column |
| +4 … +7 | Left column, rising toward the center |
| +8 | STAR, top of the left column — shared with the NEXT arm (it is also the top of that arm's right column) |
| +9 … +13 | The next arm's right column, descending (+13 is its bottom corner) |
| +14 | On the next arm's bottom row, immediately beside its start — this is the next arm's home entry |

Each star sits on the boundary between two arms; the 6 stars form the inner
star-track ring. See `board-drawing` (repo root) for the trusted picture of
one arm's U.

Track wraps: 84 → 1.

For pixel coordinates and rendering geometry, see `public/js/board-spec.md`.

---

## Testing

Both test files use a custom `assert(condition, label)` / `describe(label, fn)`
harness — no external test framework, no dependencies beyond Node.js.

```bash
node test/engine.mjs    # ~140 assertions: track math, legal moves, bumping,
                        # home entry, win condition, undo, robot scoring, etc.
node test/manager.mjs   # ~60 assertions: room lifecycle, WebSocket dispatch,
                        # forfeit guards, disconnect/reconnect, undo/commit
```

Tests use a mock WebSocket (`MockWs`) that records sent messages. Helper
`getEvents(ws)` extracts events by name for assertion.

Always run both test files after modifying GameEngine.js or GameManager.js.
