import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = existsSync(path.join(__dirname, "package.json"))
  ? __dirname
  : path.resolve(__dirname, "..");

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

/** @typedef {{ included: number, filtered: Record<string, number> }} GuideStats */

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

/** Remove nav/header/footer/aside regions (best-effort; shallow nesting). */
function stripStructuralNoise(html) {
  let s = html;
  for (const tag of ["nav", "header", "footer", "aside"]) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    s = s.replace(re, "");
  }
  return s;
}

/** Slice inner HTML between outermost `<tag>...</tag>` pair. */
function sliceOutermost(html, tag) {
  const openRe = new RegExp(`<${tag}\\b`, "i");
  const closeLiteral = `</${tag}>`;
  const start = html.search(openRe);
  if (start === -1) return null;
  const gt = html.indexOf(">", start);
  if (gt === -1) return null;
  const innerStart = gt + 1;
  const lower = html.toLowerCase();
  const end = lower.lastIndexOf(closeLiteral.toLowerCase());
  if (end === -1 || end < innerStart) return null;
  return html.slice(innerStart, end);
}

const CONTENT_DIV_CLASS =
  "\\b(?:article-body|article__body|post-content|post__content|content-body|story-body|article-content|ArticlePageContent|body-text)\\b";

/** Extract balanced inner HTML after first `<div class="...article-body...">`-style opener. */
function extractContentDiv(html) {
  const re = new RegExp(`<div\\b[^>]*(?:${CONTENT_DIV_CLASS})[^>]*>`, "i");
  const m = re.exec(html);
  if (!m) return null;
  const innerStart = m.index + m[0].length;
  return sliceBalancedDiv(html, innerStart);
}

function sliceBalancedDiv(html, innerStart) {
  let depth = 1;
  let i = innerStart;
  const lower = html.toLowerCase();
  while (depth > 0 && i < html.length) {
    const open = lower.indexOf("<div", i);
    const close = lower.indexOf("</div>", i);
    if (close === -1) break;
    if (open !== -1 && open < close) {
      depth++;
      i = open + 4;
    } else {
      depth--;
      if (depth === 0) return html.slice(innerStart, close);
      i = close + 6;
    }
  }
  return html.slice(innerStart);
}

/**
 * Limit scraping to main article markup (drops global chrome outside article/main/content divs).
 * @param {string} html
 */
function extractMainContentHtml(html) {
  let h = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "");
  h = stripStructuralNoise(h);

  let chunk =
    sliceOutermost(h, "article") ||
    sliceOutermost(h, "main") ||
    extractContentDiv(h);

  if (!chunk) {
    const bm = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(h);
    chunk = bm ? bm[1] : h;
  }
  return chunk;
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

/** Lowercase exact-match blocklists (case-insensitive comparison). */
const BLOCKLIST_SOCIAL = [
  "Facebook",
  "Instagram",
  "Pinterest",
  "TikTok",
  "Twitter",
  "YouTube",
  "Threads",
  "LinkedIn",
  "Snapchat",
  "WhatsApp",
].map((s) => s.toLowerCase());

const BLOCKLIST_VOGUE_NAV = [
  "Fashion",
  "Beauty",
  "Culture",
  "Living",
  "Weddings",
  "Shopping",
  "Runway",
  "Street Style",
  "Celebrity Style",
  "Celebrity Beauty",
  "Trends",
  "Designers",
  "Models",
  "Parties",
  "Royals",
  "News",
  "Opinion",
  "Music",
  "Sports",
  "Technology",
  "Travel",
  "Food",
  "Books",
  "Homes",
  "Makeup",
  "Nails",
  "Hair",
  "Skin",
  "Wellness",
  "Retail",
  "Companies",
  "Events",
  "Careers",
  "Arts",
].map((s) => s.toLowerCase());

const BLOCKLIST_COUNTRY = [
  "Arabia",
  "Australia",
  "Brasil",
  "Britain",
  "China",
  "Czechoslovakia",
  "España",
  "France",
  "Germany",
  "Greece",
  "Hong Kong",
  "India",
  "Italia",
  "Japan",
  "Korea",
  "México",
  "Nederland",
  "Philippines",
  "Polska",
  "Portugal",
  "Scandinavia",
  "Singapore",
  "Taiwan",
  "Thailand",
  "Türkiye",
  "Ukraine",
  "Adria",
].map((s) => s.toLowerCase());

const BLOCKLIST_FOOTER = [
  "Ad Choices",
  "Manage Account",
  "Masthead",
  "Member Benefits",
  "Newsletter",
  "Privacy Policy",
  "Site Map",
  "Skip to main content",
  "Subscribe",
  "Sustainability",
  "User Agreement",
  "Verify Subscription",
  "Vogue Archive",
  "TEEN VOGUE",
  "VOGUE BUSINESS",
  "Vogue College of Fashion",
  "How We Test",
  "Executive Reports",
  "Forces of Fashion",
].map((s) => s.toLowerCase());

const BLOCKLIST_SOCIAL_SET = new Set(BLOCKLIST_SOCIAL);
const BLOCKLIST_VOGUE_NAV_SET = new Set(BLOCKLIST_VOGUE_NAV);
const BLOCKLIST_COUNTRY_SET = new Set(BLOCKLIST_COUNTRY);
const BLOCKLIST_FOOTER_SET = new Set(BLOCKLIST_FOOTER);

const LEGACY_BANNED_LINK = new Set([
  "save this story",
  "save story",
  "shop the story",
  "book now",
  "see all",
  "read more",
  "previously told vogue",
]);

/** @returns {GuideStats} */
function createStats() {
  return { included: 0, filtered: {} };
}

/** @param {GuideStats} stats @param {string} reason */
function recordFiltered(stats, reason) {
  stats.filtered[reason] = (stats.filtered[reason] || 0) + 1;
}

/**
 * @param {string} name
 * @param {string} placeUrl
 * @param {Guide} guide
 * @param {GuideStats} stats
 * @returns {{ ok: boolean, reason?: string }}
 */
function validatePlace(name, placeUrl, guide, stats) {
  const n = (name ?? "").trim();
  const lower = n.toLowerCase();

  if (!n) {
    recordFiltered(stats, "empty_name");
    return { ok: false, reason: "empty_name" };
  }

  if (LEGACY_BANNED_LINK.has(lower)) {
    recordFiltered(stats, "legacy_banned_link");
    return { ok: false, reason: "legacy_banned_link" };
  }

  if (BLOCKLIST_SOCIAL_SET.has(lower)) {
    recordFiltered(stats, "blocklist_social");
    return { ok: false, reason: "blocklist_social" };
  }
  if (BLOCKLIST_VOGUE_NAV_SET.has(lower)) {
    recordFiltered(stats, "blocklist_vogue_nav");
    return { ok: false, reason: "blocklist_vogue_nav" };
  }
  if (BLOCKLIST_COUNTRY_SET.has(lower)) {
    recordFiltered(stats, "blocklist_country");
    return { ok: false, reason: "blocklist_country" };
  }
  if (BLOCKLIST_FOOTER_SET.has(lower)) {
    recordFiltered(stats, "blocklist_footer");
    return { ok: false, reason: "blocklist_footer" };
  }

  if (/expand/i.test(n) || /chevron/i.test(n) || /expand$/i.test(n)) {
    recordFiltered(stats, "expand_chevron_ui");
    return { ok: false, reason: "expand_chevron_ui" };
  }

  if (/^all\s+(beauty|culture|fashion|living|weddings)\b/i.test(n)) {
    recordFiltered(stats, "blocklist_all_section");
    return { ok: false, reason: "blocklist_all_section" };
  }

  try {
    const u = new URL(placeUrl);
    const pth = u.pathname.toLowerCase();
    if (pth.includes("/contributor/") || pth.includes("/author/")) {
      recordFiltered(stats, "byline_url");
      return { ok: false, reason: "byline_url" };
    }

    if (guide.source === "vogue") {
      const host = u.hostname.toLowerCase();
      if (!guide.allowInternalLinks) {
        if (host.endsWith("vogue.com") || host.endsWith("stag.vogue.com") || host.endsWith("compute.vogue.com")) {
          recordFiltered(stats, "host_internal_vogue");
          return { ok: false, reason: "host_internal_vogue" };
        }
        if (host.includes("vogue")) {
          recordFiltered(stats, "host_vogue");
          return { ok: false, reason: "host_vogue" };
        }
        if (host.includes("condenast")) {
          recordFiltered(stats, "host_condenast");
          return { ok: false, reason: "host_condenast" };
        }
        if (host.includes("aboutads")) {
          recordFiltered(stats, "host_aboutads");
          return { ok: false, reason: "host_aboutads" };
        }
      } else if (host.endsWith("vogue.com")) {
        if (
          pth.startsWith("/tag/") ||
          pth.startsWith("/search") ||
          pth.startsWith("/contact") ||
          pth.startsWith("/about") ||
          pth.startsWith("/newsletters") ||
          pth.startsWith("/podcast") ||
          pth.startsWith("/magazine") ||
          pth.startsWith("/video") ||
          pth.startsWith("/photovogue") ||
          pth.startsWith("/accessibility")
        ) {
          recordFiltered(stats, "host_vogue_nav_path");
          return { ok: false, reason: "host_vogue_nav_path" };
        }
      }
      if (host.includes("smart.link")) {
        recordFiltered(stats, "host_smart_link");
        return { ok: false, reason: "host_smart_link" };
      }
    }
  } catch {
    recordFiltered(stats, "bad_place_url");
    return { ok: false, reason: "bad_place_url" };
  }

  if (/^book\s+at\b/i.test(n) || /^book\s+now\b/i.test(n)) {
    recordFiltered(stats, "cta_book");
    return { ok: false, reason: "cta_book" };
  }

  if (/^##\s+/i.test(n) || /^#\s+/i.test(n)) {
    recordFiltered(stats, "cta_markdown_heading");
    return { ok: false, reason: "cta_markdown_heading" };
  }

  if (
    /^visit\s+site\b/i.test(n) ||
    /^read\s+on\b/i.test(n) ||
    /^below,\s*find\b/i.test(n) ||
    /^without\s+further\s+ado\b/i.test(n)
  ) {
    recordFiltered(stats, "cta_fragment_phrase");
    return { ok: false, reason: "cta_fragment_phrase" };
  }

  if (/&#|&amp;|&quot;/i.test(n)) {
    recordFiltered(stats, "html_entity_in_name");
    return { ok: false, reason: "html_entity_in_name" };
  }

  if (n.length > 60) {
    recordFiltered(stats, "name_too_long");
    return { ok: false, reason: "name_too_long" };
  }

  if (/^\d/.test(n) && /\bpercent\b/i.test(n)) {
    recordFiltered(stats, "digit_percent_caption");
    return { ok: false, reason: "digit_percent_caption" };
  }

  if (/^\d+\s+of\b/i.test(n)) {
    recordFiltered(stats, "digit_slide_caption");
    return { ok: false, reason: "digit_slide_caption" };
  }

  if (!isLikelyVenueName(n)) {
    recordFiltered(stats, "unlikely_venue_name");
    return { ok: false, reason: "unlikely_venue_name" };
  }

  stats.included++;
  return { ok: true };
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
  /** @type {string} */
  let body;
  if (guide.localFile) body = await fs.readFile(guide.localFile, "utf8");
  else {
    const res = await fetch(guide.guideUrl, {
      headers: {
        "user-agent": "taste-collector/1.0 (+https://github.com/kittygotclauds/taste)",
        accept: "text/html,*/*",
      },
    });
    if (!res.ok) throw new Error(`Failed to fetch ${guide.guideUrl}: ${res.status}`);
    body = await res.text();
  }

  if (/<\/html>/i.test(body) || /<body\b/i.test(body)) {
    const scoped = extractMainContentHtml(body);
    return htmlToPseudoMarkdown(scoped, guide.guideUrl);
  }
  return body;
}

/**
 * Extract Goop entries from the *textified* page output.
 * @param {string} text
 * @param {Guide} guide
 * @param {GuideStats} stats
 * @returns {Place[]}
 */
function extractGoop(text, guide, stats) {
  /** @type {Place[]} */
  const out = [];

  const lines = text.split("\n");

  const hasSections = lines.some((l) => /^##\s+(Hotels|Restaurants|Shops)\b/i.test(l.trim()));
  if (!hasSections) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const m = /^###\s+\[([^\]]+)\]\((https?:\/\/[^\)]+)\)\s*$/.exec(line);
      if (!m) continue;

      const name = m[1].trim();
      const placeUrl = cleanUrl(m[2]);
      const meta = (lines[i + 1] ?? "").trim();
      const [typeRaw, neighborhoodRaw] = meta.split("·").map((x) => x.trim());
      const type = (typeRaw ?? "").toLowerCase();
      const neighborhood = neighborhoodRaw || undefined;

      /** @type {Category} */
      const category =
        /(hotel|ryokan|inn|resort|hostel)/i.test(type) ? "hotel"
        : /(shop|store|boutique|market|gallery|department)/i.test(type) ? "shop"
        : "restaurant";

      const candidate = {
        id: `${slugify(guide.city)}-${slugify(name)}-${category}`,
        name,
        category,
        city: guide.city,
        country: guide.country,
        neighborhood,
        source: "goop",
        sourceTitle: titleFromText(text),
        sourceUrl: cleanUrl(guide.guideUrl),
        placeUrl,
      };

      const v = validatePlace(name, placeUrl, guide, stats);
      if (!v.ok) continue;

      out.push(candidate);
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

    let placeUrl = null;
    let neighborhood = undefined;
    for (let j = i; j < Math.min(i + 40, lines.length); j++) {
      const lj = lines[j].trim();

      const nb = /^([A-Za-z .'-]+)\/([A-Za-z0-9 .'-]+)\s*$/.exec(lj);
      if (nb) neighborhood = nb[2].trim();

      const urlMatch = /\]\((https?:\/\/goop\.com\/place\/[^)]+)\)/.exec(lj);
      if (urlMatch) {
        placeUrl = cleanUrl(urlMatch[1]);
        break;
      }
    }

    if (!placeUrl) continue;

    const v = validatePlace(name, placeUrl, guide, stats);
    if (!v.ok) continue;

    out.push({
      id: `${slugify(guide.city)}-${slugify(name)}-${current}`,
      name,
      category: current,
      city: guide.city,
      country: guide.country,
      neighborhood,
      source: "goop",
      sourceTitle: titleFromText(text),
      sourceUrl: placeUrl,
    });
  }

  return out;
}

/**
 * Extract Vogue entries from cached text.
 * @param {string} text
 * @param {Guide} guide
 * @param {GuideStats} stats
 * @returns {Place[]}
 */
function extractVogue(text, guide, stats) {
  /** @type {Place[]} */
  const out = [];

  /** @type {Category | null} */
  let current = guide.defaultCategory ?? null;
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^##\s+Where to Stay\b/i.test(line)) current = "hotel";
    else if (/^##\s+Where to Eat\b/i.test(line)) current = "restaurant";
    else if (/^##\s+Where to Shop\b/i.test(line)) current = "shop";
    else if (/^##\s+(Where to|What to)\s+(Do|Drink|Go|See|Play|Visit)\b/i.test(line)) current = null;
    else if (/^##\s+The\s+Wear\b/i.test(line)) current = null;

    if (!current) continue;

    const re = /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g;
    for (const m of line.matchAll(re)) {
      const name = (m[1] ?? "").trim();
      const lower = name.toLowerCase();
      if (!name) {
        recordFiltered(stats, "empty_name");
        continue;
      }
      if (lower.length <= 2) {
        recordFiltered(stats, "name_too_short");
        continue;
      }

      const placeUrl = cleanUrl(m[2]);

      const v = validatePlace(name, placeUrl, guide, stats);
      if (!v.ok) continue;

      out.push({
        id: `${slugify(guide.city)}-${slugify(name)}-${current}`,
        name,
        category: current,
        city: guide.city,
        country: guide.country,
        source: "vogue",
        sourceTitle: titleFromText(text),
        sourceUrl: cleanUrl(guide.guideUrl),
        placeUrl,
      });
    }
  }

  return out;
}

/** @param {string} name */
function foldNameKey(name) {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {string} name */
function accentPreferenceScore(name) {
  const stripped = name.normalize("NFD").replace(/\p{M}/gu, "");
  return name.length - stripped.length + [...name].filter((c) => c.charCodeAt(0) > 127).length;
}

/** @param {string} a @param {string} b */
function pickBetterAccentedName(a, b) {
  const sa = accentPreferenceScore(a);
  const sb = accentPreferenceScore(b);
  if (sa !== sb) return sa > sb ? a : b;
  return a.length >= b.length ? a : b;
}

/** Collapse pairs like Chateau vs Château; prefer accented spelling. @param {Place[]} places */
function dedupeAccentVariants(places) {
  const map = new Map();
  for (const p of places) {
    const key = `${p.city}\0${p.category}\0${foldNameKey(p.name)}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...p });
      continue;
    }
    const name = pickBetterAccentedName(p.name, prev.name);
    map.set(key, {
      ...prev,
      ...p,
      name,
      id: `${slugify(p.city)}-${slugify(name)}-${p.category}`,
    });
  }
  return [...map.values()];
}

/** @param {Place[]} places */
function uniqById(places) {
  const m = new Map();
  for (const p of places) m.set(p.id, p);
  return [...m.values()];
}

/** @param {GuideStats} stats @param {string} label */
function logGuideSummary(label, stats) {
  const filteredTotal = Object.values(stats.filtered).reduce((a, b) => a + b, 0);
  const parts = Object.entries(stats.filtered)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, n]) => `${reason}: ${n}`);
  console.log(
    `[collect] ${label} — included: ${stats.included}, filtered: ${filteredTotal}` +
      (parts.length ? ` (${parts.join(", ")})` : ""),
  );
}

function parseArgs() {
  const args = process.argv.slice(2);
  /** @type {{ guideIndex: number | null, limit: number | null, dryRun: boolean }} */
  const opts = { guideIndex: null, limit: null, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--guide-index" && args[i + 1] !== undefined) {
      opts.guideIndex = Number(args[++i]);
    } else if (a === "--limit" && args[i + 1] !== undefined) {
      opts.limit = Number(args[++i]);
    } else if (a === "--dry-run") {
      opts.dryRun = true;
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs();

  const guidesPathRoot = path.join(ROOT, "guides.json");
  const guidesPathScripts = path.join(ROOT, "scripts", "guides.json");
  const configPath = existsSync(guidesPathRoot) ? guidesPathRoot : guidesPathScripts;

  const raw = await fs.readFile(configPath, "utf8");
  /** @type {Guide[]} */
  let guides = JSON.parse(raw);

  if (opts.guideIndex !== null && !Number.isNaN(opts.guideIndex)) {
    const g = guides[opts.guideIndex];
    if (!g) throw new Error(`No guide at index ${opts.guideIndex}`);
    guides = [g];
  } else if (opts.limit !== null && !Number.isNaN(opts.limit)) {
    guides = guides.slice(0, opts.limit);
  }

  /** @type {Place[]} */
  let all = [];
  for (const g of guides) {
    const stats = createStats();
    const text = await loadGuideText(g);
    const extracted =
      g.source === "goop" ? extractGoop(text, g, stats) : extractVogue(text, g, stats);

    const label = `${g.city} (${g.source}) ${g.guideUrl ? `<${g.guideUrl}>` : ""}`;
    logGuideSummary(label, stats);

    all = all.concat(extracted);
  }

  all = dedupeAccentVariants(all);
  all = uniqById(all).sort((a, b) => (a.city + a.name).localeCompare(b.city + b.name));

  const outPath = path.join(ROOT, "data.generated.js");
  const js =
    "// Generated by scripts/collect.mjs. Do not edit by hand.\n" +
    `export const PLACES = ${JSON.stringify(all, null, 2)};\n`;

  if (opts.dryRun) {
    console.log(`[collect] dry-run: skipped writing ${all.length} places -> ${outPath}`);
  } else {
    await fs.writeFile(outPath, js, "utf8");
    console.log(`Generated ${all.length} places -> ${outPath}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
