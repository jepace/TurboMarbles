// league.js — the Grand Marble Circuit: six permanent teams, one per colour,
// each with four named marbles (one the captain) and their personalities. In the
// league the teams are the players; each team plays its own style.
// Shared by the server (stats, records, AI context) and the page (names on
// screen, commentary). Marble ids 0–3 are the engine's marble ids.
//
// Traits are flavour for the commentators (no effect on play):
//   name, nick (short form), trait (one word), bio (one line), cheer (a catchphrase).

export const TEAMS = {
  blue: {
    name: 'Tidal Wave', short: 'Waves', emoji: '🌊', style: 'balanced',
    marbles: [
      { name: 'Splash',  trait: 'fearless', bio: 'Charges into every star track, consequences be damned.', cheer: 'Surf\'s up!' },
      { name: 'Ripple',  trait: 'patient',  bio: 'Waits in base for the perfect roll. Usually.', cheer: 'Steady as she goes.' },
      { name: 'Undertow', trait: 'sneaky', bio: 'Never seems to be in front, until suddenly it is.', cheer: 'Didn\'t see me coming.' },
      { captain: true, name: 'Pearl',   trait: 'veteran',  bio: 'The team captain. Has seen every bonk imaginable.', cheer: 'Been here before.' },
    ],
  },
  pink: {
    name: 'Bubblegum Bandits', short: 'Bandits', emoji: '🍬', style: 'bonker',
    marbles: [
      { name: 'Fizz',    trait: 'hyper',    bio: 'Bounces off the walls. Literally.', cheer: 'Wheee!' },
      { name: 'Taffy',   trait: 'sticky',   bio: 'Once it gets a lead, it won\'t let go.', cheer: 'Mine now.' },
      { captain: true, name: 'Rascal',  trait: 'troublemaker', bio: 'Lives to bonk. Has a list.', cheer: 'Nothing personal.' },
      { name: 'Sprinkles', trait: 'lucky',  bio: 'Rolls sixes like other marbles breathe.', cheer: 'Lucky me!' },
    ],
  },
  orange: {
    name: 'Ember Rush', short: 'Embers', emoji: '🔥', style: 'gambler',
    marbles: [
      { captain: true, name: 'Blaze',   trait: 'hothead',  bio: 'Picks fights it shouldn\'t. Wins some of them.', cheer: 'Bring the heat!' },
      { name: 'Cinder',  trait: 'comeback kid', bio: 'Always seems to rise from the ashes of base.', cheer: 'Not done yet.' },
      { name: 'Flint',   trait: 'tough',    bio: 'Bonked more than any marble alive and still rolling.', cheer: 'Is that all?' },
      { name: 'Ash',     trait: 'quiet',    bio: 'Says nothing, finishes first.', cheer: '…' },
    ],
  },
  yellow: {
    name: 'Solar Flares', short: 'Flares', emoji: '☀️', style: 'racer',
    marbles: [
      { name: 'Sunny',   trait: 'optimist', bio: 'Every bonk is just a fresh start.', cheer: 'What a day!' },
      { captain: true, name: 'Dash',    trait: 'speedster', bio: 'Hates waiting. Hates the hub most of all.', cheer: 'Gotta go!' },
      { name: 'Goldie',  trait: 'showboat', bio: 'Plays to the camera. Occasionally to the game.', cheer: 'Did you see that?' },
      { name: 'Corona',  trait: 'calculating', bio: 'Counts pips in its sleep.', cheer: 'As predicted.' },
    ],
  },
  green: {
    name: 'Mossy Rollers', short: 'Rollers', emoji: '🌿', style: 'packer',
    marbles: [
      { captain: true, name: 'Clover',  trait: 'lucky',    bio: 'Four-leaf by name, four-leaf by nature.', cheer: 'Fortune favours me.' },
      { name: 'Fern',    trait: 'gentle',   bio: 'Apologises after every bonk.', cheer: 'Sorry, sorry!' },
      { name: 'Thorn',   trait: 'prickly',  bio: 'Holds a grudge for exactly one lap.', cheer: 'Payback time.' },
      { name: 'Sprout',  trait: 'rookie',   bio: 'The youngest on the team. Still learning the star track.', cheer: 'Is this the way?' },
    ],
  },
  white: {
    name: 'Polar Express', short: 'Polars', emoji: '❄️', style: 'cautious',
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

// Playing styles (src/RobotPlayer.js STYLES). In the league each team plays its
// own style; in other games a robot is named after its style ("Bonker",
// "Bonker 2"…), picked in the lobby.
export const ROBOT_STYLES = [
  { style: 'balanced', name: 'Robot',     label: 'balanced',               bio: 'The tuned all-rounder.' },
  { style: 'bonker',   name: 'Bonker',    label: 'the bonker',             bio: 'Bonks anything in reach.' },
  { style: 'racer',    name: 'Racer',     label: 'pure racer',             bio: 'All about the race; hardly ever bonks.' },
  { style: 'gambler',  name: 'Gambler',   label: 'the gambler',            bio: 'Ignores danger, rushes out of base.' },
  { style: 'cautious', name: 'Turtle',    label: 'safety first',           bio: 'Keeps marbles out of harm\'s way.' },
  { style: 'hub',      name: 'Shortcut',  label: 'shortcut specialist',    bio: 'Loves the star circle and the hub.' },
  { style: 'packer',   name: 'Neatnik',   label: 'home-row perfectionist', bio: 'Obsessed with a tidy home row.' },
];
export const STYLE_LABELS = Object.fromEntries(ROBOT_STYLES.map(x => [x.style, x.label]));
// How a team with this style plays, for commentary ("The Embers … roll the dice on everything").
export const STYLE_PHRASES = { balanced: 'play it balanced', bonker: 'bonk everything in sight', racer: 'race flat out and rarely bonk', gambler: 'take every risk going',
  cautious: 'play it safe', hub: 'live on the shortcuts', packer: 'keep a tidy home row' };
export const styleInfo = style => ROBOT_STYLES.find(x => x.style === style) ?? null;
// A team's captain (one of its four marbles).
export const captainOf = color => TEAMS[color]?.marbles.findIndex(m => m.captain) ?? -1;
