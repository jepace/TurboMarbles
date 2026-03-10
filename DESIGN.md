# TurboMarbles — Design Document

## 1. Overview

TurboMarbles is a turn-based multiplayer browser game for 2–6 players. The server is the authoritative source of all game state. Clients render the board and send player actions; the server validates moves, advances state, and broadcasts updates to all players in the room.

---

## 2. Technology Stack

All chosen technologies are available on FreeBSD via `pkg` or the ports tree.

| Concern          | Technology                  | FreeBSD package       |
|------------------|-----------------------------|-----------------------|
| Runtime          | Node.js 20 LTS              | `node20`              |
| HTTP server      | Express 4                   | (npm)                 |
| WebSockets       | `ws` library                | (npm)                 |
| Persistence      | SQLite 3 (via `better-sqlite3`) | `sqlite3` + (npm) |
| Reverse proxy    | nginx                       | `nginx`               |
| Process manager  | FreeBSD rc.d service        | built-in              |
| Frontend         | Vanilla JS (ES modules), HTML5 Canvas | —        |

No build step is required for the frontend. No Linux-specific APIs are used.

---

## 3. Board Layout

Based on the Aggravation 6-player board, adapted for TurboMarbles.

### Shape

The board is a **6-pointed star**. Six colored arms radiate from a central hub at 60° intervals. There are **three separate paths** a marble can travel:

1. **Main track** — the outer 84-space ring; all marbles travel clockwise.
2. **Star track** — an inner circle of exactly 6 spaces (one per player's star); adjacent stars are 1 step apart.  A marble that lands on any star space may use this track on future turns.
3. **Center hub** — a single space in the middle, 1 step from every star on the star track.

```
              [Base]
                |
           [Home lane]  ← 4 slots, inward toward center
                |
           [Home entry]
                |
  ──[★]──[  ]──[Start]──[  ]──[  ]──[  ]──[  ]──[★]──
         ↑                                        ↑
    shortcut star                           shortcut star
    (prior player's                         (this player's
       section)                               section)
                       [Center Hub]
                    (shortcut destination)
```

### Track numbering

84 spaces, numbered **1–84 clockwise** around the outer ring.

| Player | Color  | Start space | Shortcut star | Home entry |
|--------|--------|-------------|---------------|------------|
| 0      | Yellow | 1           | 8             | 84         |
| 1      | Orange | 15          | 22            | 14         |
| 2      | Pink   | 29          | 36            | 28         |
| 3      | White  | 43          | 50            | 42         |
| 4      | Green  | 57          | 64            | 56         |
| 5      | Blue   | 71          | 78            | 70         |

- Each player owns **14 consecutive spaces** (e.g., Player 0 owns spaces 1–14).
- **Start space**: the first space in a player's section; marble placed here on exit from Base.
- **Shortcut star**: 7 spaces into the player's section (the midpoint; gold star-burst on the physical board).
- **Home entry**: the last space before the next player's start; turning inward here enters the home lane.

### Home lane

Each player has a **private 4-slot home lane** running from the board edge inward toward the center hub. These slots are off the main track and cannot be landed on by opponents.

- Slots are numbered 1 (outermost) to 4 (innermost, closest to center).
- A marble enters slot 1 from the home entry space using an exact roll.
- Subsequent exact rolls advance it deeper (slot 1 → 2 → 3 → 4).

### Base

Each player has **4 base slots** at the tip of their arm, fully off the track. Marbles start here and return here when bumped.

### Star Track

When a marble lands **exactly** on any star space (via main-track movement), it becomes **star-eligible** and may use the star track on future turns — and remains star-eligible as long as it stays on a star.

From a star-eligible marble, any die may be used to travel **K steps clockwise** around the inner star circle (K = 1–5, stopping before a full loop).  After K star-steps the marble can:
- **Stop on that star** (remaining die steps = 0)
- **Enter the center hub** (remaining = 1; the hub is 1 step from any star)
- **Exit onto the main track** and continue the remaining die steps from that star

A marble is still star-eligible after stopping on a star via the star track.

### Center Hub

The center hub is **1 step from any star** on the star track.

- **Entering**: A marble may reach the center from the **main track** (die count = stepsToAnyStar + 1, landing there exactly) or from the **star track** (1 remaining step at any intermediate star).
- **Exiting**: Requires a die of **1**; the marble exits to any star (not blocked by own marble) and becomes star-eligible.
- **Bumping**: Arriving at the center bumps any opponent marble already there.  Only the final landing position is checked for bumping.

### Canvas coordinate system

The board is drawn on an HTML5 Canvas. Layout is computed geometrically from these constants:

```js
const CENTER = { x: 500, y: 500 };  // canvas center
const ARM_LENGTH = 340;             // pixels from center to base tip
const ARM_WIDTH = 80;               // pixels
const SPACE_RADIUS = 14;            // hole circle radius
const PLAYERS = 6;
const ANGLE_STEP = (2 * Math.PI) / PLAYERS; // 60°

// Each player i has arm angle: i * ANGLE_STEP - Math.PI / 2
// (Player 0 points straight down, matching the photo reference)
```

Track space pixel positions are pre-computed once at startup and stored in a 84-element array indexed by space number. Home lane and base slot positions are stored separately per player.

---

## 4. Game Rules (Authoritative Reference)

### Players and marbles
- 2–6 players, each with 4 marbles.
- All marbles start in the player's Base.

### Turn structure
1. Player rolls both dice.
2. Each die represents an **independent move** — they are never summed.
3. The player chooses which die to play first.
4. Each die move must be applied to a marble (any marble, including the same marble twice).
5. **Both dice must be used** every turn. If a legal move exists for a die, it must be played. If no legal move is possible for a die, that die is forfeited.

### Getting out of Base
- A marble leaves Base only when the player rolls a **1** or a **6** on a die.
- That die's value (1 or 6) is consumed to move the marble from Base onto the player's start space.
- The start space must be **unoccupied by the player's own marble** to exit. If it is occupied by an opponent, the opponent is bumped.
- A **6** used to leave Base still triggers the extra-roll rule.

### Rolling a 6
- Rolling a **6** on either die grants the player **one extra roll** after completing both moves.
- Rolling 6–6 grants only **one** extra roll — sixes do not stack.
- The extra roll follows the same rules as a normal turn (both dice, both must be used).

### Movement blocking — cannot pass your own marble
- A marble **cannot move through or land on** a space occupied by another of the player's own marbles.
- If a die move would require passing your own marble, that move is illegal for that die.
- **Exception — shortcut path**: While in the shortcut path (star → center → star), a marble may pass over your own marbles that are on the main track. However, it still cannot pass your own marble that is also on the shortcut path (star or center).

### Bumping
- Landing on a space occupied by an **opponent's marble** sends that marble back to its owner's Base.
- The Center Hub follows the same rule — arriving there bumps any marble already present.
- Marbles in **Base** and **Home** cannot be bumped under any circumstances.

### Entering Home
- A marble may only enter the home lane from the player's designated home entry space.
- The player must roll the **exact number** needed to advance a marble to an open home slot.
- Overshooting (rolling more than needed) is illegal for that die; the die is forfeited for that marble.
- A marble already in the home lane cannot move forward if its path is blocked by another of the player's own marbles.

---

## 5. Architecture

```
┌─────────────────────────────────────────┐
│                Browser                  │
│  Canvas renderer  │  WebSocket client   │
└───────────────────┬─────────────────────┘
                    │ WSS
┌───────────────────▼─────────────────────┐
│              nginx (TLS termination)    │
└───────────────────┬─────────────────────┘
                    │ HTTP upgrade / proxy
┌───────────────────▼─────────────────────┐
│           Node.js app (port 3000)       │
│                                         │
│  ┌─────────────┐   ┌─────────────────┐  │
│  │   Express   │   │   ws Server     │  │
│  │  (HTTP/API) │   │  (game events)  │  │
│  └──────┬──────┘   └────────┬────────┘  │
│         │                   │           │
│  ┌──────▼───────────────────▼────────┐  │
│  │          GameManager              │  │
│  │  - Room registry (in-memory)      │  │
│  │  - Session → Room mapping         │  │
│  └──────────────┬────────────────────┘  │
│                 │                       │
│  ┌──────────────▼────────────────────┐  │
│  │          GameEngine               │  │
│  │  - State machine per room         │  │
│  │  - Rule enforcement               │  │
│  │  - Move validation                │  │
│  └──────────────┬────────────────────┘  │
│                 │                       │
│  ┌──────────────▼────────────────────┐  │
│  │          SQLite (better-sqlite3)  │  │
│  │  - Completed game records         │  │
│  │  - (Active game state in memory)  │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

Active game state lives **in memory** for speed. SQLite stores completed game records and is used to restore rooms after a server restart (serialized state snapshot written on each move).

---

## 6. State Machine

Each game room moves through these states:

```
LOBBY → STARTING → IN_TURN → AWAITING_MOVE → EXTRA_ROLL → GAME_OVER
```

| State           | Description                                                  |
|-----------------|--------------------------------------------------------------|
| `LOBBY`         | Waiting for players to join and ready up                     |
| `STARTING`      | Countdown before first turn                                  |
| `IN_TURN`       | Active player has been notified; waiting for roll            |
| `AWAITING_MOVE` | Dice have been rolled; waiting for player to submit moves    |
| `EXTRA_ROLL`    | Player rolled a 6; waiting for the bonus roll                |
| `GAME_OVER`     | A player has moved all marbles home                          |

---

## 7. Data Model

### Room

```json
{
  "roomId": "abc123",
  "state": "AWAITING_MOVE",
  "players": [
    {
      "id": "ws-session-id",
      "color": "red",
      "name": "Alice",
      "marbles": [
        { "id": 0, "location": "base" },
        { "id": 1, "location": "track", "space": 14 },
        { "id": 2, "location": "track", "space": 38, "shortcutPending": true },
        { "id": 3, "location": "home", "slot": 1 }
      ]
    }
  ],
  "turnIndex": 0,
  "dice": [3, 6],
  "diceUsed": [false, false],
  "extraRollPending": true
}
```

### Marble location values

| Value                      | Meaning                                         |
|----------------------------|-------------------------------------------------|
| `{ zone: "base" }`         | In player's base, not on track                  |
| `{ zone: "track", space: n }` | On the main ring at space 1–84              |
| `{ zone: "home", slot: n }` | In home lane at slot 1–4                       |
| `{ zone: "center" }`       | On the center hub (shortcut transit)            |

Shortcut eligibility is a boolean flag on the marble: `shortcutEligible: true`. It is set when the marble lands on the player's shortcut star, and cleared when the shortcut is used or the marble moves off the star.

---

## 8. WebSocket Protocol

All messages are JSON. The client sends **actions**; the server sends **events**.

### Client → Server

| Action             | Payload                                           |
|--------------------|---------------------------------------------------|
| `join`             | `{ roomId, playerName }`                          |
| `ready`            | `{}`                                              |
| `roll`             | `{}`                                              |
| `move`             | `{ dieIndex: 0|1, marbleId: 0-3, useShortcut?: bool }` |
| `forfeitDie`       | `{ dieIndex: 0|1 }` (only when no legal move exists) |

### Server → Client (broadcast)

| Event              | Payload                                           |
|--------------------|---------------------------------------------------|
| `roomState`        | Full room snapshot (on join or reconnect)         |
| `playerJoined`     | `{ player }`                                      |
| `rolled`           | `{ playerId, dice: [n, n] }`                      |
| `marbleMoved`      | `{ playerId, marbleId, from, to }`                |
| `marbleBumped`     | `{ bumpedPlayerId, marbleId }`                    |
| `turnChanged`      | `{ turnIndex, playerId }`                         |
| `extraRoll`        | `{ playerId }`                                    |
| `gameOver`         | `{ winnerId }`                                    |
| `error`            | `{ code, message }`                               |

---

## 9. Frontend

### Rendering
- The board is drawn on an **HTML5 Canvas** element.
- Layout is computed once on load; marbles are drawn on top as circles in player colors.
- Marble movement is animated by interpolating position over ~300ms.

### Files
```
public/
├── index.html
├── style.css
└── js/
    ├── main.js        # Bootstrap, room join flow
    ├── socket.js      # WebSocket wrapper, event dispatch
    ├── board.js       # Canvas draw, layout constants
    ├── marbles.js     # Marble state, animation
    └── dice.js        # Dice roll animation, display
```

### Move flow (client side)
1. Server sends `rolled` → dice values displayed.
2. Player clicks a marble → client highlights legal destinations for the next unused die.
3. Player clicks a destination (or the shortcut option if available) → client sends `move`.
4. Server responds with `marbleMoved` (and possibly `marbleBumped`, `extraRoll`, `turnChanged`).
5. Repeat for second die.

---

## 10. Lobby & Room Flow

### Creating a game

1. Player visits the site, enters their name.
2. Clicks **Create Game** and selects total player count (2–6).
3. Server creates a room and returns a short **room code** (e.g. `KFMQ`).
4. Host shares the code out-of-band (text, Discord, etc.).
5. As other humans join, they appear in the waiting room list.
6. Host may click **Add Robot** on any unfilled slot at any time.
7. Host clicks **Start** once the room is full (all slots human or robot). A single human playing against all robots is valid.

### Joining a game

1. Player visits the site, enters their name.
2. Clicks **Join Game**, enters the room code.
3. Lands in the waiting room; waits for host to start.

### Disconnection during a game

- If a human player's WebSocket disconnects, the server starts a **2-minute countdown**.
- The disconnected player's turns are skipped during the countdown.
- If they reconnect before the timer expires, they resume normally.
- If the timer expires, a **robot permanently takes over** that player's marbles for the rest of the game.

### Robot players

- Robots share the same turn interface as human players (same WebSocket events, same rule engine).
- The server handles a robot's turn internally: on `IN_TURN`, the robot computes and submits its moves server-side without a WebSocket round-trip.
- Robot strategy is heuristic-based (v1): prioritize getting marbles out of base, advance the furthest marble, bump opponents when possible.

---

## 11. FreeBSD Deployment

### Service setup

Create `/usr/local/etc/rc.d/turbomarbles`:

```sh
#!/bin/sh
. /etc/rc.subr
name="turbomarbles"
rcvar="turbomarbles_enable"
command="/usr/local/bin/node"
command_args="/usr/local/turbomarbles/src/server.js"
pidfile="/var/run/${name}.pid"
load_rc_config $name
run_rc_command "$1"
```

Enable in `/etc/rc.conf`:
```
turbomarbles_enable="YES"
```

### nginx config (TLS termination)

```nginx
server {
    listen 443 ssl;
    server_name marbles.example.com;

    ssl_certificate     /usr/local/etc/letsencrypt/live/marbles.example.com/fullchain.pem;
    ssl_certificate_key /usr/local/etc/letsencrypt/live/marbles.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

### Required packages

```sh
pkg install node20 sqlite3 nginx
```

---

## 12. Open Questions (Post-v1)

All core design decisions are resolved. Items to revisit after v1:

- [ ] Turn timer: configurable per-turn clock (already in feature list; exact UI TBD)
- [ ] Spectator mode
- [ ] Idle room cleanup: how long before a finished/abandoned room is purged from memory
