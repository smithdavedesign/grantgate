// The gate's rules: whether a Google authorize request goes straight through or
// stops at the interstitial, what the interstitial offers, and what each choice
// does to the allowlist and denylist. Also the policy file that carries the lists
// from an owner to staff (M3).
//
// Pure and side-effect free; the extension's service worker supplies the stored
// policy and writes back what applyChoice returns. Precedence (first match wins):
//   not a grant request -> allow   (the gate stays out of the way)
//   client_id ambiguous -> block   (a decoy copy must not dodge the denylist)
//   denylisted          -> block
//   allowlisted         -> allow
//   rated high          -> block
//   otherwise           -> allow   (medium and low; see BUILD.md "Decisions")

import { parseAuthorizeUrl, type AuthorizeRequest } from './authorize.ts';
import { scopeRisk, type ScopeRisk } from './scopes.ts';

export type Decision = 'allow' | 'block';

export type Reason =
  | 'not-a-grant-request'
  | 'unidentified-app'
  | 'denylisted'
  | 'allowlisted'
  | 'high-risk'
  | 'not-high-risk';

/** What the user can pick on the interstitial. */
export type Choice = 'back' | 'once' | 'always-allow' | 'always-block';

// A Record, so adding a Choice fails to compile until it is listed here.
const CHOICE_KEYS: Record<Choice, true> = { back: true, once: true, 'always-allow': true, 'always-block': true };

/** Every choice, for validating messages. */
export const CHOICES = Object.freeze(Object.keys(CHOICE_KEYS) as Choice[]);

/** Client IDs, stored lower-case. An ID is never on both lists. */
export interface Policy {
  allow: string[];
  deny: string[];
}

export type ListName = keyof Policy;

/** Where the worker keeps the lists in chrome.storage.local. */
export const POLICY_STORAGE_KEY = 'policy';

export const POLICY_FILE_FORMAT = 'grantgate-policy';
const POLICY_FILE_VERSION = 1;
/** The most apps a policy file, or the stored lists after an import, may hold. */
export const MAX_POLICY_ENTRIES = 10_000;
export const MAX_POLICY_FILE_CHARS = 1_000_000;
// Google client IDs are printable ASCII with no spaces.
const CLIENT_ID_PATTERN = /^[\x21-\x7e]{1,256}$/;
const NOT_A_POLICY = "That file isn't a grantgate policy file.";

export type PolicyFileResult = { ok: true; policy: Policy } | { ok: false; error: string };

export interface Assessment {
  decision: Decision;
  reason: Reason;
  /** M1's parse of the URL; null when it is not a grant request. */
  request: AuthorizeRequest | null;
  /** M1's rating and labels for the requested scopes; null when not a grant request. */
  risk: ScopeRisk | null;
}

// Typed as a Record so adding a Reason fails to compile until it is handled here.
const CHOICES_BY_REASON: Record<Reason, readonly Choice[]> = {
  'not-a-grant-request': [],
  allowlisted: [],
  'not-high-risk': [],
  'high-risk': ['back', 'once', 'always-allow', 'always-block'],
  denylisted: ['back'],
  // Nothing can be remembered for an app we can't name.
  'unidentified-app': ['back', 'once'],
};

/** Reads a policy from storage or a file, keeping only well-formed entries. Never throws. */
export function normalizePolicy(input: unknown): Policy {
  const raw = isRecord(input) ? input : {};
  const deny = clientIds(raw.deny);
  const denied = new Set(deny);
  return { allow: clientIds(raw.allow).filter((id) => !denied.has(id)), deny };
}

/** Decides a navigation and says why, with the parse and risk the interstitial shows. */
export function assess(url: string | URL, policy?: unknown): Assessment {
  const request = parseAuthorizeUrl(url);
  if (!request) return { decision: 'allow', reason: 'not-a-grant-request', request: null, risk: null };
  const risk = scopeRisk(request.scopes);
  const verdict = (decision: Decision, reason: Reason): Assessment => ({ decision, reason, request, risk });

  if (request.client_id === null) return verdict('block', 'unidentified-app');
  const { allow, deny } = normalizePolicy(policy);
  const id = clientIdKey(request.client_id);
  if (deny.includes(id)) return verdict('block', 'denylisted');
  if (allow.includes(id)) return verdict('allow', 'allowlisted');
  if (risk.rating === 'high') return verdict('block', 'high-risk');
  return verdict('allow', 'not-high-risk');
}

/** `block` sends the navigation to the interstitial; `allow` lets it through. */
export function decide(url: string | URL, policy?: unknown): Decision {
  return assess(url, policy).decision;
}

/** The choices the interstitial offers; empty when there is nothing to ask. */
export function choicesFor(assessment: Pick<Assessment, 'reason'>): Choice[] {
  return [...(CHOICES_BY_REASON[assessment.reason] ?? [])];
}

/**
 * Applies the user's choice. Only "always allow" adds to the allowlist and only
 * "always block" adds to the denylist; "once" and "back" return the lists unchanged.
 * Throws when the choice was not offered for this assessment.
 */
export function applyChoice(
  policy: unknown,
  assessment: Assessment,
  choice: Choice,
): { policy: Policy; proceed: boolean } {
  if (!choicesFor(assessment).includes(choice)) {
    throw new Error(`"${String(choice)}" is not offered for a ${assessment.reason} request`);
  }
  const current = normalizePolicy(policy);
  const proceed = choice === 'once' || choice === 'always-allow';
  if (choice !== 'always-allow' && choice !== 'always-block') return { policy: current, proceed };

  // Offered only when the request names exactly one app, so client_id is set.
  const id = clientIdKey(assessment.request?.client_id ?? '');
  const allow = current.allow.filter((entry) => entry !== id);
  const deny = current.deny.filter((entry) => entry !== id);
  if (choice === 'always-allow') allow.push(id);
  else deny.push(id);
  return { policy: { allow, deny }, proceed };
}

/**
 * True when `request` asks for no more than an approval the user already gave:
 * same app, same redirect, and a subset of the approved scopes. Used for the
 * steps Google redirects through after the user continues.
 */
export function coversRequest(approved: AuthorizeRequest, request: AuthorizeRequest): boolean {
  if (approved.client_id === null || request.client_id === null) return false;
  if (clientIdKey(approved.client_id) !== clientIdKey(request.client_id)) return false;
  if (approved.redirect_uri !== request.redirect_uri) return false;
  const granted = new Set(approved.scopes);
  return request.scopes.every((scope) => granted.has(scope));
}

// ---------------------------------------------------------------------------
// Policy files: how an owner hands the same lists to everyone.

/** The lists as a policy file an owner can hand to staff. */
export function policyFile(policy: unknown): string {
  const { allow, deny } = normalizePolicy(policy);
  return `${JSON.stringify({ format: POLICY_FILE_FORMAT, version: POLICY_FILE_VERSION, allow, deny }, null, 2)}\n`;
}

/**
 * Reads a policy file. Strict, so an owner learns their file is broken instead of
 * having it half-applied. Accepts policyFile's format or a bare { allow, deny }.
 * Never throws.
 */
export function parsePolicyFile(text: string): PolicyFileResult {
  const fail = (error: string): PolicyFileResult => ({ ok: false, error });
  if (typeof text !== 'string') return fail(NOT_A_POLICY);
  if (text.length > MAX_POLICY_FILE_CHARS) return fail('That file is too big to be a grantgate policy file.');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("That file isn't valid JSON, so it can't be a grantgate policy file.");
  }
  if (!isRecord(raw) || (raw.format !== undefined && raw.format !== POLICY_FILE_FORMAT)) return fail(NOT_A_POLICY);
  if (raw.version !== undefined && raw.version !== POLICY_FILE_VERSION) {
    return fail("That policy file's version isn't one this grantgate can read. Update grantgate and try again.");
  }
  if (raw.allow === undefined && raw.deny === undefined) return fail('That file has no allow or deny list.');
  let total = 0;
  for (const list of ['allow', 'deny'] as const) {
    const ids = raw[list];
    if (ids === undefined) continue;
    if (!Array.isArray(ids)) return fail(`"${list}" must be a list of client IDs.`);
    const bad = ids.findIndex((id) => typeof id !== 'string' || !CLIENT_ID_PATTERN.test(id.trim()));
    if (bad !== -1) return fail(`Entry ${bad + 1} in "${list}" isn't a client ID.`);
    total += ids.length;
  }
  if (total > MAX_POLICY_ENTRIES) return fail(`That file lists more than ${MAX_POLICY_ENTRIES} apps.`);
  return { ok: true, policy: normalizePolicy(raw) };
}

/** Adds `incoming` to `current`. A block wins over an allow, whichever list it came from. */
export function mergePolicies(current: unknown, incoming: unknown): Policy {
  const mine = normalizePolicy(current);
  const theirs = normalizePolicy(incoming);
  return normalizePolicy({ allow: [...mine.allow, ...theirs.allow], deny: [...mine.deny, ...theirs.deny] });
}

/** The lists with `clientId` taken off `list`. */
export function removeFromPolicy(policy: unknown, list: ListName, clientId: string): Policy {
  const { allow, deny } = normalizePolicy(policy);
  const id = clientIdKey(clientId);
  const without = (ids: string[]) => ids.filter((entry) => entry !== id);
  return { allow: list === 'allow' ? without(allow) : allow, deny: list === 'deny' ? without(deny) : deny };
}

function clientIdKey(id: string): string {
  return id.trim().toLowerCase();
}

function clientIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((v): v is string => typeof v === 'string').map(clientIdKey);
  return [...new Set(ids.filter((id) => id !== ''))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
