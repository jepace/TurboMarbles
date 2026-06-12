# TurboMarbles — TODO

## Features

- **Board rotation per player**: Rotate the canvas so each player always sees their own arm at the bottom. Pure client-side change in `computeLayout()` — offset the starting angle by the local player's arm index. No server changes needed.
