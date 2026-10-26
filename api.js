// Calls to tg-api (backend/supabase/functions/tg-api). Every request carries the Telegram initData;
// the server checks its signature and takes the user id from it.

import { API_BASE } from "./config.js";

export class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function createApi(initData, fetchImpl = fetch) {
  async function call(method, path, body) {
    let response;
    try {
      response = await fetchImpl(API_BASE + path, {
        method,
        headers: { Authorization: `tma ${initData}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, "network");
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      // Empty or non-JSON body: keep data null.
    }
    if (!response.ok) throw new ApiError(response.status, data?.error ?? "http_" + response.status);
    return data;
  }

  return {
    me: (day) => call("GET", `/me?day=${day}`),
    saveProfile: (profile) => call("PUT", "/profile", profile),
    entries: (day) => call("GET", `/entries?day=${day}`),
    saveEntry: (entry) => call("PUT", "/entries", entry),
    deleteEntry: (id) => call("DELETE", `/entries/${id}`),
    history: (from, to) => call("GET", `/history?from=${from}&to=${to}`),
    invoice: (tier) => call("POST", "/invoice", { tier }),
    scan: (request) => call("POST", "/scan", request),
    deleteMe: () => call("DELETE", "/me"),
  };
}

const OFF_TIMEOUT_MS = 12_000;

// Open Food Facts tags of the 14 EU allergens (same as Allergen.offTag in the Android app).
const OFF_TAGS = {
  "en:gluten": "gluten", "en:milk": "milk", "en:eggs": "eggs", "en:peanuts": "peanuts", "en:nuts": "nuts",
  "en:soybeans": "soy", "en:fish": "fish", "en:crustaceans": "crustaceans", "en:molluscs": "molluscs",
  "en:celery": "celery", "en:mustard": "mustard", "en:sesame-seeds": "sesame",
  "en:sulphur-dioxide-and-sulphites": "sulphites", "en:lupin": "lupin",
};

/**
 * Product by barcode from Open Food Facts, straight from the browser: only the barcode number
 * leaves the phone. Returns null when the product is unknown.
 */
export async function lookupBarcode(barcode, lang, fetchImpl = fetch) {
  if (!/^[0-9]{6,14}$/.test(barcode)) return null;
  const fields = [
    "product_name", `product_name_${lang}`, "brands", "nutriments",
    "allergens_tags", "traces_tags", "ingredients_text", `ingredients_text_${lang}`,
  ].join(",");
  // Open Food Facts is sometimes slow: give up after a while instead of spinning forever.
  const response = await fetchImpl(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json?fields=${fields}`, {
    signal: AbortSignal.timeout(OFF_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new ApiError(response.status, "off_failed");
  const body = await response.json();
  if (body.status !== 1 || !body.product) return null;
  const p = body.product;
  const n = p.nutriments ?? {};
  const text = (k) => (typeof p[k] === "string" && p[k].trim() ? p[k].trim() : null);
  const name = text(`product_name_${lang}`) ?? text("product_name");
  if (!name) return null;
  const brand = text("brands")?.split(",")[0].trim();
  const kcal = n["energy-kcal_100g"] ?? (n["energy_100g"] != null ? n["energy_100g"] / 4.184 : null);
  const tags = (k) => (Array.isArray(p[k]) ? p[k].map((x) => OFF_TAGS[x]).filter(Boolean) : null);
  const ingredients = text(`ingredients_text_${lang}`) ?? text("ingredients_text");
  // An empty allergen list means "none" only when the ingredients were actually analysed.
  const declared = tags("allergens_tags");
  return {
    name: brand && !name.toLowerCase().includes(brand.toLowerCase()) ? `${name} (${brand})` : name,
    kcal100: kcal,
    protein100: n.proteins_100g ?? 0,
    fat100: n.fat_100g ?? 0,
    carbs100: n.carbohydrates_100g ?? 0,
    barcode,
    declared: declared && (declared.length > 0 || ingredients) ? declared : null,
    traces: tags("traces_tags") ?? [],
  };
}
