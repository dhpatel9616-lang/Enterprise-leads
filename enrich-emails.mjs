// scripts/enrich-emails.mjs
//
// Finds email addresses for leads that have a website but no email on file.
// Pulls run settings from the `email_enrichment` row in the `settings` table
// so limits/paths can be tuned without touching code.
//
// Requires env vars (same ones your other scripts already use):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Run manually with:  node scripts/enrich-emails.mjs

import { createClient } from "@supabase/supabase-js";
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

// GitHub's ubuntu-latest runners ship a system Chrome — using it directly
// avoids downloading a separate Chromium bundle on every run.
const CHROME_PATHS = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
];

let browserPromise = null;
function getBrowser() {
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    const executablePath = CHROME_PATHS.find((p) => existsSync(p));
    if (!executablePath) {
      console.warn("enrich-emails: no system Chrome found — skipping the JS-rendering fallback for this run.");
      return null;
    }
    return puppeteer.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  })();
  return browserPromise;
}

async function closeBrowser() {
  const browser = await (browserPromise || Promise.resolve(null));
  if (browser) await browser.close();
}

// For sites that render their contact info client-side (React/Vue/Wix-style
// pages where the raw HTML is nearly empty) — a real browser sees what a
// plain fetch can't. Only used as a fallback since it's much slower.
async function fetchRenderedHtml(url, timeoutMs) {
  const browser = await getBrowser();
  if (!browser) return null;
  let page;
  try {
    page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (compatible; WadeCapitalOutreachBot/1.0; +mailto:wadecapitallc@gmail.com)"
    );
    await page.goto(url, { waitUntil: "networkidle2", timeout: timeoutMs });
    return await page.content();
  } catch {
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const DEFAULT_SETTINGS = {
  max_leads_per_run: 25,
  request_timeout_ms: 8000,
  retry_after_days: 30,
  subpaths: [
    "/contact", "/contact-us", "/contact-us.html", "/contact.html",
    "/about", "/about-us",
    "/reach-us", "/get-in-touch", "/connect",
    "/team", "/staff",
  ],
};

// Domains/patterns that are never real contact emails, even though they look
// like one syntactically. Extend this list as you see junk come through.
const JUNK_PATTERNS = [
  /\.(png|jpg|jpeg|gif|svg|webp)$/i,
  /sentry\.io$/i,
  /wixpress\.com$/i,
  /godaddy\.com$/i,
  /schema\.org$/i,
  /example\.(com|org)$/i,
  /^(noreply|no-reply|donotreply)@/i,
  /^webmaster@/i,
  /^postmaster@/i,
  /wordpress\.(com|org)$/i,
  /sentry-next\.wixpress\.com$/i,
  // Our own outreach bot's User-Agent header includes
  // "mailto:wadecapitallc@gmail.com" for abuse-contact purposes. If a
  // site's response ever echoes back request headers (error pages,
  // debug endpoints, some WAF block pages), a naive scrape can pick
  // our own address up and mistake it for the business's. Never valid
  // as a lead's email regardless of source.
  /^wadecapitallc@gmail\.com$/i,
];

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const EMAIL_SHAPE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// Some sites HTML-entity-encode their contact email specifically to
// defeat simple regex scrapers (e.g. "info@x.com" becomes
// "&#105;&#110;&#102;&#111;&#64;..."). Browsers render this as plain
// text so a human never notices — but a scraper that doesn't decode
// entities first ends up storing the literal encoded gibberish as the
// "email." Decode before we ever try to validate or match anything.
function decodeHtmlEntities(str) {
  return str
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&');
}

function isValidEmailShape(email) {
  return EMAIL_SHAPE.test(email);
}

function isJunkEmail(email) {
  return JUNK_PATTERNS.some((pattern) => pattern.test(email));
}

function extractEmails(rawHtml) {
  const html = decodeHtmlEntities(rawHtml);
  const found = new Set();

  // mailto: links are the highest-confidence signal
  const mailtoMatches = html.matchAll(/mailto:([^"'\s?]+)/gi);
  for (const m of mailtoMatches) {
    const email = m[1].trim().toLowerCase();
    if (isValidEmailShape(email) && !isJunkEmail(email)) found.add(email);
  }

  // Fallback: plain-text email pattern anywhere in the page
  const textMatches = html.match(EMAIL_REGEX) || [];
  for (const raw of textMatches) {
    const email = raw.trim().toLowerCase();
    if (!isJunkEmail(email)) found.add(email);
  }

  return Array.from(found);
}

function pickBestEmail(emails, siteDomain) {
  if (emails.length === 0) return null;

  // Prefer an email whose domain matches the business's own site domain
  const sameDomain = emails.find((e) => e.split("@")[1] === siteDomain);
  if (sameDomain) return sameDomain;

  // Otherwise prefer common role addresses over random personal-looking ones
  const rolePriority = ["info@", "contact@", "hello@", "office@"];
  for (const prefix of rolePriority) {
    const match = emails.find((e) => e.startsWith(prefix));
    if (match) return match;
  }

  return emails[0];
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; WadeCapitalOutreachBot/1.0; +mailto:wadecapitallc@gmail.com)",
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

async function findEmailForSite(siteUrl, settings) {
  const domain = getDomain(siteUrl);
  if (!domain) return { email: null, result: "invalid_url" };

  const urlsToTry = [siteUrl, ...settings.subpaths.map((p) => {
    try {
      return new URL(p, siteUrl).toString();
    } catch {
      return null;
    }
  }).filter(Boolean)];

  for (const url of urlsToTry) {
    const html = await fetchWithTimeout(url, settings.request_timeout_ms);
    if (!html) continue;

    const emails = extractEmails(html);
    const best = pickBestEmail(emails, domain);
    if (best) {
      return { email: best, result: "found" };
    }
  }

  // Nothing in the raw HTML anywhere — try rendering just the homepage
  // and contact page with a real browser before giving up. Slower, so
  // it's deliberately limited to two pages rather than the full subpath list.
  const contactUrl = urlsToTry.find((u) => /contact/i.test(u));
  const renderUrls = [siteUrl, contactUrl].filter(Boolean);
  for (const url of renderUrls) {
    const html = await fetchRenderedHtml(url, settings.request_timeout_ms);
    if (!html) continue;

    const emails = extractEmails(html);
    const best = pickBestEmail(emails, domain);
    if (best) {
      return { email: best, result: "found_rendered" };
    }
  }

  return { email: null, result: "not_found" };
}

async function loadSettings() {
  const { data, error } = await supabase
    .from("settings")
    .select("value")
    .eq("key", "email_enrichment")
    .maybeSingle();

  if (error || !data) {
    console.warn("Could not load email_enrichment settings, using defaults.");
    return DEFAULT_SETTINGS;
  }
  return { ...DEFAULT_SETTINGS, ...data.value };
}

async function main() {
  const settings = await loadSettings();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - settings.retry_after_days);

  const { data: leads, error } = await supabase
    .from("leads")
    .select("id, business_name, site_url")
    .or("email.is.null,email.eq.")
    .not("site_url", "is", null)
    .not("site_url", "ilike", "%facebook.com%")
    .or(
      `email_enrichment_attempted_at.is.null,email_enrichment_attempted_at.lt.${cutoff.toISOString()}`
    )
    .limit(settings.max_leads_per_run);

  if (error) {
    console.error("Error querying leads:", error.message);
    process.exit(1);
  }

  if (!leads || leads.length === 0) {
    console.log("No leads need email enrichment right now.");
    return;
  }

  console.log(`Attempting enrichment for ${leads.length} lead(s)...`);

  let foundCount = 0;

  for (const lead of leads) {
    const { email, result } = await findEmailForSite(lead.site_url, settings);

    const update = {
      email_enrichment_attempted_at: new Date().toISOString(),
      email_enrichment_result: result,
    };
    if (email) {
      update.email = email;
      foundCount++;
    }

    const { error: updateError } = await supabase
      .from("leads")
      .update(update)
      .eq("id", lead.id);

    if (updateError) {
      console.error(`Failed to update lead ${lead.id}:`, updateError.message);
    } else {
      console.log(
        `${lead.business_name}: ${result}${email ? ` (${email})` : ""}`
      );
    }

    // Be polite to the sites we're scraping
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`Done. Found emails for ${foundCount}/${leads.length} leads.`);
  await closeBrowser();
}

main();
