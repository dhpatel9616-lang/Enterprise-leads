// Sends and reads Gmail on your behalf using the OAuth refresh token
// generated via the OAuth Playground (one-time setup, doesn't expire).
// No googleapis SDK — just plain REST calls, consistent with the rest
// of this codebase's zero-dependency style.

// Cached for the life of this process — every Gmail call in a run was
// previously exchanging its own fresh access token, which alone doubled
// the API calls per lead and was the main driver of hitting Gmail's
// per-minute quota partway through a run.
let cachedAccessToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < cachedTokenExpiresAt) return cachedAccessToken;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gmail token refresh failed: ${JSON.stringify(data)}`);

  cachedAccessToken = data.access_token;
  // Tokens last ~3600s; refresh a couple minutes early to be safe.
  cachedTokenExpiresAt = Date.now() + ((data.expires_in || 3000) - 120) * 1000;
  return cachedAccessToken;
}

function base64url(str) {
  return Buffer.from(str, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function buildRawMessage({ to, subject, html, replyTo }) {
  const headers = [`To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0', 'Content-Type: text/html; charset=UTF-8'];
  if (replyTo) headers.push(`Reply-To: ${replyTo}`);
  return base64url(`${headers.join('\r\n')}\r\n\r\n${html}`);
}

// Sends an email as the authenticated Gmail account immediately. Pass
// threadId to keep a follow-up grouped in the same Gmail conversation as
// earlier touches. Returns { id, threadId } — save threadId to track
// this lead's conversation for reply-detection. Kept for check-replies.js
// and any script that genuinely wants an immediate send (not used by
// outreach-sequencer.js anymore — that creates drafts instead, see below).
async function sendGmail({ to, subject, html, replyTo, threadId }) {
  const accessToken = await getAccessToken();
  const raw = buildRawMessage({ to, subject, html, replyTo });
  const body = { raw };
  if (threadId) body.threadId = threadId;

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gmail send failed: ${JSON.stringify(data)}`);
  return data;
}

// Creates a DRAFT instead of sending — the message sits in the Gmail
// Drafts folder until a human reviews and sends it. Returns
// { id, message: { id, threadId } }. Save the returned draft `id` so a
// later run can check draftStillPending() to detect whether it was sent.
async function createDraft({ to, subject, html, replyTo, threadId }) {
  const accessToken = await getAccessToken();
  const raw = buildRawMessage({ to, subject, html, replyTo });
  const message = { raw };
  if (threadId) message.threadId = threadId;

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gmail draft creation failed: ${JSON.stringify(data)}`);
  return data;
}

// Returns true if the draft still exists (still sitting unreviewed in the
// Drafts folder). Returns false if it's gone — meaning it was either sent
// (Gmail converts a sent draft into a normal sent message, and the draft
// id stops resolving) or manually deleted. This library can't tell those
// two apart; the caller treats "gone" as "sent" and documents that
// assumption to the person.
async function draftStillPending(draftId) {
  const accessToken = await getAccessToken();
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${draftId}?format=minimal`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return false;
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`Gmail draft check failed: ${JSON.stringify(data)}`);
  }
  return true;
}

// Sends an existing draft exactly as it sits in the Drafts folder (including
// any edits made to it in Gmail). Returns the sent message { id, threadId }.
async function sendDraft(draftId) {
  const accessToken = await getAccessToken();
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: draftId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gmail draft send failed: ${JSON.stringify(data)}`);
  return data;
}

// The Gmail address the automation is authorized as — used by
// check-replies.js to tell "a reply came in" apart from "this is one
// of our own sent messages."
async function getOwnEmailAddress() {
  const accessToken = await getAccessToken();
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gmail profile fetch failed: ${JSON.stringify(data)}`);
  return data.emailAddress;
}

async function getThreadMessages(threadId) {
  const accessToken = await getAccessToken();
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=metadata&metadataHeaders=From`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Gmail thread fetch failed: ${JSON.stringify(data)}`);
  return data.messages || [];
}

module.exports = { sendGmail, createDraft, draftStillPending, sendDraft, getOwnEmailAddress, getThreadMessages };
