#!/usr/bin/env node
/**
 * @file Dev launcher for the Electron shell.
 *
 * Some shells export ELECTRON_RUN_AS_NODE=1 (this workspace's shell does). Inheriting it
 * makes the Electron binary behave like plain Node: `require('electron')` returns the path
 * string, `app` is undefined, and the shell crashes before opening a window. Strip it.
 */
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const electronPath = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [ROOT, ...process.argv.slice(2)], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
});
child.on('error', (e) => {
  console.error('failed to start electron:', e.message);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) console.error(`electron exited on signal ${signal}`);
  process.exit(code === null ? 1 : code);
});
