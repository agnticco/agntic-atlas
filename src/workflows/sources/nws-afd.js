/**
 * NWS Area Forecast Discussion fetcher.
 *
 * Fetches the latest AFD from forecast.weather.gov for a given NWS office code
 * (e.g., "BMX" for Birmingham, "OHX" for Nashville). Extracts the raw forecast
 * discussion text from the HTML response.
 *
 * @module src/workflows/sources/nws-afd.js
 */

/**
 * Fetch the latest AFD for an NWS office.
 * @param {object} params
 * @param {string} params.office — 3-letter NWS office code (e.g., "BMX")
 * @returns {Promise<{ text: string, fetchedAt: string, office: string }>}
 */
export async function fetch({ office }) {
  if (!office || typeof office !== 'string' || office.length !== 3) {
    throw new Error(`Invalid NWS office code: "${office}" — expected 3-letter code like "BMX"`);
  }

  const code = office.toUpperCase();
  const url = `https://forecast.weather.gov/product.php?site=NWS&issuedby=${code}&product=AFD&format=CI&version=1&glossary=1`;

  const res = await globalThis.fetch(url, {
    headers: { 'User-Agent': 'Agntic/1.0 (workflow automation)' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`NWS fetch failed: HTTP ${res.status} for office ${code}`);
  }

  const html = await res.text();

  // The AFD text lives inside a <pre> tag with class "glossaryProduct"
  const preMatch = html.match(/<pre[^>]*class="glossaryProduct"[^>]*>([\s\S]*?)<\/pre>/i);
  let text;

  if (preMatch) {
    text = preMatch[1]
      .replace(/<[^>]+>/g, '')        // strip remaining HTML tags (glossary links)
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
  } else {
    // Fallback: grab all <pre> content
    const allPre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/gi);
    if (allPre && allPre.length > 0) {
      text = allPre.map(p => p.replace(/<[^>]+>/g, '').trim()).join('\n\n').trim();
    } else {
      throw new Error(`Could not extract AFD text from NWS response for office ${code}`);
    }
  }

  return {
    text,
    fetchedAt: new Date().toISOString(),
    office: code,
  };
}
