// Twenty Google OAuth authorize URLs shaped like the ones real apps send, with the
// values grantgate must read from each. Client IDs are made up; none of these apps exist.
import type { Rating } from '../../src/scopes.ts';

export interface AuthorizeFixture {
  name: string;
  url: string;
  client_id: string;
  scopes: string[];
  redirect_uri: string;
  rating: Rating;
}

const API = 'https://www.googleapis.com/auth/';

export const AUTHORIZE_FIXTURES: readonly AuthorizeFixture[] = [
  {
    name: 'roadmap example: full Gmail plus openid',
    url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc.apps.googleusercontent.com&scope=https%3A%2F%2Fmail.google.com%2F%20openid&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&response_type=code',
    client_id: 'abc.apps.googleusercontent.com',
    scopes: ['https://mail.google.com/', 'openid'],
    redirect_uri: 'https://app.example/cb',
    rating: 'high',
  },
  {
    name: 'plain "Sign in with Google", plus-separated scopes',
    url: 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=100000000002-signin.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fnotes.example%2Fauth%2Fgoogle%2Fcallback&scope=openid+email+profile&state=st02&nonce=n02',
    client_id: '100000000002-signin.apps.googleusercontent.com',
    scopes: ['openid', 'email', 'profile'],
    redirect_uri: 'https://notes.example/auth/google/callback',
    rating: 'low',
  },
  {
    name: 'legacy /o/oauth2/auth endpoint with userinfo scopes',
    url: 'https://accounts.google.com/o/oauth2/auth?client_id=100000000003-legacy.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fforum.example%2Foauth2callback&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.profile&approval_prompt=force',
    client_id: '100000000003-legacy.apps.googleusercontent.com',
    scopes: [`${API}userinfo.email`, `${API}userinfo.profile`],
    redirect_uri: 'https://forum.example/oauth2callback',
    rating: 'low',
  },
  {
    name: '"PDF tool" asking for all of Drive, offline',
    url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=100000000004-pdfmerge.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fpdfmerge.example%2Fapi%2Foauth%2Fgoogle&response_type=code&access_type=offline&prompt=consent&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email',
    client_id: '100000000004-pdfmerge.apps.googleusercontent.com',
    scopes: [`${API}drive`, `${API}userinfo.email`],
    redirect_uri: 'https://pdfmerge.example/api/oauth/google',
    rating: 'high',
  },
  {
    name: '"email tracker" reading and sending mail',
    url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=100000000005-mailtrack.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Ftracker.example%2Foauth%2Fcallback&response_type=code&access_type=offline&scope=openid%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.readonly%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.send&include_granted_scopes=true&state=st05',
    client_id: '100000000005-mailtrack.apps.googleusercontent.com',
    scopes: ['openid', `${API}gmail.readonly`, `${API}gmail.send`],
    redirect_uri: 'https://tracker.example/oauth/callback',
    rating: 'high',
  },
  {
    name: 'meeting scheduler editing calendar events',
    url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=100000000006-scheduler.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fbook.example%2Fintegrations%2Fgoogle%2Fcallback&response_type=code&scope=openid%20email%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.events&access_type=offline',
    client_id: '100000000006-scheduler.apps.googleusercontent.com',
    scopes: ['openid', 'email', `${API}calendar.events`],
    redirect_uri: 'https://book.example/integrations/google/callback',
    rating: 'medium',
  },
  {
    name: 'CRM contact sync with the company directory',
    url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=100000000007-crmsync.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fcrm.example%2Fgoogle%2Fcontacts%2Fcallback&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcontacts.readonly%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdirectory.readonly',
    client_id: '100000000007-crmsync.apps.googleusercontent.com',
    scopes: [`${API}contacts.readonly`, `${API}directory.readonly`],
    redirect_uri: 'https://crm.example/google/contacts/callback',
    rating: 'medium',
  },
  {
    name: 'e-signature app using the per-file Drive picker, PKCE',
    url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=100000000008-picker.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fsign.example%2Fcb&response_type=code&scope=openid%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file&code_challenge=fixture08challenge&code_challenge_method=S256',
    client_id: '100000000008-picker.apps.googleusercontent.com',
    scopes: ['openid', `${API}drive.file`],
    redirect_uri: 'https://sign.example/cb',
    rating: 'low',
  },
  {
    name: 'fake "Privacy Policy Extension" wanting the Chrome Web Store',
    url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=100000000009-privacypolicy.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fprivacy-policy-extension.example%2Fauth&response_type=code&access_type=offline&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fchromewebstore',
    client_id: '100000000009-privacypolicy.apps.googleusercontent.com',
    scopes: [`${API}chromewebstore`],
    redirect_uri: 'https://privacy-policy-extension.example/auth',
    rating: 'high',
  },
  {
    name: 'org chart tool asking for Workspace admin directory access',
    url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=100000000010-orgchart.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Forgchart.example%2Foauth&response_type=code&hd=firm.example&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fadmin.directory.user.readonly%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fadmin.directory.group',
    client_id: '100000000010-orgchart.apps.googleusercontent.com',
    scopes: [`${API}admin.directory.user.readonly`, `${API}admin.directory.group`],
    redirect_uri: 'https://orgchart.example/oauth',
    rating: 'high',
  },
  {
    name: 'reporting add-on editing every spreadsheet',
    url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=100000000011-sheetreports.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Freports.example%2Foauth%2Fgoogle&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fspreadsheets%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.appdata',
    client_id: '100000000011-sheetreports.apps.googleusercontent.com',
    scopes: [`${API}spreadsheets`, `${API}drive.appdata`],
    redirect_uri: 'https://reports.example/oauth/google',
    rating: 'high',
  },
  {
    name: 'account-chooser step of the legacy endpoint, Gmail modify',
    url: 'https://accounts.google.com/o/oauth2/auth/oauthchooseaccount?client_id=100000000012-inboxzero.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Finbox.example%2Fcallback&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.modify&access_type=offline&flowName=GeneralOAuthFlow',
    client_id: '100000000012-inboxzero.apps.googleusercontent.com',
    scopes: [`${API}gmail.modify`],
    redirect_uri: 'https://inbox.example/callback',
    rating: 'high',
  },
  {
    name: 'upper-case host, calendar read-only',
    url: 'https://ACCOUNTS.GOOGLE.COM/o/oauth2/v2/auth?client_id=100000000013-calview.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fcal.example%2Fcb&response_type=code&scope=profile%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.readonly',
    client_id: '100000000013-calview.apps.googleusercontent.com',
    scopes: ['profile', `${API}calendar.readonly`],
    redirect_uri: 'https://cal.example/cb',
    rating: 'medium',
  },
  {
    name: 'Gmail scope hidden in a second scope parameter',
    url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=100000000014-splitscope.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fsplit.example%2Fcb&response_type=code&scope=openid&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.readonly',
    client_id: '100000000014-splitscope.apps.googleusercontent.com',
    scopes: ['openid', `${API}gmail.readonly`],
    redirect_uri: 'https://split.example/cb',
    rating: 'high',
  },
  {
    name: 'messy whitespace and a repeated scope',
    url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=100000000015-messy.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fmessy.example%2Fcb&response_type=code&scope=%20profile%20%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.readonly%20profile%20',
    client_id: '100000000015-messy.apps.googleusercontent.com',
    scopes: ['profile', `${API}drive.readonly`],
    redirect_uri: 'https://messy.example/cb',
    rating: 'high',
  },
  {
    name: 'cloud cost CLI with a localhost redirect',
    url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=100000000016-cloudcost.apps.googleusercontent.com&redirect_uri=http%3A%2F%2Flocalhost%3A8085%2F&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email&access_type=offline',
    client_id: '100000000016-cloudcost.apps.googleusercontent.com',
    scopes: [`${API}cloud-platform`, `${API}userinfo.email`],
    redirect_uri: 'http://localhost:8085/',
    rating: 'high',
  },
  {
    name: 'to-do sync using the implicit (token) flow',
    url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=100000000017-todosync.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Ftodo.example%2Foauth.html&response_type=token&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Ftasks',
    client_id: '100000000017-todosync.apps.googleusercontent.com',
    scopes: [`${API}tasks`],
    redirect_uri: 'https://todo.example/oauth.html',
    rating: 'medium',
  },
  {
    name: 'Google Identity Services popup with a storagerelay redirect',
    url: 'https://accounts.google.com/o/oauth2/v2/auth?gsiwebsdk=3&client_id=100000000018-tubestats.apps.googleusercontent.com&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fyoutube.readonly&redirect_uri=storagerelay%3A%2F%2Fhttps%2Ftubestats.example%3Fid%3Dauth18&prompt=consent&access_type=offline&response_type=code&include_granted_scopes=true&enable_granular_consent=true',
    client_id: '100000000018-tubestats.apps.googleusercontent.com',
    scopes: [`${API}youtube.readonly`],
    redirect_uri: 'storagerelay://https/tubestats.example?id=auth18',
    rating: 'medium',
  },
  {
    name: 'v2 account chooser: Gmail labels, metadata and filter settings',
    url: 'https://accounts.google.com/o/oauth2/v2/auth/oauthchooseaccount?client_id=100000000019-mailsort.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fmailsort.example%2Foauth&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.labels%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.metadata%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.settings.basic&service=lso&o2v=2&flowName=GeneralOAuthFlow',
    client_id: '100000000019-mailsort.apps.googleusercontent.com',
    scopes: [`${API}gmail.labels`, `${API}gmail.metadata`, `${API}gmail.settings.basic`],
    redirect_uri: 'https://mailsort.example/oauth',
    rating: 'high',
  },
  {
    name: 'desktop exporter on a loopback redirect, URL with a fragment',
    url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=100000000020-docexport.apps.googleusercontent.com&redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2F&response_type=code&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdocuments.readonly%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.metadata.readonly&state=st20#section',
    client_id: '100000000020-docexport.apps.googleusercontent.com',
    scopes: [`${API}documents.readonly`, `${API}drive.metadata.readonly`],
    redirect_uri: 'http://127.0.0.1:53682/',
    rating: 'high',
  },
];
