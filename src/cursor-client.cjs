const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ceilPercent, formatUsdFromCents } = require('./usage-format.cjs');
const {
  CURSOR_SAFE_PREFIX,
  decryptCursorAuthValue,
  looksLikeJwt,
  unwrapStoredValue
} = require('./cursor-auth-decrypt.cjs');

const USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const USAGE_SUMMARY_URL = 'https://cursor.com/api/usage-summary';
const MIN_REFRESH_MS = 60_000;
const AUTO_REFRESH_MS = 5 * 60_000;

class CursorUsageClient {
  constructor({
    stateDb = resolveStateDbPath(),
    timeoutMs = 15_000,
    cacheFile = null,
    minRefreshMs = MIN_REFRESH_MS
  } = {}) {
    this.stateDb = stateDb;
    this.timeoutMs = timeoutMs;
    this.cacheFile = cacheFile;
    this.minRefreshMs = minRefreshMs;
    this.lastFetchAt = 0;
    this.lastPayload = null;
  }

  async readUsage({ force = false } = {}) {
    if (!force && this.lastPayload && Date.now() - this.lastFetchAt < this.minRefreshMs) {
      return this.lastPayload;
    }
    const token = readAccessToken(this.stateDb);
    if (!token) {
      throw tokenReadError(this.stateDb);
    }

    let raw;
    try {
      raw = await requestCurrentPeriodUsage(token, this.timeoutMs);
    } catch (error) {
      const summary = await requestUsageSummary(token, this.timeoutMs).catch(() => null);
      if (summary) raw = summary;
      else throw error;
    }

    this.lastFetchAt = Date.now();
    this.lastPayload = {
      ...raw,
      accountEmail: readStateValue(this.stateDb, 'cursorAuth/cachedEmail'),
      planType: readStateValue(this.stateDb, 'cursorAuth/stripeMembershipType')
    };
    if (this.cacheFile) writeCache(this.cacheFile, this.lastPayload);
    return this.lastPayload;
  }
}

function resolveStateDbPath() {
  if (process.env.CURSOR_STATE_DB) return process.env.CURSOR_STATE_DB;
  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.APPDATA || '', 'Cursor', 'User', 'globalStorage', 'state.vscdb')]
    : process.platform === 'darwin'
      ? [path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')]
      : [
        path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
        path.join(home, '.config', 'cursor', 'User', 'globalStorage', 'state.vscdb')
      ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || candidates[0];
}

function readStateValue(stateDb, key) {
  if (!stateDb || !fs.existsSync(stateDb)) return '';
  const db = new DatabaseSync(`file:${stateDb}?mode=ro`, { open: true });
  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
    if (!row?.value) return '';
    return unwrapStoredValue(String(row.value));
  } finally {
    db.close();
  }
}

function readAccessToken(stateDb) {
  if (!stateDb || !fs.existsSync(stateDb)) return '';
  const raw = readStateValue(stateDb, 'cursorAuth/accessToken');
  if (!raw) return '';
  const token = decryptCursorAuthValue(raw, stateDb);
  return looksLikeJwt(token) ? token : '';
}

function tokenReadError(stateDb) {
  if (!stateDb || !fs.existsSync(stateDb)) {
    return new Error(
      `Cursor sign-in data not found at ${stateDb || resolveStateDbPath()}. Install the Cursor desktop app and sign in.`
    );
  }
  const raw = readStateValue(stateDb, 'cursorAuth/accessToken');
  if (!raw) {
    return new Error('Sign in to the Cursor desktop app on this profile');
  }
  if (raw.startsWith(CURSOR_SAFE_PREFIX)) {
    return new Error(
      'Could not decrypt Cursor credentials — run this widget as the same Windows user that uses Cursor'
    );
  }
  return new Error('Sign in to the Cursor desktop app on this profile');
}

async function requestCurrentPeriodUsage(token, timeoutMs) {
  const response = await fetchWithTimeout(USAGE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1'
    },
    body: '{}'
  }, timeoutMs);

  if (response.status === 401) {
    throw new Error('Cursor sign-in expired — open Cursor and sign in again');
  }
  if (response.status === 429) {
    throw new Error('Cursor usage API is rate-limited — try again shortly');
  }
  if (!response.ok) {
    throw new Error(`Cursor usage request failed (${response.status})`);
  }
  const body = await response.json();
  if (!hasPlanUsage(body)) {
    throw new Error('Cursor did not return plan usage for this account');
  }
  return { source: 'live', ...body };
}

async function requestUsageSummary(token, timeoutMs) {
  const session = workosSessionCookie(token);
  if (!session) return null;
  const response = await fetchWithTimeout(USAGE_SUMMARY_URL, {
    method: 'GET',
    headers: { Cookie: `WorkosCursorSessionToken=${session}` }
  }, timeoutMs);
  if (!response.ok) return null;
  const summary = await response.json();
  return mapUsageSummary(summary);
}

function hasPlanUsage(body) {
  const plan = body?.planUsage;
  return plan && Number.isFinite(Number(plan.totalPercentUsed));
}

function mapUsageSummary(summary) {
  const pooled = summary?.teamUsage?.pooled;
  const individual = summary?.individualUsage?.overall;
  const bucket = pooled?.enabled ? pooled : individual;
  if (!bucket || !Number.isFinite(Number(bucket.used)) || !Number.isFinite(Number(bucket.limit))) {
    return null;
  }
  const usedPercent = Number(bucket.limit) > 0
    ? (Number(bucket.used) / Number(bucket.limit)) * 100
    : 0;
  return {
    source: 'live',
    billingCycleStart: summary.billingCycleStart,
    billingCycleEnd: summary.billingCycleEnd,
    planUsage: {
      totalPercentUsed: usedPercent,
      autoPercentUsed: usedPercent,
      apiPercentUsed: 0,
      limit: Number(bucket.limit),
      remaining: Number(bucket.remaining ?? (Number(bucket.limit) - Number(bucket.used))),
      includedSpend: Number(bucket.used)
    },
    membershipType: summary.membershipType
  };
}

function normalizeUsage(result, now = Date.now()) {
  const plan = result?.planUsage;
  const resetAt = parseCycleEnd(result.billingCycleEnd);
  const window = (usedPercent) => {
    if (!Number.isFinite(Number(usedPercent))) return null;
    return {
      usedPercent: Math.max(0, Math.min(100, Number(usedPercent))),
      windowMinutes: null,
      resetsAt: resetAt
    };
  };
  const primary = window(plan?.totalPercentUsed);
  const secondary = window(plan?.autoPercentUsed);
  if (!plan || (!primary && !secondary)) {
    throw new Error('Cursor did not return a usage snapshot');
  }
  const limitCents = Number(plan.limit);
  const remainingCents = Number(plan.remaining);
  const spendLabel = Number.isFinite(limitCents) && limitCents > 0
    ? `$${formatUsdFromCents(remainingCents)} of $${formatUsdFromCents(limitCents)}`
    : null;

  return {
    source: result.source === 'local-cache' ? 'local-cache' : 'live',
    fetchedAt: now,
    accountId: result.accountEmail ?? null,
    planType: titleCase(result.planType || result.membershipType || 'unknown'),
    ordinaryUsageAllowed: plan.enabled !== false,
    primary,
    secondary,
    credits: spendLabel ? {
      hasCredits: remainingCents > 0,
      unlimited: false,
      balance: spendLabel
    } : null,
    resetCredits: ceilPercent(plan.apiPercentUsed) ?? 0,
    displayMessage: result.displayMessage ?? null,
    reachedType: null
  };
}

function readCachedSnapshot(cacheFile = defaultCacheFile()) {
  if (!cacheFile || !fs.existsSync(cacheFile)) {
    throw new Error('No cached Cursor usage snapshot found');
  }
  const payload = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const usage = normalizeUsage({ ...payload, source: 'local-cache' }, payload.cachedAt || Date.now());
  usage.source = 'local-cache';
  return usage;
}

function writeCache(cacheFile, payload) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ ...payload, cachedAt: Date.now() }));
}

function defaultCacheFile() {
  return path.join(os.homedir(), '.config', 'CursorUsageWidget', 'usage-cache.json');
}

function parseCycleEnd(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function titleCase(value) {
  return String(value)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function jwtPayload(token) {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function workosSessionCookie(token) {
  const subject = jwtPayload(token)?.sub;
  if (!subject) return null;
  const parts = String(subject).split('|');
  const userID = parts.length > 1 ? parts[1] : parts[0];
  if (!userID) return null;
  return `${userID}%3A%3A${token}`;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Cursor usage request timed out');
    throw new Error('Cursor usage API is offline or unreachable');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  AUTO_REFRESH_MS,
  CursorUsageClient,
  MIN_REFRESH_MS,
  defaultCacheFile,
  normalizeUsage,
  readCachedSnapshot,
  readAccessToken,
  resolveStateDbPath
};