// Sovereign Social Publisher
// Runs on its own twice-weekly schedule. Picks the oldest "Scheduled" card (Deven's
// manual approval status) in the Sovereign Content Calendar and posts it to X,
// Instagram, and TikTok. Never touches "Drafting" cards — only ones you've approved.
//
// Idempotent: each platform's success is recorded as a tag in the page's "Notes"
// field (e.g. "[posted:x]"). If a run partially fails, the next run only retries
// the platforms that haven't succeeded yet, so nothing gets double-posted.

const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";

const X_API_KEY = process.env.X_API_KEY;
const X_API_SECRET = process.env.X_API_SECRET;
const X_ACCESS_TOKEN = process.env.X_ACCESS_TOKEN;
const X_ACCESS_TOKEN_SECRET = process.env.X_ACCESS_TOKEN_SECRET;

const IG_USER_ID = process.env.IG_USER_ID;
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;

const TIKTOK_ACCESS_TOKEN = process.env.TIKTOK_ACCESS_TOKEN;
// Default to SELF_ONLY (private) since TikTok forces this for unaudited apps anyway,
// and some accounts reject a public privacy_level request outright pre-audit.
// Flip to PUBLIC_TO_EVERYONE via this env var once your TikTok client passes audit.
const TIKTOK_PRIVACY_LEVEL = process.env.TIKTOK_PRIVACY_LEVEL || "SELF_ONLY";

function requireEnv(name, value) {
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}
for (const [name, value] of [
  ["NOTION_DATABASE_ID", NOTION_DATABASE_ID],
  ["NOTION_API_KEY", NOTION_API_KEY],
  ["X_API_KEY", X_API_KEY],
  ["X_API_SECRET", X_API_SECRET],
  ["X_ACCESS_TOKEN", X_ACCESS_TOKEN],
  ["X_ACCESS_TOKEN_SECRET", X_ACCESS_TOKEN_SECRET],
  ["IG_USER_ID", IG_USER_ID],
  ["IG_ACCESS_TOKEN", IG_ACCESS_TOKEN],
  ["TIKTOK_ACCESS_TOKEN", TIKTOK_ACCESS_TOKEN],
]) {
  requireEnv(name, value);
}

// ---- Notion helpers ----

async function findNextScheduledCard() {
  const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
    },
    body: JSON.stringify({
      filter: {
        and: [
          { property: "Format", select: { equals: "Social" } },
          { property: "Status", select: { equals: "Scheduled" } },
        ],
      },
      sorts: [{ timestamp: "created_time", direction: "ascending" }],
      page_size: 1,
    }),
  });
  if (!res.ok) throw new Error(`Notion query error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.results[0] || null;
}

function richText(page, prop) {
  return (page.properties[prop]?.rich_text || []).map((t) => t.plain_text).join("");
}

async function updateNotionPage(pageId, { notes, status }) {
  const properties = {};
  if (notes !== undefined) properties.Notes = { rich_text: [{ text: { content: notes.slice(0, 2000) } }] };
  if (status !== undefined) properties.Status = { select: { name: status } };

  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
    },
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) throw new Error(`Notion update error: ${res.status} ${await res.text()}`);
}

// ---- X (OAuth 1.0a user-context) ----

async function postToX(text) {
  const OAuth = (await import("oauth-1.0a")).default;
  const crypto = await import("node:crypto");

  const oauth = OAuth({
    consumer: { key: X_API_KEY, secret: X_API_SECRET },
    signature_method: "HMAC-SHA1",
    hash_function(baseString, key) {
      return crypto.createHmac("sha1", key).update(baseString).digest("base64");
    },
  });

  const requestData = { url: "https://api.x.com/2/tweets", method: "POST" };
  const token = { key: X_ACCESS_TOKEN, secret: X_ACCESS_TOKEN_SECRET };
  const headers = oauth.toHeader(oauth.authorize(requestData, token));

  const res = await fetch(requestData.url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`X post failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ---- Instagram (Graph API content publishing) ----

async function postToInstagram({ imageUrl, caption }) {
  const base = "https://graph.facebook.com/v21.0";

  const createRes = await fetch(
    `${base}/${IG_USER_ID}/media?image_url=${encodeURIComponent(imageUrl)}&caption=${encodeURIComponent(caption)}&access_token=${IG_ACCESS_TOKEN}`,
    { method: "POST" }
  );
  if (!createRes.ok) throw new Error(`Instagram container failed: ${createRes.status} ${await createRes.text()}`);
  const { id: creationId } = await createRes.json();

  // Poll until the container finishes processing (usually a few seconds).
  for (let attempt = 0; attempt < 10; attempt++) {
    const statusRes = await fetch(`${base}/${creationId}?fields=status_code&access_token=${IG_ACCESS_TOKEN}`);
    const { status_code } = await statusRes.json();
    if (status_code === "FINISHED") break;
    if (status_code === "ERROR") throw new Error("Instagram container processing failed.");
    await new Promise((r) => setTimeout(r, 2000));
  }

  const publishRes = await fetch(
    `${base}/${IG_USER_ID}/media_publish?creation_id=${creationId}&access_token=${IG_ACCESS_TOKEN}`,
    { method: "POST" }
  );
  if (!publishRes.ok) throw new Error(`Instagram publish failed: ${publishRes.status} ${await publishRes.text()}`);
  return publishRes.json();
}

// ---- TikTok (Content Posting API, photo mode) ----

async function postToTikTok({ imageUrl, caption }) {
  const res = await fetch("https://open.tiktokapis.com/v2/post/publish/content/init/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TIKTOK_ACCESS_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      post_info: {
        title: caption.slice(0, 90),
        description: caption,
        privacy_level: TIKTOK_PRIVACY_LEVEL,
        disable_comment: false,
      },
      source_info: {
        source: "PULL_FROM_URL",
        photo_cover_index: 0,
        photo_images: [imageUrl],
      },
      post_mode: "DIRECT_POST",
      media_type: "PHOTO",
    }),
  });
  if (!res.ok) throw new Error(`TikTok post failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ---- Main ----

async function main() {
  const card = await findNextScheduledCard();
  if (!card) {
    console.log("No approved (Scheduled) social posts waiting. Nothing to do.");
    return;
  }

  const title = card.properties.Title.title.map((t) => t.plain_text).join("");
  const xCopy = richText(card, "X Copy");
  const igCaption = richText(card, "Instagram Caption");
  const tiktokCaption = richText(card, "TikTok Caption");
  const cardImageUrl = card.properties["Card Image URL"]?.url;
  const existingNotes = richText(card, "Notes");

  console.log(`Publishing: ${title}`);

  const results = { x: existingNotes.includes("[posted:x]"), instagram: existingNotes.includes("[posted:instagram]"), tiktok: existingNotes.includes("[posted:tiktok]") };
  const noteLines = existingNotes ? [existingNotes] : [];

  if (!results.x) {
    try {
      await postToX(xCopy);
      results.x = true;
      noteLines.push("[posted:x]");
      console.log("Posted to X.");
    } catch (err) {
      console.error("X post failed:", err.message);
      noteLines.push(`[x error: ${err.message.slice(0, 200)}]`);
    }
  }

  if (!results.instagram) {
    if (!cardImageUrl) {
      console.error("No Card Image URL set — skipping Instagram (it requires an image).");
      noteLines.push("[instagram error: no Card Image URL]");
    } else {
      try {
        await postToInstagram({ imageUrl: cardImageUrl, caption: igCaption });
        results.instagram = true;
        noteLines.push("[posted:instagram]");
        console.log("Posted to Instagram.");
      } catch (err) {
        console.error("Instagram post failed:", err.message);
        noteLines.push(`[instagram error: ${err.message.slice(0, 200)}]`);
      }
    }
  }

  if (!results.tiktok) {
    if (!cardImageUrl) {
      console.error("No Card Image URL set — skipping TikTok (it requires an image).");
      noteLines.push("[tiktok error: no Card Image URL]");
    } else {
      try {
        await postToTikTok({ imageUrl: cardImageUrl, caption: tiktokCaption });
        results.tiktok = true;
        noteLines.push("[posted:tiktok]");
        console.log("Posted to TikTok (will be private-only until your TikTok client passes audit).");
      } catch (err) {
        console.error("TikTok post failed:", err.message);
        noteLines.push(`[tiktok error: ${err.message.slice(0, 200)}]`);
      }
    }
  }

  const allSucceeded = results.x && results.instagram && results.tiktok;
  await updateNotionPage(card.id, {
    notes: noteLines.join(" "),
    status: allSucceeded ? "Published" : "Scheduled",
  });

  if (!allSucceeded) {
    console.log("One or more platforms failed — left Status as Scheduled so the next run retries only those.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
