import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const DOCKERFILE = 'Dockerfile';
const DOCKERIGNORE = '.dockerignore';
const PRODUCTION_DOC = 'docs/ti-production.md';
const RELEASE_CHECKLIST = 'docs/release-checklist.md';
const CI_WORKFLOW = '.github/workflows/ci.yml';

const requiredEnv: Array<[string, string]> = [
  ['NODE_ENV', 'production'],
  ['INDEXER_MODE', 'production'],
  ['TON_NETWORK', 'mainnet'],
  ['TON_DATASOURCE', 'lite'],
  ['LITESERVER_POOL_MAINNET', 'https://ton.org/global.config.json'],
  ['HOST', '0.0.0.0'],
  ['PORT', '8787'],
  ['TRUST_PROXY', 'true'],
  ['CORS_ENABLED', 'true'],
  ['CORS_ALLOW_ORIGIN', '*'],
  ['RATE_LIMIT_ENABLED', 'true'],
  ['RESPONSE_CACHE_ENABLED', 'true'],
  ['INDEXER_ENABLE_WRITE_RPC', 'false'],
  ['LOG_LEVEL', 'info'],
];

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const readText = (root: string, relativePath: string) => readFileSync(join(root, relativePath), 'utf8');

export function validateDeploymentManifest(root = process.cwd()) {
  const dockerfile = readText(root, DOCKERFILE);
  const dockerignore = readText(root, DOCKERIGNORE);
  const productionDoc = readText(root, PRODUCTION_DOC);
  const releaseChecklist = readText(root, RELEASE_CHECKLIST);
  const ciWorkflow = readText(root, CI_WORKFLOW);

  assert.match(dockerfile, /FROM\s+node:20[^\n]*\s+AS\s+deps/i, 'Dockerfile must pin a Node 20 dependency stage.');
  assert.match(dockerfile, /FROM\s+deps\s+AS\s+build/i, 'Dockerfile must build from the dependency stage.');
  assert.match(dockerfile, /FROM\s+node:20[^\n]*\s+AS\s+runtime/i, 'Dockerfile must use a slim Node 20 runtime stage.');
  assert.match(dockerfile, /\bRUN\s+npm\s+ci\b/i, 'Dockerfile must install from package-lock.json with npm ci.');
  assert.match(dockerfile, /\bRUN\s+npm\s+run\s+build\b/i, 'Dockerfile must compile TypeScript during image build.');
  assert.match(dockerfile, /\bRUN\s+npm\s+prune\s+--omit=dev\b/i, 'Dockerfile must prune dev dependencies from runtime node_modules.');
  assert.match(dockerfile, /COPY\s+--from=build[\s\S]+\/app\/registry\s+\.\/registry/i, 'Dockerfile must carry the reviewed registry files into runtime.');
  assert.match(dockerfile, /\bUSER\s+node\b/i, 'Dockerfile must run as the bundled non-root node user.');
  assert.match(dockerfile, /\bEXPOSE\s+8787\b/, 'Dockerfile must expose port 8787.');
  assert.match(dockerfile, /HEALTHCHECK[\s\S]+\/api\/indexer\/v1\/health/i, 'Dockerfile must healthcheck the v1 health route.');
  assert.match(dockerfile, /CMD\s+\[\s*"npm"\s*,\s*"start"\s*\]/, 'Dockerfile must start with npm start.');
  assert.doesNotMatch(dockerfile, /TON_NETWORK\s*=\s*testnet/i, 'Production Dockerfile must not default TI to testnet.');

  for (const [key, value] of requiredEnv) {
    assert.match(
      dockerfile,
      new RegExp(`${key}\\s*=\\s*"?${escapeRegex(value)}"?`),
      `Dockerfile must set ${key}=${value}.`,
    );
  }

  const ignored = new Set(
    dockerignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#')),
  );
  for (const pattern of ['.git', 'node_modules', 'dist', 'coverage', '.env', '.env.*']) {
    assert.ok(ignored.has(pattern), `.dockerignore must exclude ${pattern}.`);
  }

  for (const requiredText of [
    'docker build',
    'docker run',
    'TON_NETWORK=mainnet',
    'ti.soramitsu.io',
    '/api/indexer/v1/service-info',
    'TON_INDEXER_BASE_URL=https://ti.soramitsu.io npm run smoke:production',
  ]) {
    assert.match(productionDoc, new RegExp(escapeRegex(requiredText)), `Production docs must mention ${requiredText}.`);
  }

  assert.match(
    releaseChecklist,
    /docker build -t ton-indexer:release \./,
    'Release checklist must require a production Docker image build.',
  );
  assert.match(
    releaseChecklist,
    /Docker\s+image\s+build/i,
    'Release checklist must include the Docker image build in required CI evidence.',
  );
  assert.match(
    ciWorkflow,
    /docker build -t ton-indexer:ci \./,
    'CI must build the production Docker image.',
  );
}

const writeFixture = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), 'ton-indexer-deploy-'));
  for (const [relativePath, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, relativePath)), { recursive: true });
    writeFileSync(join(root, relativePath), content);
  }
  return root;
};

const assertRejectsFixture = (files: Record<string, string>, expected: RegExp) => {
  const root = writeFixture(files);
  try {
    assert.throws(() => validateDeploymentManifest(root), expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const main = () => {
  validateDeploymentManifest();

  const actualFiles = {
    [DOCKERFILE]: readText(process.cwd(), DOCKERFILE),
    [DOCKERIGNORE]: readText(process.cwd(), DOCKERIGNORE),
    [PRODUCTION_DOC]: readText(process.cwd(), PRODUCTION_DOC),
    [RELEASE_CHECKLIST]: readText(process.cwd(), RELEASE_CHECKLIST),
    [CI_WORKFLOW]: readText(process.cwd(), CI_WORKFLOW),
  };

  assertRejectsFixture(
    {
      ...actualFiles,
      [DOCKERFILE]: actualFiles[DOCKERFILE].replace('EXPOSE 8787', 'EXPOSE 8788'),
    },
    /Dockerfile must expose port 8787/,
  );
  assertRejectsFixture(
    {
      ...actualFiles,
      [DOCKERFILE]: actualFiles[DOCKERFILE].replace('TON_NETWORK=mainnet', 'TON_NETWORK=testnet'),
    },
    /Production Dockerfile must not default TI to testnet/,
  );
  assertRejectsFixture(
    {
      ...actualFiles,
      [DOCKERFILE]: actualFiles[DOCKERFILE].replace(/^HEALTHCHECK .*$/m, ''),
    },
    /Dockerfile must healthcheck/,
  );
  assertRejectsFixture(
    {
      ...actualFiles,
      [DOCKERIGNORE]: actualFiles[DOCKERIGNORE].replace(/^node_modules\n/m, ''),
    },
    /\.dockerignore must exclude node_modules/,
  );
  assertRejectsFixture(
    {
      ...actualFiles,
      [PRODUCTION_DOC]: actualFiles[PRODUCTION_DOC].replace(
        'TON_INDEXER_BASE_URL=https://ti.soramitsu.io npm run smoke:production',
        'npm run smoke:production',
      ),
    },
    /Production docs must mention TON_INDEXER_BASE_URL=https:\/\/ti\.soramitsu\.io npm run smoke:production/,
  );
  assertRejectsFixture(
    {
      ...actualFiles,
      [RELEASE_CHECKLIST]: actualFiles[RELEASE_CHECKLIST].replace(
        'docker build -t ton-indexer:release .',
        'npm run build',
      ),
    },
    /Release checklist must require a production Docker image build/,
  );
  assertRejectsFixture(
    {
      ...actualFiles,
      [CI_WORKFLOW]: actualFiles[CI_WORKFLOW].replace('docker build -t ton-indexer:ci .', 'npm run build'),
    },
    /CI must build the production Docker image/,
  );

  process.stdout.write('ton deployment manifest tests passed\n');
};

main();
