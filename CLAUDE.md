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
PUBLIC_URL=https://example.com  # links in emails (password reset, email confirmation); else ORIGIN
MAIL_FROM=noreply@example.com   # sender; mail goes through /usr/sbin/sendmail (SENDMAIL=path to override);
                                # without sendmail the links are written to the server log
STREAM_URL=…                                    # optional fallback for the stream link (normally set on the Admin page → Stream)
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
node test/ai.mjs          # AI commentator, providers, YouTube chat reader, admin settings (fake clients)
node test/league.mjs      # league tracker: robot games through it (careers, records, notes)
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
- `src/Accounts.js` — account WebSocket actions (register/login/logout/identify/setPassword/setEmail/verifyEmail/forgotPassword/resetPassword/rename/signOutOthers/deleteAccount/profile/history/openGame, social), rate-limited per IP and per account. Name + password (salted scrypt in `Store.js`, constant-time); each login creates a device session key (kept in the browser; only its hash is stored; logout revokes it). Optional email, confirmed by link, for password resets (`src/Mailer.js`, sendmail). Accounts from before passwords are asked to choose one. Names are unique; guests can't use a registered name.
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
square's number is the pips from there into h1 (1 = home entry, 84 = start
square), like backgammon's point numbers — `squareNumber` / `fromSquareNumber`
(display) over `countdown` / `fromCountdown` (walking distance to the home entry,
0–83, used internally), `locName` / `parseLocName` in `public/js/constants.js`. Each player sees their own numbers
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
  value, double for an **aggro** (loser has no marbles home), triple for a **baggro** (loser has all four
  still in base). Every room keeps a points score across Rematches: each loser pays the winner 1, 2 for an
  aggro, 3 for a baggro (× the cube); with 3+ players the winner collects from every loser. Robot cube play: `src/CubeDecision.js` (exact duel tables, else played-out estimates;
  Janowski money-play formulas). Cube decisions are analysed too (`src/CubeAnalysis.js`): in-game feedback
  (`cubeFeedback`) and post-game rows with no double / double-take / double-drop equities.
- Matches to N points (2 players; Crawford rule: no doubling in the first game after someone reaches
  N−1, then post-Crawford). Match score per room; Rematch continues the match, then starts a new one.
  Cube decisions in a match use a match equity table for this game (`src/MatchEquity.js`, from the
  measured 7.3% aggro rate; cube ownership valued like money play where the cube is alive), shown in equity units (EMG).
- Rating (`src/Store.js` rateGame): Elo from rated games (accounts only, no robot seats), start 1400; the
  winner takes points from each loser. Every rated game is analysed at once at the quick level; if the
  winner also had the lower error rate than a loser, that pair's exchange counts twice (applyRatingBonus).
- Platform: side-nav pages (Play with quick match, Leaderboard, Friends, Messages, Stats, Board, Settings);
  friends by request/accept with presence and invites; direct messages between friends; in-game chat;
  blocks. Account actions in `src/Accounts.js`; quick match and chat in `src/server.js` / GameManager.
- Move analysis values each played-out ending by what it is worth (`outcomeValuer` in `src/Analysis.js`):
  money ±1/±2/±3 per cube unit; match: match-winning chances after the result
  at the game's starting score and cube, as EMG (`game._valueCtx`); 3+ players: plain win chance. The instant
  (evaluator) pass still judges by win chance only.
- Watching: anyone can watch a game from the Play page's Live games list (`listGames` / `watchGame`); watchers
  (`room.watchers`) get every broadcast and the chat but never act for a seat or post. "Watch robots play" makes a
  room with robots in every seat (`createRoom` watch) whose games run back to back (`watchNextGameMs`). A
  robots-only game ends when its last watcher leaves (a dropped connection gets a short grace to come back).
- Streaming: `/?watch=robots&players=6` is a kiosk page (no sign-in, no menus or buttons) that starts a
  robots-only watch room and restarts it if the room goes; for an OBS Browser Source at 1920×1080. Options:
  `numbers=1` (board numbers; off by default), `log=0`, `players_list=0`, `sound=1`, `music=0` (music is on by default), `speed=slow|normal|fast` (robots-only rooms play at `room.pace`: 2.2× / 1.5× / 1× the
  normal robot delays). The Play page's
  "Stream it" fold-out builds the URL. Kiosk options are per URL, never saved to the browser's settings.
- Music: `public/js/music.js`, adaptive background music made live with Web Audio (in-game "Music" option; on by default
  on the stream page, `music=0` turns it off). Fed by updatePips (pips, marbles home/in base) and moments (rolls of 6/1/doubles, hits, home,
  win): tempo and layers follow the race, minor harmony for aggro/baggro risk, a key lift for the final lap, one
  motif + instrument per colour with the leader's in front. Ten song bases (`SONGS`: key, scales, chord loops, tempo,
  beat, bass, chord style, swing, echo, motif twist); each game picks one at random. Console: `__music()`,
  `__musicSong(i)`, `__musicSet({...})`.
- Commentary: `public/js/commentary.js` turns game events into paced text lines (hits with revenge / near-home
  heartbreak, double hits, 6-6 and three-sixes runs, hub trips, marbles home with tidy/untidy home rows (home debt),
  full mobility gained/lost, final lap, lead changes, aggro/baggro watch with an occasional explanation, tight race,
  runaway, the win, and "the roll someone else needed": the server's rollEnvy tries each roll for the other players
  (win, bonk the leader near home, end a 2+ turn wait in hub/base) and sends `envy` with `rolled`), shown left of the board when there's room (gear option "Commentary"; on by default on the
  stream page, `commentary=0` turns it off). Lines about moves wait for the animation (afterAnimations).
- Marble League (robot stream rooms only): `public/js/league.js` has six permanent teams, one per colour, each with
  four named marbles (trait, bio, catchphrase); the robot in the seat is that game's coach. `src/LeagueTracker.js`
  watches the room's broadcasts and keeps per-game numbers (bonks by marble — the engine reports a bump before the
  attacker's move, so the attacker is found by position —, homes, hub trips/turns, rolls/sixes/doubles, lead changes,
  wire-to-wire, comeback deficit, finish margin, length), then writes careers (team / coach / marble), streaks,
  rivalries, the month's season table, all-time records (announced after 20 league games) and a game log to the Store
  (`league_stats`, `league_records`, `league_games`; in memory without a DB). It sends `leagueNote` (parts with
  team / marble / coach tokens) and `leagueState`. Page: teams instead of coach names in league rooms, plural verb
  agreement for team names in commentary (`leagueGrammar`), the 🏟 League page (`/league.json`). Test: `node test/league.mjs`.
- Admin → Stream (settings in the DB: `src/SiteSettings.js`, meta table `set.*`; API keys never sent to clients): the
  stream link (`/site.json`), the AI commentator and the YouTube chat reader. AI commentator: `src/AICommentator.js`, one
  per robot watch room, calls only while on + watched + something happened, at most every `aiEverySec`, capped by
  `aiDailyCalls`; sends `aiComment`. Providers in `src/ai/providers.js`: Anthropic (official SDK, default
  `claude-opus-5-5`, effort low, refusal fallback), Google Gemini, any OpenAI-compatible endpoint. YouTube chat:
  `src/YouTubeChat.js` (Data API key; finds the live chat from a channel handle or stream URL, polls every
  `chatEverySec`, skips the backlog); messages go to the AI as untrusted `<chat>` input and to the page (`streamChat`).
  Bonk counts (game + session) feed both commentators. Tests: `node test/ai.mjs` (fake clients, no network).
- Admin: `node tools/admin.mjs grant <name>` (server only) makes an account an admin; the Admin page (side menu)
  unlocks with the password for 30 minutes: reports inbox, players (ban/unban, rename, reset rating, delete),
  server status and recent errors. Players report others from the game's player list (⚑) and from a friend's chat.
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

