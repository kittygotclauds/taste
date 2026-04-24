import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

/**
 * Minimal collector for Goop city-guide pages and Vogue editor guides.
 * It stores factual place metadata + backlinks; it does not store article text.
 */

/** @typedef {"restaurant"|"hotel"|"shop"} Category */
/** @typedef {"goop"|"vogue"} Source */

/** @typedef Guide
 * @property {Source} source
 * @property {string} guideUrl
 * @property {string} city
 * @property {string} country
 * @property {string=} localFile Absolute path to cached text, optional
 * @property {Category=} defaultCategory If no headings exist, assume this category
 * @property {boolean=} allowInternalLinks Allow vogue.com links as placeUrl
 */

/** @typedef Place
 * @property {string} id
 * @property {string} name
 * @property {Category} category
 * @property {string} city
 * @property {string} country
 * @property {Source} source
 * @property {string} sourceTitle
 * @property {string} sourceUrl
 * @property {string=} placeUrl
 * @property {string=} neighborhood
 * @property {readonly string[]=} tags
 */

/** @param {string} s */
function slugify(s) {
  return (s ?? "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** @param {string} url */
function cleanUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

/** @param {string} text */
function titleFromText(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const h1 = lines.find((l) => /^#\s+\S/.test(l));
  if (h1) return h1.replace(/^#\s+/, "").trim();
  const first = lines.find((l) => l.length > 3 && l.length < 140);
  return first || "Guide";
}

/** @param {string} s */
function stripTags(s) {
  return (s ?? "")
    .toString()
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?(?:noscript|svg|img|picture|source)[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {string} html @param {string} baseUrl */
function htmlToPseudoMarkdown(html, baseUrl) {
  let s = html ?? "";
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");

  // Headings
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, t) => `\n## ${stripTags(t)}\n`);
  s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, t) => `\n### ${stripTags(t)}\n`);

  // Links -> markdown links
  s = s.replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const label = stripTags(text);
    if (!label) return " ";
    let abs = href;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      // ignore
    }
    return `[${label}](${abs})`;
  });

  // Paragraph-ish spacing
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/p>/gi, "\n");
  s = s.replace(/<\/li>/gi, "\n");

  // Strip remaining tags + normalize whitespace
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return s;
}

/** @param {string} name */
function isLikelyVenueName(name) {
  const n = (name ?? "").trim();
  if (!n) return false;
  if (n.length < 2 || n.length > 70) return false;

  const lower = n.toLowerCase();
  const bannedExact = new Set([
    "update to the latest version",
    "save this story",
    "save story",
    "book now",
    "shop the story",
    "download now",
    "see all",
    "read more",
  ]);
  if (bannedExact.has(lower)) return false;

  // Reject obviously descriptive phrases / sentences.
  if (/[.!?]/.test(n)) return false;
  if (/\b(this|that|these|those|here|below|while|when|because)\b/i.test(n)) return false;
  if (/^(a|an|the)\b/i.test(n)) return false;

  // Must look like a proper noun: starts with upper/digit and has at least one uppercase.
  if (!/^[A-Z0-9]/.test(n)) return false;
  if (!/[A-Z]/.test(n)) return false;

  // Too many words is usually a description, not a venue.
  const wordCount = n.split(/\s+/).filter(Boolean).length;
  if (wordCount > 7) return false;

  return true;
}

/** @param {Guide} guide */
async function loadGuideText(guide) {
  if (guide.localFile) return await fs.readFile(guide.localFile, "utf8");
  const res = await fetch(guide.guideUrl, {
    headers: {
      "user-agent": "taste-collector/1.0",
      accept: "text/html,*/*",
    },
  });
  if (!res.ok) throw new Error(`Failed to fetch ${guide.guideUrl}: ${res.status}`);
  const body = await res.text();
  // If it's HTML, convert it to a pseudo-markdown that our regex extractors can handle.
  if (/<\/html>/i.test(body) || /<body\b/i.test(body)) return htmlToPseudoMarkdown(body, guide.guideUrl);
  return body;
}

/**
 * Extract Goop entries from the *textified* page output.
 * Pattern seen in cached content:
 * - section headings: "## Hotels", "## Restaurants", "## Shops"
 * - cards contain "### Place Name" and then a markdown link to a /place/ page
 * @param {string} text
 * @param {Guide} guide
 * @returns {Place[]}
 */
function extractGoop(text, guide) {
  /** @type {Place[]} */
  const out = [];

  const lines = text.split("\n");

  // Postcard-export format: no sections, but many "### [Place](url)" lines.
  // Example:
  // ### [Panadería Rosetta](https://www.postcard.inc/places/...)
  // Bakery · Roma Norte
  const hasSections = lines.some((l) => /^##\s+(Hotels|Restaurants|Shops)\b/i.test(l.trim()));
  if (!hasSections) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const m = /^###\s+\[([^\]]+)\]\((https?:\/\/[^\)]+)\)\s*$/.exec(line);
      if (!m) continue;

      const name = m[1].trim();
      const placeUrl = cleanUrl(m[2]);
      const meta = (lines[i + 1] ?? "").trim(); // "Cafe · Juarez"
      const [typeRaw, neighborhoodRaw] = meta.split("·").map((x) => x.trim());
      const type = (typeRaw ?? "").toLowerCase();
      const neighborhood = neighborhoodRaw || undefined;

      /** @type {Category} */
      const category =
        /(hotel|ryokan|inn|resort|hostel)/i.test(type) ? "hotel"
        : /(shop|store|boutique|market|gallery|department)/i.test(type) ? "shop"
        : "restaurant";

      out.push({
        id: `${slugify(guide.city)}-${slugify(name)}-${category}`,
        name,
        category,
        city: guide.city,
        country: guide.country,
        neighborhood,
        source: "goop",
        sourceTitle: titleFromText(text),
        // Recommendation is the city guide; keep the venue link separately.
        sourceUrl: cleanUrl(guide.guideUrl),
        placeUrl,
      });
    }

    return out;
  }

  /** @type {Category | null} */
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^##\s+Hotels\b/i.test(line)) current = "hotel";
    else if (/^##\s+Restaurants\b/i.test(line)) current = "restaurant";
    else if (/^##\s+Shops\b/i.test(line)) current = "shop";

    if (!current) continue;

    const m = /^###\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const name = m[1].trim();

    // Look ahead for the first goop place URL nearby
    let placeUrl = null;
    let neighborhood = undefined;
    for (let j = i; j < Math.min(i + 40, lines.length); j++) {
      const lj = lines[j].trim();

      // Neighborhood sometimes appears like "London/Mayfair" (no spaces)
      const nb = /^([A-Za-z .'-]+)\/([A-Za-z0-9 .'-]+)\s*$/.exec(lj);
      if (nb) neighborhood = nb[2].trim();

      const urlMatch = /\]\((https?:\/\/goop\.com\/place\/[^)]+)\)/.exec(lj);
      if (urlMatch) {
        placeUrl = cleanUrl(urlMatch[1]);
        break;
      }
    }

    if (!placeUrl) continue;

    out.push({
      id: `${slugify(guide.city)}-${slugify(name)}-${current}`,
      name,
      category: current,
      city: guide.city,
      country: guide.country,
      neighborhood,
      source: "goop",
      sourceTitle: titleFromText(text),
      // For Goop, the recommendation *is* the place page.
      sourceUrl: placeUrl,
    });
  }

  return out;
}

/**
 * Extract Vogue entries from cached text.
 * In cached content, places appear as markdown links: [Name](url)
 * We assign categories based on section headings.
 * @param {string} text
 * @param {Guide} guide
 * @returns {Place[]}
 */
function extractVogue(text, guide) {
  /** @type {Place[]} */
  const out = [];

  /** @type {Category | null} */
  let current = guide.defaultCategory ?? null;
  const lines = text.split("\n");

  const bannedLinkTexts = new Set([
    "book now",
    "save this story",
    "save story",
    "shop the story",
    "see all",
    "read more",
    "previously told vogue",
  ]);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^##\s+Where to Stay\b/i.test(line)) current = "hotel";
    else if (/^##\s+Where to Eat\b/i.test(line)) current = "restaurant";
    else if (/^##\s+Where to Shop\b/i.test(line)) current = "shop";
    else if (/^##\s+(Where to|What to)\s+(Do|Drink|Go|See|Play|Visit)\b/i.test(line)) current = null;
    else if (/^##\s+The\s+Wear\b/i.test(line)) current = null;

    if (!current) continue;

    // Grab any markdown links on the line (standalone OR inline).
    const re = /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g;
    for (const m of line.matchAll(re)) {
      const name = (m[1] ?? "").trim();
      const lower = name.toLowerCase();
      if (!name) continue;
      if (bannedLinkTexts.has(lower)) continue;
      if (lower.length <= 2) continue;
      if (!isLikelyVenueName(name)) continue;

      const placeUrl = cleanUrl(m[2]);
      try {
        const u = new URL(placeUrl);
        const host = u.hostname.toLowerCase();
        const path = u.pathname.toLowerCase();
        if (!guide.allowInternalLinks) {
          // For Vogue pages, we only want outbound links to venues (or booking/retail),
          // not Vogue's own internal navigation/footer links.
          if (host.endsWith("vogue.com") || host.endsWith("stag.vogue.com") || host.endsWith("compute.vogue.com")) continue;
          if (host.includes("vogue")) continue;
          if (host.includes("condenast")) continue;
          if (host.includes("aboutads")) continue;
        } else {
          // When internal links are allowed (e.g. some Vogue list pages),
          // still drop obvious nav/footer destinations.
          if (
            host.endsWith("vogue.com") &&
            (path.startsWith("/tag/") ||
              path.startsWith("/search") ||
              path.startsWith("/contact") ||
              path.startsWith("/about") ||
              path.startsWith("/newsletters") ||
              path.startsWith("/podcast") ||
              path.startsWith("/magazine") ||
              path.startsWith("/video") ||
              path.startsWith("/photovogue") ||
              path.startsWith("/accessibility"))
          ) {
            continue;
          }
        }
        if (host.includes("smart.link")) continue;
      } catch {
        // ignore
      }

      out.push({
        id: `${slugify(guide.city)}-${slugify(name)}-${current}`,
        name,
        category: current,
        city: guide.city,
        country: guide.country,
        source: "vogue",
        sourceTitle: titleFromText(text),
        // For Vogue, the recommendation is the guide article itself.
        sourceUrl: cleanUrl(guide.guideUrl),
        placeUrl,
      });
    }
  }

  return out;
}

/** @param {Place[]} places */
function uniqById(places) {
  const m = new Map();
  for (const p of places) m.set(p.id, p);
  return [...m.values()];
}

async function main() {
  const configPath = path.join(ROOT, "scripts", "guides.json");
  const raw = await fs.readFile(configPath, "utf8");
  /** @type {Guide[]} */
  const guides = JSON.parse(raw);

  /** @type {Place[]} */
  let all = [];
  for (const g of guides) {
    const text = await loadGuideText(g);
    const extracted = g.source === "goop" ? extractGoop(text, g) : extractVogue(text, g);
    all = all.concat(extracted);
  }

  all = uniqById(all).sort((a, b) => (a.city + a.name).localeCompare(b.city + b.name));

  const outPath = path.join(ROOT, "data.generated.js");
  const js = `// Generated by scripts/collect.mjs. Do not edit by hand.\n` +
    `export const PLACES = ${JSON.stringify(all, null, 2)};\n`;
  await fs.writeFile(outPath, js, "utf8");

  console.log(`Generated ${all.length} places -> ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

