import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { enrichPlacesWithWebsitesMultiStrategy } from "../website-resolve.mjs";
import { assignDescriptors } from "../descriptorSynth.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = existsSync(path.join(__dirname, "package.json"))
  ? __dirname
  : path.resolve(__dirname, "..");

/**
 * Collector for Goop city-guide pages and Vogue editor guides.
 * Outputs places with backlinks; optional pass resolves official websites via website-resolve.mjs.
 */

/** @typedef {"restaurant"|"hotel"|"shop"|"attraction"|"wellness"} Category */
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
 * @property {string|null=} website Official venue URL discovered from listing page (never Goop/Vogue)
 * @property {string} descriptor One-line voice descriptor (≤10 words)
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

/** Fold unicode punctuation so curly apostrophes still match fluff patterns. */
function foldForFluff(line) {
  return (line ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[\u2018\u2019\u0060]/g, "'")
    .toLowerCase();
}

/** Editorial / dek lines that must never become guide titles or source titles. */
function isEditorialFluffLine(line) {
  const s = (line ?? "").trim();
  if (!s) return true;
  const lower = foldForFluff(s);
  if (/below\s*[,.]?\s*find\b/.test(lower)) return true;
  if (/below\b/.test(lower) && /\bfind\b/.test(lower) && /\bvogue\b/.test(lower)) return true;
  if (/without\s+further\s+ado/i.test(lower)) return true;
  if (/\bvogue\b/i.test(lower) && /\bguide\b/i.test(lower)) return true;
  if (/editor'?s\s+(official\s+)?guide\b/i.test(lower)) return true;
  if (/^\*{0,2}\s*vogue\b/i.test(lower)) return true;
  if (/photographs?\s+(by|courtesy)/i.test(lower)) return true;
  if (/^(published|posted|updated)\s+/i.test(lower)) return true;
  // Inline markdown recommendations / editor blurbs mistaken for titles.
  if (/\]\(https?:\/\//i.test(s)) return true;
  return false;
}

/** Stable citation line per listing (never raw article deks). */
function pickGuideDisplayTitle(text, guide) {
  const raw = titleFromText(text).trim();
  if (!raw || isEditorialFluffLine(raw)) {
    const src = guide.source === "goop" ? "Goop" : "Vogue";
    return `${src}: ${guide.city}`;
  }

  if (guide.source === "vogue") {
    // Vogue markdown often lifts photo captions / short blurbs without markdown links.
    if (/\.\s*$/.test(raw) && raw.length < 140 && !/\bguide\b/i.test(raw)) {
      return `Vogue: ${guide.city}`;
    }
  }

  return raw;
}

/** @param {string} text */
function titleFromText(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const h1 = lines.find((l) => /^#\s+\S/.test(l));
  if (h1) {
    const t = h1.replace(/^#\s+/, "").trim();
    if (!isEditorialFluffLine(t)) return t;
  }
  const first = lines.find(
    (l) =>
      l.length > 3 &&
      l.length < 140 &&
      !/^#{2,3}\s/.test(l) &&
      !isEditorialFluffLine(l),
  );
  return first || "Guide";
}

/** Decode common entities in og:title / title attributes. */
function decodeHtmlEntities(s) {
  return (s ?? "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** Prefer og:title, then document title (stripped of site suffix). */
function extractHtmlArticleTitle(html) {
  const og =
    /<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html) ||
    /<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i.exec(html);
  if (og) {
    let t = decodeHtmlEntities(og[1]).trim();
    t = t.replace(/\s*\|\s*Vogue\s*$/i, "").replace(/\s*\|\s*Goop\s*$/i, "").trim();
    if (t && !isEditorialFluffLine(t)) return t;
  }
  const tit = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (tit) {
    let t = stripTags(tit[1])
      .replace(/\s*\|\s*Vogue\s*$/i, "")
      .replace(/\s*\|\s*Goop\s*$/i, "")
      .trim();
    t = decodeHtmlEntities(t);
    if (t && !isEditorialFluffLine(t)) return t;
  }
  return null;
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

/**
 * Map a section heading (## or ### intro) to a category using keyword cues.
 * @param {string} line
 * @returns {Category | null}
 */
function inferCategoryFromHeadingLine(line) {
  const raw = line
    .replace(/^#{2,3}\s+/, "")
    .trim()
    .toLowerCase();
  if (!raw) return null;

  const hotelRx =
    /\b(where to stay|hotels?|hotel guide|hotel picks|accommodation|lodging|places to stay)\b/;
  const wellnessRx =
    /\b(wellness|spas?\b|spa\b|fitness|gyms?\b|pilates|yoga|health\s*(and\s*|&\s*)beauty|beauty\s*(and\s*|&\s*)health|beauty\s*(and\s*|&\s*)wellness|wellness\s*(and\s*|&\s*)beauty|salons?\b|beauty\s+services|clinics?\b|medical\b|dermatolog|massage|facials?\b|skin\s*care|acupuncture|osteopath|physio|cryotherapy|barbershop|\bbarber\b)\b/;
  const attractionRx =
    /\b(what to see|things to do|sightseeing|attractions?|museums?|museum guide|galleries|\bgallery\b|culture\b|cultural|landmarks?|\bparks?\b|castle|palaces?|monuments?|historic|exhibitions?|botanical|zoos?\b|aquarium|architecture)\b/;
  const shopRx = /\b(where to shop|shopping|shops?\b|stores?|boutiques?|retail|markets?\b)\b/;
  const restaurantRx =
    /\b(where to eat|restaurants?|dining|food\b|\bbars?\b|\bcafes?\b|\bcafés?\b|coffee|baker(y|ies)|breakfast|brunch|where to drink)\b/;

  if (hotelRx.test(raw)) return "hotel";
  if (wellnessRx.test(raw)) return "wellness";
  if (attractionRx.test(raw)) return "attraction";
  if (shopRx.test(raw)) return "shop";
  if (restaurantRx.test(raw)) return "restaurant";

  return null;
}

/**
 * Infer category from Goop postcard-type metadata before the · separator (e.g. "Bakery", "Museum").
 * @param {string} typeRaw
 * @returns {Category | null}
 */
function inferCategoryFromMetaType(typeRaw) {
  const t = (typeRaw ?? "").trim().toLowerCase();
  if (!t) return null;

  if (/\b(hotel|ryokan|inn|resort|hostel)\b/i.test(t)) return "hotel";
  if (
    /\b(spa|wellness|salon|gym|yoga|pilates|fitness|beauty|clinic|medical|massage|facial|nails|brows?|lashes|dermatolog|skin|acupuncture|osteopath|physio|cryotherapy|barbershop|barber)\b/i.test(t)
  ) {
    return "wellness";
  }
  if (
    /\b(museum|museo|gallery|park|castle|palace|landmark|attraction|monument|church|temple|plaza|university|universidad|historic|botanical|zoo|aquarium|exhibition)\b/i.test(t)
  ) {
    return "attraction";
  }
  if (/\b(shop|store|boutique|market|department|designer|fashion)\b/i.test(t)) return "shop";
  if (/\b(restaurant|cafe|coffee|bakery|bar|bistro|dining|food)\b/i.test(t)) return "restaurant";

  return null;
}

/**
 * Fallback cues from the visible place name.
 * @param {string} name
 * @returns {Category | null}
 */
function inferCategoryFromName(name) {
  const lower = (name ?? "").trim().toLowerCase();
  if (!lower) return null;

  if (/\b(m\.d\.|d\.o\.|clinic|medical)\b/i.test(name)) return "wellness";
  if (
    /\b(spa\b|yoga|pilates|salon\b|massage|facial|cryotherapy|acupuncture|osteopath|physio|barbershop|\bbarber\b|medspa|anti-aging)\b/i.test(lower)
  ) {
    return "wellness";
  }
  if (/\b(gym\b|fitness\b|crossfit\b|\bspin\b|soulcycle|facegym|bodyism|\bblok\b)\b/i.test(lower)) {
    return "wellness";
  }

  if (/\b(hotel|hôtel|ryokan)\b/i.test(lower)) return "hotel";

  if (
    /\bmuseo\b|\bmuseum\b|\bgallery\b|\bcastle\b|\bpalace\b|\bmonument\b|\bcathedral\b|\bplaza\b|\bzoo\b|\baquarium\b|\bobservatory\b|\bbotanical\b/i.test(lower)
  ) {
    return "attraction";
  }
  // Avoid treating surnames like "Park" as parks; require compound venue cues.
  if (
    /\b(?:national|city|theme|water|amusement|skate)\s+parks?\b|\bcentral\s+park\b|\bhyde\s+park\b|\bolympic\s+park\b/i.test(
      lower,
    ) ||
    /\bparks?\s+(?:museum|hotel|theater|theatre|centre|center)\b/i.test(lower)
  ) {
    return "attraction";
  }

  if (/\bcafe\b|\bcafé\b|\bcoffee\b|\bbakery\b|\bbar\b/i.test(lower)) return "restaurant";

  return null;
}

/**
 * Goop /place/ URL paths often encode vertical (spa, health-and-beauty, etc.).
 * @param {string} placeUrl
 * @returns {Category | null}
 */
function inferCategoryFromPlaceUrl(placeUrl) {
  try {
    const u = new URL(placeUrl);
    const host = u.hostname.toLowerCase();
    const p = u.pathname.toLowerCase();
    if (!host.includes("goop.com")) return null;
    if (
      /\/(spa|wellness|beauty|health|fitness|skin|massage|salon|health-and-beauty|health-and-wellness)\b/.test(p)
    ) {
      return "wellness";
    }
    if (
      /\/(museum|gallery|activities|sightseeing|park|attractions|cultural)\b/.test(p) ||
      /\/things-to-do\b/.test(p)
    ) {
      return "attraction";
    }
    if (/\/(hotel|hotels|accommodation)\b/.test(p)) return "hotel";
    if (/\/(shop|shopping|stores|boutiques)\b/.test(p)) return "shop";
    if (/\/(restaurant|restaurants|dining|cafes|bars)\b/.test(p)) return "restaurant";
  } catch {
    // ignore
  }
  return null;
}

/**
 * @param {Category | null} sectionCategory from nearest ## heading
 * @param {string} metaType Goop postcard line before ·
 * @param {string} name
 * @param {Guide} guide
 * @param {string} placeUrl
 */
function resolvePlaceCategory(sectionCategory, metaType, name, guide, placeUrl) {
  const metaCat = inferCategoryFromMetaType(metaType);
  const nameCat = inferCategoryFromName(name);
  const urlCat = inferCategoryFromPlaceUrl(placeUrl);

  const nameKey = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
  if (nameKey === "carla fernandez") return "shop";

  // Strong cues override obvious section mismatches (e.g. museums listed under Dining, parks under Shops).
  if (nameCat === "attraction" && (sectionCategory === "shop" || sectionCategory === "restaurant")) {
    return "attraction";
  }
  if (
    nameCat === "wellness" &&
    (sectionCategory === "shop" || sectionCategory === "attraction" || sectionCategory === "restaurant")
  ) {
    return "wellness";
  }
  if (nameCat === "restaurant" && sectionCategory === "hotel") return "restaurant";

  if (metaCat === "shop" && sectionCategory === "hotel") return "shop";

  if (urlCat === "wellness" && (sectionCategory === "shop" || sectionCategory === "restaurant")) {
    return "wellness";
  }
  if (urlCat === "attraction" && sectionCategory === "shop") return "attraction";

  if (sectionCategory) return sectionCategory;
  if (urlCat) return urlCat;
  if (metaCat) return metaCat;
  if (nameCat) return nameCat;
  return guide.defaultCategory ?? "restaurant";
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
 * Full validation without mutating GuideStats (used to probe URLs before committing).
 * @param {string} name
 * @param {string} placeUrl
 * @param {Guide} guide
 * @returns {{ ok: boolean, reason?: string }}
 */
function analyzePlaceCandidate(name, placeUrl, guide) {
  const n = (name ?? "").trim();
  const lower = n.toLowerCase();

  if (!n) return { ok: false, reason: "empty_name" };

  if (LEGACY_BANNED_LINK.has(lower)) return { ok: false, reason: "legacy_banned_link" };

  if (BLOCKLIST_SOCIAL_SET.has(lower)) return { ok: false, reason: "blocklist_social" };
  if (BLOCKLIST_VOGUE_NAV_SET.has(lower)) return { ok: false, reason: "blocklist_vogue_nav" };
  if (BLOCKLIST_COUNTRY_SET.has(lower)) return { ok: false, reason: "blocklist_country" };
  if (BLOCKLIST_FOOTER_SET.has(lower)) return { ok: false, reason: "blocklist_footer" };

  if (/expand/i.test(n) || /chevron/i.test(n) || /expand$/i.test(n)) {
    return { ok: false, reason: "expand_chevron_ui" };
  }

  if (/^all\s+(beauty|culture|fashion|living|weddings)\b/i.test(n)) {
    return { ok: false, reason: "blocklist_all_section" };
  }

  try {
    const u = new URL(placeUrl);
    const pth = u.pathname.toLowerCase();
    if (pth.includes("/contributor/") || pth.includes("/author/")) {
      return { ok: false, reason: "byline_url" };
    }

    if (guide.source === "vogue") {
      const host = u.hostname.toLowerCase();
      if (!guide.allowInternalLinks) {
        if (host.endsWith("vogue.com") || host.endsWith("stag.vogue.com") || host.endsWith("compute.vogue.com")) {
          return { ok: false, reason: "host_internal_vogue" };
        }
        if (host.includes("vogue")) return { ok: false, reason: "host_vogue" };
        if (host.includes("condenast")) return { ok: false, reason: "host_condenast" };
        if (host.includes("aboutads")) return { ok: false, reason: "host_aboutads" };
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
          return { ok: false, reason: "host_vogue_nav_path" };
        }
        // Gallery / legacy numeric URLs are not stable place links.
        if (!pth.startsWith("/article/")) {
          return { ok: false, reason: "host_vogue_non_article" };
        }
      }
      if (host.includes("smart.link")) return { ok: false, reason: "host_smart_link" };
    }
  } catch {
    return { ok: false, reason: "bad_place_url" };
  }

  if (/^book\s+at\b/i.test(n) || /^book\s+now\b/i.test(n)) return { ok: false, reason: "cta_book" };

  if (/^##\s+/i.test(n) || /^#\s+/i.test(n)) return { ok: false, reason: "cta_markdown_heading" };

  if (
    /^visit\s+site\b/i.test(n) ||
    /^read\s+on\b/i.test(n) ||
    /^below,\s*find\b/i.test(n) ||
    /^without\s+further\s+ado\b/i.test(n)
  ) {
    return { ok: false, reason: "cta_fragment_phrase" };
  }

  if (/&#|&amp;|&quot;/i.test(n)) return { ok: false, reason: "html_entity_in_name" };

  if (n.length > 60) return { ok: false, reason: "name_too_long" };

  if (/^\d/.test(n) && /\bpercent\b/i.test(n)) return { ok: false, reason: "digit_percent_caption" };

  if (/^\d+\s+of\b/i.test(n)) return { ok: false, reason: "digit_slide_caption" };

  if (!isLikelyVenueName(n)) return { ok: false, reason: "unlikely_venue_name" };

  return { ok: true };
}

/**
 * @param {string} name
 * @param {string} placeUrl
 * @param {Guide} guide
 * @param {GuideStats} stats
 * @returns {{ ok: boolean, reason?: string }}
 */
function validatePlace(name, placeUrl, guide, stats) {
  const r = analyzePlaceCandidate(name, placeUrl, guide);
  if (!r.ok) {
    recordFiltered(stats, r.reason);
    return { ok: false, reason: r.reason };
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
  // Reject bare indefinite-article fragments ("a trendy boutique"); keep names like "A Land".
  if (/^(a|an)\b/i.test(n)) {
    const afterArticle = n.replace(/^(a|an)\s+/i, "").trim();
    if (!afterArticle || !/^[A-Z]/.test(afterArticle)) return false;
  }

  // Must look like a proper noun: starts with upper/digit and has at least one uppercase.
  if (!/^[A-Z0-9]/.test(n)) return false;
  if (!/[A-Z]/.test(n)) return false;

  // Too many words is usually a description, not a venue (allow longer clinic names).
  const wordCount = n.split(/\s+/).filter(Boolean).length;
  const maxWords = /\b(M\.D\.|D\.O\.|Clinic|Medical|Hospital)\b/i.test(n) ? 10 : 7;
  if (wordCount > maxWords) return false;

  return true;
}

/** Browser-like headers — Goop often returns 403 to minimal bots; localFile mirrors then apply. */
const GUIDE_FETCH_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

/** @param {string} url */
async function tryFetchGuide(url) {
  try {
    const res = await fetch(url, {
      headers: GUIDE_FETCH_HEADERS,
      redirect: "follow",
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Accept only plausible official venue URLs (not editorial hosts or social profiles).
 * @param {string|null|undefined} url
 */
function validateOfficialWebsiteUrl(url) {
  if (!url || typeof url !== "string") return false;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (host.endsWith("goop.com")) return false;
    if (host.endsWith("vogue.com")) return false;
    if (host.endsWith("stag.vogue.com")) return false;
    if (host.includes("condenast")) return false;
    if (host.endsWith("smart.link")) return false;
    if (host.endsWith("lamag.com") || host.endsWith("laweekly.com")) return false;

    const socialDomains = [
      "facebook.com",
      "instagram.com",
      "twitter.com",
      "tiktok.com",
      "pinterest.com",
      "linkedin.com",
      "youtube.com",
      "threads.net",
    ];
    if (socialDomains.some((d) => host === d || host.endsWith("." + d))) return false;
    if (host === "x.com" || host.endsWith(".x.com")) return false;

    if (host.endsWith("wikipedia.org") || host.endsWith("wikidata.org")) return false;
    if (host.includes("tripadvisor.")) return false;
    if (host.includes("yelp.")) return false;
    if (host.includes("opentable.")) return false;
    if (host.includes("resy.")) return false;
    if (host.includes("mapquest.")) return false;
    if (host.includes("foursquare.")) return false;
    if (host === "maps.apple.com") return false;
    if ((host === "google.com" || host.endsWith(".google.com")) && u.pathname.includes("/maps")) return false;

    const segments = u.pathname.toLowerCase().split("/").filter(Boolean);
    if (segments.includes("tag") || segments.includes("tags")) return false;
    const editorialPrefixes = ["category", "categories", "news", "article", "articles", "topic", "topics"];
    if (segments.length && editorialPrefixes.includes(segments[0])) return false;

    return true;
  } catch {
    return false;
  }
}

/** @param {string} href @param {string} baseUrl */
function resolveHrefAbsolute(href, baseUrl) {
  const h = (href ?? "").trim();
  if (!h || h.startsWith("#") || /^javascript:/i.test(h)) return null;
  try {
    return new URL(h, baseUrl).href;
  } catch {
    return null;
  }
}

/**
 * Pull Organization / LocalBusiness URLs from JSON-LD when present (often highest precision).
 * @param {string} html
 * @param {string} pageUrl
 */
function extractOfficialWebsiteFromJsonLd(html, pageUrl) {
  const scriptRe = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let sm;
  while ((sm = scriptRe.exec(html))) {
    let raw = sm[1].trim().replace(/^\s*<!--/, "").replace(/-->\s*$/, "").trim();
    /** @type {unknown} */
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }

    /** @type {unknown[]} */
    const roots = Array.isArray(data) ? data : [data];
    for (const root of roots) {
      if (!root || typeof root !== "object") continue;
      const obj = /** @type {Record<string, unknown>} */ (root);
      const graphRaw = obj["@graph"];
      /** @type {Record<string, unknown>[]} */
      const nodes = Array.isArray(graphRaw)
        ? graphRaw.filter((x) => x && typeof x === "object").map((x) => /** @type {Record<string, unknown>} */ (x))
        : [obj];

      for (const node of nodes) {
        const types = ([]).concat(/** @type {unknown} */ (node["@type"]) ?? []).flatMap((t) =>
          String(t ?? "")
            .split(/\s+/)
            .filter(Boolean),
        );
        const placeLike = types.some((t) =>
          /Restaurant|LocalBusiness|LodgingBusiness|Hotel|Store|ShoppingCenter|FoodEstablishment|TouristAttraction|SportsActivityLocation|HealthAndBeautyBusiness|DaySpa|BeautySalon/i.test(
            t,
          ),
        );
        if (!placeLike) continue;

        /** @type {string[]} */
        const candidates = [];
        const urlVal = node.url;
        if (typeof urlVal === "string") candidates.push(urlVal);
        const sameAs = node.sameAs;
        if (typeof sameAs === "string") candidates.push(sameAs);
        if (Array.isArray(sameAs)) {
          for (const s of sameAs) {
            if (typeof s === "string") candidates.push(s);
          }
        }

        for (const c of candidates) {
          const abs = resolveHrefAbsolute(c, pageUrl);
          if (abs && validateOfficialWebsiteUrl(abs)) return cleanUrl(abs);
        }
      }
    }
  }
  return null;
}

/** @param {string} html */
function extractAnchorRecords(html) {
  /** @type {{ href: string; text: string; className: string; ariaLabel: string }[]} */
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const inner = m[2];
    const hrefM = /\bhref\s*=\s*(["'])([\s\S]*?)\1/i.exec(attrs);
    if (!hrefM) continue;
    const href = hrefM[2].trim().replace(/\s+/g, "");
    if (!href) continue;

    const clsM = /\bclass\s*=\s*(["'])([\s\S]*?)\1/i.exec(attrs);
    const ariaM = /\baria-label\s*=\s*(["'])([\s\S]*?)\1/i.exec(attrs);

    const text = stripTags(inner).replace(/\s+/g, " ").trim();
    out.push({
      href,
      text,
      className: clsM ? clsM[2] : "",
      ariaLabel: ariaM ? ariaM[2].trim() : "",
    });
  }
  return out;
}

const VISIT_WEBSITE_LABEL =
  /\b(visit\s+(the\s+)?(website|site)|go\s+to\s+(the\s+)?(website|site)|official\s+website)\b/i;

const FOOTERISH_LINK_TEXT =
  /^(subscribe|sign\s+up|privacy|cookies?|cookie\s+policy|terms(\s+of\s+use)?|contact\s+us|advertise)/i;

/**
 * Scan a fetched listing/article HTML page for an outbound official website URL.
 * @param {string} html
 * @param {string} pageUrl
 */
function extractOfficialWebsiteFromListingHtml(html, pageUrl) {
  const fromLd = extractOfficialWebsiteFromJsonLd(html, pageUrl);
  if (fromLd) return fromLd;

  const scoped = extractMainContentHtml(html);
  const anchors = extractAnchorRecords(scoped);

  for (const a of anchors) {
    const label = `${a.text} ${a.ariaLabel}`.trim();
    if (!VISIT_WEBSITE_LABEL.test(label)) continue;
    const abs = resolveHrefAbsolute(a.href, pageUrl);
    if (abs && validateOfficialWebsiteUrl(abs)) return cleanUrl(abs);
  }

  for (const a of anchors) {
    if (!/\bexternal-link\b/i.test(a.className)) continue;
    const abs = resolveHrefAbsolute(a.href, pageUrl);
    if (abs && validateOfficialWebsiteUrl(abs)) return cleanUrl(abs);
  }

  for (const a of anchors) {
    if (!/\b(arrow|outbound|opens?\s*-?\s*external|icon-external|external\b)/i.test(a.className)) continue;
    const abs = resolveHrefAbsolute(a.href, pageUrl);
    if (abs && validateOfficialWebsiteUrl(abs)) return cleanUrl(abs);
  }

  /** @type {{ url: string; score: number }[]} */
  const scored = [];
  for (const a of anchors) {
    if (FOOTERISH_LINK_TEXT.test(a.text)) continue;
    const abs = resolveHrefAbsolute(a.href, pageUrl);
    if (!abs || !validateOfficialWebsiteUrl(abs)) continue;
    let score = 1;
    const tl = a.text.toLowerCase();
    if (/^(website|homepage|official)$/i.test(a.text.trim())) score += 4;
    if (/\b(book|reserve|shop|store|menu|tickets)\b/i.test(tl)) score += 2;
    if (abs.startsWith("https:")) score += 1;
    scored.push({ url: abs, score });
  }
  scored.sort((x, y) => y.score - x.score || x.url.length - y.url.length);
  return scored.length ? cleanUrl(scored[0].url) : null;
}

/** @returns {Promise<{ markdown: string, scopedHtml: string }>} */
async function loadGuidePayload(guide) {
  /** @type {string | null} */
  let body = await tryFetchGuide(guide.guideUrl);

  if (!body && guide.localFile) {
    try {
      body = await fs.readFile(guide.localFile, "utf8");
    } catch {
      body = null;
    }
  }

  if (!body) {
    throw new Error(
      `Could not load guide (${guide.guideUrl}). Fetch failed (often HTTP 403 outside a browser) and no readable localFile.`,
    );
  }

  if (/<\/html>/i.test(body) || /<body\b/i.test(body)) {
    const articleTitle = extractHtmlArticleTitle(body);
    const scoped = extractMainContentHtml(body);
    let md = htmlToPseudoMarkdown(scoped, guide.guideUrl);
    if (articleTitle && !/^#\s+\S/m.test(md)) {
      md = `# ${articleTitle}\n\n${md}`;
    }
    return { markdown: md, scopedHtml: scoped };
  }
  return { markdown: body, scopedHtml: "" };
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

  const isPostcardFormat = lines.some((l) =>
    /^###\s+\[[^\]]+\]\(https?:\/\/[^\)]+\)\s*$/.test(l.trim()),
  );

  /** @type {Category | null} */
  let sectionFromHeading = null;

  if (isPostcardFormat) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (/^##\s+/.test(line)) {
        sectionFromHeading = inferCategoryFromHeadingLine(line);
        continue;
      }

      const m = /^###\s+\[([^\]]+)\]\((https?:\/\/[^\)]+)\)\s*$/.exec(line);
      if (!m) continue;

      const name = m[1].trim();
      const placeUrl = cleanUrl(m[2]);
      const meta = (lines[i + 1] ?? "").trim();
      const [typeRaw, neighborhoodRaw] = meta.split("·").map((x) => x.trim());
      const neighborhood = neighborhoodRaw || undefined;

      const category = resolvePlaceCategory(sectionFromHeading, typeRaw ?? "", name, guide, placeUrl);

      const candidate = {
        id: `${slugify(guide.city)}-${slugify(name)}-${category}`,
        name,
        category,
        city: guide.city,
        country: guide.country,
        neighborhood,
        source: "goop",
        sourceTitle: pickGuideDisplayTitle(text, guide),
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

    if (/^##\s+/.test(line)) {
      current = inferCategoryFromHeadingLine(line);
      continue;
    }

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

    const category = resolvePlaceCategory(current, "", name, guide, placeUrl);

    const v = validatePlace(name, placeUrl, guide, stats);
    if (!v.ok) continue;

    out.push({
      id: `${slugify(guide.city)}-${slugify(name)}-${category}`,
      name,
      category,
      city: guide.city,
      country: guide.country,
      neighborhood,
      source: "goop",
      sourceTitle: pickGuideDisplayTitle(text, guide),
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
  let sectionCategory = guide.defaultCategory ?? null;
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (/^##\s+/.test(line)) {
      if (/^##\s+The\s+Wear\b/i.test(line)) {
        sectionCategory = null;
        continue;
      }
      const inferred = inferCategoryFromHeadingLine(line);
      sectionCategory = inferred ?? guide.defaultCategory ?? null;
      continue;
    }

    if (!sectionCategory) continue;

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

      const category = resolvePlaceCategory(sectionCategory, "", name, guide, placeUrl);

      const v = validatePlace(name, placeUrl, guide, stats);
      if (!v.ok) continue;

      out.push({
        id: `${slugify(guide.city)}-${slugify(name)}-${category}`,
        name,
        category,
        city: guide.city,
        country: guide.country,
        source: "vogue",
        sourceTitle: pickGuideDisplayTitle(text, guide),
        sourceUrl: cleanUrl(guide.guideUrl),
        placeUrl,
      });
    }
  }

  return out;
}

/** @param {string} innerHtml @param {string} baseUrl */
function collectAnchorHrefs(innerHtml, baseUrl) {
  const hrefRe = /<a\b[^>]*href\s*=\s*(["'])([^"']+)\1/gi;
  /** @type {string[]} */
  const out = [];
  let m;
  while ((m = hrefRe.exec(innerHtml))) {
    try {
      out.push(cleanUrl(new URL(m[2], baseUrl).href));
    } catch {
      // ignore
    }
  }
  return out;
}

/**
 * Vogue shopping essays often list venues as `<p><strong>Name</strong><br/>…` with no outbound link.
 * Prefer real URLs when present; otherwise allow linking back to the guide article when enabled.
 */
function pickParagraphPlaceUrl(innerHtml, name, guide) {
  const hrefs = collectAnchorHrefs(innerHtml, guide.guideUrl);
  /** @type {{ u: string, tier: number }[]} */
  const tiers = [];
  for (const u of hrefs) {
    try {
      const host = new URL(u).hostname.toLowerCase();
      const pth = new URL(u).pathname.toLowerCase();
      if (!host.endsWith("vogue.com")) tiers.push({ u, tier: 0 });
      else if (guide.allowInternalLinks && pth.startsWith("/article/")) tiers.push({ u, tier: 1 });
    } catch {
      // ignore
    }
  }
  tiers.sort((a, b) => a.tier - b.tier || a.u.localeCompare(b.u));
  const fallback = cleanUrl(guide.guideUrl);
  const ordered = [...new Set([...tiers.map((t) => t.u), fallback])];
  for (const u of ordered) {
    if (analyzePlaceCandidate(name, u, guide).ok) return u;
  }
  return null;
}

/**
 * Paragraph-led Vogue listings (no ## headings / postcard links).
 * @param {string} html
 * @param {Guide} guide
 * @param {GuideStats} stats
 * @param {string} guideMarkdown full markdown for citation title resolution
 */
function extractVogueParagraphStrong(html, guide, stats, guideMarkdown) {
  /** @type {Place[]} */
  const out = [];
  const paraRe = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = paraRe.exec(html))) {
    const inner = (m[1] ?? "").trim();
    const sm = /^\s*<strong\b[^>]*>([\s\S]*?)<\/strong>/i.exec(inner);
    if (!sm) continue;

    let name = stripTags(sm[1]).trim().replace(/\s+/g, " ");
    if (!name) continue;

    const nk = name.toLowerCase();
    if (/^photographs?\b/i.test(nk) || /^courtesy\b/i.test(nk) || /^photo\s*[.:]/i.test(nk)) continue;

    const placeUrl = pickParagraphPlaceUrl(inner, name, guide);
    if (!placeUrl) continue;

    const category = resolvePlaceCategory(guide.defaultCategory ?? null, "", name, guide, placeUrl);

    const v = validatePlace(name, placeUrl, guide, stats);
    if (!v.ok) continue;

    out.push({
      id: `${slugify(guide.city)}-${slugify(name)}-${category}`,
      name,
      category,
      city: guide.city,
      country: guide.country,
      source: "vogue",
      sourceTitle: pickGuideDisplayTitle(guideMarkdown, guide),
      sourceUrl: cleanUrl(guide.guideUrl),
      placeUrl,
    });
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
  /** @type {{ guideIndex: number | null, limit: number | null, dryRun: boolean, skipWebsiteResolve: boolean }} */
  const opts = { guideIndex: null, limit: null, dryRun: false, skipWebsiteResolve: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--guide-index" && args[i + 1] !== undefined) {
      opts.guideIndex = Number(args[++i]);
    } else if (a === "--limit" && args[i + 1] !== undefined) {
      opts.limit = Number(args[++i]);
    } else if (a === "--dry-run") {
      opts.dryRun = true;
    } else if (a === "--skip-website-resolve") {
      opts.skipWebsiteResolve = true;
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
  /** @type {Map<string, string>} */
  const guideScopedHtmlBySourceUrl = new Map();

  for (const g of guides) {
    const stats = createStats();
    const payload = await loadGuidePayload(g);
    guideScopedHtmlBySourceUrl.set(cleanUrl(g.guideUrl), payload.scopedHtml || "");
    const text = payload.markdown;
    let extracted =
      g.source === "goop" ? extractGoop(text, g, stats) : extractVogue(text, g, stats);

    if (
      g.source === "vogue" &&
      payload.scopedHtml &&
      (g.allowInternalLinks === true || !/^##\s+/m.test(text))
    ) {
      extracted = extracted.concat(extractVogueParagraphStrong(payload.scopedHtml, g, stats, text));
    }

    const label = `${g.city} (${g.source}) ${g.guideUrl ? `<${g.guideUrl}>` : ""}`;
    logGuideSummary(label, stats);

    all = all.concat(extracted);
  }

  all = dedupeAccentVariants(all);
  all = uniqById(all).sort((a, b) => (a.city + a.name).localeCompare(b.city + b.name));

  if (!opts.dryRun && !opts.skipWebsiteResolve) {
    all = await enrichPlacesWithWebsitesMultiStrategy(all, guideScopedHtmlBySourceUrl, {
      strategy1Extract: extractOfficialWebsiteFromListingHtml,
      fetchListingHtml: tryFetchGuide,
      cleanUrl,
      validateOfficialWebsiteUrl,
    }, ROOT);
  } else if (opts.dryRun || opts.skipWebsiteResolve) {
    all = all.map((p) => ({ ...p, website: null }));
  }

  all = assignDescriptors(all, ROOT);

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
