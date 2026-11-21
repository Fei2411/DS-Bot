// Parse an exported cookie file into normalized cookie objects. Node built-ins only; no values
// ever go into skipped/warning entries or logs (an exported file is a sign-in credential).
//
// parseCookieFile(bufferOrString, opts) detects the format from the CONTENT (not the file name):
//   netscape       cookies.txt: 7 tab-separated fields, '#HttpOnly_' prefix, '# Netscape HTTP Cookie File' header
//                  (curl / wget / yt-dlp / "Get cookies.txt" / Cookie-Editor "Netscape" export)
//   cookie-editor  JSON array of browser-extension cookie objects (Cookie-Editor, EditThisCookie, raw chrome.cookies
//                  objects). The same parser tolerates Selenium arrays (`expiry`) and CDP / Puppeteer arrays (`expires`).
//   playwright     Playwright storageState JSON: { cookies: [...], origins: [...] }
// and returns
//   { ok, format, flavor, error, encoding, bom, lineEndings, entries, cookies: CookieParam[], skipped, warnings, info }
//
// CookieParam = { name, value, domain, path, secure, httpOnly, sameSite?: 'Strict'|'Lax'|'None', expires?: seconds,
//                 partitionKey?: { topLevelSite, hasCrossSiteAncestor } }
//   - domain: host without a dot = host-only cookie; '.host' = domain cookie (also sent to subdomains).
//   - expires is omitted for session cookies (CDP treats expires 0 as 1970-01-01, i.e. already expired).
// `skipped` / `warnings` entries carry { where, name, domain, path, code, reason|message } only — never cookie values.

import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';

export const FORMATS = ['netscape', 'cookie-editor', 'playwright', 'curl', 'header-string'];

const CTL_ANY = /[\x00-\x1f\x7f]/;
const CTL_EXCEPT_TAB = /[\x00-\x08\x0a-\x1f\x7f]/;
const MAX_NAME_VALUE_BYTES = 4096; // Chrome limit for name + value
const MAX_ATTR_BYTES = 1024;       // Chrome limit for an attribute value (path, domain)
const DAY = 86400;
const CHROME_MAX_AGE_DAYS = 400;   // Chrome stores at most 400 days of lifetime
const WEBKIT_EPOCH_OFFSET = 11644473600; // seconds between 1601-01-01 and 1970-01-01

// ------------------------------------------------------------------ decoding

/** Buffer | string → { text, encoding, bom }. Handles UTF-8 BOM, UTF-16 LE/BE (with or without BOM). */
export function decodeInput(input) {
  if (typeof input === 'string') {
    const bom = input.charCodeAt(0) === 0xfeff;
    return { text: bom ? input.slice(1) : input, encoding: 'string', bom };
  }
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8', bom: true };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf-16le', bom: true };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: swap16(buf.subarray(2)).toString('utf16le'), encoding: 'utf-16be', bom: true };
  }
  // UTF-16 without BOM: ASCII text has a zero in every second byte.
  if (buf.length >= 4 && buf[0] !== 0 && buf[1] === 0 && buf[2] !== 0 && buf[3] === 0) {
    return { text: buf.toString('utf16le'), encoding: 'utf-16le', bom: false };
  }
  if (buf.length >= 4 && buf[0] === 0 && buf[1] !== 0 && buf[2] === 0 && buf[3] !== 0) {
    return { text: swap16(buf).toString('utf16le'), encoding: 'utf-16be', bom: false };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8', bom: false };
  } catch {
    return { text: buf.toString('latin1'), encoding: 'latin1 (not valid UTF-8)', bom: false };
  }
}

function swap16(buf) {
  const out = Buffer.alloc(buf.length - (buf.length % 2));
  for (let i = 0; i + 1 < buf.length; i += 2) { out[i] = buf[i + 1]; out[i + 1] = buf[i]; }
  return out;
}

function lineEndingsOf(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  const cr = (text.match(/\r(?!\n)/g) || []).length;
  const kinds = [crlf && 'CRLF', lf && 'LF', cr && 'CR'].filter(Boolean);
  return kinds.length === 0 ? 'none' : kinds.length === 1 ? kinds[0] : `mixed (${kinds.join('+')})`;
}

// ------------------------------------------------------------------ detection

function validHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function normalizeDefaultUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const direct = validHttpUrl(trimmed);
  if (direct) return direct;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/\s/.test(trimmed) && (trimmed.includes('.') || /^localhost(?::\d+)?(?:\/|$)/i.test(trimmed))) {
    return validHttpUrl(`https://${trimmed}`);
  }
  return null;
}

/** → { format, flavor?, data?, error? }. format: one of FORMATS, or 'invalid-json' | 'unknown-json' | 'empty' | 'unknown'. */
export function detectFormat(text, opts = {}) {
  const t = text.replace(/^\uFEFF/, '').trim();
  if (!t) return { format: 'empty', error: 'the file is empty' };
  if (t[0] === '[' || t[0] === '{') {
    let data;
    try { data = JSON.parse(t); } catch (e) { return { format: 'invalid-json', error: `not valid JSON: ${e.message}` }; }
    if (Array.isArray(data)) return { format: 'cookie-editor', flavor: jsonFlavor(data), data };
    if (data && typeof data === 'object' && Array.isArray(data.cookies)) return { format: 'playwright', flavor: 'origins' in data ? 'storageState' : 'object with cookies', data };
    return { format: 'unknown-json', error: 'JSON, but neither an array of cookies nor an object with a "cookies" array' };
  }
  if (/^curl(?:\.exe)?\s+/i.test(t)) return { format: 'curl', flavor: 'devtools' };
  const lines = t.split(/\r\n|\n|\r/);
  if (/^#\s*(netscape\s+)?http\s+cookie\s+file/i.test(lines[0].trim())) return { format: 'netscape', flavor: 'header' };
  if (lines.some((l) => /^#HttpOnly_/i.test(l) || (!l.trimStart().startsWith('#') && l.split('\t').length >= 6))) {
    return { format: 'netscape', flavor: 'no header' };
  }
  const one = t.replace(/^cookie:\s*/i, '');
  if (!one.includes('\n') && /^[^=;\s]+=[^;]*(;\s*[^=;\s]+=[^;]*)*;?$/.test(one)) {
    if (normalizeDefaultUrl(opts.defaultUrl)) return { format: 'header-string', flavor: 'url-scoped', header: one };
    return { format: 'header-string', error: 'a Cookie header string ("a=1; b=2") has no domain, path or flags; it needs the site URL to import' };
  }
  return { format: 'unknown', error: 'not a known cookie export format (Netscape cookies.txt, JSON cookie array, Playwright storageState, cURL)' };
}

function jsonFlavor(arr) {
  const objs = arr.filter((x) => x && typeof x === 'object' && !Array.isArray(x)).slice(0, 50);
  const has = (k) => objs.some((o) => k in o);
  if (has('hostOnly') || has('storeId') || has('expirationDate')) return 'browser-extension';
  if (has('expiry')) return 'selenium';
  if (has('expires') && (has('size') || has('priority') || has('session'))) return 'cdp';
  return 'generic';
}

// ------------------------------------------------------------------ entry point

/** Detect the format from the content and parse. opts: { now (seconds), sameSiteNoneInsecure: 'drop-samesite'|'skip'|'keep', defaultUrl?: string } */
export function parseCookieFile(input, opts = {}) {
  const dec = decodeInput(input);
  const det = detectFormat(dec.text, opts);
  let res;
  if (det.format === 'netscape') res = parseNetscape(dec.text, opts);
  else if (det.format === 'cookie-editor') res = parseCookieEditor(det.data, opts);
  else if (det.format === 'playwright') res = parsePlaywright(det.data, opts);
  else if (det.format === 'curl') res = parseCurl(dec.text, opts);
  else if (det.format === 'header-string' && !det.error) res = parseHeaderString(det.header, opts.defaultUrl, opts);
  else res = finish(newCtx(det.format, opts), det.error);
  res.flavor = det.flavor ?? null;
  res.encoding = dec.encoding;
  res.bom = dec.bom;
  res.lineEndings = lineEndingsOf(dec.text);
  if (dec.encoding.startsWith('latin1')) res.warnings.unshift({ where: 'file', code: 'not-utf8', message: 'the file is not valid UTF-8; read as Latin-1' });
  return res;
}

// ------------------------------------------------------------------ Netscape cookies.txt

export function parseNetscape(text, opts = {}) {
  const ctx = newCtx('netscape', opts);
  ctx.info.commentLines = 0;
  ctx.info.blankLines = 0;
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  lines.forEach((rawLine, i) => {
    const where = `line ${i + 1}`;
    let line = rawLine;
    if (!line.trim()) { ctx.info.blankLines++; return; }
    let httpOnly = false;
    const m = line.match(/^\s*#HttpOnly_/i);
    if (m) { httpOnly = true; line = line.slice(m[0].length); } else if (line.trimStart().startsWith('#')) { ctx.info.commentLines++; return; }

    ctx.buffer = []; // warnings of this line; dropped if the line is skipped
    let fields = line.split('\t');
    if (fields.length < 6) {
      // Tabs turned into spaces (copy-paste): accept only if the fixed columns still look right.
      const ws = line.trim().split(/\s+/);
      const looksLikeCookie = (ws.length === 7 || ws.length === 6) && toBool(ws[1]) !== undefined && toBool(ws[3]) !== undefined && /^-?\d+(\.\d+)?$/.test(ws[4]);
      if (looksLikeCookie) {
        fields = ws;
        warn(ctx, where, { name: ws[5], domain: ws[0] }, 'spaces-not-tabs', 'fields are separated by spaces, not tabs (copy-paste?); read them anyway');
      } else {
        ctx.buffer = null;
        ctx.entries++;
        skip(ctx, where, {}, 'field-count', `expected 7 tab-separated fields, found ${fields.length}`);
        return;
      }
    }
    const [domainF, flagF, pathF, secureF, expiryF, nameF] = fields;
    let value = '';
    if (fields.length >= 7) value = fields.slice(6).join('\t');
    const raw = { name: nameF, value, domain: domainF.trim(), path: pathF.trim(), httpOnly };
    if (fields.length === 6) warn(ctx, where, raw, 'missing-value', 'no value field; using an empty value');
    if (fields.length > 7) warn(ctx, where, raw, 'tab-in-value', 'more than 7 fields; the extra fields were joined into the value');

    const flag = toBool(flagF);
    if (flag === undefined) warn(ctx, where, raw, 'bad-subdomain-flag', `include-subdomains flag "${clip(flagF)}" is not TRUE/FALSE; using the leading dot of the domain`);
    else raw.includeSubdomains = flag;
    const secure = toBool(secureF);
    if (secure === undefined) warn(ctx, where, raw, 'bad-secure', `secure flag "${clip(secureF)}" is not TRUE/FALSE; using FALSE`);
    raw.secure = secure ?? false;
    raw.expires = expiryF.trim();
    raw.expiresField = 'expiry';
    addCookie(ctx, where, raw);
  });
  return finish(ctx);
}

// ------------------------------------------------------------------ JSON cookie array (Cookie-Editor & co.)

export function parseCookieEditor(input, opts = {}) {
  const ctx = newCtx('cookie-editor', opts);
  let data = input;
  if (typeof input === 'string') {
    try { data = JSON.parse(input.replace(/^\uFEFF/, '')); } catch (e) { return finish(ctx, `not valid JSON: ${e.message}`); }
  }
  if (!Array.isArray(data)) return finish(ctx, 'expected a JSON array of cookie objects');
  const storeIds = new Set();
  data.forEach((e, i) => {
    const where = `entry ${i + 1}`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) { ctx.entries++; skip(ctx, where, {}, 'not-object', 'entry is not an object'); return; }
    if (e.storeId != null) storeIds.add(String(e.storeId));
    ctx.buffer = [];
    if (e.firstPartyDomain) warn(ctx, where, e, 'first-party-domain', 'Firefox first-party-isolation domain ignored');
    addCookie(ctx, where, rawFromObject(e));
  });
  if (storeIds.size > 1) {
    ctx.warnings.push({ where: 'file', code: 'mixed-stores', message: `cookies from ${storeIds.size} cookie stores are mixed (storeId ${[...storeIds].join(', ')}: e.g. normal + incognito windows or containers)` });
  }
  ctx.info.storeIds = [...storeIds];
  return finish(ctx);
}

// ------------------------------------------------------------------ Playwright storageState

export function parsePlaywright(input, opts = {}) {
  const ctx = newCtx('playwright', opts);
  let data = input;
  if (typeof input === 'string') {
    try { data = JSON.parse(input.replace(/^\uFEFF/, '')); } catch (e) { return finish(ctx, `not valid JSON: ${e.message}`); }
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.cookies)) return finish(ctx, 'expected an object with a "cookies" array');
  data.cookies.forEach((c, i) => {
    const where = `entry ${i + 1}`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) { ctx.entries++; skip(ctx, where, {}, 'not-object', 'entry is not an object'); return; }
    const raw = rawFromObject(c);
    // Playwright writes partitionKey as the top-level site string plus a non-standard _crHasCrossSiteAncestor.
    if (typeof c.partitionKey === 'string') raw.partitionKey = { topLevelSite: c.partitionKey, hasCrossSiteAncestor: c._crHasCrossSiteAncestor ?? true };
    addCookie(ctx, where, raw);
  });
  const origins = Array.isArray(data.origins) ? data.origins : [];
  const parsedOrigins = [];
  for (const o of origins) {
    const parsedUrl = validHttpUrl(o?.origin);
    if (!parsedUrl || !Array.isArray(o?.localStorage)) continue;
    const localStorage = [];
    for (const item of o.localStorage) {
      if (item && typeof item.name === 'string' && typeof item.value === 'string') {
        localStorage.push({ name: item.name, value: item.value });
      }
    }
    if (localStorage.length > 0) parsedOrigins.push({ origin: parsedUrl.origin, localStorage });
  }
  ctx.origins = parsedOrigins;
  ctx.info.origins = origins.length;
  ctx.info.localStorageOrigins = parsedOrigins.map((o) => ({ origin: o.origin, entries: o.localStorage.length }));
  return finish(ctx);
}

// ------------------------------------------------------------------ cURL & Cookie header string

function tokenizeCurl(text) {
  // Collapse bash (`\` + newline) and cmd (`^` + newline) line continuations.
  const joined = String(text).replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ');
  const tokens = [];
  let i = 0;
  while (i < joined.length) {
    while (i < joined.length && /\s/.test(joined[i])) i++;
    if (i >= joined.length) break;
    let tok = '';
    while (i < joined.length && !/\s/.test(joined[i])) {
      const ch = joined[i];
      if (ch === '$' && joined[i + 1] === "'") {
        i += 2;
        while (i < joined.length && joined[i] !== "'") {
          if (joined[i] === '\\' && i + 1 < joined.length) { tok += joined[i + 1]; i += 2; }
          else { tok += joined[i++]; }
        }
        if (joined[i] === "'") i++;
      } else if (ch === "'") {
        i++;
        while (i < joined.length && joined[i] !== "'") tok += joined[i++];
        if (joined[i] === "'") i++;
      } else if (ch === '^' && joined[i + 1] === '"') {
        // Chrome DevTools "Copy as cURL (cmd)" wraps arguments in ^"…^".
        i += 2;
        while (i < joined.length) {
          if (joined[i] === '^' && joined[i + 1] === '"') { i += 2; break; }
          if (joined[i] === '\\' && joined[i + 1] === '^' && joined[i + 2] === '"') { tok += '"'; i += 3; }
          else if (joined[i] === '^' && i + 1 < joined.length) { tok += joined[i + 1]; i += 2; }
          else { tok += joined[i++]; }
        }
      } else if (ch === '"') {
        i++;
        while (i < joined.length && joined[i] !== '"') {
          if (joined[i] === '\\' && i + 1 < joined.length) { tok += joined[i + 1]; i += 2; }
          else if (joined[i] === '^' && i + 1 < joined.length && /["^%&|<>]/.test(joined[i + 1])) { tok += joined[i + 1]; i += 2; }
          else { tok += joined[i++]; }
        }
        if (joined[i] === '"') i++;
      } else if (ch === '\\' && i + 1 < joined.length) {
        tok += joined[i + 1]; i += 2;
      } else if (ch === '^' && i + 1 < joined.length) {
        tok += joined[i + 1]; i += 2;
      } else {
        tok += ch; i++;
      }
    }
    if (tok) tokens.push(tok);
  }
  return tokens;
}

function addHeaderCookies(ctx, headerValue, targetUrl) {
  const secure = targetUrl.protocol === 'https:';
  const parts = String(headerValue).split(';');
  parts.forEach((part, index) => {
    const trimmed = part.trim();
    if (!trimmed) return;
    const eq = trimmed.indexOf('=');
    const where = `cookie ${index + 1}`;
    if (eq === -1) { ctx.entries++; skip(ctx, where, {}, 'bad-pair', 'missing "=" in Cookie pair'); return; }
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    // Scope pasted request cookies to "/" on the target host rather than an API endpoint subpath.
    addCookie(ctx, where, {
      name, value, domain: targetUrl.hostname, path: '/', secure, httpOnly: false,
      hasField: (k) => k === 'secure' || k === 'httpOnly',
    });
  });
}

const CURL_VALUE_FLAGS = new Set([
  '-X', '--request', '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--json',
  '-e', '--referer', '-A', '--user-agent', '-u', '--user', '-F', '--form', '-o', '--output', '-m', '--max-time',
  '--connect-timeout', '-x', '--proxy', '-U', '--proxy-user', '-c', '--cookie-jar', '-w', '--write-out',
]);

export function parseCurl(text, opts = {}) {
  const ctx = newCtx('curl', opts);
  const tokens = tokenizeCurl(text);
  let targetUrl = null;
  const cookieHeaders = [];
  const pushHeader = (header) => {
    const m = String(header).match(/^cookie\s*:\s*(.*)$/i);
    if (m && m[1].trim()) cookieHeaders.push(m[1].trim());
  };
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if ((t === '-H' || t === '--header') && i + 1 < tokens.length) {
      pushHeader(tokens[++i]);
    } else if (t.startsWith('--header=')) {
      pushHeader(t.slice('--header='.length));
    } else if (t.startsWith('-H') && t.length > 2) {
      pushHeader(t.slice(2));
    } else if ((t === '-b' || t === '--cookie') && i + 1 < tokens.length) {
      const val = tokens[++i].trim();
      if (val.includes('=')) cookieHeaders.push(val);
    } else if (t.startsWith('--cookie=')) {
      const val = t.slice('--cookie='.length).trim();
      if (val.includes('=')) cookieHeaders.push(val);
    } else if (t.startsWith('-b') && t.length > 2) {
      const val = t.slice(2).trim();
      if (val.includes('=')) cookieHeaders.push(val);
    } else if (t === '--url' && i + 1 < tokens.length) {
      const u = validHttpUrl(tokens[++i]);
      if (u && !targetUrl) targetUrl = u;
    } else if (t.startsWith('--url=')) {
      const u = validHttpUrl(t.slice('--url='.length));
      if (u && !targetUrl) targetUrl = u;
    } else if (CURL_VALUE_FLAGS.has(t)) {
      i++;
    } else if (!t.startsWith('-') && !targetUrl) {
      const u = validHttpUrl(t);
      if (u) targetUrl = u;
    }
  }
  if (!targetUrl) targetUrl = normalizeDefaultUrl(opts.defaultUrl);
  if (!targetUrl) return finish(ctx, 'cURL command contains no http(s) URL');
  if (cookieHeaders.length === 0) return finish(ctx, 'cURL command contains no Cookie header (-H "cookie: ..." or -b "...")');
  for (const h of cookieHeaders) addHeaderCookies(ctx, h, targetUrl);
  return finish(ctx);
}

export function parseHeaderString(header, defaultUrl, opts = {}) {
  const ctx = newCtx('header-string', opts);
  const targetUrl = normalizeDefaultUrl(defaultUrl);
  if (!targetUrl) return finish(ctx, 'a Cookie header string ("a=1; b=2") has no domain, path or flags; it needs the site URL to import');
  addHeaderCookies(ctx, header, targetUrl);
  return finish(ctx);
}

// ------------------------------------------------------------------ shared normalization

/** One JSON cookie object (any of the known spellings) → raw fields for normalizeCookie(). */
function rawFromObject(e) {
  // Cookie-Editor / chrome.cookies: expirationDate (s); CDP / Puppeteer / Playwright: expires (s, -1 = session); Selenium: expiry (s)
  let expires; let expiresField;
  for (const k of ['expirationDate', 'expires', 'expiry']) {
    if (e[k] !== undefined && e[k] !== null && e[k] !== '') { expires = e[k]; expiresField = k; break; }
  }
  return {
    name: e.name, value: e.value, domain: e.domain, url: e.url,
    hostOnly: typeof e.hostOnly === 'boolean' ? e.hostOnly : undefined,
    path: e.path, secure: e.secure, httpOnly: e.httpOnly, sameSite: e.sameSite,
    session: typeof e.session === 'boolean' ? e.session : undefined,
    expires, expiresField, partitionKey: e.partitionKey,
    hasField: (k) => k in e,
  };
}

function newCtx(format, opts) {
  return {
    format,
    now: opts.now ?? Date.now() / 1000,
    sameSiteNoneInsecure: opts.sameSiteNoneInsecure ?? 'drop-samesite',
    entries: 0,
    items: [],
    origins: [],
    skipped: [],
    warnings: [],
    info: {},
  };
}

function finish(ctx, error = null) {
  // Duplicates (same name + domain + path) would overwrite each other in Chrome: keep the last one.
  const byKey = new Map();
  ctx.items.forEach((it, idx) => {
    it.idx = idx;
    const k = `${it.cookie.name}\u0000${it.cookie.domain}\u0000${it.cookie.path}`;
    if (byKey.has(k)) {
      warn(ctx, it.where, it.cookie, 'duplicate', `same name/domain/path as ${byKey.get(k).where}; the later entry is used`);
    }
    byKey.set(k, it);
  });
  const kept = [...byKey.values()].sort((a, b) => a.idx - b.idx);
  return {
    ok: !error,
    format: ctx.format,
    error,
    entries: ctx.entries,
    cookies: kept.map((it) => it.cookie),
    origins: ctx.origins,
    where: kept.map((it) => it.where),
    skipped: ctx.skipped,
    warnings: ctx.warnings,
    info: ctx.info,
  };
}

function warn(ctx, where, raw, code, message) {
  // While an entry is being read, warnings go to ctx.buffer and are kept only if the entry is imported.
  (ctx.buffer || ctx.warnings).push({ where, name: strOrNull(raw?.name), domain: strOrNull(raw?.domain), code, message });
}

function skip(ctx, where, raw, code, reason) {
  ctx.skipped.push({ where, name: strOrNull(raw?.name), domain: strOrNull(raw?.domain), path: strOrNull(raw?.path), code, reason });
}

function addCookie(ctx, where, raw) {
  ctx.entries++;
  if (!ctx.buffer) ctx.buffer = [];
  const r = normalizeCookie(raw, ctx, where);
  const buffered = ctx.buffer;
  ctx.buffer = null;
  if (r.skip) skip(ctx, where, raw, r.skip[0], r.skip[1]);
  else { ctx.items.push({ where, cookie: r.cookie }); ctx.warnings.push(...buffered); }
}

function normalizeCookie(raw, ctx, where) {
  const W = (code, msg) => warn(ctx, where, raw, code, msg);
  const missing = (k) => (raw.hasField ? !raw.hasField(k) : false);

  // --- name / value (Chrome rejects the WHOLE Storage.setCookies call if one cookie is invalid)
  if (typeof raw.name !== 'string') return { skip: ['bad-name', 'name is missing or not a string'] };
  let name = raw.name;
  if (name !== name.trim()) { name = name.trim(); W('trimmed-name', 'whitespace around the name was removed'); }
  let value = raw.value;
  if (value === undefined || value === null) { value = ''; W('missing-value', 'no value; using an empty value'); } else if (typeof value === 'number' || typeof value === 'boolean') { value = String(value); W('value-not-string', 'value was not a string; converted'); } else if (typeof value !== 'string') return { skip: ['bad-value', 'value is not a string'] };
  if (value !== value.trim()) { value = value.trim(); W('trimmed-value', 'whitespace around the value was removed (Chrome rejects it)'); }
  if (!name && !value) return { skip: ['empty', 'name and value are both empty'] };
  if (/[;=]/.test(name) || CTL_ANY.test(name)) return { skip: ['bad-char-name', 'name contains ";", "=" or a control character (Chrome would reject the whole import call)'] };
  if (value.includes(';') || CTL_EXCEPT_TAB.test(value)) return { skip: ['bad-char-value', 'value contains ";" or a control character (Chrome would reject the whole import call)'] };
  if (Buffer.byteLength(name) + Buffer.byteLength(value) > MAX_NAME_VALUE_BYTES) return { skip: ['too-long', 'name + value is longer than 4096 bytes'] };

  // --- domain and host-only / domain cookie
  let rawDomain = typeof raw.domain === 'string' ? raw.domain.trim() : '';
  let url = null;
  if (!rawDomain && typeof raw.url === 'string' && raw.url) {
    try { url = new URL(raw.url); } catch { url = null; }
    if (!url || !/^https?:$/.test(url.protocol)) return { skip: ['bad-url', 'url is not an http(s) URL'] };
    rawDomain = url.hostname;
  }
  if (!rawDomain) return { skip: ['missing-domain', 'domain is missing'] };
  const dotted = rawDomain.startsWith('.');
  let host = rawDomain.replace(/^\.+/, '').toLowerCase();
  if (!host) return { skip: ['bad-domain', 'domain is only dots'] };
  const ipv6 = /^\[[0-9a-f:.]+\]$/.test(host) && isIP(host.slice(1, -1)) === 6;
  if (!ipv6) {
    const ascii = domainToASCII(host);
    if (!ascii || !/^[a-z0-9._-]+$/.test(ascii) || Buffer.byteLength(ascii) > MAX_ATTR_BYTES) return { skip: ['bad-domain', `"${clip(host)}" is not a valid host name`] };
    if (ascii !== host) W('punycode', `domain converted to ASCII (${ascii})`);
    host = ascii;
  }
  const ip = ipv6 || isIP(host) !== 0;
  // Domain cookie (also sent to subdomains) if ANY signal says so; host-only only if none does.
  const domainSignals = [dotted && 'leading dot', raw.includeSubdomains === true && 'include-subdomains TRUE', raw.hostOnly === false && 'hostOnly false'].filter(Boolean);
  const hostSignals = [raw.includeSubdomains === false && 'include-subdomains FALSE', raw.hostOnly === true && 'hostOnly true'].filter(Boolean);
  let domainCookie = domainSignals.length > 0;
  if (domainCookie && hostSignals.length && !ip) {
    W('domain-conflict', `${domainSignals.join(' + ')} but ${hostSignals.join(' + ')}: imported as a domain cookie (sent to subdomains too)`);
  }
  if (domainCookie && ip) domainCookie = false; // an IP address has no subdomains; Chrome stores it host-only anyway
  if (domainCookie && !host.includes('.')) return { skip: ['domain-tld', `domain cookie for the top-level name ".${host}" (Chrome would keep it only for the host "${host}"; no site can use it)`] };
  const domain = domainCookie ? `.${host}` : host;

  // --- path
  let path = raw.path;
  if (url && (path === undefined || path === null || path === '')) path = defaultPath(url.pathname);
  if (path === undefined || path === null || path === '') { path = '/'; W('missing-path', 'no path; using "/"'); } else if (typeof path !== 'string') return { skip: ['bad-path', 'path is not a string'] };
  path = path.trim();
  if (!path.startsWith('/')) { W('relative-path', `path "${clip(path)}" does not start with "/"; using "/"`); path = '/'; }
  if (path.includes(';') || CTL_ANY.test(path)) return { skip: ['bad-char-path', 'path contains ";" or a control character'] };
  if (Buffer.byteLength(path) > MAX_ATTR_BYTES) return { skip: ['too-long-path', 'path is longer than 1024 bytes'] };

  // --- flags
  let secure = toBool(raw.secure);
  if (secure === undefined) {
    if (url) secure = url.protocol === 'https:';
    else { if (raw.secure !== undefined && raw.secure !== null) W('bad-secure', `secure "${clip(String(raw.secure))}" is not a boolean; using false`); else if (missing('secure')) W('missing-field', 'no "secure" field; using false'); secure = false; }
  }
  let httpOnly = toBool(raw.httpOnly);
  if (httpOnly === undefined) {
    if (raw.httpOnly !== undefined && raw.httpOnly !== null) W('bad-httponly', `httpOnly "${clip(String(raw.httpOnly))}" is not a boolean; using false`); else if (missing('httpOnly')) W('missing-field', 'no "httpOnly" field; using false');
    httpOnly = false;
  }
  const ss = normSameSite(raw.sameSite);
  if (!ss.known) W('bad-samesite', `unknown SameSite "${clip(String(raw.sameSite))}"; left unspecified`);
  let sameSite = ss.value;
  if (sameSite === 'None' && !secure) {
    if (ctx.sameSiteNoneInsecure === 'skip') return { skip: ['samesite-none-insecure', 'SameSite=None without Secure (Chrome refuses to store it)'] };
    if (ctx.sameSiteNoneInsecure === 'drop-samesite') { sameSite = undefined; W('samesite-none-insecure', 'SameSite=None without Secure: Chrome refuses to store it, so it was imported without SameSite (Chrome default: Lax)'); }
  }

  // --- cookie name prefixes (Chrome rejects violations, which fails the whole import call)
  const lname = name.toLowerCase();
  if (lname.startsWith('__secure-') && !secure) return { skip: ['prefix', '__Secure- cookie without Secure'] };
  if (lname.startsWith('__host-') && (!secure || domainCookie || path !== '/')) return { skip: ['prefix', '__Host- cookie needs Secure, host-only (no domain) and path "/"'] };
  if ((lname.startsWith('__http-') || lname.startsWith('__host-http-')) && (!secure || !httpOnly)) return { skip: ['prefix', '__Http- / __Host-Http- cookie needs Secure and HttpOnly'] };

  // --- expiry
  const ex = normExpiry(raw, W);
  if (ex.skip) return { skip: ex.skip };
  if (!ex.session && ex.expires <= ctx.now) return { skip: ['expired', `expired on ${isoDay(ex.expires)}`] };
  if (!ex.session && ex.expires > ctx.now + CHROME_MAX_AGE_DAYS * DAY) W('over-400-days', `expires ${isoDay(ex.expires)}; Chrome keeps at most 400 days`);

  // --- partition key (CHIPS)
  let partitionKey;
  if (raw.partitionKey !== undefined && raw.partitionKey !== null && raw.partitionKey !== '') {
    const pk = raw.partitionKey;
    if (pk && typeof pk === 'object' && typeof pk.topLevelSite === 'string' && pk.topLevelSite) {
      partitionKey = { topLevelSite: pk.topLevelSite, hasCrossSiteAncestor: !!pk.hasCrossSiteAncestor };
    } else if (typeof pk === 'string') {
      partitionKey = { topLevelSite: pk, hasCrossSiteAncestor: true };
    } else W('bad-partition-key', 'partitionKey not understood; imported unpartitioned');
    if (partitionKey && !secure) return { skip: ['partitioned-insecure', 'partitioned cookie without Secure'] };
  }

  const cookie = { name, value, domain, path, secure, httpOnly };
  if (sameSite) cookie.sameSite = sameSite;
  if (!ex.session) cookie.expires = ex.expires;
  if (partitionKey) cookie.partitionKey = partitionKey;
  return { cookie };
}

function normExpiry(raw, W) {
  const v = raw.expires;
  const present = !(v === undefined || v === null || v === '');
  if (raw.session === true) {
    if (present && Number(v) > 0) W('session-with-expiry', 'marked as a session cookie but also has an expiry; imported as a session cookie');
    return { session: true };
  }
  if (!present) {
    if (raw.session === false) W('no-expiry', 'session=false but no expiry; imported as a session cookie');
    return { session: true };
  }
  let n;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) n = Number(v.trim());
  else if (typeof v === 'string' && /\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v))) {
    n = Date.parse(v) / 1000;
    W('expiry-date-string', 'expiry was a date string; converted to seconds');
  } else return { skip: ['bad-expiry', `${raw.expiresField || 'expiry'} "${clip(String(v))}" is not a number or a date`] };
  if (!Number.isFinite(n)) return { skip: ['bad-expiry', `${raw.expiresField || 'expiry'} is not a finite number`] };
  if (n <= 0) return { session: true }; // Netscape 0, Playwright / CDP -1, some extension exports 0
  if (n >= 1e14) {
    n = n >= 1.1e16 ? n / 1e6 - WEBKIT_EPOCH_OFFSET : n / 1e6;
    W('expiry-microseconds', 'expiry looked like microseconds; converted to seconds');
  } else if (n >= 1e11) {
    n /= 1000;
    W('expiry-milliseconds', 'expiry looked like milliseconds; converted to seconds');
  }
  return { session: false, expires: n };
}

function normSameSite(v) {
  if (v === undefined || v === null || v === '') return { value: undefined, known: true };
  if (typeof v !== 'string') return { value: undefined, known: false };
  switch (v.trim().toLowerCase().replace(/[\s_-]/g, '')) {
    case 'strict': return { value: 'Strict', known: true };
    case 'lax': return { value: 'Lax', known: true };
    case 'none': case 'norestriction': return { value: 'None', known: true };
    case 'unspecified': case 'unset': case 'default': return { value: undefined, known: true };
    default: return { value: undefined, known: false };
  }
}

function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === 0) return v === 1;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
  }
  return undefined;
}

/** RFC 6265 default-path of a request path. */
function defaultPath(p) {
  if (!p || !p.startsWith('/')) return '/';
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

function strOrNull(x) { return typeof x === 'string' ? x : null; }
function clip(s, n = 40) { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n)}…` : s; }
function isoDay(sec) { try { return new Date(sec * 1000).toISOString().slice(0, 10); } catch { return String(sec); } }

// ------------------------------------------------------------------ helpers for reports (no values)

/** Value-free view of a CookieParam or a CDP Network.Cookie. */
export function describeCookie(c) {
  const d = { name: c.name, domain: c.domain ?? null, path: c.path ?? null };
  if (!c.domain && c.url) d.url = c.url;
  d.secure = !!c.secure;
  d.httpOnly = !!c.httpOnly;
  d.sameSite = c.sameSite ?? 'Unspecified';
  d.session = typeof c.session === 'boolean' ? c.session : !(typeof c.expires === 'number' && c.expires >= 0);
  if (typeof c.expires === 'number' && c.expires >= 0) d.expires = Math.round(c.expires * 1000) / 1000;
  for (const k of ['priority', 'sourceScheme', 'sourcePort', 'partitionKey', 'partitionKeyOpaque']) if (c[k] !== undefined) d[k] = c[k];
  return d;
}

/** Group cookies (and optional localStorage origins) by site for a user-facing summary. */
export function summarizeBySite(result) {
  const sites = new Map();
  const get = (domain) => {
    const site = String(domain || '(no domain)').replace(/^\./, '').toLowerCase();
    if (!sites.has(site)) sites.set(site, { site, cookies: 0, session: 0, httpOnly: 0, localStorage: 0, skipped: 0, skippedReasons: {} });
    return sites.get(site);
  };
  for (const c of result.cookies ?? []) {
    const s = get(c.domain);
    s.cookies++;
    if (c.expires === undefined) s.session++;
    if (c.httpOnly) s.httpOnly++;
  }
  for (const o of result.origins ?? []) {
    const parsed = validHttpUrl(o?.origin);
    if (!parsed || !Array.isArray(o?.localStorage) || o.localStorage.length === 0) continue;
    const s = get(parsed.hostname);
    s.localStorage += o.localStorage.length;
  }
  for (const k of result.skipped ?? []) {
    const site = String(k.domain || '').replace(/^\./, '').toLowerCase();
    const s = site ? sites.get(site) : undefined;
    if (!s) continue;
    s.skipped++;
    s.skippedReasons[k.code] = (s.skippedReasons[k.code] || 0) + 1;
  }
  return [...sites.values()].sort((a, b) => (b.cookies + b.localStorage) - (a.cookies + a.localStorage) || a.site.localeCompare(b.site));
}
