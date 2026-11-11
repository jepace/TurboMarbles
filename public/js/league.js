// league.js — the Grand Marble Circuit: six permanent teams, one per colour,
// each with four named marbles and their personalities. The robot sitting in
// a colour's seat coaches that team for the game ("Data coaches the Embers").
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
      { name: 'Pearl',   trait: 'veteran',  bio: 'The team captain. Has seen every bonk imaginable.', cheer: 'Been here before.' },
    ],
  },
  pink: {
    name: 'Bubblegum Bandits', short: 'Bandits', emoji: '🍬',
    marbles: [
      { name: 'Fizz',    trait: 'hyper',    bio: 'Bounces off the walls. Literally.', cheer: 'Wheee!' },
      { name: 'Taffy',   trait: 'sticky',   bio: 'Once it gets a lead, it won\'t let go.', cheer: 'Mine now.' },
      { name: 'Rascal',  trait: 'troublemaker', bio: 'Lives to bonk. Has a list.', cheer: 'Nothing personal.' },
      { name: 'Sprinkles', trait: 'lucky',  bio: 'Rolls sixes like other marbles breathe.', cheer: 'Lucky me!' },
    ],
  },
  orange: {
    name: 'Ember Rush', short: 'Embers', emoji: '🔥',
    marbles: [
      { name: 'Blaze',   trait: 'hothead',  bio: 'Picks fights it shouldn\'t. Wins some of them.', cheer: 'Bring the heat!' },
      { name: 'Cinder',  trait: 'comeback kid', bio: 'Always seems to rise from the ashes of base.', cheer: 'Not done yet.' },
      { name: 'Flint',   trait: 'tough',    bio: 'Bonked more than any marble alive and still rolling.', cheer: 'Is that all?' },
      { name: 'Ash',     trait: 'quiet',    bio: 'Says nothing, finishes first.', cheer: '…' },
    ],
  },
  yellow: {
    name: 'Solar Flares', short: 'Flares', emoji: '☀️',
    marbles: [
      { name: 'Sunny',   trait: 'optimist', bio: 'Every bonk is just a fresh start.', cheer: 'What a day!' },
      { name: 'Dash',    trait: 'speedster', bio: 'Hates waiting. Hates the hub most of all.', cheer: 'Gotta go!' },
      { name: 'Goldie',  trait: 'showboat', bio: 'Plays to the camera. Occasionally to the game.', cheer: 'Did you see that?' },
      { name: 'Corona',  trait: 'calculating', bio: 'Counts pips in its sleep.', cheer: 'As predicted.' },
    ],
  },
  green: {
    name: 'Mossy Rollers', short: 'Rollers', emoji: '🌿',
    marbles: [
      { name: 'Clover',  trait: 'lucky',    bio: 'Four-leaf by name, four-leaf by nature.', cheer: 'Fortune favours me.' },
      { name: 'Fern',    trait: 'gentle',   bio: 'Apologises after every bonk.', cheer: 'Sorry, sorry!' },
      { name: 'Thorn',   trait: 'prickly',  bio: 'Holds a grudge for exactly one lap.', cheer: 'Payback time.' },
      { name: 'Sprout',  trait: 'rookie',   bio: 'The youngest on the team. Still learning the star track.', cheer: 'Is this the way?' },
    ],
  },
  white: {
    name: 'Polar Express', short: 'Polars', emoji: '❄️',
    marbles: [
      { name: 'Frost',   trait: 'cool-headed', bio: 'Never panics. Never smiles either.', cheer: 'Chill.' },
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

// Coaches: the robots who sit in a team's seat for a game (they rotate between
// games). Each has a real playing style (src/RobotPlayer.js STYLES), so the
// league can find out which approach works best.
//   name (shown in games: the last name), full (with first name and nickname), style, bio, line (a catchphrase).
export const COACHES = [
  { name: 'Okafor',  full: 'Mabel "The Hammer" Okafor', style: 'bonker',   bio: 'Never met a marble she didn\'t want to bonk.', line: 'Hit first, ask later.' },
  { name: 'Delgado', full: 'Rusty Delgado',             style: 'balanced', bio: 'Thirty seasons on the circuit. Seen it all, twice.', line: 'Play the percentages.' },
  { name: 'Kowalczyk', full: 'Professor Ines Kowalczyk', style: 'racer',    bio: 'Treats the board as a pure race. Bonking is beneath her.', line: 'Pips win games.' },
  { name: 'Moretti',   full: '"Big" Sal Moretti',         style: 'gambler',  bio: 'Takes every risk on the board and a few that aren\'t.', line: 'Fortune favours the bold.' },
  { name: 'Pemberton', full: 'Dot Pemberton',             style: 'cautious', bio: 'Keeps her marbles out of harm\'s way, whatever it costs.', line: 'Safety first.' },
  { name: 'Tanaka',   full: 'Hank "Shortcut" Tanaka',    style: 'hub',      bio: 'Lives on the star circle; thinks the hub is home.', line: 'Why walk when you can fly?' },
  { name: 'Brightwater', full: 'Lou Brightwater',         style: 'packer',   bio: 'Obsessed with a tidy home row.', line: 'Home first, then we\'ll talk.' },
  { name: 'Navarro',   full: 'Bea "Blitz" Navarro',       style: 'racer',    bio: 'Floors it from the first roll.', line: 'Go, go, go!' },
  { name: 'Abernathy', full: 'Gus Abernathy',             style: 'balanced', bio: 'Steady, sensible, slightly boring. Wins a lot.', line: 'One roll at a time.' },
  { name: 'Fairweather', full: 'Tilly "Tank" Fairweather', style: 'cautious', bio: 'Builds walls. Waits. Pounces late.', line: 'Patience is a weapon.' },
  { name: 'Sand',   full: 'Viktor "The Viper" Sand',   style: 'bonker',   bio: 'Lurks behind the leader and strikes.', line: 'Nobody is safe.' },
  { name: 'Achebe',   full: 'Prue Achebe',               style: 'hub',      bio: 'Plots every route through the centre.', line: 'All roads lead to the hub.' },
];
export const STYLE_LABELS = {
  balanced: 'balanced', bonker: 'the bonker', racer: 'pure racer', cautious: 'safety first', hub: 'shortcut specialist', gambler: 'the gambler', packer: 'home-row perfectionist',
};
export const coachByName = name => COACHES.find(c => c.name === name) ?? null;
