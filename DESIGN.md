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

The board is a fixed track of **96 spaces** arranged in a loop, plus a center shortcut region.

```
         [Home A]
            |
... - [97] - [98] - [99] - [100/Start A] - [1] - [2] - ...
                                  |
                             (shortcut in)
                                  |
                            [Center Hub]
                                  |
                             (shortcut out)
                                  |
... - [48] - [49] - [50/Start C] - [51] - ...
```

### Zones per player

Each player color owns:
- **Base** — 4 slots, off the main track; immune to bumping.
- **Start space** — the entry point onto the main track.
- **Home** — 4 slots at the end of a private lane; immune to bumping.
- **Shortcut entry** — one specific track space that grants shortcut access.

### Shortcut

- Landing exactly on a **shortcut entry space** activates the shortcut for that marble.
- On the player's **next turn**, they may choose to move that marble through the center hub, skipping a significant portion of the track.
- The marble exits at the shortcut's paired **exit space** on the far side of the board.
- A player may decline the shortcut and move normally instead.

### Space numbering

Track spaces are numbered 1–96 globally. Each player's home lane is a separate sequence (e.g., `A-home-1` through `A-home-4`), not part of the main loop.

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
- A **6** used to leave Base still triggers the extra-roll rule.

### Rolling a 6
- Rolling a **6** on either die grants the player **one extra roll** after completing both moves.
- Rolling 6–6 grants only **one** extra roll — sixes do not stack.
- The extra roll follows the same rules as a normal turn (both dice, both must be used).

### Bumping
- Landing on a space occupied by an **opponent's marble** sends that marble back to its owner's Base.
- A player may not bump their own marbles.
- Marbles in **Base** and **Home** cannot be bumped under any circumstances.

### Entering Home
- A marble may only enter the home lane from the player's designated entry point.
- The player must roll the **exact number** needed to advance a marble to an open home slot.
- Overshooting (rolling more than needed) means the marble cannot enter; the die is forfeited for that marble.

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

| Value             | Meaning                                  |
|-------------------|------------------------------------------|
| `"base"`          | In player's base, not on track           |
| `"track"` + space | On the main track at global space number |
| `"home"` + slot   | In home lane at slot 1–4                 |
| `"shortcutPending"` | On track, eligible for shortcut next turn |

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

Items not yet decided:

- [ ] What are the exact shortcut entry and exit space numbers?
- [ ] Board visual design — top-down grid, circular path, or custom shape?
- [ ] Is there a maximum room idle timeout before the room is closed?
- [ ] Is a spectator mode desired?
- [ ] Local pass-and-play vs. online-only, or both?
