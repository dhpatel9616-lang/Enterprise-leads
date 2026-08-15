// Sends and reads Gmail on your behalf using the OAuth refresh token
// generated via the OAuth Playground (one-time setup, doesn't expire).
// No googleapis SDK — just plain REST calls, consistent with the rest
// of this codebase's zero-dependency style.

async function getAccessToken() {
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
  return data.access_token;
}

function base64url(str) {
  return Buffer.from(str, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Sends an email as the authenticated Gmail account. Pass threadId to
// keep a follow-up grouped in the same Gmail conversation as earlier
// touches. Returns { id, threadId } — save threadId to track this
// lead's conversation for reply-detection.
async function sendGmail({ to, subject, html, replyTo, threadId }) {
  const accessToken = await getAccessToken();
  const headers = [`To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0', 'Content-Type: text/html; charset=UTF-8'];
  if (replyTo) headers.push(`Reply-To: ${replyTo}`);

  const raw = base64url(`${headers.join('\r\n')}\r\n\r\n${html}`);
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

module.exports = { sendGmail, getOwnEmailAddress, getThreadMessages };
