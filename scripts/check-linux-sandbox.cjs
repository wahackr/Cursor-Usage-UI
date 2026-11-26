const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'linux') process.exit(0);

const sandbox = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'chrome-sandbox');
if (!fs.existsSync(sandbox)) process.exit(0);

const { mode, uid, gid } = fs.statSync(sandbox);
const setuid = (mode & 0o4000) !== 0;
const modeBits = mode & 0o7777;
if (setuid && modeBits === 0o4755 && uid === 0 && gid === 0) process.exit(0);

console.error(`
Electron's Linux sandbox helper is not configured (chrome-sandbox must be root:root mode 4755).
Ubuntu blocks Chromium's user-namespace sandbox unless this one-time step is done.

  npm run fix:linux-sandbox

That script only changes chrome-sandbox inside this project. Do not use --no-sandbox.
`);
process.exit(1);