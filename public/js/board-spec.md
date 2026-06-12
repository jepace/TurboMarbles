# board.js — Layout Specification

**Read this instead of board.js when starting a new session.**
This is the authoritative reference for space numbering and geometry.
It matches `board-drawing` in the repo root, which is the trusted picture
of one arm:

```
          [CS]

[08*]     [H4]      [78*]
[07]      [H3]      [79]
[06]      [H2]      [80]
[05]      [H1]      [81]
[04]                [82]
[03] [02] [01] [84] [83]

   [B1] [B2] [B3] [B4]
```

---

## Topology

84 total track spaces. 6 arms × 14 spaces each.
Arm `a` owns spaces `a*14+1` through `a*14+14`, but its **visual U** is made of
its own spaces +1…+8 **plus the previous arm's spaces +9…+14**.

Each arm is a **wide U**, viewed from that player's seat (outside the board):

- **Bottom row** (5 spaces, at R_OUTER): `[+3][+2][+1][prev+14][prev+13]`,
  left to right. `+1` is the **start** (center, on the arm axis); `prev+14`
  (immediately right of start) is this player's **home entry**.
- **Left column** (6 spaces): `+3` (bottom corner) rising through `+4…+7` to
  this arm's own **star** `+8` at the top.
- **Right column** (6 spaces): the **previous arm's star** `prev+8` at the top,
  descending through `prev+9…+12` to the bottom corner `prev+13`.
- **Home corridor**: H1…H4 on the arm axis, between the columns, aligned with
  column rows 4…1 (H4 innermost, level with the stars).
- **Base**: 1×4 row outside the bottom edge; B1 leftmost from the player's seat.

**Stars are shared between adjacent arms.** Star `a*14+8` is simultaneously the
top of arm `a`'s left column and the top of arm `a+1`'s right column. It sits on
the boundary ray between the two arms, at radius STAR_RING. The 6 stars form the
inner **star-track ring**.

So the main track zigzags: out along a bottom row, up a column to a star on the
inner ring, down the next arm's column to its bottom row, and so on.

**STAR_SPACES** = `{8, 22, 36, 50, 64, 78}` = `arm*14+8` for each arm.

PLAYER_CONFIG (matches GameEngine.js exactly):
```
arm 0: start=1,  star=8,  homeEntry=84
arm 1: start=15, star=22, homeEntry=14
arm 2: start=29, star=36, homeEntry=28
arm 3: start=43, star=50, homeEntry=42
arm 4: start=57, star=64, homeEntry=56
arm 5: start=71, star=78, homeEntry=70
```

`homeEntry` for arm `a` = space `a*14` = last space of the PREVIOUS arm's block,
which sits on this arm's bottom row immediately next to the start.

Track wraps: 84 → 1.

---

## Geometry Constants

Canvas is square, side = W. Center = (CX, CY) = (W/2, W/2).

```
STAR_RING = W * 0.18              // radius of the inner star-track ring
COL_OFF   = STAR_RING / 2         // perp offset of U columns from arm axis
COL_TOP   = COL_OFF * sqrt(3)     // along-axis coordinate of the star row
R_OUTER   = W * 0.40              // bottom row of each U
ROW_STEP  = (R_OUTER - COL_TOP)/5 // along-axis spacing of column rows 1–6
BASE_R    = W * 0.452             // base row radius
BASE_G    = W * 0.044             // spacing between base slots
```

`COL_OFF = STAR_RING/2` is not arbitrary: a star at radius STAR_RING on the
boundary ray (30° off-axis) has perpendicular distance `STAR_RING * sin(30°)`
from **both** adjacent arm axes. Setting COL_OFF to that value makes the star
sit exactly on top of both arms' column lines, so the shared star is the natural
continuation of each column. Its along-axis coordinate is then
`STAR_RING * cos(30°) = COL_OFF * sqrt(3) = COL_TOP`.

---

## Per-Arm Coordinate System

Arm `a` angle: `ang = a * (2π/6) + π/2`  (arm 0 at the bottom of the canvas,
arms numbered clockwise on screen).

Axis unit vector:        `dx = cos(ang), dy = sin(ang)`
Perpendicular unit vec:  `px = -sin(ang), py = cos(ang)`

Point at along-axis distance r, perpendicular offset p:
```
x = CX + dx*r + px*p
y = CY + dy*r + py*p
```
**Positive p is the left-column side** (toward the next arm clockwise).

Column row k (1 = star row … 6 = bottom row) along-axis coordinate:
```
rowR(k) = COL_TOP + ROW_STEP * (k - 1)
```

---

## Position Formulas

For arm `a`: `base = a*14`, `prev = ((a+5)%6)*14`.

**Bottom row** (at r = R_OUTER):
```
base+1 → p = 0          (start)
base+2 → p = +COL_OFF/2
base+3 → p = +COL_OFF   (corner)
prev+14 → p = -COL_OFF/2 (home entry)
prev+13 → p = -COL_OFF  (corner)
```

**Left column** (p = +COL_OFF): `base+4…+7` at `rowR(5)…rowR(2)`.

**Star** `base+8`: `(rowR(1), +COL_OFF)` ≡ radius STAR_RING at angle `ang + 30°`.

**Right column** (p = -COL_OFF): `prev+9…+12` at `rowR(2)…rowR(5)`.

**Home slots** (p = 0): slot s at `rowR(5 - s)`  (H1 at row 4 … H4 at row 1).

**Base slots** (1×4 row at r = BASE_R): slot mi at `p = (1.5 - mi) * BASE_G`.

Every track space is written exactly once: each arm's loop places its own
+1…+8 and the previous arm's +9…+14 (which lie inside this arm's U).

---

## ARM_MAP (active arms per player count)

```js
{ 2:[0,3], 3:[0,2,4], 4:[0,1,3,4], 5:[0,1,2,3,4], 6:[0,1,2,3,4,5] }
```

---

## Colors

Arms 0–5 map to: Blue, Pink, Orange, Yellow, Green, White (clockwise from bottom).

```js
const COLORS = ['#2288f0','#e8208c','#ff7800','#f5d000','#44bb44','#e0e0e0']; // arms 0-5
const DARK_C  = ['#1155cc','#a01060','#c05000','#b09800','#228822','#909090'];
const STAR_GOLD = '#f5c842'; // shortcut star markers
```

Each arm's whole U (both columns + bottom row + home corridor + base panel) is
tinted in that arm's color, even though the right column's spaces belong
numerically to the previous arm's block.

Star spaces use a gold `#c8920a` background circle with a 6-pointed `STAR_GOLD`
star drawn on top. A dashed gold circle at STAR_RING marks the star track.
The board background is a dark navy radial gradient (`#1e2f60` → `#07101e`)
with a gold rim border.

---

## Exported API (main.js imports all of these)

```js
export function init(canvasEl)
export function resize()
export function drawBoard(gameState)
export function hitTestMarble(gameState, cx, cy)   // → {playerIndex, marbleId} | null
export function highlightSpaces(spaces)            // spaces = array of space descriptors
export function highlightMarbleAt(marble, playerIndex)
export function getSpacePosition(space)            // space descriptor → {x,y} | null
export function setMarbleOverride(playerIndex, marbleId, pos)
export function clearMarbleOverride(playerIndex, marbleId)
export function setAnimatingMarble(playerIndex, marbleId)
export function clearAnimatingMarble()
```

**Space descriptor** (used by highlightSpaces / getSpacePosition):
- `{ zone:'track', space:N }` — N = 1…84
- `{ zone:'center' }`
- `{ zone:'home', playerIndex:P, slot:S }` — S = 1…4

**Marble** (from gameState.players[i].marbles):
- `{ id, zone:'base'|'track'|'home'|'center', space?, slot? }`

---

## Known Bugs (fixed in rewrites)

1. An early board.js had `STAR_SPACES = {7,21,35,49,63,77}` (star at arm*14+**7**).
   Correct value is `{8,22,36,50,64,78}`.
2. A later rewrite drew each arm as a narrow V with a **single** star at the
   arm's own apex on its axis, and no bottom row. Per `board-drawing` the arm is
   a **wide U** with a 5-space bottom row, **two different stars** at its top
   corners (shared with the adjacent arms), the home corridor between the
   columns, and a 1×4 base row (not 2×2).
