const assert = require('node:assert/strict');
const { mkdtempSync, realpathSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, symlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = resolve(__dirname, '..');
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'indexer-coverage-contract-')));
try {
  mkdirSync(join(fixture, 'scripts'));
  mkdirSync(join(fixture, 'src/scripts'), { recursive: true });
  for (const script of ['run-coverage.cjs', 'coverage-register.cjs']) copyFileSync(join(root, 'scripts', script), join(fixture, 'scripts', script));
  symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'), 'dir');
  writeFileSync(join(fixture, 'package.json'), '{"type":"commonjs"}');
  writeFileSync(join(fixture, 'src/main.ts'), `export interface Label { name: string }
export type Kind = 'positive' | 'zero';
export const label: Label = {name: 'tested'};
export function choose(value: number): Kind {
  if (value > 0) return 'positive';
  return 'zero';
}
export const second: number = 2;
${'// A non-executable comment\n\n'.repeat(50)}`);
  writeFileSync(join(fixture, 'src/unloaded.ts'), "export const absent: string = 'unloaded';\n");
  writeFileSync(join(fixture, 'src/model.ts'), 'export interface Data { value: number }\n');
  const test = `import assert from 'node:assert/strict';
import {choose, label, second} from '../main';
assert.equal(choose(1), 'positive');
assert.equal(choose(0), 'zero');
assert.equal(label.name, 'tested');
assert.equal(second, 2);
`;
  writeFileSync(join(fixture, 'src/scripts/smoke.ts'), test);
  const run = () => spawnSync(process.execPath, ['scripts/run-coverage.cjs'], { cwd: fixture, encoding: 'utf8' });
  let result = run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const summary = JSON.parse(readFileSync(join(fixture, 'coverage/coverage-summary.json')));
  assert.deepEqual(summary.total.lines, { total: 5, covered: 4, skipped: 0, pct: 80 });
  assert.equal(summary.total.branches.pct, 100);
  assert.equal(summary[join(fixture, 'src/unloaded.ts')].lines.covered, 0);
  assert.equal(summary[join(fixture, 'src/model.ts')].lines.total, 0);
  writeFileSync(join(fixture, 'src/another-unloaded.ts'), 'export const other = 1;\n');
  result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Executable-line coverage 66.66% is below 80%/);
  rmSync(join(fixture, 'src/another-unloaded.ts'));
  writeFileSync(join(fixture, 'src/scripts/smoke.ts'), test + "assert.fail('Deliberate failing assertion');\n");
  result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /All test programs must pass before coverage can pass/);
  console.log('PASS: original TypeScript executable-only lines; type declarations/comments excluded; unloaded modules counted; low coverage and test failures rejected');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
