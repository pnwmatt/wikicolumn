// WikiColumn - Wikidata API Client

import {
  PRIMARY_LANGUAGE,
  type WikidataEntity,
  type WikidataItem,
  type WikidataProperty,
  type Claim,
  type ClaimValue,
  type WikidataTimeValue,
  type WikidataQuantityValue,
  type WikidataCoordinateValue,
} from './types';

const LOG_LEVEL = 5;

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
const BATCH_SIZE = 50; // Max entities per API request
const SPARQL_BATCH_SIZE = 100; // Max terms per SPARQL query

interface WikidataApiResponse {
  entities?: Record<string, WikidataEntity>;
  success?: number;
  error?: { code: string; info: string };
}

/**
 * Extract Wikipedia article title from URL
 */
export function extractWikipediaTitle(url: string): string | null {
  try {
    const urlObj = new URL(url);
    // Match *.wikipedia.org domains
    if (!urlObj.hostname.endsWith('wikipedia.org')) {
      return null;
    }
    // Extract language code from subdomain (e.g., 'en' from 'en.wikipedia.org')
    const langMatch = urlObj.hostname.match(/^([a-z]{2,3})\.wikipedia\.org$/);
    if (!langMatch) return null;

    // Extract title from path (e.g., '/wiki/Albert_Einstein')
    const pathMatch = urlObj.pathname.match(/^\/wiki\/(.+)$/);
    if (!pathMatch) return null;

    return decodeURIComponent(pathMatch[1]);
  } catch {
    return null;
  }
}

/**
 * Extract language code from Wikipedia URL
 */
export function extractWikipediaLanguage(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const langMatch = urlObj.hostname.match(/^([a-z]{2,3})\.wikipedia\.org$/);
    return langMatch ? langMatch[1] : null;
  } catch {
    return null;
  }
}

/**
 * Batch array into chunks of specified size
 */
function batchArray<T>(arr: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
}

/**
 * Get QIDs from Wikipedia URLs via sitelinks
 * Returns map of Wikipedia URL -> QID
 */
export async function getQIDsFromWikipediaUrls(
  urls: string[]
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  // Group URLs by language
  const urlsByLang = new Map<string, { url: string; title: string }[]>();
  for (const url of urls) {
    const lang = extractWikipediaLanguage(url);
    const title = extractWikipediaTitle(url);
    if (lang && title) {
      const existing = urlsByLang.get(lang) || [];
      existing.push({ url, title });
      urlsByLang.set(lang, existing);
    }
  }

  // Process each language group
  for (const [lang, items] of urlsByLang) {
    const site = `${lang}wiki`;
    const batches = batchArray(items, BATCH_SIZE);

    for (const batch of batches) {
      const titles = batch.map((item) => item.title).join('|');
      const params = new URLSearchParams({
        action: 'wbgetentities',
        sites: site,
        titles: titles,
        props: 'sitelinks',
        format: 'json',
        origin: '*',
      });

      try {
        const response = await fetch(`${WIKIDATA_API}?${params}`);
        const data: WikidataApiResponse = await response.json();

        // With props=sitelinks, response includes sitelinks that map QID -> Wikipedia title
        // e.g., {"entities":{"Q483915":{"type":"item","id":"Q483915","sitelinks":{"enwiki":{"site":"enwiki","title":"FLIR Systems"}}}}}
        // Missing entries use negative IDs: {"-1":{"site":"enwiki","title":"Missing_Title","missing":""}}

        if (data.entities) {
          for (const [qid, entity] of Object.entries(data.entities)) {
            if (qid.startsWith('Q') && entity.sitelinks) {
              const sitelink = entity.sitelinks[site];
              if (sitelink) {
                // Find the original URL for this title
                const matchingItem = batch.find(
                  (item) => item.title === sitelink.title
                );
                if (matchingItem) {
                  if (LOG_LEVEL > 2) console.log(`WikiColumn: Matched Wikipedia URL ${matchingItem.url} to QID ${qid}`); 
                  results.set(matchingItem.url, qid);
                }
              }
            }
          }
        }
      } catch (error) {
        console.error('Error fetching QIDs from Wikipedia URLs:', error);
      }
    }
  }
  console.log(`WikiColumn: Retrieved ${results.size} QIDs from Wikipedia URLs`, results);
  return results;
}

/**
 * Get full entity data for QIDs
 * Returns map of QID -> WikidataItem
 */
export async function getEntityData(
  qids: string[],
  lang: string = PRIMARY_LANGUAGE
): Promise<Map<string, WikidataItem>> {
  const results = new Map<string, WikidataItem>();
  const batches = batchArray(qids, BATCH_SIZE);

  for (const batch of batches) {
    const ids = batch.join('|');
    const params = new URLSearchParams({
      action: 'wbgetentities',
      ids: ids,
      props: 'labels|descriptions|claims',
      languages: lang,
      format: 'json',
      origin: '*',
    });

    try {
      const response = await fetch(`${WIKIDATA_API}?${params}`);
      const data: WikidataApiResponse = await response.json();

      if (data.entities) {
        for (const [qid, entity] of Object.entries(data.entities)) {
          if (qid.startsWith('Q')) {
            const label = entity.labels?.[lang]?.value || qid;
            const description = entity.descriptions?.[lang]?.value;
            results.set(qid, {
              qid,
              label,
              description,
              json: entity,
            });
          }
        }
      }
    } catch (error) {
      console.error('Error fetching entity data:', error);
    }
  }

  return results;
}

/**
 * Get labels for multiple QIDs or PIDs
 * Returns map of ID -> label
 */
export async function getLabels(
  ids: string[],
  lang: string = PRIMARY_LANGUAGE
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  const batches = batchArray(ids, BATCH_SIZE);

  for (const batch of batches) {
    const idsStr = batch.join('|');
    const params = new URLSearchParams({
      action: 'wbgetentities',
      ids: idsStr,
      props: 'labels',
      languages: lang,
      format: 'json',
      origin: '*',
    });

    try {
      const response = await fetch(`${WIKIDATA_API}?${params}`);
      const data: WikidataApiResponse = await response.json();

      if (data.entities) {
        for (const [id, entity] of Object.entries(data.entities)) {
          const label = entity.labels?.[lang]?.value || id;
          results.set(id, label);
        }
      }
    } catch (error) {
      console.error('Error fetching labels:', error);
    }
  }

  return results;
}

/**
 * Parse claims from entity JSON into our Claim format
 */
export function parseClaims(entity: WikidataEntity): Claim[] {
  const claims: Claim[] = [];

  if (!entity.claims) return claims;

  for (const [pid, claimArray] of Object.entries(entity.claims)) {
    const values: ClaimValue[] = [];

    for (const claim of claimArray) {
      if (claim.mainsnak.snaktype !== 'value' || !claim.mainsnak.datavalue) {
        continue;
      }

      const datavalue = claim.mainsnak.datavalue;
      const claimValue = parseDataValue(datavalue);
      if (claimValue) {
        values.push(claimValue);
      }
    }

    if (values.length > 0) {
      claims.push({
        qid: entity.id,
        pid,
        values,
      });
    }
  }

  return claims;
}

/**
 * Parse a single Wikidata datavalue into ClaimValue
 */
function parseDataValue(datavalue: { type: string; value: unknown }): ClaimValue | null {
  const { type, value } = datavalue;

  switch (type) {
    case 'wikibase-entityid': {
      const entityValue = value as { 'entity-type': string; id: string };
      if (entityValue['entity-type'] === 'item') {
        return {
          type: 'wikibase-item',
          value: entityValue.id,
          qid: entityValue.id,
        };
      }
      return null;
    }

    case 'string':
      return {
        type: 'string',
        value: value as string,
      };

    case 'time': {
      const timeValue = value as WikidataTimeValue;
      return {
        type: 'time',
        value: formatTimeValue(timeValue),
      };
    }

    case 'quantity': {
      const quantityValue = value as WikidataQuantityValue;
      return {
        type: 'quantity',
        value: formatQuantityValue(quantityValue),
      };
    }

    case 'globecoordinate': {
      const coordValue = value as WikidataCoordinateValue;
      return {
        type: 'coordinate',
        value: formatCoordinateValue(coordValue),
      };
    }

    case 'monolingualtext': {
      const textValue = value as { text: string; language: string };
      return {
        type: 'string',
        value: textValue.text,
      };
    }

    default:
      return {
        type: 'unknown',
        value: JSON.stringify(value),
      };
  }
}

/**
 * Format Wikidata time value for display
 */
function formatTimeValue(timeValue: WikidataTimeValue): string {
  const { time, precision } = timeValue;

  // Time format: +YYYY-MM-DDTHH:MM:SSZ
  const match = time.match(/^([+-])(\d+)-(\d{2})-(\d{2})/);
  if (!match) return time;

  const [, sign, year, month, day] = match;
  const yearNum = parseInt(year, 10);
  const displayYear = sign === '-' ? `${yearNum} BCE` : yearNum.toString();

  // Precision: 9 = year, 10 = month, 11 = day
  switch (precision) {
    case 9:
      return displayYear;
    case 10:
      return `${getMonthName(parseInt(month, 10))} ${displayYear}`;
    case 11:
    default:
      return `${parseInt(day, 10)} ${getMonthName(parseInt(month, 10))} ${displayYear}`;
  }
}

function getMonthName(month: number): string {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  return months[month - 1] || '';
}

/**
 * Format Wikidata quantity value for display
 */
function formatQuantityValue(quantityValue: WikidataQuantityValue): string {
  const amount = parseFloat(quantityValue.amount);
  // Remove unit URL, just show the number
  return amount.toLocaleString();
}

/**
 * Format Wikidata coordinate value for display
 */
function formatCoordinateValue(coordValue: WikidataCoordinateValue): string {
  const { latitude, longitude } = coordValue;
  const latDir = latitude >= 0 ? 'N' : 'S';
  const lonDir = longitude >= 0 ? 'E' : 'W';
  return `${Math.abs(latitude).toFixed(4)}${latDir}, ${Math.abs(longitude).toFixed(4)}${lonDir}`;
}

/**
 * Extract unique property IDs from claims
 */
export function extractPropertyIds(claims: Claim[]): string[] {
  return [...new Set(claims.map((claim) => claim.pid))];
}

/**
 * Get property info (label, description) for PIDs
 */
export async function getPropertyInfo(
  pids: string[],
  lang: string = PRIMARY_LANGUAGE
): Promise<Map<string, WikidataProperty>> {
  const results = new Map<string, WikidataProperty>();
  const batches = batchArray(pids, BATCH_SIZE);

  for (const batch of batches) {
    const ids = batch.join('|');
    const params = new URLSearchParams({
      action: 'wbgetentities',
      ids: ids,
      props: 'labels|descriptions',
      languages: lang,
      format: 'json',
      origin: '*',
    });

    try {
      const response = await fetch(`${WIKIDATA_API}?${params}`);
      const data: WikidataApiResponse = await response.json();

      if (data.entities) {
        for (const [pid, entity] of Object.entries(data.entities)) {
          if (pid.startsWith('P')) {
            results.set(pid, {
              pid,
              label: entity.labels?.[lang]?.value || pid,
              description: entity.descriptions?.[lang]?.value || '',
              usage: 0,
              visible: true,
            });
          }
        }
      }
    } catch (error) {
      console.error('Error fetching property info:', error);
    }
  }

  return results;
}

/**
 * Get display value for a claim
 * For QIDs, returns the label; for other types, returns the formatted value
 */
export async function getClaimDisplayValues(
  claims: Claim[],
  lang: string = PRIMARY_LANGUAGE
): Promise<Map<string, Map<string, string>>> {
  // Collect all QIDs that need labels
  const qidsToFetch = new Set<string>();
  for (const claim of claims) {
    for (const value of claim.values) {
      if (value.type === 'wikibase-item' && value.qid) {
        qidsToFetch.add(value.qid);
      }
    }
  }

  // Fetch labels for all QIDs
  const labels = await getLabels([...qidsToFetch], lang);

  // Build result map: qid -> pid -> display value
  const results = new Map<string, Map<string, string>>();

  for (const claim of claims) {
    if (!results.has(claim.qid)) {
      results.set(claim.qid, new Map());
    }
    const qidMap = results.get(claim.qid)!;

    // Get display values for all values, comma-separated
    const displayValues: string[] = [];
    for (const value of claim.values) {
      let displayValue: string;
      if (value.type === 'wikibase-item' && value.qid) {
        displayValue = labels.get(value.qid) || value.qid;
      } else {
        displayValue = value.value;
      }
      if (displayValue && !displayValues.includes(displayValue)) {
        displayValues.push(displayValue);
      }
    }

    if (displayValues.length > 0) {
      qidMap.set(claim.pid, displayValues.join(', '));
    }
  }

  return results;
}

// ============================================================================
// SPARQL Query Functions
// ============================================================================

interface SparqlResult {
  qid: { value: string };
  name: { value: string };
  itemLabel: { value: string };
  instanceOfLabel?: { value: string };
}

interface SparqlResponse {
  results: {
    bindings: SparqlResult[];
  };
}

export interface LabelMatch {
  itemLabel: string;
  instanceOf: string[];
}

/**
 * Query Wikidata SPARQL endpoint to find entities by label and get instance of
 * Returns map of name -> Map of QID -> { itemLabel, instanceOf[] }
 * This handles cases like "Paris" which could match multiple entities (city, person, etc.)
 */
export async function queryEntitiesByLabel(
  labels: string[],
  lang: string = PRIMARY_LANGUAGE
): Promise<Map<string, Map<string, LabelMatch>>> {
  // Map<name, Map<QID, { itemLabel, instanceOf[] }>>
  const labelToResults = new Map<string, Map<string, LabelMatch>>();

  if (labels.length === 0) return labelToResults;

  // for each label remove prefix numbers (.replace(/^\d+\.\s*/, '').trim())
  labels = labels.map(label => label.replace(/^\d+\.\s*/, '').replace(/‡$/, '').trim());

  const batches = batchArray(labels, SPARQL_BATCH_SIZE);

  for (const batch of batches) {
    // Build VALUES clause with labels
    const valuesClause = batch
      .map((label) => `"${escapeSparqlString(label)}"@${lang}`)
      .join(' ');

    const query = `
SELECT ?qid ?name ?itemLabel ?instanceOfLabel
WHERE {
  VALUES ?name { ${valuesClause} }
  ?item (rdfs:label|skos:altLabel) ?name .
  OPTIONAL { ?item wdt:P31 ?instanceOf . }

  BIND(STRAFTER(STR(?item), "http://www.wikidata.org/entity/") AS ?qid)

  SERVICE wikibase:label { bd:serviceParam wikibase:language "${lang}" . }
}
`.trim();

    try {
      const response = await fetch(WIKIDATA_SPARQL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/sparql-results+json',
        },
        body: `query=${encodeURIComponent(query)}`,
      });

      if (!response.ok) {
        console.error('SPARQL query failed:', response.status, response.statusText);
        continue;
      }

      const data: SparqlResponse = await response.json();
      if (LOG_LEVEL > 1) console.log('WikiColumn: SPARQL query returned', data.results.bindings.length, 'results', data.results.bindings);

      for (const binding of data.results.bindings) {
        const qid = binding.qid.value;
        const name = binding.name.value;
        const itemLabel = binding.itemLabel?.value || name;
        const instanceOf = binding.instanceOfLabel?.value || '';

        // Store by the original search label (case-insensitive match)
        const matchingLabel = batch.find(
          (l) => l.toLowerCase() === name.toLowerCase()
        );

        if (LOG_LEVEL > 2) console.log(`WikiColumn: SPARQL matched name "${name}" to QID ${qid} (instance of: ${instanceOf})`, matchingLabel);

        if (matchingLabel) {
          // Get or create the QID map for this label
          if (!labelToResults.has(matchingLabel)) {
            labelToResults.set(matchingLabel, new Map());
          }
          const qidMap = labelToResults.get(matchingLabel)!;

          // Get or create the entry for this QID
          if (!qidMap.has(qid)) {
            qidMap.set(qid, {
              itemLabel,
              instanceOf: instanceOf ? [instanceOf] : [],
            });
          } else {
            // Append instanceOf if not already present
            const existing = qidMap.get(qid)!;
            if (instanceOf && !existing.instanceOf.includes(instanceOf)) {
              existing.instanceOf.push(instanceOf);
            }
          }
        }
      }
    } catch (error) {
      console.error('Error querying SPARQL:', error);
    }
  }
  console.log(`WikiColumn: SPARQL query matched ${labelToResults.size} out of ${labels.length} labels`, labelToResults);
  return labelToResults;
}

/**
 * Escape special characters for SPARQL string literals
 */
function escapeSparqlString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Get instance of (P31) labels for a list of QIDs
 * Returns map of QID -> instance of label
 */
export async function getInstanceOfLabels(
  qids: string[],
  lang: string = PRIMARY_LANGUAGE
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  if (qids.length === 0) return results;

  const batches = batchArray(qids, SPARQL_BATCH_SIZE);

  for (const batch of batches) {
    // Build VALUES clause with QIDs
    const valuesClause = batch.map((qid) => `wd:${qid}`).join(' ');

    const query = `
SELECT ?qid ?instanceOfLabel
WHERE {
  VALUES ?item { ${valuesClause} }
  ?item wdt:P31 ?instanceOf .

  BIND(STRAFTER(STR(?item), "http://www.wikidata.org/entity/") AS ?qid)

  SERVICE wikibase:label { bd:serviceParam wikibase:language "${lang}" . }
}
`.trim();

    try {
      const response = await fetch(WIKIDATA_SPARQL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/sparql-results+json',
        },
        body: `query=${encodeURIComponent(query)}`,
      });

      if (!response.ok) {
        console.error('SPARQL query failed:', response.status, response.statusText);
        continue;
      }

      const data: SparqlResponse = await response.json();

      for (const binding of data.results.bindings) {
        const qid = binding.qid.value;
        const instanceOfLabel = binding.instanceOfLabel?.value || '';

        // Only store the first instance of (most specific)
        if (instanceOfLabel && !results.has(qid)) {
          results.set(qid, instanceOfLabel);
        }
      }
    } catch (error) {
      console.error('Error querying SPARQL for instance of:', error);
    }
  }

  return results;
}
