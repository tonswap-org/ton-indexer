const INTERNAL_INDEXER_MOUNT = '/api/indexer';

/** Map one registered route to the native manifest's public mount. */
export function publicIndexerPath(indexer: string | undefined, route: string): string {
  if (!route.startsWith(`${INTERNAL_INDEXER_MOUNT}/`)) throw Error('Expected a registered indexer route');
  if (indexer === undefined) return route;
  const url = new URL(indexer);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw Error('Indexer mount must be an HTTP(S) URL without credentials, query or fragment');
  return `${url.pathname.replace(/\/+$/, '')}${route.slice(INTERNAL_INDEXER_MOUNT.length)}`;
}

/** Preserve the supplied transport origin and the exact mount, including query values. */
export function publicIndexerUrl(indexer: string, route: string, query?: URLSearchParams): URL {
  const url = new URL(indexer);
  url.pathname = publicIndexerPath(indexer, route);
  if (query) url.search = query.toString();
  return url;
}
