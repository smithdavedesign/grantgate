// Plain-English labels and a high/medium/low rating for Google OAuth scopes.
//
// Rating rule (see BUILD.md "Plan"):
//   high   - Google's "restricted" scopes (mail, all Drive files), plus anything that
//            sends mail as you, reads or edits all your Docs/Sheets/Slides, administers
//            your Workspace, controls Google Cloud or Ads, or publishes Chrome extensions.
//   medium - Google's "sensitive" scopes: personal data such as calendar, contacts, tasks.
//   low    - sign-in only, or access limited to files the app creates or you pick.
// Unrecognised scopes are medium, except under gmail./drive./admin. where they are high.

export type Rating = 'low' | 'medium' | 'high';

export interface KnownScope {
  scope: string;
  rating: Rating;
  /** Completes the sentence "This app wants to …". */
  label: string;
}

export interface ScopeLabel extends KnownScope {
  /** false when the scope is not in KNOWN_SCOPES and was rated by the fallback rule. */
  known: boolean;
}

export interface ScopeRisk {
  /** The highest rating among the scopes; low when there are none. */
  rating: Rating;
  /** One entry per distinct scope, in request order. */
  labels: ScopeLabel[];
}

const API = 'https://www.googleapis.com/auth/';

const RATING_ORDER: Record<Rating, number> = { low: 0, medium: 1, high: 2 };

const TABLE: ReadonlyArray<readonly [scope: string, rating: Rating, label: string]> = [
  // Sign-in
  ['openid', 'low', 'confirm who you are when you sign in'],
  ['email', 'low', 'see your email address'],
  ['profile', 'low', 'see your name and profile picture'],
  [`${API}userinfo.email`, 'low', 'see your email address'],
  [`${API}userinfo.profile`, 'low', 'see your name and profile picture'],
  [`${API}plus.me`, 'low', 'link you to your public Google profile'],

  // Gmail
  ['https://mail.google.com/', 'high', 'read, send, delete and manage all your email'],
  [`${API}gmail.readonly`, 'high', 'read all your email and email settings'],
  [`${API}gmail.modify`, 'high', 'read, send and change all your email, short of deleting it forever'],
  [`${API}gmail.compose`, 'high', 'write drafts and send email as you'],
  [`${API}gmail.send`, 'high', 'send email as you'],
  [`${API}gmail.insert`, 'high', 'add messages straight into your mailbox'],
  [`${API}gmail.metadata`, 'high', 'see who you email and the subject lines of all your email'],
  [`${API}gmail.settings.basic`, 'high', 'change your email settings and filters, which can forward your mail'],
  [`${API}gmail.settings.sharing`, 'high', 'change who else can read and send your email, including forwarding and delegates'],
  [`${API}gmail.labels`, 'low', 'see and edit your email labels'],
  [`${API}gmail.addons.execute`, 'medium', 'run as a Gmail add-on'],
  [`${API}gmail.addons.current.message.readonly`, 'medium', 'read the email you have open while the add-on runs'],
  [`${API}gmail.addons.current.message.metadata`, 'medium', 'see who sent the email you have open while the add-on runs'],
  [`${API}gmail.addons.current.message.action`, 'medium', 'read and act on the email you have open while the add-on runs'],
  [`${API}gmail.addons.current.action.compose`, 'medium', 'write email drafts while the add-on runs'],

  // Drive
  [`${API}drive`, 'high', 'see, edit, create and delete all your Google Drive files'],
  [`${API}drive.readonly`, 'high', 'see and download all your Google Drive files'],
  [`${API}drive.metadata`, 'high', 'see and change information about all your Google Drive files'],
  [`${API}drive.metadata.readonly`, 'high', 'see the names, owners and sharing of all your Google Drive files'],
  [`${API}drive.photos.readonly`, 'high', 'see the photos and videos in your Google Drive'],
  [`${API}drive.scripts`, 'high', 'change how your Google Apps Script projects behave'],
  [`${API}drive.activity`, 'high', 'see and add to the activity history of your Google Drive files'],
  [`${API}drive.activity.readonly`, 'high', 'see the activity history of your Google Drive files'],
  [`${API}drive.apps.readonly`, 'medium', 'see which apps are connected to your Google Drive'],
  [`${API}drive.file`, 'low', 'see and edit only the Drive files you open or create with this app'],
  [`${API}drive.appdata`, 'low', 'keep its own settings in a hidden folder in your Google Drive'],
  [`${API}drive.install`, 'low', 'add itself to the "Open with" menu in Google Drive'],

  // Docs, Sheets, Slides: every document of that kind, so rated like Drive
  [`${API}documents`, 'high', 'see, edit, create and delete all your Google Docs documents'],
  [`${API}documents.readonly`, 'high', 'see all your Google Docs documents'],
  [`${API}spreadsheets`, 'high', 'see, edit, create and delete all your Google Sheets spreadsheets'],
  [`${API}spreadsheets.readonly`, 'high', 'see all your Google Sheets spreadsheets'],
  [`${API}presentations`, 'high', 'see, edit, create and delete all your Google Slides presentations'],
  [`${API}presentations.readonly`, 'high', 'see all your Google Slides presentations'],
  ['https://docs.google.com/feeds/', 'high', 'see and change all your Google Docs and Drive files (old API)'],
  ['https://spreadsheets.google.com/feeds', 'high', 'see and change all your Google Sheets spreadsheets (old API)'],

  // Calendar
  [`${API}calendar`, 'medium', 'see, edit, share and permanently delete all your calendars'],
  [`${API}calendar.readonly`, 'medium', 'see everything on all your calendars'],
  [`${API}calendar.events`, 'medium', 'see and edit events on all your calendars'],
  [`${API}calendar.events.readonly`, 'medium', 'see events on all your calendars'],
  [`${API}calendar.settings.readonly`, 'low', 'see your calendar settings'],
  ['https://www.google.com/calendar/feeds', 'medium', 'see and change all your calendars (old API)'],

  // Contacts and profile details
  [`${API}contacts`, 'medium', 'see, edit, download and permanently delete your contacts'],
  [`${API}contacts.readonly`, 'medium', 'see and download your contacts'],
  [`${API}contacts.other.readonly`, 'medium', "see and download people you've emailed but not saved as contacts"],
  [`${API}directory.readonly`, 'medium', "see and download your organization's staff directory"],
  [`${API}user.emails.read`, 'medium', 'see all the email addresses on your Google account'],
  [`${API}user.phonenumbers.read`, 'medium', 'see your phone numbers'],
  [`${API}user.addresses.read`, 'medium', 'see your street addresses'],
  [`${API}user.birthday.read`, 'medium', 'see your birthday'],
  ['https://www.google.com/m8/feeds', 'medium', 'see and change your contacts (old API)'],

  // Workspace admin
  [`${API}admin.directory.user`, 'high', 'create, change and delete user accounts in your organization'],
  [`${API}admin.directory.user.readonly`, 'high', 'see every user account in your organization'],
  [`${API}admin.directory.group`, 'high', 'create, change and delete groups and their members in your organization'],
  [`${API}admin.directory.group.readonly`, 'high', 'see every group and its members in your organization'],
  [`${API}admin.reports.audit.readonly`, 'high', "see your organization's audit logs"],

  // Cloud, developer and money
  [`${API}cloud-platform`, 'high', 'see, change and delete your Google Cloud data and resources'],
  [`${API}cloud-platform.read-only`, 'medium', 'see your Google Cloud data and resources'],
  [`${API}chromewebstore`, 'high', 'publish and update your Chrome Web Store extensions'],
  [`${API}chromewebstore.readonly`, 'medium', 'see your Chrome Web Store extensions'],
  [`${API}script.projects`, 'high', 'create and change your Google Apps Script projects'],
  [`${API}adwords`, 'high', 'manage your Google Ads accounts and spending'],

  // Other personal data
  [`${API}tasks`, 'medium', 'see, edit and delete your Google Tasks'],
  [`${API}tasks.readonly`, 'medium', 'see your Google Tasks'],
  [`${API}youtube`, 'medium', 'manage your YouTube account'],
  [`${API}youtube.readonly`, 'medium', 'see your YouTube account'],
  [`${API}youtube.upload`, 'medium', 'upload videos to your YouTube channel'],
  [`${API}youtube.force-ssl`, 'medium', 'see, edit and permanently delete your YouTube videos, comments and captions'],
  [`${API}forms.body`, 'medium', 'see, edit and delete your Google Forms'],
  [`${API}forms.responses.readonly`, 'medium', 'see responses to your Google Forms'],
  [`${API}analytics.readonly`, 'medium', 'see your Google Analytics data'],
  [`${API}photospicker.mediaitems.readonly`, 'low', 'see only the Google Photos you pick'],
];

/** Every scope grantgate has a hand-written label for. */
export const KNOWN_SCOPES: readonly KnownScope[] = Object.freeze(
  TABLE.map(([scope, rating, label]) => Object.freeze({ scope, rating, label })),
);

const BY_KEY = new Map(KNOWN_SCOPES.map((entry) => [lookupKey(entry.scope), entry]));

// Unrecognised scopes in these API families are rated high: they reach mail,
// files or admin powers even when Google adds a new one.
const HIGH_RISK_FAMILIES: ReadonlyArray<readonly [prefix: string, what: string]> = [
  [`${API}gmail.`, 'access your Gmail'],
  [`${API}drive.`, 'access your Google Drive'],
  [`${API}admin.`, 'use admin powers over your organization'],
];

/** Labels each requested scope and rates the request as a whole. */
export function scopeRisk(scopes: readonly string[]): ScopeRisk {
  if (!Array.isArray(scopes)) throw new TypeError('scopeRisk expects an array of scope strings');
  const seen = new Set<string>();
  const labels: ScopeLabel[] = [];
  let rating: Rating = 'low';
  for (const raw of scopes) {
    if (typeof raw !== 'string') throw new TypeError('scopeRisk expects an array of scope strings');
    const scope = raw.trim();
    const key = lookupKey(scope);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    const label = labelScope(scope, key);
    labels.push(label);
    if (RATING_ORDER[label.rating] > RATING_ORDER[rating]) rating = label.rating;
  }
  return { rating, labels };
}

function labelScope(scope: string, key: string): ScopeLabel {
  const entry = BY_KEY.get(key);
  if (entry) return { scope, rating: entry.rating, label: entry.label, known: true };
  const family = HIGH_RISK_FAMILIES.find(([prefix]) => key.startsWith(prefix));
  if (family) {
    return { scope, rating: 'high', label: `${family[1]} in a way grantgate doesn't recognize (${scope})`, known: false };
  }
  return { scope, rating: 'medium', label: `use a permission grantgate doesn't recognize (${scope})`, known: false };
}

// Spellings that may name the same scope (case, http/https, trailing slash) share
// one key, so a variant can't dodge its rating or be counted twice.
function lookupKey(scope: string): string {
  return scope
    .trim()
    .toLowerCase()
    .replace(/^http:\/\//, 'https://')
    .replace(/\/+$/, '');
}
