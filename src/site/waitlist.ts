// The landing page's waitlist: what a sign-up is, how the form is read, and where
// sign-ups are kept. Runs in the Vercel function and the local server, never in
// the extension.
//
// The store is a single Postgres table (Neon free tier in production). Every
// query takes its values as $n parameters; no user text is ever put into SQL.

export const ROLES = ['owner', 'office-manager', 'it-provider', 'individual', 'other'] as const;
export type Role = (typeof ROLES)[number];

export const TEAM_SIZES = ['1', '2-4', '5-50', '51+'] as const;
export type TeamSize = (typeof TEAM_SIZES)[number];

/** The longest address SMTP can deliver to (RFC 5321). */
export const MAX_EMAIL_LENGTH = 254;

/** A field people never see. Bots that fill it in are told they joined and are not stored. */
export const HONEYPOT_FIELD = 'website';

export interface Signup {
  email: string;
  role: Role | null;
  teamSize: TeamSize | null;
  /** Ticked "I'm happy to do a 15-minute call". */
  interview: boolean;
}

export type ParsedForm =
  | { ok: true; action: 'join'; signup: Signup; bot: boolean }
  | { ok: true; action: 'leave'; email: string; bot: boolean }
  | { ok: false; error: 'invalid-email' | 'invalid-action' };

export interface WaitlistStore {
  /** Adds a sign-up, or fills in blanks on an existing one. */
  join(signup: Signup): Promise<void>;
  /** Removes an address; does nothing if it isn't there. */
  leave(email: string): Promise<void>;
}

/** The one method of Neon's HTTP client that the store uses. */
export interface SqlClient {
  query(text: string, params: unknown[]): Promise<unknown>;
}

export const WAITLIST_SCHEMA = `CREATE TABLE IF NOT EXISTS waitlist (
  email text PRIMARY KEY CHECK (char_length(email) <= ${MAX_EMAIL_LENGTH}),
  role text,
  team_size text,
  interview boolean NOT NULL DEFAULT false,
  joined_at timestamptz NOT NULL DEFAULT now()
)`;

// A repeat sign-up only fills in blanks and can only switch the call opt-in on, so
// nobody can overwrite another person's answers by typing their address.
export const JOIN_SQL = `INSERT INTO waitlist (email, role, team_size, interview) VALUES ($1, $2, $3, $4)
ON CONFLICT (email) DO UPDATE SET role = COALESCE(waitlist.role, EXCLUDED.role), team_size = COALESCE(waitlist.team_size, EXCLUDED.team_size), interview = waitlist.interview OR EXCLUDED.interview`;

export const LEAVE_SQL = 'DELETE FROM waitlist WHERE email = $1';

/** For the Neon SQL editor: the people who offered a call (see docs/interview-script.md). */
export const INTERVIEW_QUERY = 'SELECT email, role, team_size, joined_at FROM waitlist WHERE interview ORDER BY joined_at';

// The HTML spec's rule for <input type=email>, so the browser and the server agree,
// except that the domain must contain a dot (no "owner@localhost").
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const TICKED = new Set<unknown>(['yes', 'on', 'true', true]);

/** A trimmed, lower-cased address, or null when it isn't one plausible address. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL.test(email)) return null;
  return email;
}

/** Reads the waitlist form's fields (from JSON or a form post). Never throws. */
export function parseWaitlistForm(fields: Record<string, unknown>): ParsedForm {
  const action = fields.action ?? 'join';
  if (action !== 'join' && action !== 'leave') return { ok: false, error: 'invalid-action' };
  const email = normalizeEmail(fields.email);
  if (email === null) return { ok: false, error: 'invalid-email' };
  const honeypot = fields[HONEYPOT_FIELD];
  const bot = typeof honeypot === 'string' && honeypot.trim() !== '';
  if (action === 'leave') return { ok: true, action, email, bot };
  return {
    ok: true,
    action,
    bot,
    signup: {
      email,
      role: oneOf(ROLES, fields.role),
      teamSize: oneOf(TEAM_SIZES, fields.team_size),
      interview: TICKED.has(fields.interview),
    },
  };
}

/** The production store: one table, created on first use by each function instance. */
export function sqlStore(sql: SqlClient): WaitlistStore {
  let ready: Promise<void> | null = null;
  // Two cold starts creating the table at once can make one fail; forget the
  // failure so the next request tries again.
  const ensureTable = () =>
    (ready ??= sql.query(WAITLIST_SCHEMA, []).then(
      () => undefined,
      (error: unknown) => {
        ready = null;
        throw error;
      },
    ));
  return {
    async join(signup) {
      await ensureTable();
      await sql.query(JOIN_SQL, [signup.email, signup.role, signup.teamSize, signup.interview]);
    },
    async leave(email) {
      await ensureTable();
      await sql.query(LEAVE_SQL, [email]);
    },
  };
}

export interface StoredSignup extends Signup {
  joinedAt: Date;
}

export interface MemoryStore extends WaitlistStore {
  readonly rows: Map<string, StoredSignup>;
  /** What INTERVIEW_QUERY returns, oldest first. */
  interviewVolunteers(): StoredSignup[];
}

/** For local runs and tests: the SQL store's behaviour, kept in memory. */
export function memoryStore(): MemoryStore {
  const rows = new Map<string, StoredSignup>();
  return {
    rows,
    async join(signup) {
      const existing = rows.get(signup.email);
      if (!existing) {
        rows.set(signup.email, { ...signup, joinedAt: new Date() });
        return;
      }
      existing.role ??= signup.role;
      existing.teamSize ??= signup.teamSize;
      existing.interview ||= signup.interview;
    },
    async leave(email) {
      rows.delete(email);
    },
    interviewVolunteers() {
      return [...rows.values()].filter((row) => row.interview).sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
    },
  };
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}
