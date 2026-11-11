const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const ts = require('typescript');
const { createInstrumenter } = require('istanbul-lib-instrument');
const sources = new Set(JSON.parse(process.env.INDEXER_COVERAGE_SOURCES));
const instrumenter = createInstrumenter({ parserPlugins: ['typescript'], esModules: true });

require.extensions['.ts'] = (module, filename) => {
  let source = readFileSync(filename, 'utf8');
  if (sources.has(filename)) source = instrumenter.instrumentSync(source, filename);
  // Counters are assigned to original TypeScript AST locations, before compiler
  // helper code is generated. Type-only declarations add no executable lines.
  const result = ts.transpileModule(source, { fileName: filename, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } });
  module._compile(result.outputText, filename);
};
process.on('exit', () => {
  if (globalThis.__coverage__) writeFileSync(join(process.env.INDEXER_COVERAGE_RAW, `${process.pid}-${randomUUID()}.json`), JSON.stringify(globalThis.__coverage__));
});
