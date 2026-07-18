#!/usr/bin/env node
// Packages the agent into a standalone .exe.
//
// pkg's node18-win-x64 target bundles a Node runtime with NODE_MODULE_VERSION 108.
// better-sqlite3 in node_modules is compiled against whatever Node runs locally
// (dev machine ABI, e.g. 137 for Node 24), so the two don't match and the packaged
// exe crashes on launch. Fix: swap in better-sqlite3's official node-v108 prebuilt
// binary just for the pkg step, then restore the dev-ABI binary afterward so
// `npm run dev` keeps working locally.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const bsq3Dir = path.join(root, 'node_modules', 'better-sqlite3');
const releaseDir = path.join(bsq3Dir, 'build', 'Release');
const devBinary = path.join(releaseDir, 'better_sqlite3.node');
const devBackup = path.join(releaseDir, 'better_sqlite3.dev.node');

// pkg's "node18" target's exact ABI (108) is confirmed by the runtime crash message
// itself, not guessed - see NODE_MODULE_VERSION in the error this script fixes.
const PKG_NODE_TARGET = '18.20.4';

function run(cmd, cwd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd });
}

run('npx tsc', root);

fs.copyFileSync(devBinary, devBackup);
try {
  run(
    `npx prebuild-install --target=${PKG_NODE_TARGET} --arch=x64 --platform=win32`,
    bsq3Dir
  );
  run(
    'npx pkg dist/index.js --targets node18-win-x64 --output build/PitWallAgent.exe',
    root
  );
} finally {
  fs.copyFileSync(devBackup, devBinary);
  fs.unlinkSync(devBackup);
}
