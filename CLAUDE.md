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
node test-engine.mjs   # GameEngine unit tests (no server needed)
node test-manager.mjs  # GameManager unit tests (no server needed)
node test.mjs          # integration tests (requires server running)
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

## Board Layout

### The Shape
The board has **6 arms**, each a **U-shape**, arranged in a circle (60° apart) so the U openings face outward and the bottoms of adjacent Us connect to form a continuous ring.

```
        ★  ← star (apex, top of U, closest to center)
       | |
       | |  ← home corridor (4 slots, inside the U)
       | |
  ─────┴─┴─────  ← bottom edge of U (5 spaces)
       ↑
    start space (center of the 5 bottom spaces)
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
- The space numbering / `PLAYER_CONFIG` in `GameEngine.js` (star/start/homeEntry positions) — the renderer and engine must stay in sync.
- The board shape described above — it has been carefully specified and previous attempts to "improve" it broke the layout.
- The server-authoritative model — clients must never compute or trust their own move validation.
