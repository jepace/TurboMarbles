# TurboMarbles

A web-based, turn-based multiplayer marble racing game where strategy meets chaos. Race your marbles from base to home while sending your opponents back to start — but watch out, because with **two dice** in play, the board can flip in an instant.

---

## Overview

TurboMarbles is a browser-based board game for 2–4 players. Each player controls a set of colored marbles and races them around a shared track, trying to get all marbles safely into their home zone. The twist: rolling two dice each turn opens up split moves, doubles bonuses, and way more ways to wreck your friends' plans.

---

## How to Play

### Goal
Be the first player to move all of your marbles from your **Base** into your **Home** zone.

### Setup
- Each player picks a color and starts with all 4 marbles sitting in their Base.
- Play order is determined randomly at the start.

### Turn Structure
1. **Roll** both dice.
2. **Choose** how to use the result:
   - Use the **total** of both dice to move a single marble.
   - Use each die **separately** to make two moves (same marble or different marbles).
3. **Move** your marble(s) the chosen number of spaces clockwise around the track.
4. If you land on an opponent's marble, it gets **sent back to their Base**.

### Getting Out of Base
- A marble can only leave Base when you roll a **1** or a **6** on either die (or a combined total of **7**).
- Once out, it is placed on your designated start space.

### Doubles Bonus
- Rolling doubles (matching numbers on both dice) earns you an **extra roll** after completing your move.
- Rolling doubles three times in a row forfeits your turn.

### Safe Spaces
- Certain marked spaces on the board are **Safe Zones** — marbles on these spaces cannot be sent back to Base.
- Your own start space is always safe.

### Shortcut Spaces
- The board includes a **center shortcut** accessible from specific spaces. Landing on a shortcut entry point lets you cut across the board on your next turn for a significant leap forward.

### Winning
- To enter your Home zone, you must roll the **exact number** needed to reach it.
- The first player to get all 4 marbles into Home wins.

---

## Features

- **2–4 Player Support** — play locally (pass-and-play) or against others online
- **Two-Dice Mechanics** — split moves, doubles bonuses, and tactical choices every turn
- **Animated Board** — smooth marble movement and dice roll animations
- **Color Themes** — choose from classic colors for each player
- **Turn Timer** (optional) — keep the game moving with a configurable per-turn clock
- **Game Log** — real-time event feed showing every roll and capture
- **Responsive Design** — playable on desktop and tablet

---

## Tech Stack

| Layer     | Technology          |
|-----------|---------------------|
| Frontend  | HTML5, CSS3, JS (ES Modules) |
| Canvas    | HTML5 Canvas API    |
| Backend   | Node.js + Express   |
| Realtime  | WebSockets (ws)     |
| State     | Server-side game engine |

---

## Getting Started

### Prerequisites
- Node.js 18+
- npm 9+

### Install & Run

```bash
git clone https://github.com/your-org/TurboMarbles.git
cd TurboMarbles
npm install
npm start
```

Then open your browser to `http://localhost:3000`.

### Development Mode

```bash
npm run dev
```

This starts the server with hot-reload via `nodemon`.

---

## Project Structure

```
TurboMarbles/
├── public/
│   ├── index.html        # Game shell
│   ├── style.css         # Board and UI styles
│   └── js/
│       ├── main.js       # Entry point
│       ├── board.js      # Canvas rendering
│       ├── dice.js       # Dice animation and logic
│       └── client.js     # WebSocket client
├── src/
│   ├── server.js         # Express + WebSocket server
│   ├── GameRoom.js       # Room and session management
│   └── GameEngine.js     # Core rules and state machine
├── package.json
└── README.md
```

---

## Rules Reference Card

| Situation | Rule |
|---|---|
| Leaving Base | Roll a 1, 6, or total of 7 |
| Bump opponent | Send their marble back to Base |
| Land on Safe space | Cannot be bumped |
| Roll doubles | Take an extra turn |
| Three doubles in a row | Forfeit turn |
| Entering Home | Must roll exact count |

---

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit your changes with clear messages
4. Open a pull request

Please keep pull requests focused — one feature or fix per PR.

---

## License

MIT — see [LICENSE](LICENSE) for details.
