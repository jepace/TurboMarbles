# Analysis tools

Command-line tools for checking games and improving the robot. They use the
real rules engine (`src/GameEngine.js`), so their results match the game.
Run them from the repository root with Node 18+.

## replay.mjs — audit a game log

Paste the text from the in-game **Copy Log** button into a file, then:

```sh
node tools/replay.mjs game.txt            # full report
node tools/replay.mjs game.txt --brief    # issues, bumps, and robot surprises only
```

It replays every move and reports:

- **Rule issues** — illegal moves, a die left unused while a mandatory move
  existed, extra rolls without a 6, wrong turn order. Expect 0. (Logs from
  before a rules change will show issues for moves that are no longer legal.)
- **Winner per engine** — should match the log.
- **Robot moves that differ from the robot code** — 0 means the robot played
  exactly what the current `src/RobotPlayer.js` would. Older logs differ
  because the robot has changed since.

**`--analyze`** adds an endgame report, gnubg-style: for every roll where the
player's marbles were all home or within 12 squares of home, it compares the
play with the best play using the exact endgame table — the extra expected
turns it cost ("cost +0.53 turns"), and the race-win probability when every
opponent is in the table too — then sums each player's losses. These are pure
race values: bumps aren't counted, so a "costly" move that bumped someone may
still have been right.

Other options: `--robot <module>` compares against another robot version;
`--dump <turn>:<dice> <out.json>` saves the game state just before a roll
(e.g. `--dump 21:3-1 t21.json`) for "what if" experiments.

## selfplay.mjs — is a robot change actually better?

```sh
cp src/RobotPlayer.js /tmp/candidate.js
sed -i "s#'./GameEngine.js'#'$PWD/src/GameEngine.js'#" /tmp/candidate.js
# ... edit /tmp/candidate.js ...
node tools/selfplay.mjs /tmp/candidate.js --games 8000 --players 2
node tools/selfplay.mjs /tmp/candidate.js --games 6000 --players 3
```

One seat plays the candidate, the rest the baseline (default: the current
`src/RobotPlayer.js`, or `--baseline <module>`). Seats and the first player
rotate. "Even" is 1/players; a change is an improvement only if it wins
clearly more than even — beyond the printed ± (95% interval) — at the player
counts you care about. A candidate identical to the baseline should come out
even; that's a good sanity check.

Every robot change so far was accepted or rejected this way; several
plausible ideas turned out to make the robot weaker.

## endgame.mjs — exact endgame odds

```sh
node tools/endgame.mjs                                         # summary
node tools/endgame.mjs --position "37 42 h2 h3" --roll 3-1     # one decision
```

Solves the endgame exactly for one player (yellow: track squares 37–42 before
its home entry 42, home slots h1–h4): the expected number of rolls to get all
four marbles home with perfect play, and with the robot's play, under the real
rules (exact landing, no passing your own marbles, must use a die if you can).
Opponents and bumps are ignored — it measures the pure race.

The summary shows how long a lone last marble takes from each square, the
robot's average shortfall versus perfect play, and its worst positions.
`--position` with `--roll` lists every way to play that roll, the expected
rolls left after each, and which one the robot picks.

## build-endgame-table.mjs — the endgame table

```sh
node tools/build-endgame-table.mjs      # ~40 s; writes src/endgame-table.json
```

Precomputes, for every arrangement of a player's four marbles within the last
12 squares before home, the hub and home (2,380 positions): the expected turns
to finish with best play, and the probability of finishing within 1, 2, … 40
turns. Like gnubg's bear-off databases, two of these distributions give an
exact race-win probability. The robot plays from the table near home, and
`replay.mjs --analyze` grades endgame decisions with it. Squares are relative
to the home entry, so one table serves every colour.

Moves come from the real rules engine, so **rebuild the table after any rules
change that affects movement near home** (and commit the new JSON). The one
approximation — a star-track hop forced off the region when every other move
is blocked, 66 of ~85,000 position-rolls — is described in the script.
