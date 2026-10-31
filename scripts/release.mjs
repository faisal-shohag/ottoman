// Version control for releases. The version lives in package.json, src-tauri/tauri.conf.json and
// src-tauri/Cargo.toml (+ Cargo.lock); this keeps them in step.
//   pnpm release 0.3.0      bump all files, check CHANGELOG.md has a "## 0.3.0" section, commit "Release v0.3.0",
//                           tag v0.3.0. Run on a clean main; then `git push --follow-tags` starts the release build.
//   release.mjs check [vX]  fail if the files disagree (or differ from tag vX). Used by CI.
//   release.mjs notes vX    print the CHANGELOG.md section for vX (GitHub release body).
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const read = (f) => readFileSync(new URL(f, root), 'utf8');
const write = (f, s) => writeFileSync(new URL(f, root), s);
const git = (cmd) => execSync(`git ${cmd}`, { cwd: root, encoding: 'utf8' }).trim();
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

// Each file: how to read its version and how to set it.
const files = {
  'package.json': [/^(\s*"version":\s*")([^"]+)(")/m],
  'src-tauri/tauri.conf.json': [/^(\s*"version":\s*")([^"]+)(")/m],
  'src-tauri/Cargo.toml': [/^(version\s*=\s*")([^"]+)(")/m],
  'src-tauri/Cargo.lock': [/(name = "ottoman"\r?\nversion = ")([^"]+)(")/],
};
const versions = () => Object.fromEntries(Object.entries(files).map(([f, [re]]) => [f, read(f).match(re)?.[2]]));

/** CHANGELOG.md section for a version: from its "## x.y.z" heading to the next "## " heading. */
export function notes(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^## \\[?v?${version.replace(/\./g, '\\.')}\\]?(\\s|$)`).test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'check') {
  const v = versions();
  const distinct = [...new Set(Object.values(v))];
  if (distinct.length !== 1 || !distinct[0]) fail(`Versions disagree:\n${Object.entries(v).map(([f, x]) => `  ${f}: ${x}`).join('\n')}`);
  if (arg && arg.replace(/^v/, '') !== distinct[0]) fail(`Tag ${arg} does not match version ${distinct[0]}.`);
  console.log(`Version ${distinct[0]} everywhere${arg ? `, matches ${arg}` : ''}.`);
} else if (cmd === 'notes') {
  const body = notes(read('CHANGELOG.md'), (arg ?? '').replace(/^v/, ''));
  if (body === null) fail(`CHANGELOG.md has no "## ${arg}" section.`);
  console.log(body);
} else if (cmd && SEMVER.test(cmd)) {
  const version = cmd;
  if (git('status --porcelain')) fail('Working tree is not clean. Commit or stash first.');
  if (git('rev-parse --abbrev-ref HEAD') !== 'main') fail('Release from main.');
  if (git(`tag --list v${version}`)) fail(`Tag v${version} already exists.`);
  if (!notes(read('CHANGELOG.md'), version)) fail(`Add a "## ${version}" section to CHANGELOG.md first.`);
  for (const [f, [re]] of Object.entries(files)) write(f, read(f).replace(re, `$1${version}$3`));
  git(`add ${Object.keys(files).join(' ')}`);
  git(`commit -m "Release v${version}"`);
  git(`tag -a v${version} -m "Ottoman v${version}"`);
  console.log(`Committed and tagged v${version}. Push with: git push --follow-tags`);
} else {
  fail('Usage: pnpm release <x.y.z> | node scripts/release.mjs check [vX.Y.Z] | node scripts/release.mjs notes vX.Y.Z');
}
