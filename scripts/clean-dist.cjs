'use strict';

const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
if (process.argv.length !== 2 || fs.realpathSync(packageRoot) !== packageRoot) {
  throw new Error('Build cleanup requires its physical package root and accepts no path arguments.');
}
const dist = path.join(packageRoot, 'dist');
let stat;
try {
  stat = fs.lstatSync(dist);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (stat) {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Build output dist must be a real directory, not a symlink or file.');
  }
  // Node removes nested symlinks themselves without following their targets.
  fs.rmSync(dist, { recursive: true });
}
