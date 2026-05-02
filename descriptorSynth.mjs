/**
 * Place descriptors: one sentence, ≤10 words, Claudia voice (see project copy spec).
 * Optional overrides: descriptor-overrides.json keyed by place id.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** @typedef {{ id: string; name: string; category: string; city: string; country: string; neighborhood?: string }} PlaceLike */

const BANNED =
  /\b(hidden gem|must-visit|must visit|iconic|elevated|curated|ultimate destination|bucket list|instagram-worthy|instagram worthy|once-in-a-lifetime|best-kept secret)\b/i;

const THROAT =
  /\b(discover|experience|nestled|situated|boasts|offers a unique|welcome to|step into)\b/i;

/** @param {string} s */
function wordCount(s) {
  return (s ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

/** @param {string} s */
function lintDescriptor(s) {
  let out = (s ?? "").trim().replace(/\s+/g, " ").replace(/\u2014/g, ","); // no em dashes
  if (!out.endsWith(".")) out += ".";
  const wc = wordCount(out.replace(/\.$/, ""));
  if (wc > 10) {
    const parts = out.replace(/\.$/, "").split(/\s+/);
    out = parts.slice(0, 10).join(" ") + ".";
  }
  return out;
}

/** @param {string} s */
function passesVoiceLint(s) {
  const lower = s.toLowerCase();
  if (BANNED.test(lower)) return false;
  if (THROAT.test(lower)) return false;
  if (/\u2014/.test(s)) return false;
  if (/it's not .*it's/i.test(s)) return false;
  return wordCount(s.replace(/\.$/, "")) <= 10;
}

/** @param {string} s */
function capitalizeWords(s) {
  return (s ?? "")
    .split(/\s+/)
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

/** @param {PlaceLike} p */
function geoLead(p) {
  const nb = (p.neighborhood ?? "").split("/")[0].split(",")[0].trim();
  let raw =
    nb && nb.length <= 36 && nb.length >= 2 ? nb : (p.city ?? "").split(",")[0].trim() || "Here";
  const words = capitalizeWords(raw).split(/\s+/).filter(Boolean).slice(0, 4);
  return words.join(" ");
}

/** @param {string} str */
function hashStr(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return Math.abs(h >>> 0);
}

/** Shared tails after "{Geo}, …". Lowercase clause + period added in builder. */
const BASE_FRAGMENTS = [
  "the repeat customer's quiet argument",
  "where locals spend real money",
  "built for taste, not traction",
  "receipts over captions",
  "prettier than necessary, sharper than polite",
  "the grown-up reading of the block",
  "flavor before theater",
  "sleep like you picked the neighborhood",
  "shopping with judgment intact",
  "the museum stop worth skipping lunch for",
  "recovery without the whisper voice",
  "the reservation flex done right",
  "no brochure voice, better manners",
  "honest smoke, honest bill",
  "where hype ages out fast",
  "quiet money, louder plates",
  "proof the neighborhood still argues",
  "for people past pretending",
  "when you mean it this time",
  "not auditioning for attention",
  "the version insiders defend",
  "writes small, spends loud",
  "still rude about quality",
]

/** @type {Record<string, string[]>} */
const CATEGORY_FRAGMENTS = {
  restaurant: [
    "the pasta memo nobody skips",
    "a knife-edge appetite welcome",
    "where hunger stops negotiating",
    "menu as personality test",
  ],
  hotel: [
    "old bones, newer nerve",
    "check-in without the apology tour",
    "the room rate that makes sense later",
  ],
  shop: [
    "retail with a spine",
    "the bag that ends the browse",
    "credit card, no regret sequence",
  ],
  attraction: [
    "culture with a line worth waiting in",
    "the ticket stub you keep",
  ],
  wellness: [
    "body work, no serenity cosplay",
    "maintenance for people who skip yoga poetry",
  ],
};

/**
 * @param {PlaceLike} p
 * @param {number} salt
 */
function pickFragment(p, salt) {
  const pool = [...BASE_FRAGMENTS, ...(CATEGORY_FRAGMENTS[p.category] ?? [])];
  const h = hashStr(`${p.id}|${p.category}|${salt}`);
  return pool[h % pool.length];
}

/**
 * @param {PlaceLike} p
 */
function synthesizeDescriptor(p) {
  const geo = geoLead(p);
  for (let salt = 0; salt < 14; salt++) {
    const frag = pickFragment(p, salt);
    const body = `${frag[0].toUpperCase()}${frag.slice(1)}`;
    let s = `${geo}, ${body}.`;
    s = lintDescriptor(s);
    if (passesVoiceLint(s)) return s;
  }
  const fallback = lintDescriptor(`${geo}, taste with receipts.`);
  return passesVoiceLint(fallback) ? fallback : "Taste with receipts.";
}

/**
 * @param {unknown[]} places
 * @param {string} rootDir
 */
export function assignDescriptors(places, rootDir) {
  const overridePath = path.join(rootDir, "descriptor-overrides.json");
  /** @type {Record<string, string>} */
  let overrides = {};
  if (existsSync(overridePath)) {
    try {
      const raw = JSON.parse(readFileSync(overridePath, "utf8"));
      for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith("_")) continue;
        if (typeof v === "string") overrides[k] = v;
      }
    } catch {
      overrides = {};
    }
  }

  return places.map((p) => {
    const row = /** @type {PlaceLike} */ (p);
    const id = row.id;
    if (id && overrides[id]) {
      const d = lintDescriptor(overrides[id]);
      return { ...p, descriptor: d };
    }
    return { ...p, descriptor: synthesizeDescriptor(row) };
  });
}
