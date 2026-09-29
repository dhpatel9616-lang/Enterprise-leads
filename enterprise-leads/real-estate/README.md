# Real estate: Maryland wholesaling pipeline

Market #1 is **Baltimore City**. It had the most mortgage defaults in Maryland in Q1 2026 (418), low prices, and the city publishes vacancy notices, foreclosure filings, and every parcel's owner and last sale as free open data. Prince George's County (the highest overall foreclosure volume) is market #2.

## What runs

`baltimore-pull.mjs` runs every Sunday via `.github/workflows/re-baltimore.yml` and rebuilds two Supabase tables:

| Table | What it is | How it's scored or sorted |
|---|---|---|
| `re_properties` | Likely motivated sellers: open vacancy notice and/or a foreclosure filing in the last 18 months, with the owner's name and mailing address | +4 foreclosure in 12 months (+3 if 12 to 18), +3 vacant notice (+1 if 2+ years old), +2 absentee owner, +1 individual (not a company), +1 owned 10+ years, +2 vacant AND in foreclosure |
| `re_buyers` | Cash-buyer investors: companies that bought 2+ Baltimore properties for $10k to $400k in the last 24 months | Most purchases in the last 12 months first |

**Data note (Sept 2026):** the city's foreclosure-filings layer stops at December 2020, so in practice the list is driven by vacancy notices plus owner signals. A current foreclosure feed (Maryland court filings or Prince George's County) is the next source to add.

Properties owned by the city, banks, or government agencies are skipped, since you can't buy those from the owner directly. The pipeline **never contacts anyone**. It only builds the lists. `status` and `notes` on each row are yours to edit, and the weekly run never overwrites them.

## Maryland rules (not legal advice; confirm with a Maryland real estate attorney before your first contract)

- **No license needed** when you sign the purchase contract as the principal buyer and assign your contract interest.
- **Md. Real Prop. § 10-715 (HB 124 / SB 160, effective Oct 1, 2025)** requires:
  1. **Before the seller signs**, a written disclosure that you may assign the contract to someone else.
  2. **Before you assign**, a written disclosure to the end buyer (the assignee).
  If either is missing, that party can cancel before settlement and get their deposit back.
- Market your **contract interest**, not "the house," and don't hold yourself out as the seller's agent.
- **Baltimore vacant properties:** open city violation notices carry their own disclosure and transfer obligations. Have the title company check them on every deal.
- Contacting homeowners: letters and door-knocking carry no phone-law risk. Calls and texts need a Do-Not-Call scrub, and texts to cell phones need consent (TCPA). Don't auto-dial or auto-text sellers.

## Order of operations

1. **Buyers first** (free): work `re_buyers` top-down. Look each company up online (many have websites or Facebook pages), send a short intro, and ask their buy box: neighborhoods, price range, rehab level, and how fast they close. Record answers in `notes`.
2. **Sellers**: start with `re_properties` rows scoring 8+, absentee, individual owners. Cheapest outreach is a handwritten letter to the owner's mailing address (about $0.75 each with a stamp).
3. **Deal math**: offer at or below (after-repair value × 70%) − repairs − your assignment fee. The assessed value in the table is only a rough anchor, not the after-repair value. Pull 3 recent nearby sales before any offer.
