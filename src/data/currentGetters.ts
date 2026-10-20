/** Retired Perps ABI names are unsupported, including through generic RPC.
 * Current PxStorage intake uses get_request_check at the same head as its state. */
export const isRetiredPerpsGetter = (method: string): boolean =>
  method === 'open_order_preflight' || method === 'close_order_preflight';
