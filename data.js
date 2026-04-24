export const SOURCES = /** @type {const} */ ({
  goop: "Goop",
  vogue: "Vogue",
});

export const CATEGORIES = /** @type {const} */ ({
  restaurant: "Restaurant",
  hotel: "Hotel",
  shop: "Shop",
});

/**
 * Seed dataset.
 * Notes:
 * - This app intentionally does NOT scrape sources. Each item is a manual listing with a backlink.
 * - Replace placeholder links with the exact Goop/Vogue URLs you want to cite.
 * - Add as many cities/items as you like; the UI updates automatically.
 */
export { PLACES } from "./data.generated.js";

