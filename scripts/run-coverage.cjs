const assert = require('node:assert/strict');
const { readdirSync, readFileSync, writeFileSync, rmSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createInstrumenter } = require('istanbul-lib-instrument');
const { createCoverageMap } = require('istanbul-lib-coverage');
const { createContext } = require('istanbul-lib-report');
const reports = require('istanbul-reports');

const root = resolve(__dirname, '..');
process.chdir(root);
const output = resolve('coverage');
const raw = resolve(output, 'raw');
rmSync(raw, { recursive: true, force: true });
mkdirSync(raw, { recursive: true });
const all = readdirSync('src', { recursive: true }).filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts')).sort();
const isTest = name => name.startsWith('scripts/') && (name.endsWith('-test.ts') || name === 'scripts/smoke.ts');
const production = all.filter(name => !isTest(name));
const tests = all.filter(isTest);
assert(production.length && tests.length);
const map = createCoverageMap({});
const hashes = {};
const instrumenter = createInstrumenter({ parserPlugins: ['typescript'], esModules: true });
for (const name of production) {
  const path = resolve('src', name);
  const source = readFileSync(path, 'utf8');
  assert(!/istanbul\s+ignore/.test(source), `Unreviewed coverage exclusion: ${name}`);
  // Enums and namespaces have compiler-generated runtime behavior. Refuse them
  // until coverage support is added, rather than silently omitting their code.
  assert(!/\b(?:enum|namespace)\s+\w+\s*\{/.test(source), `Unsupported TypeScript runtime syntax: ${name}`);
  hashes[`src/${name}`] = createHash('sha256').update(source).digest('hex');
  instrumenter.instrumentSync(source, path);
  map.addFileCoverage(instrumenter.lastFileCoverage());
}
writeFileSync(resolve(output, 'source-inventory.json'), JSON.stringify({ production, tests,
  operationalScripts: production.filter(name => name.startsWith('scripts/')),
  typeOnly: map.files().filter(path => Object.keys(map.fileCoverageFor(path).statementMap).length === 0) }, null, 2));
let failed = false;
for (const test of tests) {
  console.log(`\nRUN src/${test}`);
  const result = spawnSync(process.execPath, ['--require', resolve('scripts/coverage-register.cjs'), `src/${test}`], {
    stdio: 'inherit', env: { ...process.env, INDEXER_COVERAGE_SOURCES: JSON.stringify(production.map(name => resolve('src', name))), INDEXER_COVERAGE_RAW: raw },
  });
  if (result.status !== 0 || result.error || result.signal) {
    console.error(`FAILED ${test}: status=${result.status} signal=${result.signal}`, result.error ?? '');
    failed = true;
  }
}
for (const name of readdirSync(raw)) map.merge(JSON.parse(readFileSync(resolve(raw, name), 'utf8')));
assert.deepEqual(map.files().sort(), production.map(name => resolve('src', name)).sort());
for (const [name, before] of Object.entries(hashes)) assert.equal(createHash('sha256').update(readFileSync(name)).digest('hex'), before, `Source changed: ${name}`);
const after = readdirSync('src', { recursive: true }).filter(name => name.endsWith('.ts') && !name.endsWith('.d.ts')).sort();
assert.deepEqual(after, all, 'Source inventory changed during execution');
writeFileSync(resolve(output, 'source-hashes.json'), JSON.stringify(hashes, null, 2));
const context = createContext({ dir: output, coverageMap: map });
for (const reporter of ['json', 'json-summary', 'lcovonly', 'text']) reports.create(reporter).execute(context);
const summary = map.getCoverageSummary();
writeFileSync(resolve(output, 'run-result.json'), JSON.stringify({ testPrograms: tests, testsPassed: !failed, executableLineGatePassed: summary.lines.total > 0 && summary.lines.pct >= 80 }, null, 2));
assert(!failed, 'All test programs must pass before coverage can pass');
console.log(`All ${production.length} production modules: ${summary.lines.covered}/${summary.lines.total} executable lines (${summary.lines.pct}%), ` + `${summary.branches.covered}/${summary.branches.total} branches (${summary.branches.pct}%)`);
assert(summary.lines.total > 0 && summary.lines.pct >= 80, `Executable-line coverage ${summary.lines.pct}% is below 80%`);
