// Sovereign Atomizer
// Watches the Substack RSS feed for new issues. For each new issue, asks Claude
// to draft LinkedIn / X / Threads posts, then writes those drafts into the
// "Sovereign Content Calendar" Notion database (Status: Drafting) for approval.
//
// Nothing gets posted automatically — this only creates drafts for review.

import { createClient } from "@supabase/supabase-js";

// ---- Config (env vars set as GitHub Actions secrets/variables) ----
const FEED_URL = process.env.SUBSTACK_FEED_URL || "https://sovereignnewsletter.substack.com/feed";
const RSS2JSON_URL = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(FEED_URL)}`;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID; // Sovereign Content Calendar database id
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
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
requireEnv("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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

Write five short, distinct posts promoting this issue and driving people to subscribe/read:
1. LINKEDIN: professional tone, 3-5 sentences, ends with a call to read/subscribe.
2. X: under 280 characters, punchy hook.
3. THREADS: conversational, 2-3 sentences, more personal voice.
4. INSTAGRAM: caption for a graphic card post — 2-4 sentences plus 3-5 relevant hashtags on their own line at the end.
5. TIKTOK: short caption/description for a photo-mode post — one punchy sentence plus 3-5 relevant hashtags.

Return ONLY the five posts, each on its own line, prefixed exactly with "LINKEDIN:", "X:", "THREADS:", "INSTAGRAM:", and "TIKTOK:" — no other commentary.`;

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

function parseSocialCopy(socialCopy) {
  // Pulls the LINKEDIN:/X:/THREADS:/INSTAGRAM:/TIKTOK:-prefixed lines out of the drafted
  // text so each platform's copy can be written into its own Notion column.
  const result = { linkedin: "", x: "", threads: "", instagram: "", tiktok: "" };
  for (const rawLine of socialCopy.split("\n")) {
    const line = rawLine.trim();
    if (/^LINKEDIN:/i.test(line)) result.linkedin = line.replace(/^LINKEDIN:\s*/i, "");
    else if (/^X:/i.test(line)) result.x = line.replace(/^X:\s*/i, "");
    else if (/^THREADS:/i.test(line)) result.threads = line.replace(/^THREADS:\s*/i, "");
    else if (/^INSTAGRAM:/i.test(line)) result.instagram = line.replace(/^INSTAGRAM:\s*/i, "");
    else if (/^TIKTOK:/i.test(line)) result.tiktok = line.replace(/^TIKTOK:\s*/i, "");
  }
  return result;
}

function wrapText(text, maxCharsPerLine) {
  const words = text.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > maxCharsPerLine) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current = (current + " " + word).trim();
    }
  }
  if (current) lines.push(current.trim());
  return lines;
}

async function generateCardImage(title) {
  // Instagram and TikTok won't accept a text-only post, so every issue needs a simple
  // branded card image. Kept intentionally plain (solid background + wrapped title) —
  // easy to restyle later once there's an actual brand kit.
  const { default: sharp } = await import("sharp");
  const lines = wrapText(title, 24).slice(0, 5);
  const lineHeight = 72;
  const startY = 540 - ((lines.length - 1) * lineHeight) / 2;
  const tspans = lines
    .map((line, i) => `<tspan x="60" y="${startY + i * lineHeight}">${escapeXml(line)}</tspan>`)
    .join("");

  const svg = `
    <svg width="1080" height="1080" xmlns="http://www.w3.org/2000/svg">
      <rect width="1080" height="1080" fill="#101828"/>
      <text x="60" y="120" font-family="Georgia, serif" font-size="34" fill="#9db2ce" letter-spacing="2">THE SOVEREIGN</text>
      <text font-family="Georgia, serif" font-size="58" font-weight="bold" fill="#ffffff">${tspans}</text>
      <text x="60" y="1000" font-family="Georgia, serif" font-size="28" fill="#9db2ce">sovereignnewsletter.substack.com</text>
    </svg>`;

  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  const filename = `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;

  const { error: uploadError } = await supabase.storage
    .from("sovereign-cards")
    .upload(filename, pngBuffer, { contentType: "image/png" });
  if (uploadError) throw uploadError;

  const { data } = supabase.storage.from("sovereign-cards").getPublicUrl(filename);
  return data.publicUrl;
}

function escapeXml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function createNotionDraftPage({ title, link, socialCopy, cardImageUrl }) {
  const today = new Date().toISOString().slice(0, 10);
  const parsed = parseSocialCopy(socialCopy);

  const body = {
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      Title: { title: [{ text: { content: `[Social Drafts] ${title}` } }] },
      Format: { select: { name: "Social" } },
      Status: { select: { name: "Drafting" } },
      "Publish Date": { date: { start: today } },
      "Ties Back To": { rich_text: [{ text: { content: link } }] },
      // Threads has no dedicated column yet — its text still lands in the page body below.
      "LinkedIn Copy": { rich_text: [{ text: { content: parsed.linkedin.slice(0, 2000) } }] },
      "X Copy": { rich_text: [{ text: { content: parsed.x.slice(0, 2000) } }] },
      "Instagram Caption": { rich_text: [{ text: { content: parsed.instagram.slice(0, 2000) } }] },
      "TikTok Caption": { rich_text: [{ text: { content: parsed.tiktok.slice(0, 2000) } }] },
      "Card Image URL": { url: cardImageUrl },
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

async function ensureCardBucket() {
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw error;
  if (!buckets.some((b) => b.name === "sovereign-cards")) {
    const { error: createError } = await supabase.storage.createBucket("sovereign-cards", { public: true });
    if (createError) throw createError;
    console.log("Created public 'sovereign-cards' storage bucket.");
  }
}

async function main() {
  await ensureCardBucket();

  const feedResponse = await fetch(RSS2JSON_URL);

  if (!feedResponse.ok) {
    throw new Error(`Failed to fetch Substack feed via rss2json: ${feedResponse.status} ${feedResponse.statusText}`);
  }

  const feedData = await feedResponse.json();
  if (feedData.status !== "ok") {
    throw new Error(`rss2json returned an error: ${JSON.stringify(feedData)}`);
  }

  const feed = { items: feedData.items };
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
    const content = item.content || item.description || "";

    console.log(`Drafting social copy for: ${title}`);
    const socialCopy = await draftSocialCopy({ title, link, content });

    console.log(`Generating card image for: ${title}`);
    const cardImageUrl = await generateCardImage(title);

    console.log(`Writing draft page to Notion for: ${title}`);
    await createNotionDraftPage({ title, link, socialCopy, cardImageUrl });

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
