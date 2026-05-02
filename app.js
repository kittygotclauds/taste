import { PLACES, SOURCES, CATEGORIES } from "./data.js";

const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));

const SEP = " \u00B7 ";

const els = {
  query: /** @type {HTMLInputElement} */ ($("#query")),
  city: /** @type {HTMLSelectElement} */ ($("#city")),
  category: /** @type {HTMLSelectElement} */ ($("#category")),
  source: /** @type {HTMLSelectElement} */ ($("#source")),
  resetBtn: /** @type {HTMLButtonElement} */ ($("#resetBtn")),
  results: $("#results"),
  empty: $("#emptyState"),
  resultsMeta: $("#resultsMeta"),
  year: $("#year"),
  about: /** @type {HTMLElement} */ ($("#about")),
  aboutLink: /** @type {HTMLAnchorElement} */ ($("#aboutLink")),
  closeAboutBtn: /** @type {HTMLButtonElement} */ ($("#closeAboutBtn")),
};

/** @typedef {"restaurant"|"hotel"|"shop"|"attraction"|"wellness"} Category */
/** @typedef {"goop"|"vogue"} Source */

/** @typedef Place
 * @property {string} id
 * @property {string} name
 * @property {Category} category
 * @property {string} city
 * @property {string} country
 * @property {string=} neighborhood
 * @property {Source} source
 * @property {string} sourceTitle
 * @property {string} sourceUrl
 * @property {string=} placeUrl
 * @property {string|null=} website Official venue URL when resolved by collector
 * @property {string=} descriptor One-line voice descriptor (≤10 words)
 * @property {readonly string[]=} tags
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
      SOURCES[p.source],
      ...(p.tags ?? []),
    ].join(SEP),
  );
}

function getCityOptions() {
  const cities = uniqSorted(data.map((p) => `${p.city}${SEP}${p.country}`));
  return ["All cities", ...cities];
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

function filtersFromUI() {
  const q = normalize(els.query.value);
  const city = parseCityValue(els.city.value);
  const category = /** @type {"all"|Category} */ (els.category.value);
  const source = /** @type {"all"|Source} */ (els.source.value);
  return { q, city, category, source };
}

function applyFilters() {
  const { q, city, category, source } = filtersFromUI();

  const filtered = data.filter((p) => {
    if (city && (p.city !== city.city || p.country !== city.country)) return false;
    if (category !== "all" && p.category !== category) return false;
    if (source !== "all" && p.source !== source) return false;
    if (q) {
      const hay = placeHaystack(p);
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  render(filtered);
  updateMeta(filtered.length);
}

function updateMeta(count) {
  const city = parseCityValue(els.city.value);
  const cityLabel = city ? `${city.city}, ${city.country}` : "All cities";
  els.resultsMeta.textContent = `${count} result${count === 1 ? "" : "s"}${SEP}${cityLabel}`;
}

const CATEGORY_CHIP_CLASS = /** @type {const} */ ({
  restaurant: "chip chip--accent",
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
  const cls = "chip chip--teal";
  return `<span class="${cls}">${escapeHtml(label)}</span>`;
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

/** @param {string|null|undefined} a @param {string|null|undefined} b */
function sameHttpUrl(a, b) {
  const ua = trustedHttpUrl(a);
  const ub = trustedHttpUrl(b);
  if (!ua || !ub) return false;
  try {
    const x = new URL(ua);
    const y = new URL(ub);
    x.hash = "";
    y.hash = "";
    return x.href === y.href;
  } catch {
    return false;
  }
}

/** Strip legacy Vogue deks if cached assets still serve old data. */
function displayCitationTitle(p) {
  let t = (p.sourceTitle ?? "").trim();
  const folded = t
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[\u2018\u2019\u0060]/g, "'")
    .toLowerCase();
  if (/below\s*[,.]?\s*find\b/.test(folded) && /\bvogue\b/.test(folded)) {
    return `${SOURCES[p.source]}: ${p.city}`;
  }
  if (/\bvogue\b/.test(folded) && /\bguide\b/.test(folded) && /\b(below|find)\b/.test(folded)) {
    return `${SOURCES[p.source]}: ${p.city}`;
  }
  if (/\]\(https?:\/\//i.test(t)) {
    return `${SOURCES[p.source]}: ${p.city}`;
  }
  if (!t) return `Read on ${SOURCES[p.source]}`;
  return t;
}

function card(p) {
  const cityLine = [p.neighborhood, `${p.city}, ${p.country}`].filter(Boolean).join(SEP);
  const tags = (p.tags ?? []).slice(0, 5);
  const chips = [
    categoryChip(p.category),
    sourceChip(p.source),
    ...tags.map((t) => `<span class="chip">${escapeHtml(t)}</span>`),
  ].join("");

  const safeSourceUrl = trustedHttpUrl(p.sourceUrl) ?? "#";
  const safeSourceTitle = displayCitationTitle(p);
  const officialWebsite = trustedHttpUrl(p.website);
  const listingUrl = trustedHttpUrl(p.placeUrl);
  const showListing = listingUrl && (!officialWebsite || !sameHttpUrl(p.website, p.placeUrl));

  return `
    <article class="card">
      <div class="card__top">
        <div class="titleRow">
          <h3 class="title">${escapeHtml(p.name)}</h3>
        </div>
        <div class="city">${escapeHtml(cityLine)}</div>
        ${p.descriptor ? `<p class="descriptor">${escapeHtml(p.descriptor)}</p>` : ""}
        <div class="chips">${chips}</div>
      </div>
      <div class="card__bottom">
        <div class="links">
          <a class="link" href="${safeSourceUrl}" target="_blank" rel="noopener noreferrer">
            Read on ${escapeHtml(SOURCES[p.source])}
          </a>
          ${
            officialWebsite
              ? `<a class="link link--website" href="${officialWebsite}" target="_blank" rel="noopener noreferrer">Visit website</a>`
              : ""
          }
          ${
            showListing
              ? `<a class="link link--muted" href="${listingUrl}" target="_blank" rel="noopener noreferrer">Listing</a>`
              : ""
          }
        </div>
        <span class="fine">${escapeHtml(safeSourceTitle)}</span>
      </div>
    </article>
  `.trim();
}

function render(list) {
  els.results.innerHTML = list.map(card).join("");
  els.empty.hidden = list.length > 0;
}

function reset() {
  els.query.value = "";
  els.city.value = "all";
  els.category.value = "all";
  els.source.value = "all";
  applyFilters();
}

function setAboutVisibility(isOpen) {
  els.about.hidden = !isOpen;
  if (isOpen) els.about.scrollIntoView({ behavior: "smooth", block: "start" });
}

function init() {
  els.year.textContent = String(new Date().getFullYear());
  buildCitySelect();
  applyFilters();
  setAboutVisibility(window.location.hash === "#about");

  els.query.addEventListener("input", applyFilters);
  els.city.addEventListener("change", applyFilters);
  els.category.addEventListener("change", applyFilters);
  els.source.addEventListener("change", applyFilters);
  els.resetBtn.addEventListener("click", reset);

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

