/**
 * @deprecated Homepage/meta scraping produces unreliable marketing copy and errors.
 * Use scripts/fullRegeneratePlaces.mjs (Wikipedia summaries + English shaping) instead.
 *
 * Build factual place descriptors from web metadata (og:description, meta description).
 * Lines must pass descriptorSynth.isReliableAutoDescriptor() or they are omitted.
 * Usage: node scripts/buildFactualDescriptors.mjs
 *
 * Logs batches of 50. Rewrites data.generated.js in place.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isReliableAutoDescriptor, lintDescriptor } from "../descriptorSynth.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data.generated.js");

const BATCH = 50;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_HTML_BYTES = 600_000;

const BANNED = /\b(hidden gem|must-visit|must visit|iconic|elevated|curated|ultimate destination|bucket list|instagram-worthy|instagram worthy|once-in-a-lifetime|best-kept secret)\b/i;

const JUNK_URL_SUBSTR = ["happeningnext.com", "eventbrite.", "meetup.com", "ticketmaster."];

const JUNK_TEXT =
  /\b(happening at|virtual-time coverage|buy tickets|rsvp now|\b\d{1,2}:\d{2}\s*(am|pm)\s+to\b|eid\d{6,})\b/i;

/** @typedef {{ id: string; name: string; category: string; city: string; country: string; placeUrl?: string; website?: string|null; descriptor?: string }} Place */

function loadPlaces() {
  let t = readFileSync(DATA, "utf8");
  const start = t.indexOf("[");
  let depth = 0;
  let end = start;
  for (; end < t.length; end++) {
    const c = t[end];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) {
        end++;
        break;
      }
    }
  }
  return { preamble: t.slice(0, start), places: JSON.parse(t.slice(start, end)), suffix: t.slice(end) };
}

/** @param {string} s */
function wordCount(s) {
  return (s ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

/** @param {string} text @param {string} url */
function isJunkUrl(url, text) {
  const u = (url ?? "").toLowerCase();
  if (JUNK_URL_SUBSTR.some((j) => u.includes(j))) return true;
  return JUNK_TEXT.test(text ?? "");
}

/** @param {string} html */
function extractMeta(html) {
  const og =
    html.match(/property=["']og:description["'][^>]*content=["']([^"']*)["']/i) ||
    html.match(/content=["']([^"']*)["'][^>]*property=["']og:description["']/i);
  const md =
    html.match(/name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
    html.match(/content=["']([^"']*)["'][^>]*name=["']description["']/i);
  const raw = (og?.[1] ?? md?.[1] ?? "").trim();
  return decodeBasicEntities(stripTags(raw));
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, " ");
}

function decodeBasicEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&lsquo;|&rsquo;/g, "'");
}

/** @param {string} url */
async function fetchMetaDescription(url) {
  if (!/^https?:\/\//i.test(url ?? "")) return "";
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "TasteDescriptorBot/1.0 (+https://github.com/kittygotclauds/taste)",
      },
    });
    const buf = await r.arrayBuffer();
    const slice = buf.byteLength > MAX_HTML_BYTES ? buf.slice(0, MAX_HTML_BYTES) : buf;
    const html = new TextDecoder("utf-8", { fatal: false }).decode(slice);
    return extractMeta(html);
  } catch {
    return "";
  } finally {
    clearTimeout(id);
  }
}

/** Google Translate web response: first chunk is English text. */
function parseGtxResponse(raw) {
  const anchor = '[["';
  const pos = raw.indexOf(anchor);
  if (pos === -1) return "";
  let i = pos + anchor.length;
  if (raw[i] !== '"') return "";
  i++;
  let out = "";
  while (i < raw.length) {
    const c = raw[i++];
    if (c === "\\") {
      const n = raw[i++];
      if (n === '"') out += '"';
      else if (n === "n") out += "\n";
      else out += n ?? "";
      continue;
    }
    if (c === '"') break;
    out += c;
  }
  return decodeBasicEntities(out);
}

/** @param {string} text */
async function translateToEn(text) {
  const q = text.trim();
  if (!q) return "";
  if (/^[\x00-\x7F]+$/.test(q)) return q;
  try {
    const u =
      "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=" +
      encodeURIComponent(q.slice(0, 4500));
    const r = await fetch(u);
    const raw = await r.text();
    const parsed = parseGtxResponse(raw);
    return parsed.length >= 4 ? parsed : q;
  } catch {
    return q;
  }
}

/** @param {string} s */
function isBoilerplateMeta(s) {
  const t = (s ?? "").trim();
  if (!t) return true;
  if (wordCount(t) > 42) return true;
  return /\|\s*(Find all|Official|Tickets|Visit)\b|before your visit\b|ticketing\b|cookie\b.*policy\b|subscribe to\b/i.test(
    t,
  );
}

/** @param {Place} p @param {string} text */
function stripGeo(text, p) {
  let s = text;
  const geoBits = [
    p.city,
    p.country,
    p.city?.split(/\s+/)[0],
    p.country === "United States" ? "USA" : null,
    p.country === "United Kingdom" ? "UK" : null,
  ].filter(Boolean);
  for (const g of geoBits) {
    if (!g || g.length < 3) continue;
    const re = new RegExp(`\\b${escapeRe(g)}\\b`, "gi");
    s = s.replace(re, "");
  }
  s = s
    .replace(/\s+in\s+the\s+heart\s+of\s*,?/gi, " ")
    .replace(/\s+in\s+the\s+area\s+of\s*,?/gi, " ")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
  return s;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** @param {string} raw @param {Place} p */
function shapeFromRaw(raw, p) {
  let s = raw.replace(/\s+/g, " ").trim();
  s = s.replace(/^[^:]+:\s*/, "");
  const isA = s.match(/\b(?:is a|is an|was a|was an)\s+(.+)/i);
  if (isA) s = isA[1];
  const serves = s.match(/\b(?:serves|offering|offers|specializes in|specialises in)\s+(.+)/i);
  if (serves && s.length < 30) s = serves[1];

  s = stripGeo(s, p);
  s = s.replace(/^[\s,.;-]+/, "").replace(/\s+/g, " ").trim();

  const firstSentence = s.split(/(?<=[.!?])\s+/)[0] ?? s;
  s = firstSentence;

  if (BANNED.test(s)) s = s.replace(BANNED, "").replace(/\s+/g, " ").trim();

  return s;
}

/** @param {Place} p @param {string} shaped */
function inferDescriptorCategory(p, shaped) {
  const n = (p.name ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");

  if (/\bglyptoteket\b/.test(n)) return "attraction";
  if (/farmers[\u2019']?\s*market|farmers\s+market/.test(n)) return "attraction";
  if (/\bflea\s+market\b/.test(n)) return "attraction";
  if (/\b(templo\s+mayor|la\s+lonja|mercantil)\b/.test(n)) return "attraction";
  if (/\bmuseum\b/.test(n) && !/\bmuseum\s+(hotel|shop)\b/i.test(n)) return "attraction";

  const s = shaped;
  if (/\b(groceries|grocery\b|supermarket|organic market)\b/i.test(s)) return "shop";
  if (/\b(bookshop|bookstore|homewares|furniture\b|multi-brand|boutique\b retail)\b/i.test(s)) return "shop";
  if (/\b(museum\b|historic house|archaeological|permanent collection)\b/i.test(s)) return "attraction";
  if (/\b(day spa|massage\b|pilates\b|yoga studio|breathwork|cryotherapy)\b/i.test(s)) return "wellness";
  if (/\b(hotel\b|guest rooms|suites\b|lodging)\b/i.test(s)) return "hotel";
  return p.category;
}

/** @param {string} s @param {string} cat */
function categorySignals(cat) {
  return {
    restaurant:
      /\b(restaurant|café|cafe|bar\b|bistro|brasserie|pizzeria|trattoria|tavern|grill|kitchen|dining|menu|chef|cuisine|food hall|bakery|wine bar|pub|eatery|tasting|coffee|caffe)\b/i,
    hotel: /\b(hotel|resort|inn\b|lodging|suite|boutique hotel|guesthouse|hostel)\b/i,
    shop:
      /\b(shop\b|store\b|boutique\b|retail|brand\b|fashion|homewares|bookshop|bookstore|groceries|grocery\b|supermarket|market\b|flagship)\b/i,
    attraction:
      /\b(museum|gallery\b|monument|palace\b|park\b|historic|exhibition|collection|sculpture|tower|garden|market hall)\b/i,
    wellness:
      /\b(spa\b|salon\b|studio\b|clinic\b|gym\b|fitness|pilates|yoga|massage|wellness\b|dermatolog|therapy|facial|ivf|medical|breathwork)\b/i,
  }[cat];
}

/** @param {string} s */
function capitalizeFirstSentence(s) {
  const t = s.trim();
  if (!t) return "";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** @param {string} s @param {Place} p @param {string} cat */
function looksContaminated(s, p, cat) {
  const lower = s.toLowerCase();
  const nameTok = (p.name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (/\b(church and a square|name of both a church|basilica\b|cathedral\b)\b/i.test(lower)) {
    if (cat !== "attraction" && !/\b(parish church)\b/i.test(nameTok)) return true;
  }
  if (/\b(killed|murder|murdered|shooting|patriarch of the hugely)\b/i.test(lower)) return true;
  return false;
}

/** @param {string} s @param {Place} p @param {string} cat */
function ensureCategoryLead(s, p, cat) {
  const sig = categorySignals(cat);
  let out = s.trim();

  if (sig?.test(out)) {
    return capitalizeFirstSentence(out);
  }

  const lead =
    {
      restaurant: "Restaurant",
      hotel: "Hotel",
      shop: "Shop",
      attraction: /\bmuseum\b/i.test(out)
        ? "Museum"
        : /\bgallery\b/i.test(out)
          ? "Art gallery"
          : /\bmarket\b/i.test(out)
            ? "Market"
            : "Visitor attraction",
      wellness: /\bspa\b/i.test(out) ? "Day spa" : "Wellness studio",
    }[cat] ?? "Venue";

  if (!out) return "";
  const cleaned = out.replace(/^[,.;\s]+/, "");
  const body = cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
  let join = `${lead} ${body}`.replace(/\b(hotel hotel|restaurant restaurant|shop shop)\b/gi, (m) => m.split(" ")[0]);
  join = maybeRestaurantVerbLead(join, cat);
  return capitalizeFirstSentence(join);
}

/** @param {string} s @param {string} cat */
function maybeRestaurantVerbLead(s, cat) {
  if (cat !== "restaurant") return s;
  if (
    /^(restaurant|café|cafe|bar|bistro|brasserie|pizzeria|bakery|grill|kitchen|wine|coffee|organic|modern|traditional|seasonal|plant-based|vegetarian|vegan|italian|mexican|french|japanese|chinese|sichuan|thai|vietnamese|seafood|steakhouse|new nordic)\b/i.test(
      s.trim(),
    )
  )
    return s;
  const rest = s.trim();
  return `Restaurant ${rest.charAt(0).toUpperCase() + rest.slice(1)}`;
}

/** @param {string} s @param {string} extraRaw @param {Place} p */
function clampWords(s, minW, maxW, extraRaw, p) {
  let t = s.replace(/\.$/, "").trim();
  if (!t) t = "";
  let words = t.split(/\s+/).filter(Boolean);
  if (wordCount(t) < minW && extraRaw) {
    const firstExtra = extraRaw.split(/(?<=[.!?])\s+/)[0] ?? extraRaw;
    const add = shapeFromRaw(firstExtra, p);
    const merged = `${t} ${add}`.replace(/\s+/g, " ").trim();
    words = merged.split(/\s+/).filter(Boolean);
    t = merged;
  }
  if (words.length > maxW) {
    words = words.slice(0, maxW);
    t = words.join(" ");
  }
  if (wordCount(t) < minW) return "";
  if (!/[.!?]$/.test(t)) t += ".";
  return t;
}

/** @param {Place} p */
async function describePlace(p) {
  let raw = "";
  let sourceUrl = "";

  if (p.website && !isJunkUrl(p.website, "")) {
    raw = await fetchMetaDescription(p.website);
    sourceUrl = p.website;
    if (isJunkUrl(sourceUrl, raw) || isBoilerplateMeta(raw)) raw = "";
  }

  if (!raw && p.placeUrl && /^https?:\/\//i.test(p.placeUrl)) {
    try {
      const host = new URL(p.placeUrl).hostname.replace(/^www\./, "");
      if (!/^(goop\.com|vogue\.com)$/i.test(host)) {
        raw = await fetchMetaDescription(p.placeUrl);
        sourceUrl = p.placeUrl;
        if (isJunkUrl(sourceUrl, raw) || isBoilerplateMeta(raw)) raw = "";
      }
    } catch {
      raw = "";
    }
  }

  if (!raw) return "";

  const translated = await translateToEn(raw);
  const sentences = translated
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const head = sentences[0] ?? translated;
  const tail = sentences.slice(1).join(" ");

  let en = shapeFromRaw(head, p);
  const inferCat = inferDescriptorCategory(p, en);
  if (looksContaminated(en, p, inferCat)) return "";

  en = ensureCategoryLead(en, p, inferCat);

  let out = clampWords(en, 8, 14, tail, p);
  out = lintDescriptor(out);
  return isReliableAutoDescriptor(out) ? out : "";
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<void>} fn
 */
async function forEachPool(items, limit, fn) {
  let ix = 0;
  async function worker() {
    while (true) {
      const i = ix++;
      if (i >= items.length) break;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function main() {
  const { places } = loadPlaces();
  const CONCURRENCY = 8;

  for (let i = 0; i < places.length; i += BATCH) {
    const slice = places.slice(i, i + BATCH);
    const batchNum = Math.floor(i / BATCH) + 1;
    console.log(
      `[buildFactualDescriptors] batch ${batchNum} (${i + 1}-${Math.min(i + BATCH, places.length)} / ${places.length})`,
    );

    /** @type {{ place: Place; descriptor: string }[]} */
    const acc = slice.map((place) => ({ place, descriptor: "" }));
    await forEachPool(acc, CONCURRENCY, async (row) => {
      row.descriptor = await describePlace(row.place);
    });

    for (let j = 0; j < acc.length; j++) {
      places[i + j] = { ...acc[j].place, descriptor: acc[j].descriptor };
    }
  }

  const written = places.filter((p) => p.descriptor).length;
  const empty = places.length - written;

  const js =
    "// Generated by scripts/collect.mjs. Do not edit by hand.\n" +
    `export const PLACES = ${JSON.stringify(places, null, 2)};\n`;
  writeFileSync(DATA, js, "utf8");

  console.log(`[buildFactualDescriptors] done. Non-empty: ${written}, empty: ${empty}`);

  const samples = [];
  const rnd = (n) => Math.floor(Math.random() * n);
  const pool = places.filter((p) => p.descriptor);
  while (samples.length < 20 && pool.length) {
    const p = pool.splice(rnd(pool.length), 1)[0];
    samples.push(`${p.name} (${p.city}): ${p.descriptor}`);
  }
  console.log("[spot-check samples]");
  for (const line of samples) console.log(" -", line);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
