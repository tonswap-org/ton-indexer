export const addressParamsSchema = {
  type: 'object',
  properties: {
    addr: { type: 'string' },
  },
  required: ['addr'],
};

export const txQuerySchema = {
  type: 'object',
  properties: {
    page: { type: 'integer', minimum: 1 },
    cursor_lt: { type: 'string', pattern: '^\\d+$' },
    cursor_hash: { type: 'string' },
  },
};

export const swapQuerySchema = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    pay_token: { type: 'string', minLength: 1, maxLength: 32 },
    receive_token: { type: 'string', minLength: 1, maxLength: 32 },
    execution_type: { type: 'string', enum: ['market', 'limit', 'twap', 'unknown'] },
    status: { type: 'string', enum: ['success', 'failed', 'pending'] },
    include_reverse: { type: 'string', enum: ['1', '0', 'true', 'false', 'yes', 'no'] },
  },
};

export const debugQuerySchema = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 500 },
  },
};

export const perpsSnapshotQuerySchema = {
  type: 'object',
  properties: {
    market_ids: { type: 'string' },
    max_markets: { type: 'integer', minimum: 1, maximum: 128 },
  },
};

export const governanceSnapshotQuerySchema = {
  type: 'object',
  properties: {
    owner: { type: 'string' },
    max_scan: { type: 'integer', minimum: 1, maximum: 64 },
    max_misses: { type: 'integer', minimum: 1, maximum: 8 },
  },
};

export const farmsSnapshotQuerySchema = {
  type: 'object',
  properties: {
    max_scan: { type: 'integer', minimum: 1, maximum: 64 },
    max_misses: { type: 'integer', minimum: 1, maximum: 8 },
  },
};

export const coverSnapshotQuerySchema = {
  type: 'object',
  properties: {
    owner: { type: 'string' },
    max_scan: { type: 'integer', minimum: 1, maximum: 64 },
    max_misses: { type: 'integer', minimum: 1, maximum: 8 },
  },
};
