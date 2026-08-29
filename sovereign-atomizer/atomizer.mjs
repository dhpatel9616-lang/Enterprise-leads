// Sovereign Atomizer
// Watches the Substack RSS feed for new issues. For each new issue, asks Claude
// to draft LinkedIn / X / Threads posts, then writes those drafts into the
// "Sovereign Content Calendar" Notion database (Status: Drafting) for approval.
//
// Nothing gets posted automatically — this only creates drafts for review.

import Parser from "rss-parser";
import { createClient } from "@supabase/supabase-js";

// ---- Config (env vars set as GitHub Actions secrets/variables) ----
const FEED_URL = process.env.SUBSTACK_FEED_URL || "https://sovereignnewsletter.substack.com/feed";
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID; // Sovereign Content Calendar database id
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SETTINGS_KEY = "sovereign_atomizer_last_seen";

const NOTION_VERSION = "2022-06-28";

function requireEnv(name, value) {
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}
requireEnv("NOTION_DATABASE_ID", NOTION_DATABASE_ID);
requireEnv("NOTION_API_KEY", NOTION_API_KEY);
requireEnv("ANTHROPIC_API_KEY", ANTHROPIC_API_KEY);
requireEnv("SUPABASE_URL", SUPABASE_URL);
requireEnv("SUPABASE_SERVICE_KEY", SUPABASE_SERVICE_KEY);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function getProcessedGuids() {
  const { data, error } = await supabase
    .from("settings")
    .select("value")
    .eq("key", SETTINGS_KEY)
    .maybeSingle();
  if (error) throw error;
  return data?.value?.processed_guids || [];
}

async function saveProcessedGuids(guids) {
  const { error } = await supabase
    .from("settings")
    .upsert({ key: SETTINGS_KEY, value: { processed_guids: guids }, updated_at: new Date().toISOString() });
  if (error) throw error;
}

async function draftSocialCopy({ title, link, content }) {
  const prompt = `You are writing social copy for "The Sovereign," a civic media platform (newsletter, podcast, advocacy arm) aimed at students and young professionals interested in policy and civic engagement. The tone is credible, energetic, non-partisan, and accessible — never partisan, never legal/policy advice, never referencing any specific government employer or classified/internal work.

Here is the newsletter issue to atomize:

Title: ${title}
Link: ${link}
Content:
${content}

Write three short, distinct social posts promoting this issue and driving people to subscribe/read:
1. LINKEDIN: professional tone, 3-5 sentences, ends with a call to read/subscribe.
2. X: under 280 characters, punchy hook.
3. THREADS: conversational, 2-3 sentences, more personal voice.

Return ONLY the three posts, each on its own line, prefixed exactly with "LINKEDIN:", "X:", and "THREADS:" — no other commentary.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const text = data.content.map((b) => (b.type === "text" ? b.text : "")).join("\n").trim();
  return text;
}

async function createNotionDraftPage({ title, link, socialCopy }) {
  const today = new Date().toISOString().slice(0, 10);

  const body = {
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      Title: { title: [{ text: { content: `[Social Drafts] ${title}` } }] },
      Format: { select: { name: "Social" } },
      Status: { select: { name: "Drafting" } },
      "Publish Date": { date: { start: today } },
      "Ties Back To": { rich_text: [{ text: { content: link } }] },
    },
    children: socialCopy
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => ({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: line.slice(0, 2000) } }] },
      })),
  };

  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Notion API error: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  const parser = new Parser();
  const feed = await parser.parseURL(FEED_URL);
  const processedGuids = await getProcessedGuids();

  // Oldest first, so drafts land in Notion in chronological order.
  const items = [...feed.items].reverse();
  const newItems = items.filter((item) => !processedGuids.includes(item.guid || item.link));

  if (newItems.length === 0) {
    console.log("No new Sovereign issues since last run.");
    return;
  }

  console.log(`Found ${newItems.length} new issue(s) to atomize.`);

  const updatedGuids = [...processedGuids];

  for (const item of newItems) {
    const title = item.title || "Untitled issue";
    const link = item.link || "";
    const content = item["content:encoded"] || item.content || item.contentSnippet || "";

    console.log(`Drafting social copy for: ${title}`);
    const socialCopy = await draftSocialCopy({ title, link, content });

    console.log(`Writing draft page to Notion for: ${title}`);
    await createNotionDraftPage({ title, link, socialCopy });

    updatedGuids.push(item.guid || item.link);
    // Save progress after each item so a mid-run failure doesn't reprocess earlier ones.
    await saveProcessedGuids(updatedGuids);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
