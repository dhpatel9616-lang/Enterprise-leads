/**
 * Checks every actively-sequenced lead's Gmail thread for a reply.
 * Run BEFORE outreach-sequencer.js in the daily schedule, so a reply
 * that came in overnight pauses that lead's sequence before today's
 * touch would otherwise fire.
 *
 * A lead is "replied" if its Gmail thread contains any message NOT
 * sent from your own address — good enough for a single-user setup
 * where you're the only one sending from that account.
 *
 * Requires SUPABASE_URL, SUPABASE_SERVICE_KEY, GMAIL_CLIENT_ID,
 * GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN. No-ops safely if any are
 * missing.
 */
const { createClient } = require('@supabase/supabase-js');
const { getOwnEmailAddress, getThreadMessages } = require('./lib/gmail');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = '2022-06-28';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_REFRESH_TOKEN) {
  console.log('check-replies: one or more required secrets are missing. Skipping run.');
  process.exit(0);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function fromHeader(message) {
  return (message.payload?.headers || []).find((h) => h.name === 'From')?.value || '';
}

async function threadHasReply(threadId, ownEmail) {
  const messages = await getThreadMessages(threadId);
  return messages.some((m) => !fromHeader(m).toLowerCase().includes(ownEmail.toLowerCase()));
}

// Appends a note to the lead's Raw Notes in Notion so the reply is
// visible there too, not just inferred from a frozen Outreach Step.
async function noteReplyInNotion(lead) {
  if (!NOTION_TOKEN || !lead.notion_page_id) return;
  const getRes = await fetch(`https://api.notion.com/v1/pages/${lead.notion_page_id}`, {
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION },
  });
  const page = await getRes.json();
  const currentNotes = page.properties?.['Raw Notes']?.rich_text?.[0]?.plain_text || '';
  const updatedNotes = `${currentNotes}\n\n✅ Replied on ${new Date().toISOString().slice(0, 10)} — outreach sequence paused.`;

  await fetch(`https://api.notion.com/v1/pages/${lead.notion_page_id}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ properties: { 'Raw Notes': { rich_text: [{ text: { content: updatedNotes.slice(0, 2000) } }] } } }),
  });
}

async function run() {
  const { data: leads, error } = await supabase
    .from('leads')
    .select('*')
    .in('status', ['new', 'contacted'])
    .not('gmail_thread_id', 'is', null);
  if (error) throw error;

  if (!leads || leads.length === 0) {
    console.log('check-replies: no leads with an active thread yet.');
    return;
  }

  const ownEmail = await getOwnEmailAddress();
  let repliedCount = 0;

  for (const lead of leads) {
    try {
      const replied = await threadHasReply(lead.gmail_thread_id, ownEmail);
      if (replied) {
        await supabase.from('leads').update({ status: 'replied' }).eq('id', lead.id);
        await noteReplyInNotion(lead);
        repliedCount++;
        console.log(`check-replies: ${lead.business_name} replied — sequence paused.`);
      }
    } catch (err) {
      console.error(`check-replies: failed checking ${lead.business_name}:`, err.message);
    }
  }

  console.log(`check-replies: checked ${leads.length} active leads, ${repliedCount} new replies found.`);
}

run().catch((err) => {
  console.error('check-replies failed:', err);
  process.exit(1);
});
