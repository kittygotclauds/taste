import { PLACES, SOURCES, CATEGORIES } from "./data.js";

const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));

const SEP = " \u00B7 ";

const els = {
  query: /** @type {HTMLInputElement} */ ($("#query")),
  city: /** @type {HTMLSelectElement} */ ($("#city")),
  category: /** @type {HTMLSelectElement} */ ($("#category")),
  source: /** @type {HTMLSelectElement} */ ($("#source")),
  curator: /** @type {HTMLSelectElement | null} */ ($("#curator")),
  resetBtn: /** @type {HTMLButtonElement} */ ($("#resetBtn")),
  results: $("#results"),
  empty: $("#emptyState"),
  resultsMeta: $("#resultsMeta"),
  year: $("#year"),
  about: /** @type {HTMLElement} */ ($("#about")),
  aboutLink: /** @type {HTMLAnchorElement} */ ($("#aboutLink")),
  closeAboutBtn: /** @type {HTMLButtonElement} */ ($("#closeAboutBtn")),
  adminToggle: /** @type {HTMLButtonElement} */ ($("#adminToggle")),
};

/**
 * Admin view state. Persists in localStorage so the choice survives reloads.
 * "filtered" (default, public) hides places that fail the quality filter.
 * "all" shows everything, with a "low-rated" indicator on filtered-out cards.
 */
const ADMIN_KEY = "taste:adminView";
let adminView = /** @type {"filtered"|"all"} */ (
  (() => {
    try {
      const v = localStorage.getItem(ADMIN_KEY);
      return v === "all" ? "all" : "filtered";
    } catch {
      return "filtered";
    }
  })()
);

const RATING_MIN = 4.0;
const HIGHLY_RATED = 4.5;
/** Below this review count, a "success" lookup is not used to hide places or claim "highly rated". */
const MIN_REVIEWS_FILTER = 10;
const MIN_REVIEWS_BADGE = 50;
const REVIEW_NUM_FORMAT = new Intl.NumberFormat("en-US");

/** @typedef {"restaurant"|"cafe"|"bakery"|"bar"|"hotel"|"shop"|"attraction"|"wellness"} Category */
/** @typedef {"goop"|"vogue"} Source */

/** @typedef Place
 * @property {string} id
 * @property {string} name
 * @property {Category} category
 * @property {string} city
 * @property {string} country
 * @property {string=} neighborhood
 * @property {Source|null=} source Publication source. May be null for curator-direct entries.
 * @property {string|null=} sourceTitle
 * @property {string|null=} sourceUrl Article (or post) where this place was recommended
 * @property {string|null=} venueUrl The venue's own website, when known
 * @property {string=} descriptor One-line voice descriptor (≤10 words)
 * @property {readonly string[]=} tags
 * @property {number|null=} googleRating Average rating 0..5, one decimal
 * @property {number|null=} googleRatingCount Total review count
 * @property {string|null=} googlePlaceId Google's place id for future lookups
 * @property {boolean=} manualPick Personal override flag (always show)
 * @property {"pending"|"success"|"not_found"|"error"|"skipped"=} ratingLookupStatus
 * @property {string=} curator Personal curator who vouched for this place (e.g. "Lily Rivkin")
 */

/** @type {readonly Place[]} */
const data = PLACES;

function uniqSorted(arr) {
  return [...new Set(arr)].sort((a, b) => a.localeCompare(b));
}

function normalize(s) {
  return (s ?? "")
    .toString()
    .trim()
    .toLowerCase();
}

function placeHaystack(p) {
  return normalize(
    [
      p.name,
      p.city,
      p.country,
      p.neighborhood ?? "",
      p.descriptor ?? "",
      CATEGORIES[p.category],
      p.source ? SOURCES[p.source] : "",
      p.curator ?? "",
      ...(p.tags ?? []),
    ].join(SEP),
  );
}

function getCityOptions() {
  const cities = uniqSorted(data.map((p) => `${p.city}${SEP}${p.country}`));
  return ["All cities", ...cities];
}

function getCuratorOptions() {
  const curators = uniqSorted(
    data.map((p) => (p.curator ?? "").trim()).filter((s) => s.length > 0),
  );
  return ["All curators", ...curators];
}

function parseCityValue(v) {
  if (!v || v === "all") return null;
  const [city, country] = v.split(SEP).map((x) => x.trim());
  if (!city || !country) return null;
  return { city, country };
}

function buildCitySelect() {
  const opts = getCityOptions();
  els.city.innerHTML = "";

  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "All cities";
  els.city.appendChild(all);

  for (const label of opts.slice(1)) {
    const o = document.createElement("option");
    o.value = label;
    o.textContent = label;
    els.city.appendChild(o);
  }
}

function buildCuratorSelect() {
  if (!els.curator) return;
  const opts = getCuratorOptions();
  els.curator.innerHTML = "";

  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "All curators";
  els.curator.appendChild(all);

  for (const label of opts.slice(1)) {
    const o = document.createElement("option");
    o.value = label;
    o.textContent = label;
    els.curator.appendChild(o);
  }
}

function filtersFromUI() {
  const q = normalize(els.query.value);
  const city = parseCityValue(els.city.value);
  const category = /** @type {"all"|Category} */ (els.category.value);
  const source = /** @type {"all"|Source} */ (els.source.value);
  const curator = els.curator ? els.curator.value : "all";
  return { q, city, category, source, curator };
}

/** @type {ReturnType<typeof filtersFromUI>} */
let lastFilters = filtersFromUI();

/**
 * The quality filter. A place passes if any of these hold:
 *   - googleRating >= 4.0
 *   - manualPick === true
 *   - ratingLookupStatus is not "success" (we haven't successfully rated it yet)
 *   - success but fewer than MIN_REVIEWS_FILTER reviews (not enough signal to filter on)
 * Places that fail are hidden in the default (filtered) view, but visible
 * with a low-rated indicator in the admin (all) view.
 *
 * @param {Place} p
 */
function hasEnoughReviewsToFilterOn(p) {
  if (p.ratingLookupStatus !== "success") return false;
  return typeof p.googleRatingCount === "number" && p.googleRatingCount >= MIN_REVIEWS_FILTER;
}

function passesQualityFilter(p) {
  if (p.manualPick === true) return true;
  if (!hasEnoughReviewsToFilterOn(p)) return true;
  return typeof p.googleRating === "number" && p.googleRating >= RATING_MIN;
}

function applyFilters() {
  const { q, city, category, source, curator } = filtersFromUI();
  lastFilters = { q, city, category, source, curator };

  const baseFiltered = data.filter((p) => {
    if (city && (p.city !== city.city || p.country !== city.country)) return false;
    if (category !== "all" && p.category !== category) return false;
    if (source !== "all" && p.source !== source) return false;
    if (curator !== "all" && (p.curator ?? "") !== curator) return false;
    if (q) {
      const hay = placeHaystack(p);
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const passesCount = baseFiltered.reduce((n, p) => n + (passesQualityFilter(p) ? 1 : 0), 0);
  const visible =
    adminView === "all" ? baseFiltered : baseFiltered.filter(passesQualityFilter);

  render(visible, lastFilters);
  updateMeta(visible.length, baseFiltered.length - passesCount);
}

function updateMeta(count, hiddenInFilteredView) {
  const city = parseCityValue(els.city.value);
  const cityLabel = city ? `${city.city}, ${city.country}` : "All cities";
  let line = `${count} result${count === 1 ? "" : "s"}${SEP}${cityLabel}`;
  if (adminView === "filtered" && hiddenInFilteredView > 0) {
    line += `${SEP}${hiddenInFilteredView} hidden by rating filter`;
  } else if (adminView === "all") {
    line += `${SEP}admin view (showing all)`;
  }
  els.resultsMeta.textContent = line;
}

const CATEGORY_CHIP_CLASS = /** @type {const} */ ({
  restaurant: "chip chip--accent",
  cafe: "chip chip--cafe",
  bakery: "chip chip--bakery",
  bar: "chip chip--bar",
  hotel: "chip chip--hotel",
  shop: "chip chip--teal",
  attraction: "chip chip--attraction",
  wellness: "chip chip--wellness",
});

function categoryChip(category) {
  const label = CATEGORIES[category];
  const cls = CATEGORY_CHIP_CLASS[category] ?? "chip chip--accent";
  return `<span class="${cls}">${escapeHtml(label)}</span>`;
}

function sourceChip(source) {
  const label = SOURCES[source];
  if (!label) return "";
  const cls = "chip chip--teal";
  return `<span class="${cls}">${escapeHtml(label)}</span>`;
}

function curatorChip(curator) {
  const name = (curator ?? "").trim();
  if (!name) return "";
  return `<span class="chip chip--curator" title="${escapeHtml(name)}'s pick">${escapeHtml(name)}&rsquo;s pick</span>`;
}

function escapeHtml(s) {
  return (s ?? "")
    .toString()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** @param {unknown} raw */
function trustedHttpUrl(raw) {
  try {
    const u = new URL(String(raw ?? ""));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.href;
  } catch {
    return null;
  }
}

/** Strip legacy Vogue deks if cached assets still serve old data. */
function displayCitationTitle(p) {
  const sourceLabel = p.source ? SOURCES[p.source] : "";
  let t = (p.sourceTitle ?? "").trim();
  const folded = t
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[\u2018\u2019\u0060]/g, "'")
    .toLowerCase();
  if (/below\s*[,.]?\s*find\b/.test(folded) && /\bvogue\b/.test(folded)) {
    return sourceLabel ? `${sourceLabel}: ${p.city}` : p.city;
  }
  if (/\bvogue\b/.test(folded) && /\bguide\b/.test(folded) && /\b(below|find)\b/.test(folded)) {
    return sourceLabel ? `${sourceLabel}: ${p.city}` : p.city;
  }
  if (/\]\(https?:\/\//i.test(t)) {
    return sourceLabel ? `${sourceLabel}: ${p.city}` : p.city;
  }
  if (!t) return sourceLabel ? `Read on ${sourceLabel}` : "";
  return t;
}

/**
 * Render the rating line that sits near the source attribution.
 * - "success" with rating: "4.3 · 1,847 reviews"
 * - "not_found": "(unrated)"
 * - "pending" / "error" / "skipped" / missing: nothing rendered
 * @param {Place} p
 */
function ratingLine(p) {
  if (p.ratingLookupStatus === "not_found") {
    return `<span class="ratingLine ratingLine--muted">(unrated)</span>`;
  }
  if (
    p.ratingLookupStatus === "success" &&
    typeof p.googleRating === "number"
  ) {
    const r = p.googleRating.toFixed(1);
    const count = typeof p.googleRatingCount === "number"
      ? `${SEP}${REVIEW_NUM_FORMAT.format(p.googleRatingCount)} review${p.googleRatingCount === 1 ? "" : "s"}`
      : "";
    return `<span class="ratingLine">${escapeHtml(r)}${escapeHtml(count)}</span>`;
  }
  return "";
}

/** @param {Place} p @param {ReturnType<typeof filtersFromUI>} filters */
function card(p, filters) {
  const cityLine = [p.neighborhood, `${p.city}, ${p.country}`].filter(Boolean).join(SEP);
  const tags = (p.tags ?? []).slice(0, 5);
  const showCategoryChip = !(filters.category !== "all" && p.category === filters.category);
  const showSourceChip =
    Boolean(p.source) && !(filters.source !== "all" && p.source === filters.source);
  const showCuratorChip =
    Boolean(p.curator) && !(filters.curator !== "all" && p.curator === filters.curator);
  const chips = [
    ...(showCategoryChip ? [categoryChip(p.category)] : []),
    ...(showSourceChip ? [sourceChip(p.source)] : []),
    ...(showCuratorChip ? [curatorChip(p.curator)] : []),
    ...tags.map((t) => `<span class="chip">${escapeHtml(t)}</span>`),
  ].join("");

  const venueUrl = trustedHttpUrl(p.venueUrl);
  const sourceUrl = trustedHttpUrl(p.sourceUrl);
  const safeSourceTitle = displayCitationTitle(p);

  const descriptor = (p.descriptor ?? "").trim();
  const descriptorLine = descriptor
    ? `<p class="descriptor">${escapeHtml(descriptor)}</p>`
    : `<p class="descriptor descriptor--fallback">${escapeHtml(CATEGORIES[p.category])}</p>`;

  const sourceLabel = sourceLinkLabel(p, sourceUrl);
  const showTitle =
    Boolean(safeSourceTitle) && safeSourceTitle !== `Read on ${SOURCES[p.source]}`;
  const titleSep = showTitle ? `<span class="sep">${escapeHtml(SEP.trim())}</span>` : "";

  const isFilteredOut = !passesQualityFilter(p);
  const cardClasses = ["card"];
  if (isFilteredOut) cardClasses.push("card--filteredOut");
  if (p.manualPick === true) cardClasses.push("card--pick");

  const badges = [];
  if (p.manualPick === true) {
    badges.push(`<span class="badge badge--pick" title="Editor's pick">Editor&rsquo;s pick</span>`);
  }
  if (
    p.ratingLookupStatus === "success" &&
    typeof p.googleRating === "number" &&
    p.googleRating >= HIGHLY_RATED &&
    typeof p.googleRatingCount === "number" &&
    p.googleRatingCount >= MIN_REVIEWS_BADGE
  ) {
    badges.push(`<span class="badge badge--highlyRated" title="Rated ${p.googleRating.toFixed(1)} on Google">Highly rated</span>`);
  }
  if (isFilteredOut) {
    badges.push(
      `<span class="badge badge--lowRated" title="Below the ${RATING_MIN.toFixed(1)} rating threshold">Below threshold</span>`,
    );
  }
  const badgesHtml = badges.length ? `<div class="badges">${badges.join("")}</div>` : "";
  const rating = ratingLine(p);

  return `
    <article class="${cardClasses.join(" ")}">
      <div class="card__top">
        <div class="titleRow">
          <h3 class="title">${escapeHtml(p.name)}</h3>
        </div>
        ${badgesHtml}
        ${descriptorLine}
        <div class="city">${escapeHtml(cityLine)}</div>
        ${chips ? `<div class="chips">${chips}</div>` : ""}
      </div>
      <div class="card__bottom">
        ${
          venueUrl
            ? `<a class="cta" href="${venueUrl}" target="_blank" rel="noopener noreferrer">Visit website</a>`
            : ""
        }
        ${rating ? `<div class="attributionMeta">${rating}</div>` : ""}
        ${
          sourceUrl
            ? `<a class="attributionLine" href="${sourceUrl}" target="_blank" rel="noopener noreferrer">
          <span class="sourceLink">${escapeHtml(sourceLabel)}</span>
          ${showTitle ? `${titleSep}<span class="articleTitle">${escapeHtml(safeSourceTitle)}</span>` : ""}
        </a>`
            : ""
        }
      </div>
    </article>
  `.trim();
}

/**
 * Pick a friendly label for the source link.
 * - Vogue / Goop sources use the source field directly.
 * - Otherwise infer from the URL host (Instagram, etc.).
 * @param {Place} p
 * @param {string|null} sourceUrl
 */
function sourceLinkLabel(p, sourceUrl) {
  const known = SOURCES[p.source];
  if (known) return `Read on ${known}`;
  if (!sourceUrl) return "Read source";
  try {
    const host = new URL(sourceUrl).hostname.replace(/^www\./i, "").toLowerCase();
    if (host.endsWith("instagram.com")) return "View on Instagram";
    if (host.endsWith("facebook.com") || host === "fb.com") return "View on Facebook";
    if (host.endsWith("tiktok.com")) return "View on TikTok";
    if (host.endsWith("youtube.com") || host === "youtu.be") return "Watch on YouTube";
    if (host.endsWith("twitter.com") || host === "x.com") return "View on X";
    const pretty = host.replace(/\.(com|net|org|co\.uk|fr|de|it|es|dk|se|no)$/i, "");
    return `Read on ${pretty.charAt(0).toUpperCase() + pretty.slice(1)}`;
  } catch {
    return "Read source";
  }
}

function render(list, filters) {
  const f = filters ?? lastFilters ?? filtersFromUI();
  els.results.innerHTML = list.map((p) => card(p, f)).join("");
  els.empty.hidden = list.length > 0;
}

function reset() {
  els.query.value = "";
  els.city.value = "all";
  els.category.value = "all";
  els.source.value = "all";
  if (els.curator) els.curator.value = "all";
  applyFilters();
}

function setAboutVisibility(isOpen) {
  els.about.hidden = !isOpen;
  if (isOpen) els.about.scrollIntoView({ behavior: "smooth", block: "start" });
}

function updateAdminToggleLabel() {
  if (!els.adminToggle) return;
  els.adminToggle.textContent =
    adminView === "all" ? "Hide low-rated" : "Show all (admin)";
  els.adminToggle.setAttribute(
    "aria-pressed",
    adminView === "all" ? "true" : "false",
  );
}

function toggleAdminView() {
  adminView = adminView === "all" ? "filtered" : "all";
  try {
    localStorage.setItem(ADMIN_KEY, adminView);
  } catch {
    // ignore (private mode / storage disabled)
  }
  updateAdminToggleLabel();
  applyFilters();
}

function init() {
  els.year.textContent = String(new Date().getFullYear());
  buildCitySelect();
  buildCuratorSelect();
  updateAdminToggleLabel();
  applyFilters();
  setAboutVisibility(window.location.hash === "#about");

  els.query.addEventListener("input", applyFilters);
  els.city.addEventListener("change", applyFilters);
  els.category.addEventListener("change", applyFilters);
  els.source.addEventListener("change", applyFilters);
  if (els.curator) els.curator.addEventListener("change", applyFilters);
  els.resetBtn.addEventListener("click", reset);
  if (els.adminToggle) els.adminToggle.addEventListener("click", toggleAdminView);

  els.aboutLink.addEventListener("click", (e) => {
    e.preventDefault();
    window.location.hash = "#about";
  });
  els.closeAboutBtn.addEventListener("click", () => {
    window.location.hash = "";
    setAboutVisibility(false);
  });
  window.addEventListener("hashchange", () => {
    setAboutVisibility(window.location.hash === "#about");
  });
}

init();

