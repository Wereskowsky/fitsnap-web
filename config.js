// Where the Mini App finds its backend. The anon key is not needed: tg-api authenticates every
// request with the Telegram initData signature.
export const API_BASE = "https://dncfejpkbfkfcytcvdna.supabase.co/functions/v1/tg-api";

/** Version of the Telegram product's terms; bump to ask everyone for consent again. */
export const TERMS_VERSION = 1;

// Public legal pages for the Telegram product (empty until they are published).
export const LEGAL = {
  terms: "",
  privacy: "",
};
