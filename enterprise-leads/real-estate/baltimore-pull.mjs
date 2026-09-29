// real-estate/baltimore-pull.mjs
//
// Weekly Maryland wholesaling pipeline, market #1: Baltimore City.
//
// Pulls three FREE public datasets the City of Baltimore publishes
// (Open Baltimore / DHCD ArcGIS service, no API key needed):
//   layer 1  — Vacant Building Notices (open)
//   layer 11 — Foreclosure Filings
//   layer 12 — Real Property (every parcel: owner, mailing address,
//              last sale date/price, assessed value)
//
// and produces two lists in Supabase:
//
//   re_properties — likely motivated sellers: properties with an open
//     vacancy notice and/or a recent foreclosure filing, joined to the
//     owner's name and mailing address, and scored.
//   re_buyers     — active cash-buyer investors: companies that bought
//     2+ Baltimore properties in the last 24 months, with the mailing
//     address from the property record. This is your buyers list.
//
// It never contacts anyone. It only builds the lists.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY.
// Local test without Supabase: OUTPUT_JSON=out.json node real-estate/baltimore-pull.mjs

import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";

const BASE = "https://egisdata.baltimorecity.gov/egis/rest/services/Housing/DHCD_Open_Baltimore_Datasets/FeatureServer";
const LAYER = { vacants: 1, foreclosures: 11, property: 12 };
const MARKET = "baltimore_city";

const OUTPUT_JSON = process.env.OUTPUT_JSON;
const supabase =
  !OUTPUT_JSON && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    : null;
if (!OUTPUT_JSON && !supabase) {
  console.log("baltimore-pull: SUPABASE_URL / SUPABASE_SERVICE_KEY missing. Skipping run.");
  process.exit(0);
}

const DAY = 86400000;
const NOW = Date.now();

// ---------- fetching ----------

async function getJson(url, attempt = 1) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60000), headers: { "User-Agent": "WadeCapital-research/1.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(JSON.stringify(data.error));
    return data;
  } catch (err) {
    if (attempt >= 4) throw new Error(`${url.slice(0, 160)}... failed: ${err.message}`);
    await new Promise((r) => setTimeout(r, attempt * 3000));
    return getJson(url, attempt + 1);
  }
}

// Pages through an entire layer using OBJECTID ranges (works on every
// ArcGIS server version, unlike resultOffset).
async function fetchAll(layerId, outFields, where = "1=1") {
  const rows = [];
  let lastId = -1;
  for (let page = 0; page < 1000; page++) {
    const params = new URLSearchParams({
      where: `(${where}) AND OBJECTID > ${lastId}`,
      outFields: ["OBJECTID", ...outFields].join(","),
      orderByFields: "OBJECTID ASC",
      resultRecordCount: "1000",
      returnGeometry: "false",
      f: "json",
    });
    const data = await getJson(`${BASE}/${layerId}/query?${params}`);
    const feats = data.features || [];
    if (feats.length === 0) break;
    for (const f of feats) rows.push(f.attributes);
    lastId = feats[feats.length - 1].attributes.OBJECTID;
    if (page % 25 === 24) console.log(`  layer ${layerId}: ${rows.length} rows so far...`);
  }
  return rows;
}

// ---------- normalizing ----------

const clean = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
const norm = (v) => clean(v).toUpperCase().replace(/[^A-Z0-9 ]/g, "").replace(/\s+/g, " ");
const blocklotKey = (v) => norm(v).replace(/ /g, "");

// SALEDATE is an 8-character string. Handles YYYYMMDD or MMDDYYYY.
function parseSaleDate(s) {
  const t = clean(s);
  if (!/^\d{8}$/.test(t)) return null;
  const [y, m, d] = /^(19|20)\d{2}/.test(t) ? [t.slice(0, 4), t.slice(4, 6), t.slice(6, 8)] : [t.slice(4, 8), t.slice(0, 2), t.slice(2, 4)];
  const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || +y < 1900 ? null : date;
}

const toISODate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

const ENTITY = /\b(LLC|L L C|INC|CORP|CORPORATION|COMPANY|CO|LP|LLP|LTD|TRUST|TRUSTEE|TRUSTEES|PROPERTIES|PROPERTY|HOLDINGS?|INVEST(MENTS?|ORS?)?|CAPITAL|GROUP|PARTNERS|PARTNERSHIP|REALTY|HOMES|HOUSING|VENTURES?|DEVELOPMENT|MANAGEMENT|ENTERPRISES?|ASSOCIATES|FUND|ESTATES?|REDEVELOPMENT|SOLUTIONS|RENTALS?|ASSETS?)\b/;
// Owners we can't buy from directly (government, lenders, agencies) —
// their properties go through auctions/REO desks, not a seller letter.
const INSTITUTION = /\b(MAYOR AND CITY COUNCIL|CITY OF BALTIMORE|HOUSING AUTHORITY|STATE OF MARYLAND|SECRETARY OF|UNITED STATES|FEDERAL NATIONAL|FEDERAL HOME LOAN|FANNIE MAE|FREDDIE MAC|BANK|MORTGAGE|LOAN SERVICING|WELLS FARGO|U S BANK|US BANK|DEUTSCHE|WILMINGTON|NATIONSTAR|HUD|CHURCH|MINISTR|BOARD OF EDUCATION)\b/;

function isAbsentee(propertyAddr, mailing) {
  const p = norm(propertyAddr);
  const m = norm(mailing);
  if (!p || !m) return null;
  const pStreet = p.split(" ").slice(0, 3).join(" "); // house number + first street words
  return !m.includes(pStreet);
}

// ---------- main ----------

async function main() {
  console.log("baltimore-pull: fetching vacant building notices...");
  const vacants = await fetchAll(LAYER.vacants, ["NoticeNum", "DateNotice", "BLOCKLOT", "Address", "Neighborhood", "OWNER_ABBR"]);
  console.log(`  ${vacants.length} open vacancy notices`);

  console.log("baltimore-pull: fetching foreclosure filings...");
  const foreclosures = await fetchAll(LAYER.foreclosures, ["BLOCKLOT", "Date", "Case__", "Case_Title", "Address", "Zip_Code"]);
  const fcDates = foreclosures.map((f) => f.Date).filter(Boolean).sort((a, b) => b - a);
  console.log(`  ${foreclosures.length} foreclosure filings on record; newest filing: ${fcDates[0] ? toISODate(fcDates[0]) : "unknown"}`);
  if (fcDates[0] && NOW - fcDates[0] > 120 * DAY) {
    console.log("  NOTE: the city's foreclosure layer looks stale (newest filing is 4+ months old). Vacancy notices still drive the list.");
  }

  console.log("baltimore-pull: fetching every property record (takes a few minutes)...");
  const parcels = await fetchAll(LAYER.property, [
    "BLOCKLOT", "FULLADDR", "ZIP_CODE", "NEIGHBOR", "OWNER_1", "OWNER_2", "MAILTOADD",
    "SALEDATE", "SALEPRIC", "FULLCASH", "YEAR_BUILD", "DWELUNIT", "NO_IMPRV",
  ]);
  console.log(`  ${parcels.length} parcels`);

  const parcelByBL = new Map();
  for (const p of parcels) if (p.BLOCKLOT) parcelByBL.set(blocklotKey(p.BLOCKLOT), p);

  // ----- motivated-seller signals -----
  const signalsByBL = new Map();
  const touch = (bl) => {
    const k = blocklotKey(bl);
    if (!k) return null;
    if (!signalsByBL.has(k)) signalsByBL.set(k, { bl: clean(bl) });
    return signalsByBL.get(k);
  };

  for (const v of vacants) {
    const s = touch(v.BLOCKLOT);
    if (!s) continue;
    const d = v.DateNotice || null;
    if (!s.vacantDate || (d && d < s.vacantDate)) s.vacantDate = d; // oldest open notice
    s.vacantAddr = s.vacantAddr || clean(v.Address);
    s.neighborhood = s.neighborhood || clean(v.Neighborhood);
  }
  for (const f of foreclosures) {
    if (!f.Date || NOW - f.Date > 548 * DAY) continue; // last 18 months only
    const s = touch(f.BLOCKLOT);
    if (!s) continue;
    if (!s.fcDate || f.Date > s.fcDate) {
      s.fcDate = f.Date;
      s.fcCase = clean(f.Case__);
    }
    s.fcAddr = s.fcAddr || clean(f.Address);
    s.fcZip = s.fcZip || clean(f.Zip_Code);
  }

  const properties = [];
  let skippedInstitutional = 0;
  for (const [k, s] of signalsByBL) {
    const p = parcelByBL.get(k) || {};
    const owner1 = clean(p.OWNER_1);
    const ownerAll = norm(`${p.OWNER_1 || ""} ${p.OWNER_2 || ""}`);
    if (INSTITUTION.test(ownerAll)) {
      skippedInstitutional++;
      continue;
    }
    const address = clean(p.FULLADDR) || s.vacantAddr || s.fcAddr;
    const mailing = clean(p.MAILTOADD);
    const absentee = isAbsentee(address, mailing);
    const entity = owner1 ? ENTITY.test(ownerAll) : null;
    const saleDate = parseSaleDate(p.SALEDATE);

    const signals = [];
    let score = 0;
    if (s.fcDate) {
      const recent = NOW - s.fcDate <= 365 * DAY;
      score += recent ? 4 : 3;
      signals.push(recent ? "foreclosure_12mo" : "foreclosure_18mo");
    }
    if (s.vacantDate) {
      score += 3;
      signals.push("vacant_notice");
      if (NOW - s.vacantDate > 730 * DAY) {
        score += 1;
        signals.push("vacant_2yr_plus");
      }
    }
    if (absentee) {
      score += 2;
      signals.push("absentee_owner");
    }
    if (entity === false) {
      score += 1;
      signals.push("individual_owner");
    }
    if (saleDate && NOW - saleDate.getTime() > 10 * 365 * DAY) {
      score += 1;
      signals.push("owned_10yr_plus");
    }
    if (s.fcDate && s.vacantDate) {
      score += 2;
      signals.push("vacant_and_foreclosure");
    }

    properties.push({
      blocklot: s.bl,
      market: MARKET,
      address,
      zip: clean(p.ZIP_CODE) || s.fcZip || null,
      neighborhood: clean(p.NEIGHBOR) || s.neighborhood || null,
      owner_1: owner1 || null,
      owner_2: clean(p.OWNER_2) || null,
      owner_mailing: mailing || null,
      absentee,
      owner_is_entity: entity,
      assessed_value: Number.isFinite(p.FULLCASH) ? Math.round(p.FULLCASH) : null,
      last_sale_date: toISODate(saleDate),
      last_sale_price: Number.isFinite(p.SALEPRIC) ? p.SALEPRIC : null,
      year_built: Number.isFinite(p.YEAR_BUILD) && p.YEAR_BUILD > 1700 ? p.YEAR_BUILD : null,
      vacant_notice_date: toISODate(s.vacantDate),
      foreclosure_filing_date: toISODate(s.fcDate),
      foreclosure_case: s.fcCase || null,
      score,
      signals,
      last_seen: new Date().toISOString(),
    });
  }
  properties.sort((a, b) => b.score - a.score);

  // ----- cash-buyer list -----
  const buyersMap = new Map();
  for (const p of parcels) {
    const owner = clean(p.OWNER_1);
    const ownerAll = norm(`${p.OWNER_1 || ""} ${p.OWNER_2 || ""}`);
    if (!owner || !ENTITY.test(ownerAll) || INSTITUTION.test(ownerAll)) continue;
    const d = parseSaleDate(p.SALEDATE);
    if (!d || NOW - d.getTime() > 730 * DAY) continue;
    const price = p.SALEPRIC;
    if (!Number.isFinite(price) || price < 10000 || price > 400000) continue; // investor price band
    const key = norm(owner).replace(/\b(LLC|INC|L L C|CORP|THE)\b/g, "").replace(/\s+/g, " ").trim();
    if (!key) continue;
    if (!buyersMap.has(key)) buyersMap.set(key, { owner, mailing: clean(p.MAILTOADD), buys: [] });
    buyersMap.get(key).buys.push({ date: d, price, addr: clean(p.FULLADDR) });
  }
  const buyers = [];
  for (const [key, b] of buyersMap) {
    if (b.buys.length < 2) continue;
    b.buys.sort((x, y) => y.date - x.date);
    const prices = b.buys.map((x) => x.price).sort((x, y) => x - y);
    buyers.push({
      owner_key: key,
      market: MARKET,
      owner_name: b.owner,
      mailing_address: b.mailing || null,
      purchases_12mo: b.buys.filter((x) => NOW - x.date.getTime() <= 365 * DAY).length,
      purchases_24mo: b.buys.length,
      median_price: prices[Math.floor(prices.length / 2)],
      last_purchase_date: toISODate(b.buys[0].date),
      sample_addresses: b.buys.slice(0, 5).map((x) => x.addr).filter(Boolean),
      last_seen: new Date().toISOString(),
    });
  }
  buyers.sort((a, b) => b.purchases_12mo - a.purchases_12mo || b.purchases_24mo - a.purchases_24mo);

  // ----- report -----
  console.log(`\nbaltimore-pull: ${properties.length} motivated-seller properties (skipped ${skippedInstitutional} owned by the city, banks, or agencies).`);
  console.log(`  score >= 8: ${properties.filter((p) => p.score >= 8).length} | score 6-7: ${properties.filter((p) => p.score >= 6 && p.score < 8).length}`);
  console.log(`  with foreclosure filing: ${properties.filter((p) => p.foreclosure_filing_date).length} | vacant: ${properties.filter((p) => p.vacant_notice_date).length}`);
  console.log("  top 10:");
  for (const p of properties.slice(0, 10)) console.log(`    [${p.score}] ${p.address} | owner ${p.owner_1} | ${p.signals.join(", ")}`);
  console.log(`\nbaltimore-pull: ${buyers.length} active investor buyers (2+ purchases in 24 months).`);
  for (const b of buyers.slice(0, 10)) console.log(`    ${b.owner_name}: ${b.purchases_12mo} in 12mo / ${b.purchases_24mo} in 24mo, median $${b.median_price}`);

  if (OUTPUT_JSON) {
    writeFileSync(OUTPUT_JSON, JSON.stringify({ properties, buyers }, null, 1));
    console.log(`\nWrote ${OUTPUT_JSON}`);
    return;
  }

  // ----- save (status / notes / first_seen are never overwritten) -----
  for (let i = 0; i < properties.length; i += 500) {
    const { error } = await supabase.from("re_properties").upsert(properties.slice(i, i + 500), { onConflict: "blocklot" });
    if (error) throw new Error(`re_properties upsert failed: ${error.message}`);
  }
  for (let i = 0; i < buyers.length; i += 500) {
    const { error } = await supabase.from("re_buyers").upsert(buyers.slice(i, i + 500), { onConflict: "owner_key" });
    if (error) throw new Error(`re_buyers upsert failed: ${error.message}`);
  }
  console.log(`\nbaltimore-pull: saved ${properties.length} properties and ${buyers.length} buyers to Supabase.`);
}

main().catch((err) => {
  console.error("baltimore-pull failed:", err.message);
  process.exit(1);
});
