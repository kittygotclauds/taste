/**
 * Place descriptors: optional English line (8–14 words when shown).
 * Editorial overrides in descriptor-overrides.json bypass reliability checks (lint only).
 * Auto-filled lines must pass isReliableAutoDescriptor().
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** @typedef {{ id: string; name: string; category: string; city: string; country: string; neighborhood?: string; descriptor?: string }} PlaceLike */

const BANNED =
  /\b(hidden gem|must-visit|must visit|iconic|elevated|curated|ultimate destination|bucket list|instagram-worthy|instagram worthy|once-in-a-lifetime|best-kept secret)\b/i;

const MIN_W = 8;
const MAX_W = 14;

/** English placeholder lines when Wikipedia offers no usable summary (word count relaxed). */
export const MINIMAL_FALLBACK_PHRASES = /** @type {const} */ ([
  "Small neighborhood restaurant with simple daytime menus.",
  "Independent neighborhood shop selling mixed general merchandise.",
  "Public cultural landmark open for daytime visits and tours.",
  "Boutique lodging in a modest city-center property.",
  "Massage therapy sessions and straightforward wellness treatments.",
]);

/** @param {string} text */
export function isMinimalFallbackPhrase(text) {
  const n = (text ?? "")
    .trim()
    .replace(/\.$/, "")
    .toLowerCase();
  return MINIMAL_FALLBACK_PHRASES.some((p) => p.replace(/\.$/, "").toLowerCase() === n);
}

/** @param {string} s */
function wordCount(s) {
  return (s ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

/** @param {string} s */
export function lintDescriptor(s) {
  let out = (s ?? "").trim().replace(/\s+/g, " ").replace(/\u2014/g, ",").replace(/[—–]/g, ",");
  if (!out) return "";
  if (!out.endsWith(".")) out += ".";
  let wc = wordCount(out.replace(/\.$/, ""));
  if (wc > MAX_W) {
    const parts = out.replace(/\.$/, "").split(/\s+/);
    out = parts.slice(0, MAX_W).join(" ") + ".";
  }
  if (BANNED.test(out.toLowerCase())) {
    out = out.replace(BANNED, "").replace(/\s+/g, " ").trim();
    if (!out.endsWith(".")) out += ".";
  }
  return out.trim();
}

/**
 * Publishability gate for auto-generated descriptors (Wikipedia-derived or minimal English fallback).
 *
 * @param {string} text
 */
export function isReliableAutoDescriptor(text) {
  const cleaned = (text ?? "").trim().replace(/\.$/, "");
  if (!cleaned) return false;

  if (isMinimalFallbackPhrase(text)) return true;

  const wc = wordCount(cleaned);
  if (wc < MIN_W || wc > MAX_W) return false;

  const lower = cleaned.toLowerCase();
  if (BANNED.test(lower)) return false;

  if (/included in the cited guide without further verified/i.test(lower)) return false;

  if (
    /suspended|likes ·|talking about this|could not be reached|dns propagation|404 error|page not found|website you are trying/i.test(
      lower,
    )
  )
    return false;

  if (/^(copenhagen|london|paris|milan|rome|mexico city|los angeles|new york city|new york|seoul|tokyo|miami|berlin),/i.test(cleaned))
    return false;

  if (/^(restaurant|hotels?|shops?|retail stores?|visitor attractions?|attractions?|museums?)\b/i.test(lower)) return false;

  if (/\b(er et\b|der ligger|découvrez le|serverer\b|serviert\b|nos programmes|restaurante tradicional|gastronomía)\b/i.test(lower))
    return false;

  if (/\b(killed|murder|murdered|shooting)\b/i.test(lower)) return false;

  if (/\|\s*(find all|official|tickets)\b/i.test(cleaned)) return false;

  if (/^\w+\s+\?\s+/i.test(cleaned)) return false;

  if (/\bin\s+'s\b/i.test(lower)) return false;

  // Obvious non-Latin scripts (allow light accents in English loanwords)
  if (/[\u0600-\u06FF\u0400-\u04FF\u3040-\u30FF\u4E00-\u9FFF]/.test(cleaned)) return false;

  return true;
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

    const existing = typeof row.descriptor === "string" ? row.descriptor.trim() : "";
    if (existing) {
      const d = lintDescriptor(existing);
      return { ...p, descriptor: isReliableAutoDescriptor(d) ? d : "" };
    }

    return { ...p, descriptor: "" };
  });
}
