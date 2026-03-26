# TurboMarbles

A web-based, turn-based multiplayer marble racing game where strategy meets chaos. Race your marbles from base to home while sending your opponents back to start — but watch out, because with **two dice** in play, the board can flip in an instant.

---

## Overview

TurboMarbles is a browser-based board game for 2–6 players. Each player controls a set of colored marbles and races them around a shared track, trying to get all marbles safely into their home zone. The twist: rolling two dice each turn creates constant choices — and constant threats.

---

## How to Play

### Goal
Be the first player to move all of your marbles from your **Base** into your **Home** zone.

### Setup
- Each player picks a color and starts with all 4 marbles sitting in their Base.
- Play order is determined randomly at the start.

### Turn Structure
1. **Roll** both dice.
2. Each die is an **independent move** — dice are never combined into a single total.
3. You choose the **order** in which to play each die.
4. Each die can move any marble (including using both dice on the same marble in sequence).
5. Landing on an opponent's marble sends it **back to their Base**.

### Getting Out of Base
- A marble can only leave Base when you roll a **1** or a **6** on either die.
- Once out, it is placed on your designated start space.
- A **6** that moves a marble out of Base still triggers an extra roll.

### Rolling a Six
- Rolling a **6** on either or both dice earns you an **extra roll** after completing your move.
- Rolling 6–6 still grants only **one** extra roll — sixes do not stack.

### Safe Spaces
- **Base** and **Home** are untouchable — marbles there cannot be bumped.
- Everywhere else on the track is fair game.

### Star Spaces and the Center Hub
- Each arm has a **star space** at its apex.
- Landing on your **own star** lets you use the **star track** (an inner ring connecting all 6 stars), which can teleport your marble across the board in a single die move.
- Moving exactly one step past any star puts your marble in the **center hub**. From there, a die=1 lets you exit onto any unblocked star.

### Entering Home
- Once a marble reaches your home entry space, it can move into your Home corridor (slots 1–4).
- Your marble advances as many slots as the die value allows, but **cannot overshoot slot 4** — if the die would move it past slot 4, the move is illegal.
- Marbles in Home cannot be bumped.

### Winning
- The first player to get all 4 marbles into Home wins.

---

## Features

- **2–6 Player Support** — online multiplayer; optional heuristic robot player fills empty slots
- **Two-Dice Mechanics** — independent dice with player-chosen order create tactical decisions every turn
- **Star Track Shortcuts** — use star spaces and the center hub to leapfrog opponents
- **Undo Support** — undo your last die move before committing your turn
- **Animated Board** — smooth marble movement and dice roll animations
- **Game Log** — real-time event feed showing every roll and capture
- **CLI Client** — play from the terminal with `node cli.mjs`
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

### Terminal Client

```bash
node cli.mjs                    # connect to localhost:3000
node cli.mjs ws://host:3000     # connect to a remote server
```

---

## Project Structure

```
TurboMarbles/
├── public/
│   ├── index.html           # Game shell
│   ├── style.css            # Board and UI styles
│   └── js/
│       ├── constants.js     # Shared board constants (source of truth)
│       ├── main.js          # UI controller, WebSocket event handling
│       ├── board.js         # Canvas renderer
│       └── socket.js        # WebSocket client wrapper
├── src/
│   ├── server.js            # Express + WebSocket server entry point
│   ├── GameEngine.js        # Pure rule engine — move validation, state mutation
│   ├── GameManager.js       # Room/session management, WebSocket dispatch
│   └── RobotPlayer.js       # Heuristic AI player
├── test/
│   ├── engine.mjs           # GameEngine unit tests
│   ├── manager.mjs          # GameManager unit tests
│   ├── integration.mjs      # End-to-end tests (server required)
│   └── cli.mjs              # CLI helper unit tests
├── cli.mjs                  # Standalone terminal client
└── package.json
```

---

## Rules Reference Card

| Situation | Rule |
|---|---|
| Leaving Base | Roll a 1 or 6 on either die |
| Bump opponent | Send their marble back to Base |
| Base / Home | Marbles there cannot be bumped |
| Roll a 6 | Take one extra roll (never stacks) |
| Star space | Enables star-track shortcut movement |
| Center hub | Enter by stepping 1 past any star; exit with die=1 |
| Entering Home | Cannot overshoot slot 4 |

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
