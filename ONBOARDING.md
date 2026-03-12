# TurboMarbles — Onboarding Guide

Welcome! This guide gets you productive fast. It covers running the game locally,
understanding the codebase structure, and where to start for common tasks.

---

## Quick Start

```bash
npm install
npm run dev        # starts server on http://localhost:3000 with auto-reload
```

Open two browser tabs to `http://localhost:3000` to play against yourself.

To run tests (no server needed):
```bash
node test/engine.mjs    # GameEngine unit tests (~140 assertions)
node test/manager.mjs   # GameManager unit tests (~60 assertions)
```

---

## What Is This?

TurboMarbles is a turn-based multiplayer marble racing game for 2–6 players.
Each player has 4 marbles. Roll two dice each turn, move marbles around an
84-space track. First to get all 4 marbles home wins.

Shortcuts exist: landing on a star space lets you use an inner ring shortcut
between all six stars. The center hub connects all stars and can be entered/exited.

**The server owns all game state.** Clients only render and send input. The server
validates every move before applying it.

---

## File Map (Start Here)

```
src/
  GameEngine.js     ← The rule engine. All game logic. No I/O. START HERE.
  GameManager.js    ← WebSocket session/room management. Calls GameEngine.
  RobotPlayer.js    ← AI player. Calls GameEngine, picks moves by score.
  server.js         ← Express + WebSocket entry point. Thin dispatch layer.

public/
  index.html        ← Single-page app shell, all screens
  style.css         ← All styles
  js/
    main.js         ← UI controller, event handlers, canvas interaction
    board.js        ← Canvas renderer. No game logic.
    board-spec.md   ← AUTHORITATIVE reference for board geometry. Read this
                       instead of board.js if you need to understand the layout.
    socket.js       ← Thin WebSocket wrapper, event dispatch

test/
  engine.mjs        ← GameEngine unit tests
  manager.mjs       ← GameManager unit tests

ARCHITECTURE.md     ← Full technical reference (data model, WebSocket protocol,
                       state machine, design decisions)
CLAUDE.md           ← Notes for AI assistants (read by Claude)
```

---

## The Three Things to Read First

1. **`ARCHITECTURE.md`** — Understand the full system: data flow, WebSocket
   protocol, state machine, marble data model.

2. **`src/GameEngine.js`** — All game rules live here. Well-commented. Read
   the top half first (constants, `createGame`, `legalMovesForDie`).

3. **`public/js/board-spec.md`** — The board's space numbering system. You
   need this to understand how spaces relate to coordinates.

---

## Understanding a Turn

1. Server sends `rolled` event → client displays dice, highlights legal destinations.
2. Player clicks a marble → client filters `legalMovesCache` for that marble.
3. Player clicks a highlighted destination → client sends `{ action: 'move', move }`.
4. Server validates against server-computed legal moves → applies via `applyMove`.
5. Server broadcasts `marbleMoved` (plus any `marbleBumped`, `gameOver`).
6. After each move, server sends `legalMoves` back to the active player.
7. When both dice are consumed, server sends `readyToCommit`.
8. Player clicks Commit (or presses Enter) → client sends `{ action: 'commit' }`.
9. Server advances to next turn → broadcasts `turnChanged` (or `extraRoll`).

---

## Common Development Tasks

### Add a new game rule
1. Modify `legalMovesForDie` or `applyMove` in `src/GameEngine.js`.
2. Add test cases in `test/engine.mjs` to verify the rule.
3. Run `node test/engine.mjs` to confirm all tests pass.

### Add a new UI event
1. Add a handler in `public/js/main.js` using `on('eventName', handler)`.
2. The server sends the event from `src/GameManager.js` via `broadcast(room, msg)`.

### Understand why a move is illegal
Look at `legalMovesForDie` in `GameEngine.js`. The function returns an array of
legal move objects. If a move type is missing from the return array, it's illegal.
The server re-validates every move in `tryApplyMove` before applying it.

### Add a test
Both test files use a tiny custom harness (`assert` + `describe`). No dependencies.
Append a new `describe` block and run `node test/engine.mjs` or `node test/manager.mjs`.

---

## Things NOT to Change Without Asking

- **`PLAYER_CONFIG` in `GameEngine.js`** — star/start/homeEntry space numbers must
  stay in sync with the board renderer. Changing one without the other breaks rendering.

- **`ARM_MAP`** — determines which arm each player uses in an n-player game. Changing
  this changes color assignments and board positions for existing room codes.

- **Server-authoritative model** — never compute legal moves on the client and trust
  them. The server always re-derives and validates.

- **Board geometry constants in `board.js`** — the visual layout was carefully tuned.

---

## Key Concepts to Know

### ARM_MAP
Player colors are not `playerIndex`-based — they're arm-based. In a 2-player game,
`ARM_MAP[2] = [0, 3]`, so player 0 uses arm 0 (yellow) and player 1 uses arm 3
(white). This ensures good visual spacing. Always use `player.config` to get a
player's start/star/homeEntry — never index `PLAYER_CONFIG` directly by `playerIndex`.

### starEligible
When a marble lands on any star space (spaces 8, 22, 36, 50, 64, 78), it becomes
`starEligible = true`. This unlocks star-track movement on future dice. The flag
is cleared when the marble moves off a star, moves to home, or gets bumped.

### Undo stack
After each roll, `game._rollSnapshot` captures marble positions. Each `applyMove`
pushes to `game._undoStack`. `handleUndo` pops the stack, restoring state. The
stack is reset on each new roll.

### Disconnect / reconnect
When a player disconnects mid-game, a 2-minute timer starts. The slot is NOT
immediately given to a robot. The player can reconnect with their `reconnectToken`
within the 2 minutes. After timeout, `slot.isRobot = true` and a robot takes over.

---

## Running the Integration Tests

The integration tests require a running server:
```bash
npm start &            # start server in background
node test/test.mjs     # integration tests
```
