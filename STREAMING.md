# Stream page: URL options

The stream page is the game's kiosk view: robots play non-stop, with no sign-in, menus or buttons. Point an OBS
Browser Source (1920×1080) or the headless streamer (`STREAM_PAGE` in `/usr/local/etc/turbomarbles-stream.conf`)
at it. Options go on the end of the address, joined with `&`:

```
https://marbles.pacehouse.com/?watch=robots&players=6&match=60&lite=1
```

The Play page's **Stream it** fold-out builds this address for you. Options are per URL; they never change your
own browser's settings.

| Option | Values | Default | What it does |
|---|---|---|---|
| `watch=robots` | — | (required) | Makes it the stream page. |
| `players` | 2–6 | 6 | Teams per game. |
| `speed` | `slow`, `normal`, `fast` | `normal` | How fast the robots play. |
| `match` (or `show`) | minutes | (endless) | A timed match: when time is up the game in progress finishes, the team with most wins is champion (points break ties; a full tie plays a tie-breaker game), a champion card shows for 30 s, then a new match starts. |
| `after` | `stop` | (new match) | With `match`: after the champion, stop for good: the card stays with "Full time", the music fades, and (with `record`) the headless streamer stops sending and stays stopped until its service is started again. |
| `break` | seconds | (none) | With `match` and `record`: after each match the headless streamer stops sending for this long, so YouTube ends that video and the next match starts a new one. |
| `record` | your `RECORD_KEY` | — | Needed for `break`. (Music recording for the podcast works without it.) |
| `music` | `0` | on | `music=0` turns the music off. |
| `sound` | `1` | off | `sound=1` turns the sound effects on (bonk, chimes). |
| `commentary` | `0` | on | `commentary=0` hides the commentary column. |
| `log` | `0` | on | `log=0` hides the move log. |
| `players_list` | `0` | on | `players_list=0` hides the game's team list. |
| `numbers` | `1` | off | `numbers=1` shows square numbers on the board. |
| `lite` | `1` | off | Cheaper drawing for a machine without a graphics card (no glow, at most 30 redraws a second). Use it with the headless streamer. |
| `theme` | `midnight`, `daylight`, `wood`, `neon`, `felt`, `stone` | `midnight` | The board's look. |
| `finish` | `glossy`, `glass`, `swirl`, `matte`, `metal`, `pearl` | `glossy` | The marbles' look. |
| `palette` | `classic`, `rainbow`, `safe`, `pastel`, `earthy`, `jewel`, `neon`, or six colours `ff0000,00ff00,…` | `classic` | The six team colours. |

## Examples

Endless 6-team league, headless:
```
https://marbles.pacehouse.com/?watch=robots&players=6&lite=1
```

One-hour matches, one YouTube video each (headless streamer):
```
https://marbles.pacehouse.com/?watch=robots&players=6&lite=1&match=60&break=60&record=YOUR_RECORD_KEY
```

One one-hour match, then the stream stops (headless streamer):
```
https://marbles.pacehouse.com/?watch=robots&players=6&lite=1&match=60&after=stop&record=YOUR_RECORD_KEY
```

Head-to-head duels on a wooden board, no log:
```
https://marbles.pacehouse.com/?watch=robots&players=2&theme=wood&log=0
```
