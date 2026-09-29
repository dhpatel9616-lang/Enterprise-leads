// Builds the link to a free "concept preview" website for a business
// that has no site (see preview.html in the wade-capital-website repo).
// The business's public Google listing details ride inside the link
// itself, so there's no server or database behind the page.
function previewUrl(lead, baseUrl) {
  if (!baseUrl || lead.site_url) return null;
  const payload = { n: lead.business_name, c: lead.category || '', p: lead.phone || '', a: lead.address || '' };
  return `${baseUrl}?d=${Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url')}`;
}

module.exports = { previewUrl };
