// The extension's service worker: it puts the gate in front of Google's authorize
// endpoint and lets single, checked requests back through.
//
//   navigation ─► DNR rule #1 redirects it to interstitial.html#<original URL>
//   interstitial ─ check ─► assess(url, stored policy)
//                             allow, or covered by this tab's approval ─► pass rule, "proceed"
//                             block ─► "ask" with the assessment and the choices
//   interstitial ─ choose ─► applyChoice under a write queue ─► storage; pass rule if it proceeds
//
// A pass rule lets one exact URL through in one tab for PASS_TTL_MS. It never
// covers "this tab" or "this app" in general: a site that opens a popup for a
// harmless sign-in must not be able to reuse the pass for a risky one.
//
// M3: every decision is also sealed into the encrypted ledger (src/ledger.ts),
// which needs only the ledger's public key, never the passphrase. The options
// page sends list and ledger changes here, so all storage writes share one queue.

import type { AuthorizeRequest } from '../authorize.ts';
import {
  LEDGER_KEY_STORAGE_KEY,
  LEDGER_STORAGE_KEY,
  appendSealed,
  ledgerEntry,
  parseLedgerKey,
  sealEntry,
  type LedgerDecision,
  type LedgerKey,
} from '../ledger.ts';
import {
  CHOICES,
  MAX_POLICY_ENTRIES,
  POLICY_STORAGE_KEY,
  applyChoice,
  assess,
  choicesFor,
  coversRequest,
  mergePolicies,
  parsePolicyFile,
  removeFromPolicy,
  type Assessment,
  type Choice,
  type ListName,
  type Policy,
  normalizePolicy,
} from '../policy.ts';

export const INTERSTITIAL_PATH = 'interstitial.html';
export const OPTIONS_PATH = 'options.html';
export const GATE_RULE_ID = 1;
/** Pass rules are session rules numbered from here. */
export const FIRST_PASS_RULE_ID = 1000;
/** How long a pass rule lives; the page navigates as soon as it gets one. */
export const PASS_TTL_MS = 10_000;
/**
 * How long Google's follow-up steps may reuse what the user just approved in a
 * tab, and how long a recorded sign-in covers those steps in the ledger.
 */
export const APPROVAL_TTL_MS = 60_000;

/**
 * Every main-frame URL the gate stops. RE2 syntax (Chrome's DNR engine). A path
 * containing "oauth2", or any %-escape that might spell it, on accounts.google.com.
 * It is a superset of what parseAuthorizeUrl accepts; assess() makes the real call.
 */
export const GATE_REGEX = '^https?://accounts\\.google\\.com\\.?/[^?#]*(?:oauth2|%).*';
const GATE_PATTERN = new RegExp(GATE_REGEX, 'i');

// ---------------------------------------------------------------------------
// The slice of the chrome.* API this worker uses, so tests can supply a fake.

export interface DnrRule {
  id: number;
  priority: number;
  action: { type: 'allow' | 'redirect'; redirect?: { regexSubstitution: string } };
  condition: {
    regexFilter?: string;
    urlFilter?: string;
    isUrlFilterCaseSensitive: boolean;
    resourceTypes: 'main_frame'[];
    tabIds?: number[];
  };
}

interface RuleUpdate {
  removeRuleIds?: number[];
  addRules?: DnrRule[];
}

export interface Sender {
  id?: string;
  url?: string;
  tab?: { id?: number };
}

export interface ChromeApi {
  runtime: {
    id: string;
    getURL(path: string): string;
    onMessage: {
      addListener(
        listener: (message: unknown, sender: Sender, sendResponse: (reply: unknown) => void) => boolean | undefined,
      ): void;
    };
    onInstalled: { addListener(listener: (details: { reason: string }) => void): void };
    openOptionsPage(): Promise<void>;
  };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
  declarativeNetRequest: {
    updateDynamicRules(update: RuleUpdate): Promise<void>;
    updateSessionRules(update: RuleUpdate): Promise<void>;
    getSessionRules(): Promise<DnrRule[]>;
  };
}

/** Messages from the interstitial page. */
export type Message = { type: 'check'; url: string } | { type: 'choose'; url: string; choice: Choice };

/** Messages from the options page. The passphrase is never among them. */
export type OptionsMessage =
  | { type: 'import-policy'; text: string }
  | { type: 'remove-app'; list: ListName; client_id: string }
  | { type: 'ledger-setup'; key: LedgerKey }
  | { type: 'ledger-reset' };

export type Reply =
  | { ok: true; action: 'proceed'; url: string }
  | { ok: true; action: 'ask'; assessment: Assessment; choices: Choice[] }
  | { ok: true; action: 'back' }
  | { ok: true; action: 'saved' }
  | { ok: false; error: string };

export interface GateOptions {
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => void;
  onError?: (error: unknown) => void;
}

// ---------------------------------------------------------------------------
// Rules and URLs

/** The dynamic rule that sends every gated navigation to the interstitial. */
export function gateRule(interstitialUrl: string): DnrRule {
  return {
    id: GATE_RULE_ID,
    priority: 1,
    // \0 is the whole matched URL; everything after # stays out of any request.
    action: { type: 'redirect', redirect: { regexSubstitution: `${interstitialUrl}#\\0` } },
    condition: { regexFilter: GATE_REGEX, isUrlFilterCaseSensitive: false, resourceTypes: ['main_frame'] },
  };
}

/** A session rule that lets exactly `passUrl` through in one tab. */
export function passRule(id: number, tabId: number, passUrl: string): DnrRule {
  return {
    id,
    priority: 2,
    action: { type: 'allow' },
    condition: {
      urlFilter: `|${passUrl}|`,
      isUrlFilterCaseSensitive: true,
      tabIds: [tabId],
      resourceTypes: ['main_frame'],
    },
  };
}

/**
 * The URL to navigate to and to match exactly. `*`, `^` and `|` are wildcards
 * or anchors in a urlFilter, so they are percent-encoded (Google decodes them
 * back to the same parameters). A fragment never reaches the network, so it goes.
 */
export function passUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.href.replace(/[*^|]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Only addresses the gate itself stops may be sent back through it. */
export function isGateTarget(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  if (parsed.port !== '' || parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.hostname.replace(/\.$/, '') !== 'accounts.google.com') return false;
  return GATE_PATTERN.test(parsed.href);
}

// ---------------------------------------------------------------------------
// The worker

class GateError extends Error {}

interface Pass {
  tabId: number;
  url: string;
  expires: number;
}

interface Approval {
  request: AuthorizeRequest;
  expires: number;
}

type TrustedSender = { page: 'interstitial'; tabId: number } | { page: 'options' };

const logError = (error: unknown) => console.error('grantgate:', error);

export function createGate(api: ChromeApi, options: GateOptions = {}) {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms));
  const onError = options.onError ?? logError;
  const dnr = api.declarativeNetRequest;
  const interstitialUrl = api.runtime.getURL(INTERSTITIAL_PATH);
  const optionsUrl = api.runtime.getURL(OPTIONS_PATH);

  const passes = new Map<number, Pass>();
  const approvals = new Map<number, Approval>();
  // The last sign-in recorded in each tab, so Google's follow-up steps aren't recorded again.
  const recorded = new Map<number, Approval>();
  let nextPassId = FIRST_PASS_RULE_ID;
  let writes: Promise<unknown> = Promise.resolve();

  // Every worker start re-installs the gate and drops passes from an earlier life
  // (they have expired: the worker only sleeps after 30 s idle).
  const ready = (async () => {
    await dnr
      .updateDynamicRules({ removeRuleIds: [GATE_RULE_ID], addRules: [gateRule(interstitialUrl)] })
      .catch(onError);
    try {
      const stale = (await dnr.getSessionRules()).map((rule) => rule.id);
      nextPassId = Math.max(FIRST_PASS_RULE_ID, ...stale.map((id) => id + 1));
      if (stale.length > 0) await dnr.updateSessionRules({ removeRuleIds: stale });
    } catch (error) {
      onError(error);
    }
  })();

  async function handleMessage(message: unknown, sender: Sender): Promise<Reply> {
    let fallback = 'grantgate could not check this sign-in.';
    try {
      await ready;
      await sweep();
      const from = trustedSender(sender);
      // Each page may send only its own messages: the interstitial is web-accessible,
      // so it must never be a way to change the lists or the ledger.
      if (from.page === 'options') {
        fallback = 'grantgate could not save that change. Try again.';
        return await changeSettings(parseOptionsMessage(message));
      }
      const msg = parseMessage(message);
      return msg.type === 'check' ? await check(msg.url, from.tabId) : await choose(msg.url, msg.choice, from.tabId);
    } catch (error) {
      if (!(error instanceof GateError)) onError(error);
      return { ok: false, error: error instanceof GateError ? error.message : fallback };
    }
  }

  async function check(url: string, tabId: number): Promise<Reply> {
    const assessment = assess(url, await loadPolicy());
    const { request } = assessment;
    if (assessment.decision === 'allow') {
      const reply = await letThrough(url, tabId);
      if (request) {
        const decision = assessment.reason === 'allowlisted' ? 'allowlisted' : 'allowed';
        await serialised(async () => {
          if (!stillCovers(recorded, tabId, request)) await record(tabId, request, decision);
        });
      }
      return reply;
    }
    // A follow-up step of a request the user already continued: recorded then.
    if (approvedInTab(tabId, assessment)) return letThrough(url, tabId);
    return { ok: true, action: 'ask', assessment, choices: choicesFor(assessment) };
  }

  async function choose(url: string, choice: Choice, tabId: number): Promise<Reply> {
    const { proceed, request } = await serialised(async () => {
      const policy = await loadPolicy();
      const assessment = assess(url, policy);
      let result: ReturnType<typeof applyChoice>;
      try {
        result = applyChoice(policy, assessment, choice);
      } catch {
        throw new GateError("That choice isn't offered for this sign-in. Reload the page to check it again.");
      }
      if (choice === 'always-allow' || choice === 'always-block') await savePolicy(result.policy);
      // A choice was offered, so this is a grant request.
      if (assessment.request) await record(tabId, assessment.request, choice);
      return { proceed: result.proceed, request: assessment.request };
    });
    if (!proceed) return { ok: true, action: 'back' };
    if (request?.client_id) approvals.set(tabId, { request, expires: now() + APPROVAL_TTL_MS });
    return letThrough(url, tabId);
  }

  function approvedInTab(tabId: number, assessment: Assessment): boolean {
    // Only a risk the user already accepted; never a denylisted or unnamed app.
    return assessment.reason === 'high-risk' && assessment.request !== null && stillCovers(approvals, tabId, assessment.request);
  }

  /** True when the tab's live entry in `memory` covers `request` (same app and redirect, no new scopes). */
  function stillCovers(memory: Map<number, Approval>, tabId: number, request: AuthorizeRequest): boolean {
    const remembered = memory.get(tabId);
    if (!remembered) return false;
    if (remembered.expires <= now()) {
      memory.delete(tabId);
      return false;
    }
    return coversRequest(remembered.request, request);
  }

  /**
   * Seals one entry into the ledger. The caller holds the write queue. Failures are
   * logged, never thrown: the record must not stand in the way of the gate. Before
   * a passphrase is set there is no key to seal to, so nothing is recorded.
   */
  async function record(tabId: number, request: AuthorizeRequest, decision: LedgerDecision): Promise<void> {
    try {
      const key = parseLedgerKey((await api.storage.local.get(LEDGER_KEY_STORAGE_KEY))[LEDGER_KEY_STORAGE_KEY]);
      if (!key) return;
      const sealed = await sealEntry(key, ledgerEntry(now(), request, decision));
      const ledger = (await api.storage.local.get(LEDGER_STORAGE_KEY))[LEDGER_STORAGE_KEY];
      await api.storage.local.set({ [LEDGER_STORAGE_KEY]: appendSealed(ledger, sealed) });
      // Only a sign-in that went on to Google has follow-up steps. After "go back",
      // a narrower retry from the same site is a new sign-in and is recorded.
      if (decision !== 'back' && decision !== 'always-block') recorded.set(tabId, { request, expires: now() + APPROVAL_TTL_MS });
    } catch (error) {
      onError(error);
    }
  }

  async function changeSettings(msg: OptionsMessage): Promise<Reply> {
    await serialised(async () => {
      switch (msg.type) {
        case 'import-policy': {
          const file = parsePolicyFile(msg.text);
          if (!file.ok) throw new GateError(file.error);
          const merged = mergePolicies(await loadPolicy(), file.policy);
          if (merged.allow.length + merged.deny.length > MAX_POLICY_ENTRIES) {
            throw new GateError(`Your lists would hold more than ${MAX_POLICY_ENTRIES} apps.`);
          }
          return savePolicy(merged);
        }
        case 'remove-app':
          return savePolicy(removeFromPolicy(await loadPolicy(), msg.list, msg.client_id));
        case 'ledger-setup': {
          // A damaged key can be replaced; a working one only after an explicit erase.
          const current = parseLedgerKey((await api.storage.local.get(LEDGER_KEY_STORAGE_KEY))[LEDGER_KEY_STORAGE_KEY]);
          if (current) throw new GateError('A ledger already exists. Erase it before starting a new one.');
          // Key and entries in one write, so entries sealed to an old key can't linger.
          return api.storage.local.set({ [LEDGER_KEY_STORAGE_KEY]: msg.key, [LEDGER_STORAGE_KEY]: [] });
        }
        case 'ledger-reset':
          recorded.clear();
          return api.storage.local.set({ [LEDGER_KEY_STORAGE_KEY]: null, [LEDGER_STORAGE_KEY]: [] });
        default: {
          const unhandled: never = msg;
          throw new GateError(`Unknown message ${String(unhandled)}.`);
        }
      }
    });
    return { ok: true, action: 'saved' };
  }

  async function letThrough(url: string, tabId: number): Promise<Reply> {
    const passUrl = passUrlFor(url);
    // A live pass for this exact URL and tab should have matched; if the gate
    // still caught it, sending the tab again would loop forever.
    for (const pass of passes.values()) {
      if (pass.tabId === tabId && pass.url === passUrl) {
        throw new GateError('grantgate let this sign-in through but Chrome sent it back. Try again in a few seconds.');
      }
    }
    const id = nextPassId++;
    await dnr.updateSessionRules({ addRules: [passRule(id, tabId, passUrl)] });
    passes.set(id, { tabId, url: passUrl, expires: now() + PASS_TTL_MS });
    schedule(() => void sweep(), PASS_TTL_MS);
    return { ok: true, action: 'proceed', url: passUrl };
  }

  async function sweep(): Promise<void> {
    const expired = [...passes].filter(([, pass]) => pass.expires <= now()).map(([id]) => id);
    if (expired.length === 0) return;
    for (const id of expired) passes.delete(id);
    await dnr.updateSessionRules({ removeRuleIds: expired }).catch(onError);
  }

  // Read-modify-write of the lists runs one at a time, so two tabs choosing
  // "always …" together can't overwrite each other.
  function serialised<T>(task: () => Promise<T>): Promise<T> {
    const run = writes.then(task);
    writes = run.catch(() => undefined);
    return run;
  }

  async function loadPolicy(): Promise<Policy> {
    const stored = await api.storage.local.get(POLICY_STORAGE_KEY);
    return normalizePolicy(stored[POLICY_STORAGE_KEY]);
  }

  async function savePolicy(policy: Policy): Promise<void> {
    await api.storage.local.set({ [POLICY_STORAGE_KEY]: policy });
  }

  // Our interstitial in a tab, or our options page (in a tab or not). Nothing else.
  function trustedSender(sender: Sender): TrustedSender {
    const page = typeof sender.url === 'string' ? sender.url.split(/[?#]/)[0] : '';
    const tabId = sender.tab?.id;
    if (sender.id === api.runtime.id) {
      if (page === optionsUrl) return { page: 'options' };
      if (page === interstitialUrl && typeof tabId === 'number' && Number.isInteger(tabId) && tabId >= 0) {
        return { page: 'interstitial', tabId };
      }
    }
    throw new GateError('grantgate only answers its own pages.');
  }

  return { ready, handleMessage };
}

function parseMessage(message: unknown): Message {
  if (typeof message !== 'object' || message === null) throw new GateError('Unknown message.');
  const { type, url, choice } = message as Record<string, unknown>;
  if (type !== 'check' && type !== 'choose') throw new GateError('Unknown message.');
  if (!isGateTarget(url)) throw new GateError('That is not a Google sign-in address.');
  if (type === 'check') return { type, url };
  if (!CHOICES.includes(choice as Choice)) throw new GateError('Unknown choice.');
  return { type, url, choice: choice as Choice };
}

function parseOptionsMessage(message: unknown): OptionsMessage {
  if (typeof message !== 'object' || message === null) throw new GateError('Unknown message.');
  const { type, text, list, client_id, key } = message as Record<string, unknown>;
  switch (type) {
    case 'import-policy':
      if (typeof text !== 'string') throw new GateError("That file isn't a grantgate policy file.");
      return { type, text };
    case 'remove-app':
      if (list !== 'allow' && list !== 'deny') throw new GateError('Unknown list.');
      if (typeof client_id !== 'string' || client_id.trim() === '') throw new GateError('Unknown app.');
      return { type, list, client_id };
    case 'ledger-setup': {
      const parsed = parseLedgerKey(key);
      if (!parsed) throw new GateError('That ledger key is damaged. Reload the page and try again.');
      return { type, key: parsed };
    }
    case 'ledger-reset':
      return { type };
    default:
      throw new GateError('Unknown message.');
  }
}

/** Wires the gate to Chrome. Listeners are registered synchronously, as MV3 requires. */
export function start(api: ChromeApi, options: GateOptions = {}) {
  const gate = createGate(api, options);
  const onError = options.onError ?? logError;
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void gate.handleMessage(message, sender).then(sendResponse);
    return true;
  });
  // First install: open the options page so the user can set the ledger's passphrase.
  api.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install') void api.runtime.openOptionsPage().catch(onError);
  });
  return gate;
}

const chromeApi = (globalThis as { chrome?: ChromeApi }).chrome;
if (chromeApi?.runtime?.id) start(chromeApi);
