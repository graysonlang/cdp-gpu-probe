#!/usr/bin/env node
// Print one of this checkout's derived ports — http, https or debug — and nothing
// else, so npm scripts can interpolate it:
//
//   --url=http://127.0.0.1:$(node scripts/derived-port.mjs http)/
//
// esp derives the dev-server port from the absolute path of scripts/build.mjs, so
// every clone and worktree serves on its own port (see @graysonlang/esp's README).
// That is why the probe scripts cannot hardcode a port: the number differs per
// checkout. esp exposes the values only through the runner's --print-port output,
// which prints all three as `key=value` lines, hence this thin wrapper.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KEYS = ['http', 'https', 'debug'];

const key = process.argv[2] ?? 'http';
if (!KEYS.includes(key)) {
  console.error(`derived-port: expected one of ${KEYS.join(', ')}, got '${key}'`);
  process.exit(1);
}

const build = fileURLToPath(new URL('./build.mjs', import.meta.url));
const printed = execFileSync(process.execPath, [build, '--print-port'], { encoding: 'utf8' });

const match = printed.match(new RegExp(`^${key}=(\\d+)$`, 'm'));
if (!match) {
  console.error(`derived-port: no '${key}' port in --print-port output:\n${printed}`);
  process.exit(1);
}

// No trailing newline: this is meant to be substituted mid-string.
process.stdout.write(match[1]);
