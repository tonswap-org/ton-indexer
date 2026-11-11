import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const DOCKERFILE = 'Dockerfile';
const DOCKERIGNORE = '.dockerignore';
const PRODUCTION_COMPOSE = 'docker-compose.production.yml';
const PRODUCTION_DOC = 'docs/ti-production.md';
const RELEASE_CHECKLIST = 'docs/release-checklist.md';
const CI_WORKFLOW = '.github/workflows/ci.yml';
const DOCKERFILE_FRONTEND = 'docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89';
const NODE_22_IMAGE = 'node:22-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf';

const requiredEnv: Array<[string, string]> = [
  ['NODE_ENV', 'production'],
  ['INDEXER_MODE', 'production'],
  ['TON_NETWORK', 'mainnet'],
  ['TON_DATASOURCE', 'lite'],
  ['LITESERVER_POOL_MAINNET', 'https://ton.org/global.config.json'],
  ['HOST', '0.0.0.0'],
  ['PORT', '8787'],
  ['TRUST_PROXY', 'false'],
  ['CORS_ENABLED', 'true'],
  ['CORS_ALLOW_ORIGIN', '*'],
  ['RATE_LIMIT_ENABLED', 'true'],
  ['RATE_LIMIT_MAX_KEYS', '20000'],
  ['RATE_LIMIT_GLOBAL_WINDOW_MS', '60000'],
  ['RATE_LIMIT_GLOBAL_MAX', '50000'],
  ['RESPONSE_CACHE_ENABLED', 'true'],
  ['INDEXER_ENABLE_WRITE_RPC', 'false'],
  ['LOG_LEVEL', 'info'],
];

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const readText = (root: string, relativePath: string) => readFileSync(join(root, relativePath), 'utf8');

export function validateDeploymentManifest(root = process.cwd()) {
  const dockerfile = readText(root, DOCKERFILE);
  const dockerignore = readText(root, DOCKERIGNORE);
  const productionCompose = readText(root, PRODUCTION_COMPOSE);
  const productionDoc = readText(root, PRODUCTION_DOC);
  const releaseChecklist = readText(root, RELEASE_CHECKLIST);
  const ciWorkflow = readText(root, CI_WORKFLOW);

  assert.match(
    dockerfile,
    new RegExp(`^# syntax=${escapeRegex(DOCKERFILE_FRONTEND)}$`, 'm'),
    'Dockerfile must pin the Dockerfile frontend by digest.',
  );
  assert.match(
    dockerfile,
    new RegExp(`^FROM ${escapeRegex(NODE_22_IMAGE)} AS deps$`, 'm'),
    'Dockerfile must pin the Node 22 dependency image by digest.',
  );
  assert.match(
    dockerfile,
    new RegExp(`^FROM ${escapeRegex(NODE_22_IMAGE)} AS runtime$`, 'm'),
    'Dockerfile must pin the Node 22 runtime image by digest.',
  );
  assert.match(dockerfile, /FROM\s+node:22[^\n]*\s+AS\s+deps/i, 'Dockerfile must pin a Node 22 dependency stage.');
  assert.match(dockerfile, /FROM\s+deps\s+AS\s+build/i, 'Dockerfile must build from the dependency stage.');
  assert.match(dockerfile, /FROM\s+node:22[^\n]*\s+AS\s+runtime/i, 'Dockerfile must use a slim Node 22 runtime stage.');
  assert.match(dockerfile, /\bRUN\s+npm\s+ci\s+--ignore-scripts\b/i, 'Dockerfile must install immutable dependencies without lifecycle scripts.');
  assert.doesNotMatch(
    dockerfile,
    /\|\|\s*npm\s+(?:install|i|ci)\b/i,
    'Dockerfile must not fall back to a mutable dependency install.',
  );
  assert.match(dockerfile, /\bRUN\s+npm\s+run\s+build\b/i, 'Dockerfile must compile TypeScript during image build.');
  assert.match(dockerfile, /\bRUN\s+npm\s+prune\s+--omit=dev\s+--ignore-scripts\b/i, 'Dockerfile must prune dev dependencies without lifecycle scripts.');
  assert.match(dockerfile, /COPY\s+--from=build[\s\S]+\/app\/registry\s+\.\/registry/i, 'Dockerfile must carry the reviewed registry files into runtime.');
  assert.match(dockerfile, /\bUSER\s+node\b/i, 'Dockerfile must run as the bundled non-root node user.');
  assert.match(dockerfile, /\bEXPOSE\s+8787\b/, 'Dockerfile must expose port 8787.');
  assert.match(dockerfile, /HEALTHCHECK[\s\S]+\/api\/indexer\/v1\/health/i, 'Dockerfile must healthcheck the v1 health route.');
  for (const marker of [
    "body.serviceId!=='ti.soramitsu.io'",
    "body.ecosystem!=='ton'",
    "body.chainId!=='ton:mainnet'",
    "body.network!=='mainnet'",
  ]) {
    assert.ok(dockerfile.includes(marker), `Dockerfile healthcheck must validate strict TI identity marker: ${marker}`);
  }
  assert.match(dockerfile, /CMD\s+\[\s*"npm"\s*,\s*"start"\s*\]/, 'Dockerfile must start with npm start.');
  assert.doesNotMatch(dockerfile, /TON_NETWORK\s*=\s*testnet/i, 'Production Dockerfile must not default TI to testnet.');

  for (const [pattern, message] of [
    [/image:\s*"\$\{TON_INDEXER_IMAGE_REPOSITORY:\?[^\n]*@sha256:\$\{TON_INDEXER_IMAGE_DIGEST:\?/, 'Production Compose must require an immutable TON image reference.'],
    [/"127\.0\.0\.1:8787:8787"/, 'Production Compose must publish TON only on host loopback.'],
    [/read_only:\s*true/, 'Production Compose must use a read-only root filesystem.'],
    [/cap_drop:\s*\n\s*- ALL/, 'Production Compose must drop all Linux capabilities.'],
    [/no-new-privileges:true/, 'Production Compose must prevent privilege escalation.'],
    [/pids_limit:\s*128/, 'Production Compose must bound process IDs.'],
    [/\/tmp:rw,noexec,nosuid,nodev,size=16m/, 'Production Compose must use a bounded no-exec tmpfs.'],
    [/LITESERVER_POOL_MAINNET:\s*"\$\{TON_LITESERVER_POOL_MAINNET:\?/, 'Production Compose must require external lite-server configuration.'],
    [/TRUSTED_PROXY_CIDRS:\s*"\$\{TON_TRUSTED_PROXY_CIDRS:\?/, 'Production Compose must require explicit trusted proxy CIDRs.'],
    [/INDEXER_ENABLE_WRITE_RPC:\s*"false"/, 'Production Compose must keep write RPC disabled.'],
    [/RATE_LIMIT_GLOBAL_MAX:\s*"50000"/, 'Production Compose must configure the global rate bucket.'],
  ] as Array<[RegExp, string]>) {
    assert.match(productionCompose, pattern, message);
  }

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
    'docker-compose.production.yml',
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
  assert.match(
    ciWorkflow,
    /Development-only dependency leaked into runtime image/,
    'CI must reject development dependencies in the production image.',
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
    [PRODUCTION_COMPOSE]: readText(process.cwd(), PRODUCTION_COMPOSE),
    [PRODUCTION_DOC]: readText(process.cwd(), PRODUCTION_DOC),
    [RELEASE_CHECKLIST]: readText(process.cwd(), RELEASE_CHECKLIST),
    [CI_WORKFLOW]: readText(process.cwd(), CI_WORKFLOW),
  };

  assertRejectsFixture(
    {
      ...actualFiles,
      [DOCKERFILE]: actualFiles[DOCKERFILE].replace(`@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89`, ''),
    },
    /Dockerfile must pin the Dockerfile frontend by digest/,
  );
  assertRejectsFixture(
    {
      ...actualFiles,
      [DOCKERFILE]: actualFiles[DOCKERFILE].replaceAll(`@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf`, ''),
    },
    /Dockerfile must pin the Node 22 dependency image by digest/,
  );
  assertRejectsFixture(
    {
      ...actualFiles,
      [DOCKERFILE]: actualFiles[DOCKERFILE].replaceAll('node:22-bookworm-slim', 'node:20-bookworm-slim'),
    },
    /Dockerfile must pin the Node 22 dependency image by digest/,
  );
  assertRejectsFixture(
    {
      ...actualFiles,
      [DOCKERFILE]: actualFiles[DOCKERFILE].replace(
        `FROM ${NODE_22_IMAGE} AS runtime`,
        'FROM node:20-bookworm-slim AS runtime',
      ),
    },
    /Dockerfile must pin the Node 22 runtime image by digest/,
  );
  assertRejectsFixture(
    {
      ...actualFiles,
      [DOCKERFILE]: actualFiles[DOCKERFILE].replace('npm ci --ignore-scripts', 'npm install'),
    },
    /Dockerfile must install immutable dependencies without lifecycle scripts/,
  );
  assertRejectsFixture(
    {
      ...actualFiles,
      [DOCKERFILE]: actualFiles[DOCKERFILE].replace(
        'npm ci --ignore-scripts',
        'npm ci --ignore-scripts || npm install',
      ),
    },
    /Dockerfile must not fall back to a mutable dependency install/,
  );
  assertRejectsFixture(
    {
      ...actualFiles,
      [DOCKERFILE]: actualFiles[DOCKERFILE].replace(
        'npm prune --omit=dev --ignore-scripts',
        'npm prune --omit=dev',
      ),
    },
    /Dockerfile must prune dev dependencies without lifecycle scripts/,
  );
  assertRejectsFixture(
    {
      ...actualFiles,
      [DOCKERFILE]: actualFiles[DOCKERFILE].replace('USER node', 'USER root'),
    },
    /Dockerfile must run as the bundled non-root node user/,
  );
  assertRejectsFixture(
    {
      ...actualFiles,
      [PRODUCTION_COMPOSE]: actualFiles[PRODUCTION_COMPOSE].replace('127.0.0.1:8787:8787', '0.0.0.0:8787:8787'),
    },
    /must publish TON only on host loopback/,
  );
  assertRejectsFixture(
    {
      ...actualFiles,
      [PRODUCTION_COMPOSE]: actualFiles[PRODUCTION_COMPOSE].replace('read_only: true', 'read_only: false'),
    },
    /must use a read-only root filesystem/,
  );
  assertRejectsFixture(
    {
      ...actualFiles,
      [PRODUCTION_COMPOSE]: actualFiles[PRODUCTION_COMPOSE].replace('      - ALL\n', ''),
    },
    /must drop all Linux capabilities/,
  );
  assertRejectsFixture(
    {
      ...actualFiles,
      [PRODUCTION_COMPOSE]: actualFiles[PRODUCTION_COMPOSE].replace('      - no-new-privileges:true\n', ''),
    },
    /must prevent privilege escalation/,
  );
  assertRejectsFixture(
    {
      ...actualFiles,
      [PRODUCTION_COMPOSE]: actualFiles[PRODUCTION_COMPOSE].replace('    pids_limit: 128\n', ''),
    },
    /must bound process IDs/,
  );
  assertRejectsFixture(
    {
      ...actualFiles,
      [PRODUCTION_COMPOSE]: actualFiles[PRODUCTION_COMPOSE].replace('${TON_TRUSTED_PROXY_CIDRS:?', '${TON_TRUSTED_PROXY_CIDRS-'),
    },
    /must require explicit trusted proxy CIDRs/,
  );
  assertRejectsFixture(
    {
      ...actualFiles,
      [PRODUCTION_COMPOSE]: actualFiles[PRODUCTION_COMPOSE].replace('${TON_INDEXER_IMAGE_DIGEST:?', '${TON_INDEXER_IMAGE_DIGEST-'),
    },
    /must require an immutable TON image reference/,
  );
  assertRejectsFixture(
    {
      ...actualFiles,
      [PRODUCTION_COMPOSE]: actualFiles[PRODUCTION_COMPOSE].replace('${TON_LITESERVER_POOL_MAINNET:?', '${TON_LITESERVER_POOL_MAINNET-'),
    },
    /must require external lite-server configuration/,
  );
  assertRejectsFixture(
    {
      ...actualFiles,
      [PRODUCTION_COMPOSE]: actualFiles[PRODUCTION_COMPOSE].replace('      - /tmp:rw,noexec,nosuid,nodev,size=16m\n', ''),
    },
    /must use a bounded no-exec tmpfs/,
  );
  assertRejectsFixture(
    {
      ...actualFiles,
      [PRODUCTION_COMPOSE]: actualFiles[PRODUCTION_COMPOSE].replace('      RATE_LIMIT_GLOBAL_MAX: "50000"\n', ''),
    },
    /must configure the global rate bucket/,
  );
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
      [DOCKERFILE]: actualFiles[DOCKERFILE].replace("body.chainId!=='ton:mainnet'", 'false'),
    },
    /Dockerfile healthcheck must validate strict TI identity marker/,
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
  assertRejectsFixture(
    {
      ...actualFiles,
      [CI_WORKFLOW]: actualFiles[CI_WORKFLOW].replace(
        'Development-only dependency leaked into runtime image',
        'runtime dependency surface accepted',
      ),
    },
    /CI must reject development dependencies in the production image/,
  );

  process.stdout.write('ton deployment manifest tests passed\n');
};

main();
