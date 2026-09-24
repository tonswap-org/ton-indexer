export const addressParamsSchema = {
  type: 'object',
  properties: {
    addr: { type: 'string' },
  },
  required: ['addr'],
};

export const jettonTransferPayloadParamsSchema = {
  type: 'object',
  properties: {
    jetton: { type: 'string' },
    owner: { type: 'string' },
  },
  required: ['jetton', 'owner'],
};

export const txQuerySchema = {
  type: 'object',
  propertyNames: { enum: ['page', 'cursor_lt', 'cursor_hash'] },
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
    from_utime: { type: 'integer', minimum: 1 },
    to_utime: { type: 'integer', minimum: 1 },
    pay_token: { type: 'string', minLength: 1, maxLength: 32 },
    receive_token: { type: 'string', minLength: 1, maxLength: 32 },
    execution_type: { type: 'string', enum: ['market', 'limit', 'twap', 'unknown'] },
    status: { type: 'string', enum: ['success', 'failed', 'pending'] },
    include_reverse: { type: 'string', enum: ['1', '0', 'true', 'false', 'yes', 'no'] },
  },
};

export const marketCandleParamsSchema = {
  type: 'object',
  properties: {
    market: { type: 'string', minLength: 1, maxLength: 160 },
  },
  required: ['market'],
};

export const marketCandleQuerySchema = {
  type: 'object',
  properties: {
    market_address: { type: 'string' },
    asset_symbol: { type: 'string', minLength: 1, maxLength: 32 },
    quote_symbol: { type: 'string', minLength: 1, maxLength: 32 },
    asset_decimals: { type: 'integer', minimum: 0, maximum: 30 },
    quote_decimals: { type: 'integer', minimum: 0, maximum: 30 },
    interval: { type: 'string', enum: ['1m', '5m', '15m', '1h', '4h', '1d'] },
    from_utime: { type: 'integer', minimum: 1 },
    to_utime: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 1000 },
  },
  required: ['market_address', 'asset_symbol', 'quote_symbol'],
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
    market_ids: { type: 'string', pattern: '^[1-9][0-9]*(,[1-9][0-9]*)*$', maxLength: 1407 },
    max_markets: { type: 'integer', minimum: 1, maximum: 128 },
  },
};

export const volIndexSnapshotQuerySchema = {
  type: 'object',
  properties: {
    pool: { type: 'string' },
    route_ids: { type: 'string', pattern: '^[1-9][0-9]*(,[1-9][0-9]*)*$', maxLength: 703 },
  },
};

export const governanceSnapshotQuerySchema = {
  type: 'object',
  properties: {
    owner: { type: 'string' },
    start_id: { type: 'string', pattern: '^[1-9][0-9]{0,19}$' },
    max_scan: { type: 'integer', minimum: 1, maximum: 64 },
    max_misses: { type: 'integer', minimum: 1, maximum: 8 },
  },
};

export const farmsSnapshotQuerySchema = {
  type: 'object', additionalProperties: false,
  properties: {
    owner: { type: 'string' },
    start_id: { type: 'string', pattern: '^[1-9][0-9]{0,19}$' },
    limit: { type: 'integer', minimum: 1, maximum: 64 },
  },
};

export const optionsSnapshotQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    after_id: { type: 'string', pattern: '^(0|[1-9][0-9]{0,19})$' },
    limit: { type: 'integer', minimum: 1, maximum: 64 },
  },
};

export const coverSnapshotQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    owner: { type: 'string' },
    after_slot: { type: 'integer', minimum: 0, maximum: 1024 },
    limit: { type: 'integer', minimum: 1, maximum: 40 },
    revision: { type: 'string', pattern: '^(0|[1-9][0-9]{0,19})$' },
  },
};
