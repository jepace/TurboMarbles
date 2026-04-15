# board.js — Layout Specification

**Read this instead of board.js when starting a new session.**
This is the authoritative reference for space numbering and geometry.

---

## Space Numbering

84 total track spaces. 6 arms × 14 spaces each.
Arm `a` occupies spaces `a*14+1` through `a*14+14`.

Within each arm (arm 0 as example, base = a*14):

| space offset | track space (arm 0) | description |
|---|---|---|
| +1 | 1 | **start** — outermost, bottom of U, where marbles exit base |
| +2 … +7 | 2–7 | left column — 6 spaces, outer→inner (bottom→top of U), at -COL_OFF from arm axis |
| +8 | 8 | **STAR** — apex, innermost, on arm axis at R_STAR |
| +9 … +14 | 9–14 | right column — 6 spaces, inner→outer (top→bottom of U), at +COL_OFF from arm axis |

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

`homeEntry` for arm `a` = space `a*14` = last space of the PREVIOUS arm.
Marbles entering home approach from the previous arm's final space.

Track wraps: 84 → 1.

---

## Geometry Constants

Canvas is square, side = W. Center = (CX, CY) = (W/2, W/2).

```
R_OUTER    = W * 0.40   // spaces +1 and +14 (outermost ring)
R_COL_TOP  = W * 0.22   // spaces +7 and +9 (top of columns, flanking star)
R_STAR     = W * 0.16   // space +8 (star apex)
COL_OFF    = W * 0.052  // perpendicular offset from arm axis to column center
R_HOME_OUT = W * 0.36   // home slot 1 (outermost)
R_HOME_IN  = W * 0.24   // home slot 4 (innermost)
BASE_R     = W * 0.455  // center radius of 2×2 base grid
BASE_G     = W * 0.038  // spacing between base slots
```

---

## Per-Arm Coordinate System

Arm `a` angle: `ang = a * (2π/6) + π/2`

Axis unit vector:        `dx = cos(ang), dy = sin(ang)`
Perpendicular unit vec:  `px = -sin(ang), py = cos(ang)`

Point at radius r, perpendicular offset p:
```
x = CX + dx*r + px*p
y = CY + dy*r + py*p
```

---

## Position Formulas

**Left column** (spaces base+1 … base+7, i = 0…6, perp = -COL_OFF):
```
r = R_OUTER + (R_COL_TOP - R_OUTER) * i/6
```

**Star** (space base+8, perp = 0):
```
r = R_STAR
```

**Right column** (spaces base+9 … base+14, i = 0…5, perp = +COL_OFF):
```
r = R_COL_TOP + (R_OUTER - R_COL_TOP) * i/5
```

**Home slots** (slot s = 1…4, on arm axis, perp = 0):
```
r = R_HOME_OUT + (R_HOME_IN - R_HOME_OUT) * (s-1)/3
```

**Base slots** (4 slots in a 2×2 grid, index mi = 0…3):
```
row = floor(mi/2),  col = mi % 2
dr = (row - 0.5) * BASE_G
dp = (col - 0.5) * BASE_G
r = BASE_R,  perp_offset = dp  (and add dr along axis)
```

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

Star spaces use a gold `#c8920a` background circle with a 6-pointed `STAR_GOLD` star drawn on top.
The board background is a dark navy radial gradient (`#1e2f60` → `#07101e`) with a gold rim border.

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

## Known Bug (fixed in rewrite)

Old board.js had `STAR_SPACES = {7,21,35,49,63,77}` (star at arm*14+**7**).
Correct value is `{8,22,36,50,64,78}` (star at arm*14+**8**).
This caused stars to render at the wrong track positions.
The left column also had only 6 spaces (should be 7, including start).
