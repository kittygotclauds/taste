/**
 * Place descriptors: optional factual sentence (8–14 words when shown).
 * Editorial overrides in descriptor-overrides.json bypass reliability heuristics (lint only).
 * Auto-filled lines must pass isReliableAutoDescriptor() or they ship as empty.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** @typedef {{ id: string; name: string; category: string; city: string; country: string; neighborhood?: string; descriptor?: string }} PlaceLike */

const BANNED =
  /\b(hidden gem|must-visit|must visit|iconic|elevated|curated|ultimate destination|bucket list|instagram-worthy|instagram worthy|once-in-a-lifetime|best-kept secret)\b/i;

const MIN_W = 8;
const MAX_W = 14;

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
 * Returns true only when automatic/meta-derived copy looks trustworthy enough to show.
 * Editorial overrides skip this (see assignDescriptors).
 *
 * @param {string} text
 */
export function isReliableAutoDescriptor(text) {
  const cleaned = (text ?? "").trim().replace(/\.$/, "");
  if (!cleaned) return false;

  const wc = wordCount(cleaned);
  if (wc < MIN_W || wc > MAX_W) return false;

  const lower = cleaned.toLowerCase();

  if (BANNED.test(lower)) return false;

  if (/included in the cited guide/i.test(lower)) return false;
  if (/without further verified/i.test(lower)) return false;
  if (/without fuller verified/i.test(lower)) return false;

  if (/\|\s*(find all|official|tickets|visit)\b/i.test(cleaned)) return false;
  if (/before your visit\b/i.test(lower)) return false;

  if (/\b(killed|murder|murdered|shooting|patriarch of the hugely)\b/i.test(lower)) return false;

  if (
    /^(visitor attraction|museum|art gallery|shop|hotel|restaurant|wellness studio|day spa|wellness business|wellness venue)\s+(el|la|los|las|les|der|die|das|det|den)\b/i.test(
      lower,
    )
  )
    return false;

  if (/^(visitor attraction|shop)\s+[a-záéíóúñ]{2,},\s+/i.test(lower)) return false;

  if (/\bdistrict in the danish capital\b/i.test(lower)) return false;
  if (/\bconstructed in the late \d/i.test(lower)) return false;

  if (/\b(boasts|nestled|situated|step into|welcome to|offers a unique)\b/i.test(lower)) return false;

  if (/\brestaurant\s+restaurante\b/i.test(lower)) return false;

  if (/\band\s*\.\s*$/.test(lower)) return false;
  if (/,\s+with\s+(the\s+)?vibrant\s*\.\s*$/i.test(lower)) return false;

  if (/\bin\s+'s\b/i.test(lower)) return false;
  if (/\s\?\s/.test(lower)) return false;

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
