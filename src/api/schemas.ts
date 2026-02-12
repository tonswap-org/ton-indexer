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
