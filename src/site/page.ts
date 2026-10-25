// The landing page's script (served as /page.js). The forms work without it, as
// plain posts; with it, a sign-up is sent as JSON and the reply is shown in place.
// Server text is only ever rendered with textContent.

export const SENDING = 'Sending…';
export const NETWORK_ERROR = "grantgate couldn't be reached. Check your connection and try again.";
export const UNEXPECTED_REPLY = 'Something went wrong on our side. Please try again in a minute.';
export const CHECKOUT_SOON = "Pre-orders open soon. Join the waitlist below and you'll hear first.";

export interface FormEnv {
  form: HTMLFormElement;
  /** The live region that shows progress and the reply. */
  status: HTMLElement;
  /** The form's fields as strings (unticked checkboxes are absent). */
  values(): Record<string, string>;
  fetch(url: string, init: RequestInit): Promise<Response>;
}

type Reply = { ok: true; message: string } | { ok: false; error: string };

/** Sends the form with fetch instead of a page load. */
export function enhanceForm(env: FormEnv): void {
  const { form, status } = env;
  let pending = false;
  const setButtons = (disabled: boolean) => {
    for (const button of form.querySelectorAll('button')) button.disabled = disabled;
  };
  const show = (text: string, kind: 'success' | 'error' | '') => {
    status.textContent = text;
    status.className = kind ? `form-status ${kind}` : 'form-status';
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending) return;
    pending = true;
    setButtons(true);
    show(SENDING, '');
    const reply = await send(env);
    if (reply.ok) {
      form.hidden = true;
      show(reply.message, 'success');
      return;
    }
    show(reply.error, 'error');
    setButtons(false);
    pending = false;
  });
}

async function send(env: FormEnv): Promise<Reply> {
  let response: Response;
  try {
    response = await env.fetch(env.form.getAttribute('action') ?? '/api/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(env.values()),
    });
  } catch {
    return { ok: false, error: NETWORK_ERROR };
  }
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const { ok, message, error } = body as Record<string, unknown>;
      if (ok === true && typeof message === 'string') return { ok, message };
      if (ok === false && typeof error === 'string') return { ok, error };
    }
  } catch {
    // Not JSON: a proxy error page, say.
  }
  return { ok: false, error: UNEXPECTED_REPLY };
}

/** After "Pre-order" while checkout isn't open, says so above the waitlist form. */
export function showCheckoutNotice(notice: HTMLElement | null, search: string): boolean {
  if (notice === null || new URLSearchParams(search).get('checkout') !== 'soon') return false;
  notice.textContent = CHECKOUT_SOON;
  notice.hidden = false;
  return true;
}

function main(): void {
  for (const form of document.querySelectorAll<HTMLFormElement>('form[data-waitlist]')) {
    const status = document.getElementById(form.dataset.status ?? '');
    if (!status) continue;
    enhanceForm({
      form,
      status,
      values() {
        const values: Record<string, string> = {};
        new FormData(form).forEach((value, name) => {
          if (typeof value === 'string') values[name] = value;
        });
        return values;
      },
      fetch: (url, init) => fetch(url, init),
    });
  }
  showCheckoutNotice(document.getElementById('checkout-notice'), location.search);
}

if (typeof document !== 'undefined' && typeof location !== 'undefined') main();
