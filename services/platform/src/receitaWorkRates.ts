/** Canonical Receita monthly-table contract, shared by the server and browser worker.
 * No DOM, network, Node dependency, floating-point rate, or calendar-month shift. */
export const RECEITA_WORK_RATES_TTL_MS = 21_600_000;
export const RECEITA_WORK_RATES_MAX_BYTES = 4_000_000;
export const RECEITA_WORK_RATES_DOCUMENTATION = 'https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda/pagamento/carne-leao/rendimentos';
const root = 'https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda/tabelas/conversao/';
const format = 'receita-work-rates-evidence-v1' as const;
export interface ReceitaWorkRatesRequest {
  currency: 'USD'; quoteCurrency: 'BRL'; receiptMonth: string; method: 'receita-monthly-work-income-compra';
  source: { provider: 'receita-federal-do-brasil'; requestUrl: string; documentationUrl: string };
}
export interface ReceitaWorkRatesObservation {
  receiptMonth: string; currency: 'USD'; quoteCurrency: 'BRL'; side: 'compra';
  buy: string; buySourceLexeme: string; sellSourceLexeme: string; sourceMonthLabel: string;
}
export interface ReceitaWorkRatesEvidence {
  format: typeof format; request: ReceitaWorkRatesRequest; fetchedAt: string; expiresAt: string;
  sourceHtml: string; sourceSha256: string; observation: ReceitaWorkRatesObservation | null; issues: string[];
}
export interface ReceitaWorkRatesRevision { revisionId: string; evidence: ReceitaWorkRatesEvidence }
export interface ReceitaWorkRatesResponse {
  request: ReceitaWorkRatesRequest; requestedAt: string; status: 'available' | 'missing' | 'unavailable';
  revisionId: string | null; fetchedAt: string | null; expiresAt: string | null; stale: boolean;
  observation: ReceitaWorkRatesObservation | null; issues: string[];
}
const fail = (message: string): never => { throw Error(message); };
export function receitaWorkRatesSnapshot(value: unknown, depth = 0): unknown {
  if (depth > 20) return fail('Receita evidence is too deeply nested.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string' && value.length <= RECEITA_WORK_RATES_MAX_BYTES) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') return fail('Receita evidence requires plain JSON data.');
  if (Array.isArray(value)) {
    if (value.length > 100 || Reflect.ownKeys(value).length !== value.length + 1) return fail('Receita evidence requires plain bounded arrays.');
    return Array.from({ length: value.length }, (_, index) => {
      const d = Object.getOwnPropertyDescriptor(value, String(index));
      if (!d?.enumerable || !Object.hasOwn(d, 'value')) return fail('Receita evidence rejects accessor or missing array entries.');
      return receitaWorkRatesSnapshot(d.value, depth + 1);
    });
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail('Receita evidence requires plain records.');
  const keys = Reflect.ownKeys(value);
  if (keys.length > 100) return fail('Receita evidence has too many fields.');
  return Object.fromEntries(keys.map(key => {
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value')) return fail('Receita evidence rejects hidden, symbol or accessor fields.');
    return [key, receitaWorkRatesSnapshot(d.value, depth + 1)];
  }));
}
export const receitaWorkRatesRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Receita evidence requires a record.');
  return value as Record<string, unknown>;
};
export const receitaWorkRatesCanonical = (value: unknown): string => {
  const order = (v: unknown): unknown => Array.isArray(v) ? v.map(order) : v !== null && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, item]) => [k, order(item)])) : v;
  return JSON.stringify(order(value));
};
export function receitaWorkRatesFields(value: Record<string, unknown>, names: string[]) {
  if (receitaWorkRatesCanonical(Object.keys(value).sort()) !== receitaWorkRatesCanonical([...names].sort())) fail('Receita evidence has noncanonical fields.');
}
export function receitaWorkRatesTime(value: unknown): number {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return fail('Receita evidence requires a canonical UTC instant.');
  return Date.parse(value);
}
export function receitaWorkRatesRequest(receiptMonth: string): ReceitaWorkRatesRequest {
  if (typeof receiptMonth !== 'string' || receiptMonth.length !== 7 || !/^202[56]-(?:0[1-9]|1[0-2])$/.test(receiptMonth)) return fail('Receita work rates require an original receipt month in the documented 2025 or 2026 table.');
  return { currency: 'USD', quoteCurrency: 'BRL', receiptMonth, method: 'receita-monthly-work-income-compra',
    source: { provider: 'receita-federal-do-brasil', requestUrl: root + receiptMonth.slice(0, 4), documentationUrl: RECEITA_WORK_RATES_DOCUMENTATION } };
}
const months = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const contentText = (html: string): string => html.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;|&#xA0;/gi, ' ').replace(/\s+/g, ' ').trim();
function one(matches: string[], what: string): string { if (matches.length !== 1) return fail(`Receita source needs exactly one ${what}.`); return matches[0]!; }
function sourceTags(html: string, name: 'link' | 'h1' | 'div'): { attributes: Map<string, string>; contentAt: number }[] {
  return [...html.matchAll(new RegExp(`<${name}\\b((?:"[^"]*"|'[^']*'|[^'">])*)>`, 'gi'))].map(tag => {
    const raw = tag[1]!, attributes = new Map<string, string>();
    const pattern = /\s+([A-Za-z_:][A-Za-z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gy;
    let offset = 0;
    while (raw.slice(offset).trim() && raw.slice(offset).trim() !== '/') {
      pattern.lastIndex = offset;
      const attribute = pattern.exec(raw);
      if (!attribute) return fail('Receita source has malformed marker attributes.');
      const key = attribute[1]!.toLowerCase();
      if (attributes.has(key)) return fail('Receita source has duplicate marker attributes.');
      attributes.set(key, attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
      offset = pattern.lastIndex;
    }
    return { attributes, contentAt: tag.index! + tag[0].length };
  });
}
function sourceContent(html: string, contentAt: number, name: 'h1' | 'div'): string {
  const rest = html.slice(contentAt), close = new RegExp(`</${name}\\s*>`, 'i').exec(rest);
  if (!close) return fail('Receita source marker has no closing tag.');
  return rest.slice(0, close.index);
}
function rate(lexeme: string): string {
  if (lexeme.length > 128 || !/^(?:0|[1-9]\d{0,63}),\d{1,64}$/.test(lexeme)) return fail('Receita source quote is not an exact positive Portuguese decimal.');
  const decimal = lexeme.replace(',', '.').replace(/0+$/, '').replace(/\.$/, '');
  if (!/[1-9]/.test(decimal)) return fail('Receita source quote must be positive.');
  return decimal;
}
/** Accept only the documented unspanned grid; do not flatten an altered HTML layout into quotes. */
function tableRows(group: string, expected: number): string[] {
  const rows = [...group.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)];
  if (rows.length !== expected || group.replace(/<tr>[\s\S]*?<\/tr>/gi, '').trim()) return fail('Receita source must retain its complete unmodified row structure.');
  return rows.map(row => row[1]!);
}
function tableCells(row: string, expectedKind: 'th' | 'td'): string[] {
  const cells = [...row.matchAll(/<(th|td)>([^<>]*)<\/\1>/gi)];
  if (cells.length !== 3 || cells.some(cell => cell[1]!.toLowerCase() !== expectedKind) || row.replace(/<(th|td)>([^<>]*)<\/\1>/gi, '').trim()) return fail('Receita source needs exactly three plain unspanned cells of the expected kind.');
  return cells.map(cell => contentText(cell[2]!));
}
/** Reconstruct both source columns; Compra is the sole selected work-income rate. */
export function receitaWorkRatesObservation(sourceHtml: string, request: ReceitaWorkRatesRequest): { observation: ReceitaWorkRatesObservation | null; issues: string[] } {
  const bytes = new TextEncoder().encode(sourceHtml);
  if (!sourceHtml || bytes.byteLength > RECEITA_WORK_RATES_MAX_BYTES || new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== sourceHtml || sourceHtml.includes('\0')) return fail('Receita source must be complete bounded UTF-8 HTML.');
  const html = sourceHtml.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '\0');
  const canonicalLinks = sourceTags(html, 'link').filter(tag => tag.attributes.get('rel') === 'canonical').map(tag => tag.attributes.get('href') ?? '');
  if (one(canonicalLinks, 'canonical source URL') !== request.source.requestUrl) return fail('Receita page does not match the requested table year or official URL.');
  const titles = sourceTags(html, 'h1').filter(tag => tag.attributes.get('class') === 'documentFirstHeading').map(tag => contentText(sourceContent(html, tag.contentAt, 'h1')));
  if (one(titles, 'table-year title') !== `Tabelas para conversão de dólar em ${request.receiptMonth.slice(0, 4)}`) return fail('Receita title does not bind the requested table year.');
  const bodies = sourceTags(html, 'div').filter(tag => tag.attributes.get('id') === 'parent-fieldname-text').map(tag => sourceContent(html, tag.contentAt, 'div'));
  const body = one(bodies, 'document content');
  const sections = [...body.matchAll(/<h2\b[^>]*>Rendimentos ou pagamentos em moeda estrangeira<\/h2>([\s\S]*?)(?=<h2\b|$)/gi)].map(m => m[1]!);
  const section = one(sections, 'foreign-income section');
  const text = contentText(section);
  if (!text.includes('Os rendimentos ou pagamentos em moeda estrangeira devem ser convertidos em dólares dos Estados Unidos da América, pelo valor fixado pela autoridade monetária do país de origem dos rendimentos, na data do recebimento ou pagamento e, em seguida, em reais, mediante a utilização do valor do dólar fixado pelo Banco Central do Brasil para o último dia útil da primeira quinzena do mês anterior ao do recebimento ou pagamento.') || !text.includes('Para os rendimentos e o imposto pago, deve ser utilizada a cotação de compra.')) return fail('Receita source lacks its work-income currency, timing and Compra rule.');
  const table = one([...section.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(m => m[1]!), 'monthly table');
  const grid = /^\s*<thead>\s*([\s\S]*?)\s*<\/thead>\s*<tbody>\s*([\s\S]*?)\s*<\/tbody>\s*$/i.exec(table);
  if (!grid) return fail('Receita source requires one plain header group followed by one plain monthly body.');
  const header = tableCells(tableRows(grid[1]!, 1)[0]!, 'th');
  if (receitaWorkRatesCanonical(header) !== receitaWorkRatesCanonical(['Mês', 'Compra', 'Venda'])) return fail('Receita source column identities are missing or reversed.');
  let observation: ReceitaWorkRatesObservation | null = null;
  tableRows(grid[2]!, 12).forEach((row, index) => {
    const cells = tableCells(row, 'td');
    if (cells.length !== 3 || cells[0] !== months[index]) return fail('Receita monthly rows must be unique, complete and ordered.');
    const buy = cells[1]!, sell = cells[2]!;
    if (!buy && !sell) return;
    if (!buy || !sell) return fail('Receita monthly source has only one numeric column.');
    const exact = rate(buy); rate(sell);
    if (request.receiptMonth.slice(5) === String(index + 1).padStart(2, '0')) observation = { receiptMonth: request.receiptMonth, currency: 'USD', quoteCurrency: 'BRL', side: 'compra', buy: exact, buySourceLexeme: buy, sellSourceLexeme: sell, sourceMonthLabel: cells[0]! };
  });
  return { observation, issues: observation ? [] : ['receita_work_rate_missing_for_receipt_month'] };
}
/** Snapshot and rederive metadata and every table-derived value before asynchronous hashing. */
export function receitaWorkRatesReplay(value: unknown, receiptMonth: string, now: Date): ReceitaWorkRatesEvidence {
  const checkedAt = now.getTime(); if (!Number.isFinite(checkedAt)) return fail('Receita evidence requires a valid evaluation time.');
  const evidence = receitaWorkRatesRecord(receitaWorkRatesSnapshot(value)), canonical = receitaWorkRatesRequest(receiptMonth);
  receitaWorkRatesFields(evidence, ['format', 'request', 'fetchedAt', 'expiresAt', 'sourceHtml', 'sourceSha256', 'observation', 'issues']);
  const fetched = receitaWorkRatesTime(evidence.fetchedAt), expires = receitaWorkRatesTime(evidence.expiresAt);
  if (evidence.format !== format || receitaWorkRatesCanonical(evidence.request) !== receitaWorkRatesCanonical(canonical) || fetched > checkedAt || expires !== fetched + RECEITA_WORK_RATES_TTL_MS || typeof evidence.sourceHtml !== 'string' || typeof evidence.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.sourceSha256)) return fail('Receita evidence source, request or fetch metadata is invalid.');
  const replayed = receitaWorkRatesObservation(evidence.sourceHtml, canonical);
  if (receitaWorkRatesCanonical(evidence.observation) !== receitaWorkRatesCanonical(replayed.observation) || receitaWorkRatesCanonical(evidence.issues) !== receitaWorkRatesCanonical(replayed.issues)) return fail('Receita derived evidence differs from the retained source table.');
  return evidence as unknown as ReceitaWorkRatesEvidence;
}
export function receitaWorkRatesResponse(request: ReceitaWorkRatesRequest, now: Date, revision?: ReceitaWorkRatesRevision, expired = false): ReceitaWorkRatesResponse {
  const evidence = revision?.evidence;
  return { request, requestedAt: now.toISOString(), status: !evidence ? 'unavailable' : evidence.observation ? 'available' : 'missing', revisionId: revision?.revisionId ?? null,
    fetchedAt: evidence?.fetchedAt ?? null, expiresAt: evidence?.expiresAt ?? null, stale: !evidence || expired || Date.parse(evidence.expiresAt) <= now.getTime(),
    observation: evidence?.observation ?? null, issues: [...(evidence?.issues ?? []), ...(!evidence || expired ? ['receita_work_rate_refresh_unavailable'] : [])] };
}
