/**
 * Multi-strategy official website resolution with verification (used by collect.mjs).
 */

import { promises as fs } from "node:fs";
import path from "node:path";

/** Browser-like fetch headers */
const FETCH_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

/** @typedef {"restaurant"|"hotel"|"shop"|"attraction"|"wellness"} Category */

/**
 * @typedef {object} PlaceRow
 * @property {string} id
 * @property {string} name
 * @property {Category} category
 * @property {string} city
 * @property {string} country
 * @property {string} source
 * @property {string} sourceUrl
 * @property {string} [placeUrl]
 * @property {string|null} [website]
 */

/**
 * @typedef {object} WebsiteDeps
 * @property {(html: string, listingUrl: string) => string | null} strategy1Extract
 * @property {(url: string) => Promise<string | null>} fetchListingHtml
 * @property {(url: string) => string} cleanUrl
 * @property {(url: string | null | undefined) => boolean} validateOfficialWebsiteUrl
 */

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** @param {string} s */
function stripTags(s) {
  return (s ?? "")
    .toString()
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

/** Aggressive blocks + review aggregators (verification gate). */
function isBlockedAggregatorHost(hostname) {
  const h = hostname.toLowerCase();
  if (h.includes("resy.")) return true;
  const blocked = [
    "goop.com",
    "vogue.com",
    "condenast",
    "smart.link",
    "tripadvisor.",
    "yelp.",
    "opentable.",
    "foursquare.",
    "instagram.",
    "facebook.com",
    "twitter.com",
    "tiktok.com",
    "pinterest.",
    "linkedin.",
    "youtube.com",
    "youtu.be",
    "wikipedia.org",
    "wikidata.org",
    "mapquest.",
    "threads.net",
    "snapchat.",
    "reddit.com",
    "expedia.",
    "lamag.com",
    "laweekly.com",
  ];
  if (blocked.some((b) => (b.endsWith(".") ? h.includes(b) : h === b || h.endsWith("." + b)))) return true;
  if (h === "x.com" || h.endsWith(".x.com")) return true;
  const socialRoots = [
    "facebook.com",
    "instagram.com",
    "twitter.com",
    "tiktok.com",
    "pinterest.com",
    "linkedin.com",
    "youtube.com",
    "threads.net",
  ];
  if (socialRoots.some((d) => h === d || h.endsWith("." + d))) return true;
  if ((h === "google.com" || h.endsWith(".google.com")) && false) return false;
  return false;
}

/** Path segments that usually indicate editorial/tag pages, not venue homepages. */
function hasEditorialPathSegments(pathname) {
  const segments = pathname.toLowerCase().split("/").filter(Boolean);
  if (segments.includes("tag") || segments.includes("tags")) return true;
  const badFirst = ["category", "categories", "news", "article", "articles", "topic", "topics"];
  if (segments.length && badFirst.includes(segments[0])) return true;
  return false;
}

/** @param {string} url */
function verificationDomainAllowed(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (isBlockedAggregatorHost(host)) return false;
    if (hasEditorialPathSegments(u.pathname)) return false;
    if (host === "maps.apple.com") return false;
    if ((host === "google.com" || host.endsWith(".google.com")) && u.pathname.includes("/maps")) return false;
    return true;
  } catch {
    return false;
  }
}

/** @param {string} text */
function looksLikeParkingPage(text) {
  const t = text.slice(0, 12000).toLowerCase();
  return (
    /domain\s+for\s+sale|buy\s+(this\s+)?domain|is\s+for\s+sale|parked\s+free|cash\s+parking|sedo\.com|hugedomains|dan\.com\/domain|leased\s+domain|renew\s+your\s+domain/i.test(
      t,
    ) || /^(domain\s+name\s+for\s+sale)/im.test(text.slice(0, 500))
  );
}

/** @param {string} s */
function normalizeMatchKey(s) {
  return (s ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/^the\s+/i, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** @param {string} placeName @param {string} haystackText */
function nameAppearsInText(placeName, haystackText) {
  const pn = normalizeMatchKey(placeName);
  const th = normalizeMatchKey(haystackText);
  if (pn.length < 2 || th.length < 2) return false;
  if (th.includes(pn)) return true;
  const tokens = pn.split(/\s+/).filter((t) => t.length > 2);
  if (tokens.length === 0) return pn.length >= 4 && th.includes(pn);
  return tokens.every((t) => th.includes(t));
}

/** @param {string} html */
function extractVerificationTexts(html) {
  const buckets = [];
  const tit = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (tit) buckets.push(stripTags(tit[1]));

  const hx = /<h([12])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = hx.exec(html))) {
    buckets.push(stripTags(m[2]));
  }

  const bodyM = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const bodySlice = bodyM ? bodyM[1].slice(0, 25000) : html.slice(0, 25000);
  buckets.push(stripTags(bodySlice).slice(0, 1000));

  return buckets.filter(Boolean);
}

/** @param {string} placeName @param {string} html */
function nameVerifiedOnPage(placeName, html) {
  const buckets = extractVerificationTexts(html);
  return buckets.some((b) => nameAppearsInText(placeName, b));
}

/** City hints including neighborhoods users might see on venue sites. */
const CITY_ALIASES = /** @type {Record<string, string[]>} */ ({
  "Mexico City": ["mexico city", "ciudad de mexico", "cdmx", "c.d.m.x.", "polanco", "roma norte", "condesa"],
  "New York City": ["new york", "nyc", "manhattan", "brooklyn", "queens"],
  London: ["london", "uk", "united kingdom", "england"],
  Paris: ["paris", "france"],
  Milan: ["milan", "milano", "italy"],
  "Los Angeles": ["los angeles", "california", "santa monica", "west hollywood"],
  Miami: ["miami", "florida"],
  Copenhagen: ["copenhagen", "københavn", "kobenhavn", "denmark"],
  Seoul: ["seoul", "south korea", "korea"],
  Tokyo: ["tokyo", "japan"],
});

/** @param {string} city @param {string} html */
function cityAppearsOnPage(city, html) {
  const text = normalizeMatchKey(stripTags(html).slice(0, 120000));
  const aliases = CITY_ALIASES[city];
  const extras = aliases ? aliases.map(normalizeMatchKey) : [];
  const primary = normalizeMatchKey(city);
  const all = [primary, ...extras];
  return all.some((a) => a.length >= 3 && text.includes(a));
}

/** @param {Category} category @param {string} html */
function categoryKeywordsHit(category, html) {
  const t = normalizeMatchKey(stripTags(html).slice(0, 100000));
  /** @type {Record<Category, RegExp>} */
  const rx = {
    restaurant: /\b(menu|dining|food|restaurant|cuisine|kitchen|chef|wine|cocktail|breakfast|lunch|dinner|brunch|reserve|reservation)\b/,
    hotel: /\b(hotel|rooms?|suite|stay|booking|accommodation|lodging|check[\s-]?in)\b/,
    shop: /\b(shop|store|boutique|buy|cart|collection|products|shipping)\b/,
    attraction: /\b(visit|hours|tickets|museum|gallery|exhibition|tour|park)\b/,
    wellness: /\b(spa|wellness|massage|treatment|appointment|beauty|salon|therapy|facial)\b/,
  };
  return rx[category]?.test(t) ?? false;
}

/**
 * @param {string} url
 * @param {{ retries429?: number }} [opts]
 */
async function fetchHttpPage(url, opts = {}) {
  const retries429 = opts.retries429 ?? 1;
  try {
    const res = await fetch(url, {
      headers: FETCH_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(18000),
    });
    if (res.status === 429 && retries429 > 0) {
      console.warn("[collect] website-resolve: 429, waiting 30s then retry…");
      await sleep(30000);
      return fetchHttpPage(url, { retries429: retries429 - 1 });
    }
    const html = await res.text();
    return {
      status: res.status,
      finalUrl: res.url || url,
      html,
    };
  } catch {
    return { status: 0, finalUrl: url, html: "" };
  }
}

/** Accept HTTP statuses user considers usable for verification / linking. */
function httpStatusAcceptable(status) {
  return status === 200 || status === 301 || status === 302 || status === 403;
}

/**
 * @typedef {{ accepted: boolean; confidence: "high"|"medium"|"low"; strategy: number; cityVerified: boolean; categoryHit: boolean; httpStatus: number; detail?: string }} VerifyOutcome
 */

/**
 * @param {PlaceRow} place
 * @param {string} candidateUrl
 * @param {number} strategy 1–4
 */
async function verifyCandidate(place, candidateUrl, strategy) {
  /** @type {VerifyOutcome} */
  const base = {
    accepted: false,
    confidence: "low",
    strategy,
    cityVerified: false,
    categoryHit: false,
    httpStatus: 0,
    detail: "",
  };

  if (!candidateUrl || !verificationDomainAllowed(candidateUrl)) {
    base.detail = "blocked_domain_or_path";
    return base;
  }

  const page = await fetchHttpPage(candidateUrl);
  base.httpStatus = page.status;

  if (!httpStatusAcceptable(page.status)) {
    base.detail = `bad_http_${page.status}`;
    return base;
  }

  const html = page.html || "";
  const titleText = stripTags((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || "");

  if (looksLikeParkingPage(titleText + "\n" + html.slice(0, 8000))) {
    base.detail = "parking_or_domain_sale";
    return base;
  }

  const bodyTextSample = stripTags(html).slice(0, 8000);
  const nameOk = nameVerifiedOnPage(place.name, html);
  const curatedSource = strategy === 1 || strategy === 2;

  if (!nameOk) {
    if (page.status === 403 && curatedSource && bodyTextSample.length < 120) {
      base.detail = "name_skip_403_curated";
      base.accepted = true;
      base.confidence = "medium";
      return base;
    }
    base.detail = "name_mismatch";
    return base;
  }

  base.cityVerified = cityAppearsOnPage(place.city, html);
  base.categoryHit = categoryKeywordsHit(place.category, html);

  if (strategy === 1 || strategy === 2) {
    base.accepted = true;
    base.confidence = "high";
    return base;
  }

  // Strategy 3 / 4 — Medium when name + city present on page (category hints logged only).
  if (base.cityVerified) {
    base.accepted = true;
    base.confidence = "medium";
    if (!base.categoryHit) base.detail = "category_mismatch";
    return base;
  }

  base.detail = "city_unverified";
  base.confidence = "low";
  base.accepted = false;
  return base;
}

/** Strategy 2: links near place name in guide HTML. */
function proximityCandidates(placeName, guideHtml, guideUrl, validateUrl) {
  if (!guideHtml || !placeName) return [];
  let escaped = "";
  try {
    escaped = placeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  } catch {
    return [];
  }
  const re = new RegExp(escaped, "gi");
  /** @type {Set<string>} */
  const found = new Set();
  let m;
  while ((m = re.exec(guideHtml)) !== null) {
    const start = Math.max(0, m.index - 200);
    const end = Math.min(guideHtml.length, m.index + placeName.length + 200);
    const slice = guideHtml.slice(start, end);
    const hrefRe = /<a\b[^>]*href\s*=\s*(["'])([^"']+)\1/gi;
    let hm;
    while ((hm = hrefRe.exec(slice))) {
      const abs = resolveHrefAbsolute(hm[2], guideUrl);
      if (abs && validateUrl(abs) && verificationDomainAllowed(abs)) found.add(abs);
    }
  }
  return [...found];
}

/** @param {string} html */
function parseDuckDuckGoUrls(html) {
  /** @type {string[]} */
  const urls = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"/gi;
  let m;
  while ((m = re.exec(html))) {
    let u = m[1];
    try {
      if (u.includes("duckduckgo.com/l/?") || u.includes("duckduckgo.com/l?")) {
        const parsed = new URL(u, "https://duckduckgo.com");
        const uddg = parsed.searchParams.get("uddg");
        if (uddg) u = decodeURIComponent(uddg);
      }
      urls.push(u);
    } catch {
      // ignore
    }
  }
  const seen = new Set(urls);
  if (seen.size === 0) {
    const alt = /<a[^>]*href="([^"]+)"[^>]*class="[^"]*result__a[^"]*"/gi;
    let m;
    while ((m = alt.exec(html))) {
      try {
        let u = m[1];
        if (u.includes("uddg=")) {
          const parsed = new URL(u, "https://duckduckgo.com");
          const uddg = parsed.searchParams.get("uddg");
          if (uddg) u = decodeURIComponent(uddg);
        }
        seen.add(u);
      } catch {
        // ignore
      }
    }
  }

  return [...seen].slice(0, 8);
}

/** @param {string} html */
function parseBingUrls(html) {
  /** @type {string[]} */
  const urls = [];
  const re =
    /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      urls.push(m[1]);
    } catch {
      // ignore
    }
  }
  return [...new Set(urls)].slice(0, 8);
}

/** @param {PlaceRow} place */
function domainGuessUrls(place) {
  const slug = place.name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/^the\s+/i, "")
    .replace(/[^a-z0-9\s-]/gi, "")
    .trim()
    .replace(/\s+/g, "-");
  const compact = slug.replace(/-/g, "");
  if (compact.length < 3) return [];

  /** @type {string[]} */
  const bases = [`https://${compact}.com`, `https://www.${compact}.com`, `https://${compact}.net`, `https://${compact}.org`];

  if (slug.includes("-")) {
    bases.push(`https://the-${slug}.com`, `https://www.the-${slug}.com`);
  }

  if (place.category === "restaurant") {
    bases.push(`https://${compact}restaurant.com`, `https://www.${compact}restaurant.com`);
  }
  if (place.category === "hotel") {
    bases.push(`https://${compact}hotel.com`, `https://hotel${compact}.com`);
  }

  return [...new Set(bases)];
}

/**
 * @param {PlaceRow[]} places
 * @param {Map<string, string>} guideScopedHtmlBySourceUrl
 * @param {WebsiteDeps} deps
 * @param {string} rootDir project root for report file
 */
export async function enrichPlacesWithWebsitesMultiStrategy(places, guideScopedHtmlBySourceUrl, deps, rootDir) {
  const listingUrls = [
    ...new Set(
      places.map((p) => p.placeUrl).filter((u) => typeof u === "string" && /^https?:\/\//i.test(u)),
    ),
  ];

  /** @type {Map<string, string>} */
  const listingHtmlCache = new Map();
  const workers = Math.min(6, Math.max(1, listingUrls.length));
  let li = 0;
  async function listingWorker() {
    for (;;) {
      const idx = li++;
      if (idx >= listingUrls.length) break;
      const u = listingUrls[idx];
      const html = await deps.fetchListingHtml(u);
      listingHtmlCache.set(u, html || "");
    }
  }
  await Promise.all(Array.from({ length: workers }, () => listingWorker()));

  /** @type {{ strategy: Record<string, number>; confidence: Record<string, number>; rejected: { id: string; name: string; city: string; url: string; reason: string }[]; lowSkipped: { id: string; name: string; city: string; url: string; detail: string }[] }} */
  const stats = {
    strategy: { "1": 0, "2": 0, "3": 0, "4": 0 },
    confidence: { high: 0, medium: 0 },
    strategyConfidence: /** @type {Record<string, number>} */ ({}),
    rejected: [],
    lowSkipped: [],
  };

  /** @param {number} strat @param {"high"|"medium"} conf */
  function bumpStored(strat, conf) {
    stats.strategy[String(strat)]++;
    stats.confidence[conf]++;
    const key = `s${strat}_${conf}`;
    stats.strategyConfidence[key] = (stats.strategyConfidence[key] || 0) + 1;
  }

  let searchCooldown = Promise.resolve();

  /** @type {Map<string, string[]>} */
  const searchResultCache = new Map();

  /** @param {PlaceRow} place */
  async function runSearch(place) {
    const cacheKey = `${normalizeMatchKey(place.name)}\t${normalizeMatchKey(place.city)}`;
    const cached = searchResultCache.get(cacheKey);
    if (cached) return cached;

    await searchCooldown;
    searchCooldown = sleep(1200 + Math.random() * 800);

    const q = `"${place.name}" "${place.city}" official site`;
    const enc = encodeURIComponent(q);

    let html = "";
    try {
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${enc}`, {
        headers: FETCH_HEADERS,
        redirect: "follow",
        signal: AbortSignal.timeout(22000),
      });
      if (res.status === 429) {
        await sleep(30000);
        const res2 = await fetch(`https://html.duckduckgo.com/html/?q=${enc}`, {
          headers: FETCH_HEADERS,
          redirect: "follow",
          signal: AbortSignal.timeout(22000),
        });
        html = await res2.text();
      } else {
        html = await res.text();
      }
    } catch {
      html = "";
    }

    let urls = parseDuckDuckGoUrls(html);
    if (urls.length < 2) {
      try {
        const res = await fetch(`https://www.bing.com/search?q=${enc}`, {
          headers: FETCH_HEADERS,
          redirect: "follow",
          signal: AbortSignal.timeout(22000),
        });
        const bhtml = await res.text();
        urls = urls.concat(parseBingUrls(bhtml));
      } catch {
        // ignore
      }
    }

    const result = [...new Set(urls)].slice(0, 5);
    searchResultCache.set(cacheKey, result);
    return result;
  }

  /** @param {string} url */
  function isSearchPortalUrl(url) {
    try {
      const h = new URL(url).hostname.toLowerCase();
      return (
        h.includes("duckduckgo.com") ||
        h.includes("bing.com") ||
        h.includes("microsoft.com") ||
        h.includes("google.com")
      );
    } catch {
      return true;
    }
  }

  /** @type {PlaceRow[]} */
  const out = [];

  for (let i = 0; i < places.length; i++) {
    if (i % 25 === 0) {
      console.log(`[collect] Website resolve progress ${i}/${places.length}`);
    }

    const place = places[i];
    /** @type {PlaceRow} */
    let next = { ...place, website: null };

    const listingUrl = place.placeUrl && /^https?:\/\//i.test(place.placeUrl) ? place.placeUrl : null;
    const guideHtml = guideScopedHtmlBySourceUrl.get(deps.cleanUrl(place.sourceUrl)) || "";
    const guideUrl = place.sourceUrl;

    /** @type {{ url: string; reason: string }[]} */
    const triedRejections = [];
    let lowLoggedForPlace = false;

    // Strategy 1
    if (listingUrl) {
      const lisHtml = listingHtmlCache.get(listingUrl) || "";
      const cand = lisHtml ? deps.strategy1Extract(lisHtml, listingUrl) : null;
      if (cand && deps.validateOfficialWebsiteUrl(cand)) {
        const v = await verifyCandidate(place, deps.cleanUrl(cand), 1);
        if (v.accepted && (v.confidence === "high" || v.confidence === "medium")) {
          next.website = deps.cleanUrl(cand);
          bumpStored(1, v.confidence);
          out.push(next);
          continue;
        }
        triedRejections.push({
          url: cand,
          reason: `${place.name}: strat1 ${v.detail || v.confidence} http=${v.httpStatus}`,
        });
      }
    }

    // Strategy 2
    const prox = proximityCandidates(place.name, guideHtml, guideUrl, deps.validateOfficialWebsiteUrl);
    for (const u of prox) {
      const v = await verifyCandidate(place, deps.cleanUrl(u), 2);
      if (v.accepted && (v.confidence === "high" || v.confidence === "medium")) {
        next.website = deps.cleanUrl(u);
        bumpStored(2, v.confidence);
        out.push(next);
        break;
      }
      triedRejections.push({
        url: u,
        reason: `${place.name}: strat2 ${v.detail || v.confidence} http=${v.httpStatus}`,
      });
    }
    if (next.website) {
      continue;
    }

    // Strategy 3
    const searchUrls = await runSearch(place);
    for (const raw of searchUrls) {
      let abs = raw;
      try {
        abs = new URL(raw, "https://duckduckgo.com").href;
      } catch {
        continue;
      }
      if (
        isSearchPortalUrl(abs) ||
        !deps.validateOfficialWebsiteUrl(abs) ||
        !verificationDomainAllowed(abs)
      )
        continue;

      const v = await verifyCandidate(place, deps.cleanUrl(abs), 3);
      if (v.accepted && v.confidence === "medium") {
        next.website = deps.cleanUrl(abs);
        bumpStored(3, "medium");
        break;
      }
      if (
        !lowLoggedForPlace &&
        v.confidence === "low" &&
        v.detail === "city_unverified"
      ) {
        lowLoggedForPlace = true;
        stats.lowSkipped.push({
          id: place.id,
          name: place.name,
          city: place.city,
          url: deps.cleanUrl(abs),
          detail: `low_city_unverified;s3;cat=${v.categoryHit}`,
        });
      }
      triedRejections.push({
        url: abs,
        reason: `${place.name}: strat3 ${v.detail || v.confidence} http=${v.httpStatus}`,
      });
    }

    if (next.website) {
      out.push(next);
      continue;
    }

    // Strategy 4
    const guesses = domainGuessUrls(place);
    for (const g of guesses) {
      if (!verificationDomainAllowed(g)) continue;
      const v = await verifyCandidate(place, g, 4);
      if (v.accepted && v.confidence === "medium") {
        next.website = deps.cleanUrl(g);
        bumpStored(4, "medium");
        break;
      }
      if (!lowLoggedForPlace && v.confidence === "low" && v.detail === "city_unverified") {
        lowLoggedForPlace = true;
        stats.lowSkipped.push({
          id: place.id,
          name: place.name,
          city: place.city,
          url: g,
          detail: "low_city_unverified;s4",
        });
      }
      triedRejections.push({
        url: g,
        reason: `${place.name}: strat4 ${v.detail || v.confidence} http=${v.httpStatus}`,
      });
    }

    out.push(next);

    if (!next.website && triedRejections.length) {
      for (const tr of triedRejections.slice(0, 6)) {
        if (stats.rejected.length >= 60) break;
        stats.rejected.push({
          id: place.id,
          name: place.name,
          city: place.city,
          url: tr.url,
          reason: tr.reason,
        });
      }
    }
  }

  console.log(`[collect] Website resolve progress ${places.length}/${places.length}`);

  const withWebsite = out.filter((p) => p.website).length;
  console.log("\n=== Website resolution summary ===");
  console.log(`Total places: ${out.length}`);
  console.log(`With website: ${withWebsite}`);
  console.log(`Without website: ${out.length - withWebsite}`);
  console.log(`By strategy (accepted): ${JSON.stringify(stats.strategy)}`);
  console.log(`By confidence (stored): ${JSON.stringify(stats.confidence)}`);
  console.log(`Strategy × confidence: ${JSON.stringify(stats.strategyConfidence)}`);

  /** Spot-check 10 stored websites */
  const withSites = out.filter((p) => p.website);
  const shuffled = [...withSites].sort(() => Math.random() - 0.5);
  const sampleSize = Math.min(10, shuffled.length);
  console.log("\n=== Spot-check (10 random samples, name on page) ===");
  for (let s = 0; s < sampleSize; s++) {
    const p = shuffled[s];
    const page = await fetchHttpPage(p.website || "");
    const ok = page.html ? nameVerifiedOnPage(p.name, page.html) : false;
    console.log(`  ${ok ? "OK" : "FAIL"} ${p.name} → ${p.website} (http ${page.status})`);
  }

  console.log("\n=== Sample rejected candidates (see report file for more) ===");
  stats.rejected.slice(0, 10).forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.name} | ${r.url} | ${r.reason}`);
  });

  console.log("\n=== Low confidence skipped (first 5) ===");
  stats.lowSkipped.slice(0, 5).forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.name} (${r.city}) | ${r.url} | ${r.detail}`);
  });

  const reportPath = path.join(rootDir, "website-resolution-report.json");
  await fs.writeFile(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        totals: {
          places: out.length,
          withWebsite,
          withoutWebsite: out.length - withWebsite,
        },
        strategyAccepted: stats.strategy,
        confidenceStored: stats.confidence,
        strategyByConfidence: stats.strategyConfidence,
        rejectionSamples: stats.rejected.slice(0, 25),
        lowConfidenceSkipped: stats.lowSkipped.slice(0, 25),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\n[collect] Wrote ${reportPath}`);

  return out;
}
