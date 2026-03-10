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

The board is a **6-pointed star**. Six colored arms radiate from a central hub at 60° intervals. The outer track is an 84-space ring connecting all six arms. Marbles travel clockwise.

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

### Shortcut (Center Hub)

The shortcut path is: **track star → Center Hub → any track star**. Each leg costs exactly one die value of **1**.

- **Entering the hub**: When a marble is on a shortcut star space and the player rolls (or chooses to apply) a **1**, the marble moves to the Center Hub instead of advancing one track space.
- **Exiting the hub**: On any subsequent turn, when the player rolls (or applies) a **1**, the marble exits to **any** shortcut star of the player's choosing. The marble is placed on that star and play continues from there.
- **Bumping applies**: The center hub is a normal space for bumping. A marble arriving at the center bumps any marble already there, sending it back to its owner's Base.
- **Choice**: The player may always choose to move along the track normally instead of taking the shortcut, even when holding a 1.

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

## 10. FreeBSD Deployment

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

## 11. Open Questions (Pre-Implementation)

- [ ] Is there a maximum room idle timeout before the room is closed?
- [ ] Robo-player: which player slots can be filled by a bot, and how does the host trigger it?
