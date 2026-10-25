// The sign-in ledger: one record per Google sign-in the gate decided, encrypted
// so that only the passphrase can read it, while the service worker, which never
// sees the passphrase, can still add to it.
//
//   set up (options page)  passphrase ─PBKDF2-SHA-256, random salt─► wrapping key (AES-GCM)
//                          new ECDH P-256 key pair: the public half is stored as is,
//                          the private half is stored wrapped with the wrapping key
//   append (worker)        new ephemeral ECDH key + the stored public key ─► shared secret
//                          ─HKDF-SHA-256─► a one-off AES-GCM key ─► { epk, iv, ct }
//   read (options page)    passphrase ─► wrapping key ─► unwrap the private key (a wrong
//                          passphrase fails the GCM tag) ─► ECDH with each epk ─► decrypt
//
// WebCrypto only, so it runs the same in Chrome and in Node's tests. Also builds the
// entries the worker records and the CSV export.

import type { AuthorizeRequest } from './authorize.ts';
import type { Choice } from './policy.ts';
import { scopeRisk, type Rating } from './scopes.ts';

export const LEDGER_STORAGE_KEY = 'ledger';
export const LEDGER_KEY_STORAGE_KEY = 'ledgerKey';

/** OWASP's 2023 figure for PBKDF2-HMAC-SHA-256. */
export const PBKDF2_ITERATIONS = 600_000;
// The range accepted when reading a stored key. Counts below the default exist only in tests.
const MIN_ITERATIONS = 1_000;
const MAX_ITERATIONS = 10_000_000;
export const MIN_PASSPHRASE_LENGTH = 8;

/** The stored ledger keeps the newest entries within both limits, well inside chrome.storage's 10 MB. */
export const MAX_LEDGER_ENTRIES = 2_000;
export const MAX_LEDGER_CHARS = 3_000_000;
/** Per entry, so one hostile URL can't take up the ledger's space. */
export const MAX_RECORDED_SCOPES = 40;
export const MAX_FIELD_CHARS = 300;

const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const PUBLIC_KEY_BYTES = 65;
// A wrapped P-256 pkcs8 key is about 150 bytes; anything this short is damaged.
const MIN_WRAPPED_BYTES = 64;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ENTRY_INFO = encoder.encode('grantgate ledger entry v1');

/** What happened to a sign-in: let through automatically, or what the user chose. */
export type LedgerDecision = 'allowed' | 'allowlisted' | Choice;

// A Record, so adding a decision fails to compile until it has words.
export const DECISION_TEXT: Readonly<Record<LedgerDecision, string>> = Object.freeze({
  allowed: 'Allowed (not high risk)',
  allowlisted: 'Allowed (on your allow list)',
  once: 'Continued once',
  'always-allow': 'Always allowed',
  'always-block': 'Always blocked',
  back: 'Went back',
});

export const LEDGER_DECISIONS = Object.freeze(Object.keys(DECISION_TEXT) as LedgerDecision[]);

const RATING_RANK: Record<Rating, number> = { low: 0, medium: 1, high: 2 };

/** Shown for a request whose link named more than one app (client_id null). */
export const UNIDENTIFIED_APP = 'Unknown (the link named more than one app)';

export interface LedgerEntry {
  /** ISO 8601, UTC. */
  at: string;
  client_id: string | null;
  redirect_uri: string | null;
  scopes: string[];
  /** The rating of the whole request when it was decided. */
  rating: Rating;
  decision: LedgerDecision;
}

/** Stored as `ledgerKey`. Holds no passphrase and no usable private key. */
export interface LedgerKey {
  v: 1;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  /** Raw uncompressed P-256 point, base64. */
  publicKey: string;
  /** pkcs8 private key, AES-GCM-wrapped with the passphrase's key, base64. */
  wrappedPrivateKey: string;
  iv: string;
}

/** One entry in the stored `ledger` list. */
export interface SealedEntry {
  v: 1;
  /** The ephemeral ECDH public key, base64. */
  epk: string;
  iv: string;
  ct: string;
}

export interface OpenedLedger {
  entries: LedgerEntry[];
  /** Records that were damaged, tampered with or sealed to another key. */
  unreadable: number;
}

export class WrongPassphraseError extends Error {
  constructor() {
    super("That passphrase doesn't open this ledger.");
    this.name = 'WrongPassphraseError';
  }
}

// ---------------------------------------------------------------------------
// Entries

/** The entry recorded for a decision on `request`, clipped to a bounded size. */
export function ledgerEntry(at: number, request: AuthorizeRequest, decision: LedgerDecision): LedgerEntry {
  const risk = scopeRisk(request.scopes);
  // Riskiest first when clipping, so padding with harmless scopes can't push the risky one out.
  const labels =
    risk.labels.length > MAX_RECORDED_SCOPES
      ? [...risk.labels].sort((a, b) => RATING_RANK[b.rating] - RATING_RANK[a.rating]).slice(0, MAX_RECORDED_SCOPES)
      : risk.labels;
  return {
    at: new Date(at).toISOString(),
    client_id: request.client_id === null ? null : clip(request.client_id),
    redirect_uri: request.redirect_uri === null ? null : clip(request.redirect_uri),
    scopes: labels.map((label) => clip(label.scope)),
    rating: risk.rating,
    decision,
  };
}

/** The stored ledger with `entry` added, oldest entries dropped past the limits. */
export function appendSealed(stored: unknown, entry: SealedEntry): SealedEntry[] {
  const ledger = [...(Array.isArray(stored) ? stored.filter(isSealed) : []), entry];
  let size = ledger.reduce((total, e) => total + sealedSize(e), 0);
  while (ledger.length > 1 && (ledger.length > MAX_LEDGER_ENTRIES || size > MAX_LEDGER_CHARS)) {
    size -= sealedSize(ledger.shift() as SealedEntry);
  }
  return ledger;
}

// ---------------------------------------------------------------------------
// Keys and encryption

/** Makes a new ledger key protected by `passphrase`. Runs in the options page. */
export async function createLedgerKey(passphrase: string, options: { iterations?: number } = {}): Promise<LedgerKey> {
  if (typeof passphrase !== 'string' || [...passphrase.normalize('NFC')].length < MIN_PASSPHRASE_LENGTH) {
    throw new RangeError(`Use at least ${MIN_PASSPHRASE_LENGTH} characters for the passphrase.`);
  }
  const iterations = options.iterations ?? PBKDF2_ITERATIONS;
  if (!validIterations(iterations)) throw new RangeError('Unsupported PBKDF2 iteration count.');
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const pair = await crypto.subtle.generateKey(CURVE, true, ['deriveBits']);
  const wrapping = await passphraseKey(passphrase, salt, iterations, 'wrapKey');
  const wrapped = await crypto.subtle.wrapKey('pkcs8', pair.privateKey, wrapping, { name: 'AES-GCM', iv });
  const publicKey = await crypto.subtle.exportKey('raw', pair.publicKey);
  return {
    v: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toBase64(salt) },
    publicKey: toBase64(publicKey),
    wrappedPrivateKey: toBase64(wrapped),
    iv: toBase64(iv),
  };
}

/** A stored ledger key, or null when it is missing or damaged. Never throws. */
export function parseLedgerKey(value: unknown): LedgerKey | null {
  if (!isRecord(value) || value.v !== 1 || !isRecord(value.kdf)) return null;
  const { name, hash, iterations, salt } = value.kdf;
  const { publicKey, wrappedPrivateKey, iv } = value;
  if (name !== 'PBKDF2' || hash !== 'SHA-256' || !validIterations(iterations)) return null;
  if (!decodes(salt, (b) => b.length === SALT_BYTES)) return null;
  if (!decodes(iv, (b) => b.length === IV_BYTES)) return null;
  if (!decodes(publicKey, (b) => b.length === PUBLIC_KEY_BYTES && b[0] === 0x04)) return null;
  if (!decodes(wrappedPrivateKey, (b) => b.length >= MIN_WRAPPED_BYTES)) return null;
  return { v: 1, kdf: { name, hash, iterations, salt }, publicKey, wrappedPrivateKey, iv };
}

/** Encrypts `entry` so that only the holder of the ledger's passphrase can read it. Needs no passphrase. */
export async function sealEntry(key: Pick<LedgerKey, 'publicKey'>, entry: LedgerEntry): Promise<SealedEntry> {
  const recipient = await crypto.subtle.importKey('raw', fromBase64(key.publicKey), CURVE, false, []);
  const ephemeral = await crypto.subtle.generateKey(CURVE, true, ['deriveBits']);
  const epk = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const aes = await entryKey(ephemeral.privateKey, recipient, epk, 'encrypt');
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, encoder.encode(JSON.stringify(entry)));
  return { v: 1, epk: toBase64(epk), iv: toBase64(iv), ct: toBase64(ct) };
}

/**
 * Decrypts the stored ledger. Throws WrongPassphraseError when the passphrase
 * doesn't unwrap the key; counts records it can't open instead of failing on them.
 */
export async function openLedger(key: LedgerKey, passphrase: string, stored: unknown): Promise<OpenedLedger> {
  let privateKey: CryptoKey;
  try {
    const unwrapping = await passphraseKey(String(passphrase), fromBase64(key.kdf.salt), key.kdf.iterations, 'unwrapKey');
    privateKey = await crypto.subtle.unwrapKey(
      'pkcs8',
      fromBase64(key.wrappedPrivateKey),
      unwrapping,
      { name: 'AES-GCM', iv: fromBase64(key.iv) },
      CURVE,
      false,
      ['deriveBits'],
    );
  } catch {
    throw new WrongPassphraseError();
  }
  const records: unknown[] = Array.isArray(stored) ? stored : [];
  const opened = await Promise.all(records.map((record) => (isSealed(record) ? openEntry(privateKey, record) : null)));
  const entries = opened.filter((entry): entry is LedgerEntry => entry !== null);
  return { entries, unreadable: records.length - entries.length };
}

async function openEntry(privateKey: CryptoKey, sealed: SealedEntry): Promise<LedgerEntry | null> {
  try {
    const epk = fromBase64(sealed.epk);
    const sender = await crypto.subtle.importKey('raw', epk, CURVE, false, []);
    const aes = await entryKey(privateKey, sender, epk, 'decrypt');
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(sealed.iv) }, aes, fromBase64(sealed.ct));
    return parseEntry(JSON.parse(decoder.decode(plain)));
  } catch {
    return null;
  }
}

async function passphraseKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number, usage: KeyUsage): Promise<CryptoKey> {
  // NFC, so the same words typed on another system give the same key.
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

// The raw ECDH secret isn't uniformly random, so it goes through HKDF, salted with
// the ephemeral key, to give a fresh AES key for this entry alone.
async function entryKey(privateKey: CryptoKey, publicKey: CryptoKey, epk: Uint8Array<ArrayBuffer>, usage: KeyUsage): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const base = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epk, info: ENTRY_INFO }, base, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

// ---------------------------------------------------------------------------
// CSV export

export const CSV_HEADER = Object.freeze(['date (UTC)', 'app', 'decision', 'risk', 'permissions', 'scopes', 'redirect_uri']);

/** RFC 4180 CSV, oldest entry first, with a header row. */
export function ledgerCsv(entries: readonly LedgerEntry[]): string {
  const rows = entries.map((e) => [
    new Date(e.at).toISOString().slice(0, 19).replace('T', ' '),
    e.client_id ?? UNIDENTIFIED_APP,
    DECISION_TEXT[e.decision],
    e.rating,
    scopeRisk(e.scopes)
      .labels.map((label) => label.label)
      .join('; '),
    e.scopes.join(' '),
    e.redirect_uri ?? '',
  ]);
  return `${[CSV_HEADER, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

// App IDs, scopes and redirects come from the sign-in URL, which a site controls.
// A leading = + - @ (or tab, CR) would run as a formula in a spreadsheet.
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

// ---------------------------------------------------------------------------
// Helpers

function parseEntry(value: unknown): LedgerEntry | null {
  if (!isRecord(value)) return null;
  const { at, client_id, redirect_uri, scopes, rating, decision } = value;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null;
  if (!isStringOrNull(client_id) || !isStringOrNull(redirect_uri)) return null;
  if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string')) return null;
  if (typeof rating !== 'string' || !Object.hasOwn(RATING_RANK, rating)) return null;
  if (typeof decision !== 'string' || !Object.hasOwn(DECISION_TEXT, decision)) return null;
  return { at, client_id, redirect_uri, scopes, rating: rating as Rating, decision: decision as LedgerDecision };
}

function isSealed(value: unknown): value is SealedEntry {
  return isRecord(value) && value.v === 1 && typeof value.epk === 'string' && typeof value.iv === 'string' && typeof value.ct === 'string';
}

function sealedSize(entry: SealedEntry): number {
  return entry.epk.length + entry.iv.length + entry.ct.length;
}

function validIterations(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_ITERATIONS && value <= MAX_ITERATIONS;
}

function clip(text: string): string {
  return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS - 1)}…` : text;
}

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

function toBase64(data: ArrayBuffer | Uint8Array): string {
  let binary = '';
  for (const byte of data instanceof Uint8Array ? data : new Uint8Array(data)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Throws on text that isn't base64. */
function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodes(value: unknown, test: (bytes: Uint8Array) => boolean): value is string {
  if (typeof value !== 'string') return false;
  try {
    return test(fromBase64(value));
  } catch {
    return false;
  }
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
