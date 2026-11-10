#!/usr/bin/env node
// tools/admin.mjs — grant or revoke admin rights (run on the server).
//   node tools/admin.mjs grant <name>      DATA_DIR as for the server (default data/)
//   node tools/admin.mjs revoke <name>
//   node tools/admin.mjs list
// Admin rights can only be given here, never from the website.
import { openStore, setAdmin, adminSearch } from '../src/Store.js';
const [cmd, name] = process.argv.slice(2);
if (!openStore()) { console.error('Could not open the store (DATA_DIR?).'); process.exit(1); }
if (cmd === 'grant' || cmd === 'revoke') {
  if (!name) { console.error('usage: admin.mjs grant|revoke <name>'); process.exit(2); }
  console.log(setAdmin(name, cmd === 'grant') ? `${name}: ${cmd === 'grant' ? 'now an admin' : 'no longer an admin'}` : `No player named ${name}.`);
} else if (cmd === 'list') {
  for (const p of adminSearch('', 100000).filter(p => p.admin)) console.log(p.name);
} else { console.error('usage: admin.mjs grant|revoke <name> | list'); process.exit(2); }
