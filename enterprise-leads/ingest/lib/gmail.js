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


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every Gmail API call goes through here. Gmail limits how much each
// account can do per minute; when it says "slow down" (429, or 403 with
// rateLimitExceeded), wait and retry instead of failing the lead.
async function gmailFetch(url, options = {}) {
  for (let attempt = 1; ; attempt++) {
    const accessToken = await getAccessToken();
    const res = await fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${accessToken}` } });
    if (res.status === 429 || res.status === 403) {
      const text = await res.text();
      if (/rateLimitExceeded|RESOURCE_EXHAUSTED|Quota exceeded|userRateLimitExceeded/i.test(text) && attempt < 5) {
        await sleep(15000 * attempt);
        continue;
      }
      return new Response(text, { status: res.status, headers: res.headers });
    }
    return res;
  }
}

function base64url(str) {
  return Buffer.from(str, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Non-ASCII subjects/names (e.g. "Engel & Völkers") must be encoded
// per RFC 2047 or some mail servers mangle them.
function encodeHeader(value) {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`;
}

// Builds the raw email. Cold outreach goes out as PLAIN TEXT with a
// minimal HTML twin (multipart/alternative) — plain, personal-looking
// email lands in the inbox far more often than designed HTML email.
// Pass `text` for that. Passing only `html` keeps the old behavior.
function buildRawMessage({ to, subject, html, text, replyTo, fromName, fromEmail }) {
  const headers = [`To: ${to}`, `Subject: ${encodeHeader(subject)}`, 'MIME-Version: 1.0'];
  if (fromName && fromEmail) headers.unshift(`From: ${encodeHeader(fromName)} <${fromEmail}>`);
  if (replyTo) headers.push(`Reply-To: ${replyTo}`);

  if (!text) {
    headers.push('Content-Type: text/html; charset=UTF-8');
    return base64url(`${headers.join('\r\n')}\r\n\r\n${html}`);
  }

  const boundary = `wc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const htmlPart =
    html ||
    `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#222;">${text
      .split('\n')
      .map((line) => line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>') || '&nbsp;')
      .join('<br>')}</div>`;
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    htmlPart,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return base64url(`${headers.join('\r\n')}\r\n\r\n${body}`);
}

// Sends an email as the authenticated Gmail account immediately. Pass
// threadId to keep a follow-up grouped in the same Gmail conversation as
// earlier touches. Returns { id, threadId } — save threadId to track
// this lead's conversation for reply-detection.
async function sendGmail({ to, subject, html, text, replyTo, threadId, fromName, fromEmail }) {
  const raw = buildRawMessage({ to, subject, html, text, replyTo, fromName, fromEmail });
  const body = { raw };
  if (threadId) body.threadId = threadId;

  const res = await gmailFetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
async function createDraft({ to, subject, html, text, replyTo, threadId, fromName, fromEmail }) {
  const raw = buildRawMessage({ to, subject, html, text, replyTo, fromName, fromEmail });
  const message = { raw };
  if (threadId) message.threadId = threadId;

  const res = await gmailFetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  const res = await gmailFetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${draftId}?format=minimal`);
  if (res.status === 404) return false;
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`Gmail draft check failed: ${JSON.stringify(data)}`);
  }
  return true;
}

// The Gmail address the automation is authorized as — used by
// check-replies.js to tell "a reply came in" apart from "this is one
// of our own sent messages."
async function getOwnEmailAddress() {
  const res = await gmailFetch('https://gmail.googleapis.com/gmail/v1/users/me/profile');
  const data = await res.json();
  if (!res.ok) throw new Error(`Gmail profile fetch failed: ${JSON.stringify(data)}`);
  return data.emailAddress;
}

// Sends an EXISTING draft exactly as it was written. Used to clear out
// touch-1 drafts left over from the old "draft, then a human sends it"
// flow: if a draft is still sitting there, sending that same draft
// (instead of composing a fresh email) guarantees nobody gets two copies.
// Returns { id, threadId } of the sent message.
async function sendDraft(draftId) {
  const res = await gmailFetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: draftId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gmail draft send failed: ${JSON.stringify(data)}`);
  return data;
}

// Deletes a draft. A 404 means it's already gone, which is fine.
async function deleteDraft(draftId) {
  const res = await gmailFetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${draftId}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 404) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`Gmail draft delete failed: ${JSON.stringify(data)}`);
  }
}

// Returns every message in a thread with From + Subject headers, the
// label list (DRAFT / SENT / INBOX), and Gmail's short text snippet —
// enough for check-replies.js to tell a real reply apart from a bounce
// notice, an out-of-office auto-reply, or an unsubscribe request.
async function getThreadMessages(threadId) {
  const res = await gmailFetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Auto-Submitted`);
  const data = await res.json();
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Gmail thread fetch failed: ${JSON.stringify(data)}`);
  return data.messages || [];
}

// True if Gmail bounced one of our own sends for hitting the account's daily
// sending limit in the last 24 hours. Those notices mean "never sent", and
// sending more only produces more of them.
async function recentSendLimitHit() {
  const q = encodeURIComponent('from:mailer-daemon newer_than:1d "limit for sending"');
  const res = await gmailFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1&q=${q}`);
  if (!res.ok) throw new Error(`Gmail search failed: ${res.status}`);
  const data = await res.json();
  return (data.messages || []).length > 0;
}

module.exports = { recentSendLimitHit, sendGmail, createDraft, sendDraft, deleteDraft, draftStillPending, getOwnEmailAddress, getThreadMessages };
