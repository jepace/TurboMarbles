// league.js — the Grand Marble Circuit: six permanent teams, one per colour,
// each with four named marbles (one the captain) and their personalities. In the
// league the teams are the players (all play the same, tuned robot).
// Shared by the server (stats, records, AI context) and the page (names on
// screen, commentary). Marble ids 0–3 are the engine's marble ids.
//
// Traits are flavour for the commentators (no effect on play):
//   name, nick (short form), trait (one word), bio (one line), cheer (a catchphrase).

export const TEAMS = {
  blue: {
    name: 'Tidal Wave', short: 'Waves', emoji: '🌊',
    marbles: [
      { name: 'Splash',  trait: 'fearless', bio: 'Charges into every star track, consequences be damned.', cheer: 'Surf\'s up!' },
      { name: 'Ripple',  trait: 'patient',  bio: 'Waits in base for the perfect roll. Usually.', cheer: 'Steady as she goes.' },
      { name: 'Undertow', trait: 'sneaky', bio: 'Never seems to be in front, until suddenly it is.', cheer: 'Didn\'t see me coming.' },
      { captain: true, name: 'Pearl',   trait: 'veteran',  bio: 'The team captain. Has seen every bonk imaginable.', cheer: 'Been here before.' },
    ],
  },
  pink: {
    name: 'Bubblegum Bandits', short: 'Bandits', emoji: '🍬',
    marbles: [
      { name: 'Fizz',    trait: 'hyper',    bio: 'Bounces off the walls. Literally.', cheer: 'Wheee!' },
      { name: 'Taffy',   trait: 'sticky',   bio: 'Once it gets a lead, it won\'t let go.', cheer: 'Mine now.' },
      { captain: true, name: 'Rascal',  trait: 'troublemaker', bio: 'Lives to bonk. Has a list.', cheer: 'Nothing personal.' },
      { name: 'Sprinkles', trait: 'lucky',  bio: 'Rolls sixes like other marbles breathe.', cheer: 'Lucky me!' },
    ],
  },
  orange: {
    name: 'Ember Rush', short: 'Embers', emoji: '🔥',
    marbles: [
      { captain: true, name: 'Blaze',   trait: 'hothead',  bio: 'Picks fights it shouldn\'t. Wins some of them.', cheer: 'Bring the heat!' },
      { name: 'Cinder',  trait: 'comeback kid', bio: 'Always seems to rise from the ashes of base.', cheer: 'Not done yet.' },
      { name: 'Flint',   trait: 'tough',    bio: 'Bonked more than any marble alive and still rolling.', cheer: 'Is that all?' },
      { name: 'Ash',     trait: 'quiet',    bio: 'Says nothing, finishes first.', cheer: '…' },
    ],
  },
  yellow: {
    name: 'Solar Flares', short: 'Flares', emoji: '☀️',
    marbles: [
      { name: 'Sunny',   trait: 'optimist', bio: 'Every bonk is just a fresh start.', cheer: 'What a day!' },
      { captain: true, name: 'Dash',    trait: 'speedster', bio: 'Hates waiting. Hates the hub most of all.', cheer: 'Gotta go!' },
      { name: 'Goldie',  trait: 'showboat', bio: 'Plays to the camera. Occasionally to the game.', cheer: 'Did you see that?' },
      { name: 'Corona',  trait: 'calculating', bio: 'Counts pips in its sleep.', cheer: 'As predicted.' },
    ],
  },
  green: {
    name: 'Mossy Rollers', short: 'Rollers', emoji: '🌿',
    marbles: [
      { captain: true, name: 'Clover',  trait: 'lucky',    bio: 'Four-leaf by name, four-leaf by nature.', cheer: 'Fortune favours me.' },
      { name: 'Fern',    trait: 'gentle',   bio: 'Apologises after every bonk.', cheer: 'Sorry, sorry!' },
      { name: 'Thorn',   trait: 'prickly',  bio: 'Holds a grudge for exactly one lap.', cheer: 'Payback time.' },
      { name: 'Sprout',  trait: 'rookie',   bio: 'The youngest on the team. Still learning the star track.', cheer: 'Is this the way?' },
    ],
  },
  white: {
    name: 'Polar Express', short: 'Polars', emoji: '❄️',
    marbles: [
      { captain: true, name: 'Frost',   trait: 'cool-headed', bio: 'Never panics. Never smiles either.', cheer: 'Chill.' },
      { name: 'Blizzard', trait: 'chaotic', bio: 'Nobody, including Blizzard, knows where it\'s going.', cheer: 'Whoosh!' },
      { name: 'Glacier', trait: 'slow and steady', bio: 'Takes its time. Gets there in the end.', cheer: 'Patience.' },
      { name: 'Snowball', trait: 'momentum', bio: 'Starts small, ends unstoppable.', cheer: 'Rolling, rolling…' },
    ],
  },
};

export const team = color => TEAMS[color] ?? null;
export const teamName = color => TEAMS[color]?.name ?? color;
export const teamShort = color => TEAMS[color]?.short ?? color;
export const marble = (color, id) => TEAMS[color]?.marbles[id] ?? null;
export const marbleName = (color, id) => TEAMS[color]?.marbles[id]?.name ?? `${color} ${id + 1}`;

// The league's name.
export const LEAGUE_NAME = 'The Grand Marble Circuit';

// A team's captain (one of its four marbles).
export const captainOf = color => TEAMS[color]?.marbles.findIndex(m => m.captain) ?? -1;
