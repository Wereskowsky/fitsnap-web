// FitSnap Telegram Mini App: onboarding with consent, food diary, barcode lookup, photo recognition,
// plans paid in Telegram Stars, history and profile. Plain DOM, no build step.
//
// All user-visible data goes through text nodes (h() never sets innerHTML), so names of foods and
// users cannot inject markup.

import { ApiError, createApi, lookupBarcode } from "./api.js";
import { legalUrl, TERMS_VERSION } from "./config.js";
import { ALLERGENS, allergenName, formatDate, lang, langOf, LANGS, setLang, t } from "./i18n.js";
import { dailyTarget, entryTotals, localDay, shiftDay, sum } from "./nutrition.js";

const tg = window.Telegram?.WebApp;
const MEALS = ["Breakfast", "Lunch", "Dinner", "Snack"];
const TIERS = ["lite", "pro", "max"];
const TIER_NAMES = { free: "Free", lite: "Lite", pro: "Pro", max: "Max" };
const ACTIVITIES = ["Sedentary", "Light", "Moderate", "Active", "VeryActive"];
const GOALS = ["LoseWeight", "Maintain", "GainMuscle"];
const RECENT_KEY = "fitsnap.recent";
const RECENT_MAX = 20;

const root = document.getElementById("app");
let api;

const state = {
  profile: null,
  tiers: {},
  scansUsed: 0,
  day: localDay(),
  entries: [],
  tab: "diary",
  /** Stack of overlay screens on top of the tabs: {kind, ...}. The Telegram back button pops it. */
  overlays: [],
};

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style") el.setAttribute("style", v);
    else if (k in el && k !== "list") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const round = (x) => Math.round(x);
const one = (x) => Math.round(x * 10) / 10;

function haptic(kind) {
  try {
    if (kind === "success" || kind === "error" || kind === "warning") tg?.HapticFeedback?.notificationOccurred(kind);
    else tg?.HapticFeedback?.impactOccurred(kind ?? "light");
  } catch {
    // Older clients have no haptics.
  }
}

function alertBox(text) {
  return new Promise((resolve) => {
    if (tg?.showAlert && tg.isVersionAtLeast?.("6.2")) tg.showAlert(text, resolve);
    else {
      window.alert(text);
      resolve();
    }
  });
}

function confirmBox(text) {
  return new Promise((resolve) => {
    if (tg?.showConfirm && tg.isVersionAtLeast?.("6.2")) tg.showConfirm(text, resolve);
    else resolve(window.confirm(text));
  });
}

function openLink(url) {
  if (!url) return;
  if (tg?.openLink) tg.openLink(url);
  else window.open(url, "_blank", "noopener");
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((v) => v.toString(16).padStart(2, "0")).join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

function errorText(e) {
  if (e instanceof ApiError && e.status === 401) return t("errorAuth");
  return t("errorGeneric");
}

// Per-device list of recently added foods for one-tap repeat. Browser storage can be missing
// (private mode, cleared data): the app works without it.
function loadRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function rememberRecent(entry) {
  try {
    const item = {
      name: entry.name, grams: entry.grams, kcal100: entry.kcal100, protein100: entry.protein100,
      fat100: entry.fat100, carbs100: entry.carbs100, barcode: entry.barcode, allergens: entry.allergens,
    };
    const list = [item, ...loadRecent().filter((r) => r.name !== item.name)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Not critical.
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  const top = state.overlays.at(-1);
  if (tg?.BackButton) {
    if (top) tg.BackButton.show();
    else tg.BackButton.hide();
  }
  root.replaceChildren();
  if (top) root.append(renderOverlay(top));
  else root.append(renderTabs());
}

function push(overlay) {
  state.overlays.push(overlay);
  render();
  window.scrollTo(0, 0);
}

function pop() {
  state.overlays.pop();
  render();
}

function renderMessage(text, action) {
  return h("div", { class: "center" }, h("p", {}, text), action);
}

function renderOverlay(o) {
  switch (o.kind) {
    case "add": return renderAdd(o);
    case "manual": return renderManual(o);
    case "barcode": return renderBarcode(o);
    case "photo": return renderPhoto(o);
    case "profileForm": return renderProfileForm(o);
  }
  return h("div");
}

function renderTabs() {
  const tabs = [
    ["diary", t("tabDiary")],
    ["history", t("tabHistory")],
    ["plans", t("tabPlans")],
    ["profile", t("tabProfile")],
  ];
  const body = {
    diary: renderDiary,
    history: renderHistory,
    plans: renderPlans,
    profile: renderProfile,
  }[state.tab]();
  return h(
    "div",
    { class: "tabs-layout" },
    h("main", { class: "page" }, body),
    h(
      "nav",
      { class: "tabbar" },
      tabs.map(([id, label]) =>
        h("button", {
          class: id === state.tab ? "tab active" : "tab",
          onclick: () => {
            state.tab = id;
            haptic("light");
            render();
          },
        }, label)
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Onboarding: consent, then profile
// ---------------------------------------------------------------------------

function renderConsent() {
  let health = false;
  let terms = false;
  const button = h("button", { class: "primary", disabled: true }, t("consentContinue"));
  const update = () => (button.disabled = !(health && terms));
  const link = (label, url) =>
    url ? h("a", { href: "#", onclick: (e) => (e.preventDefault(), openLink(url)) }, label) : label;
  const termsLine = t("consentTerms").split(/(\{terms\}|\{privacy\})/).map((part) =>
    part === "{terms}"
      ? link(t("termsLink"), legalUrl("terms", lang()))
      : part === "{privacy}"
      ? link(t("privacyLink"), legalUrl("privacy", lang()))
      : part
  );
  button.onclick = () => {
    state.consented = true;
    state.overlays = [{ kind: "profileForm", onboarding: true }];
    render();
  };
  root.replaceChildren(
    h(
      "main",
      { class: "page" },
      h("h1", {}, t("welcomeTitle")),
      h("p", {}, t("welcomeText")),
      h("h2", {}, t("safetyTitle")),
      h("p", { class: "notice" }, t("safetyText")),
      h("label", { class: "check" }, h("input", { type: "checkbox", onchange: (e) => ((health = e.target.checked), update()) }), h("span", {}, t("consentHealth"))),
      h("label", { class: "check" }, h("input", { type: "checkbox", onchange: (e) => ((terms = e.target.checked), update()) }), h("span", {}, termsLine)),
      button,
    ),
  );
}

function field(label, input, hint) {
  return h("label", { class: "field" }, h("span", { class: "label" }, label), input, hint ? h("span", { class: "hint" }, hint) : null);
}

function select(name, options, value) {
  return h("select", { name }, options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)));
}

/**
 * Number field that accepts both "81.5" and "81,5": type=number rejects the comma that Russian and
 * German keyboards produce. The range is checked by readNumber().
 */
function numberInput(name, value, min, max, decimal = true) {
  return h("input", {
    name, type: "text", inputMode: decimal ? "decimal" : "numeric", autocomplete: "off",
    value: value == null || value === "" ? "" : String(value), "data-min": min, "data-max": max, required: true,
  });
}

/** Value of a numberInput, or NaN when it is empty, not a number or out of range (and marks it). */
function readNumber(input) {
  const raw = input.value.trim().replace(",", ".");
  const v = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  const ok = v >= Number(input.dataset.min) && v <= Number(input.dataset.max);
  input.classList.toggle("invalid", !ok);
  return ok ? v : NaN;
}

function renderProfileForm(o) {
  const p = state.profile?.onboarded ? state.profile : {};
  const chosen = new Set(p.allergens ?? []);
  const form = h("form", { class: "form", novalidate: true });
  const error = h("p", { class: "error", hidden: true }, t("fieldInvalid"));
  const languageSelect = select("language", LANGS.map((l) => [l, { en: "English", de: "Deutsch", ru: "Русский" }[l]]), lang());

  form.append(
    field(t("name"), h("input", { name: "name", value: p.name ?? tg?.initDataUnsafe?.user?.first_name ?? "", maxLength: 40, required: true })),
    field(t("sex"), select("sex", [["Female", t("sexFemale")], ["Male", t("sexMale")]], p.sex ?? "Female")),
    h("div", { class: "row3" },
      field(t("age"), numberInput("age", p.ageYears, 13, 100, false)),
      field(t("height"), numberInput("height", p.heightCm, 120, 230)),
      field(t("weight"), numberInput("weight", p.weightKg, 30, 300)),
    ),
    field(t("activity"), select("activity", ACTIVITIES.map((a) => [a, t("activity" + a)]), p.activity ?? "Light")),
    field(t("goal"), select("goal", GOALS.map((g) => [g, t("goal" + g)]), p.goal ?? "Maintain")),
    h("h3", {}, t("allergiesTitle")),
    h("p", { class: "hint" }, t("allergiesHint")),
    h("div", { class: "chips" },
      ALLERGENS.map((a) =>
        h("label", { class: "chip" },
          h("input", { type: "checkbox", checked: chosen.has(a), onchange: (e) => (e.target.checked ? chosen.add(a) : chosen.delete(a)) }),
          h("span", {}, allergenName(a)))
      )),
    field(t("language"), languageSelect),
    h("p", { class: "notice small" }, t("disclaimer")),
    error,
    h("button", { class: "primary", type: "submit" }, t("save")),
  );

  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const n = (k) => readNumber(form.elements[k]);
    const profile = {
      name: String(f.get("name")).trim(),
      sex: f.get("sex"),
      ageYears: Math.round(n("age")),
      heightCm: n("height"),
      weightKg: n("weight"),
      activity: f.get("activity"),
      goal: f.get("goal"),
      allergens: [...chosen],
      acceptedTermsVersion: o.onboarding ? TERMS_VERSION : (state.profile.acceptedTermsVersion ?? TERMS_VERSION),
      language: f.get("language"),
    };
    form.elements.name.classList.toggle("invalid", !profile.name);
    const bad = !profile.name || [profile.ageYears, profile.heightCm, profile.weightKg].some(Number.isNaN);
    error.hidden = !bad;
    if (bad) return haptic("error");
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true;
    try {
      const { profile: saved } = await api.saveProfile(profile);
      state.profile = saved;
      setLang(saved.language);
      haptic("success");
      state.overlays = [];
      await loadDay();
    } catch (err) {
      submit.disabled = false;
      await alertBox(errorText(err));
    }
  };

  return h("main", { class: "page" }, h("h1", {}, o.onboarding ? t("profileTitle") : t("profileEdit")), form);
}

// ---------------------------------------------------------------------------
// Diary
// ---------------------------------------------------------------------------

async function loadDay() {
  const [{ entries }, me] = await Promise.all([api.entries(state.day), api.me(state.day)]);
  state.entries = entries;
  state.profile = me.profile;
  state.tiers = me.tiers;
  state.scansUsed = me.scansUsed;
  render();
}

function ring(eaten, target) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const share = target > 0 ? Math.min(eaten / target, 1) : 0;
  const over = eaten > target;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 120 120");
  svg.setAttribute("class", "ring");
  for (const [cls, len] of [["track", c], [over ? "value over" : "value", c * share]]) {
    const circle = document.createElementNS(ns, "circle");
    circle.setAttribute("cx", "60");
    circle.setAttribute("cy", "60");
    circle.setAttribute("r", String(r));
    circle.setAttribute("class", cls);
    circle.setAttribute("stroke-dasharray", `${len} ${c}`);
    svg.append(circle);
  }
  const left = target - eaten;
  return h("div", { class: "ring-wrap" }, svg,
    h("div", { class: "ring-text" },
      h("strong", {}, round(Math.abs(left))),
      h("span", {}, `${t("kcal")} ${left >= 0 ? t("left") : t("over")}`)));
}

function macroBar(label, eaten, target, cls) {
  const share = target > 0 ? Math.min(eaten / target, 1) : 0;
  return h("div", { class: "macro" },
    h("div", { class: "macro-head" }, h("span", {}, label), h("span", {}, `${round(eaten)} / ${round(target)} ${t("g")}`)),
    h("div", { class: "bar" }, h("div", { class: `fill ${cls}`, style: `width:${share * 100}%` })));
}

function dayLabel(day) {
  const today = localDay();
  if (day === today) return t("today");
  if (day === shiftDay(today, -1)) return t("yesterday");
  const [y, m, d] = day.split("-").map(Number);
  return formatDate(new Date(y, m - 1, d), { weekday: "short", day: "numeric", month: "long" });
}

async function changeDay(delta) {
  const next = shiftDay(state.day, delta);
  if (next > localDay()) return;
  state.day = next;
  state.entries = [];
  render();
  try {
    await loadDay();
  } catch (e) {
    await alertBox(errorText(e));
  }
}

function renderDiary() {
  const target = dailyTarget(state.profile);
  const eaten = sum(state.entries);
  const isToday = state.day === localDay();
  return [
    h("div", { class: "daynav" },
      h("button", { class: "icon", "aria-label": "previous day", onclick: () => changeDay(-1) }, "‹"),
      h("strong", {}, dayLabel(state.day)),
      h("button", { class: "icon", "aria-label": "next day", disabled: isToday, onclick: () => changeDay(1) }, "›")),
    h("section", { class: "card summary" },
      ring(eaten.kcal, target.kcal),
      h("div", { class: "summary-side" },
        h("div", {}, h("strong", {}, round(eaten.kcal)), ` ${t("eaten")}`),
        h("div", { class: "muted" }, `${round(target.kcal)} ${t("target")}`),
        macroBar(t("protein"), eaten.protein, target.protein, "protein"),
        macroBar(t("fat"), eaten.fat, target.fat, "fat"),
        macroBar(t("carbs"), eaten.carbs, target.carbs, "carbs"))),
    MEALS.map((meal) => renderMeal(meal)),
  ];
}

function renderMeal(meal) {
  const items = state.entries.filter((e) => e.mealType === meal);
  const total = sum(items);
  return h("section", { class: "card meal" },
    h("div", { class: "meal-head" },
      h("strong", {}, t("meal" + meal)),
      h("span", { class: "muted" }, items.length ? `${round(total.kcal)} ${t("kcal")}` : ""),
      h("button", { class: "add", "aria-label": t("add"), onclick: () => push({ kind: "add", meal }) }, "+")),
    items.length
      ? h("ul", { class: "entries" }, items.map(renderEntry))
      : h("p", { class: "muted small" }, t("emptyMeal")));
}

function renderEntry(e) {
  const n = entryTotals(e);
  const warn = e.allergens.filter((a) => state.profile.allergens.includes(a));
  return h("li", { class: "entry" },
    h("div", { class: "entry-main" },
      h("span", {}, warn.length ? "⚠️ " : "", e.name),
      h("span", { class: "muted small" }, `${round(e.grams)} ${t("g")} · ${t("macroShort", { p: round(n.protein), f: round(n.fat), c: round(n.carbs) })}`)),
    h("span", { class: "kcal" }, round(n.kcal)),
    h("button", {
      class: "icon danger",
      "aria-label": t("delete"),
      onclick: async () => {
        if (!(await confirmBox(`${t("delete")}: ${e.name}?`))) return;
        try {
          await api.deleteEntry(e.id);
          state.entries = state.entries.filter((x) => x.id !== e.id);
          haptic("light");
          render();
        } catch (err) {
          await alertBox(errorText(err));
        }
      },
    }, "×"));
}

// ---------------------------------------------------------------------------
// Adding food
// ---------------------------------------------------------------------------

/** Names of the user's own allergens that this food has or may have. */
function userAllergenHits(declared, traces, likely) {
  const mine = new Set(state.profile.allergens);
  const pick = (list) => (list ?? []).filter((a) => mine.has(a));
  return { contains: pick(declared), mayContain: pick(traces), likely: pick(likely) };
}

async function saveEntry(draft, meal) {
  const hits = draft.allergens.filter((a) => state.profile.allergens.includes(a));
  if (hits.length && !(await confirmBox(t("allergenConfirm", { list: hits.map(allergenName).join(", ") })))) return false;
  const entry = {
    id: uuid(),
    eatenOn: state.day,
    mealType: meal,
    name: draft.name,
    grams: draft.grams,
    kcal100: draft.kcal100,
    protein100: draft.protein100,
    fat100: draft.fat100,
    carbs100: draft.carbs100,
    source: draft.source,
    barcode: draft.barcode ?? null,
    allergens: draft.allergens,
  };
  const { entry: saved } = await api.saveEntry(entry);
  state.entries.push(saved);
  rememberRecent(saved);
  return true;
}

function renderAdd(o) {
  const recent = loadRecent();
  const paid = state.profile.tier !== "free";
  return h("main", { class: "page" },
    h("h1", {}, t("addTitle", { meal: t("meal" + o.meal) })),
    h("div", { class: "actions" },
      h("button", { class: "big", onclick: () => push({ kind: "photo", meal: o.meal }) }, "📷 ", t("addPhoto"), paid ? null : h("span", { class: "badge" }, "⭐")),
      h("button", { class: "big", onclick: () => push({ kind: "barcode", meal: o.meal }) }, "▥ ", t("addBarcode")),
      h("button", { class: "big", onclick: () => push({ kind: "manual", meal: o.meal }) }, "✎ ", t("addManual"))),
    recent.length
      ? [
        h("h2", {}, t("addRecent")),
        h("ul", { class: "entries card" }, recent.map((r) =>
          h("li", { class: "entry clickable", onclick: () => push({ kind: "manual", meal: o.meal, draft: { ...r, source: "Repeat" } }) },
            h("div", { class: "entry-main" },
              h("span", {}, r.name),
              h("span", { class: "muted small" }, `${round(r.grams)} ${t("g")}`)),
            h("span", { class: "kcal" }, round(r.kcal100 * r.grams / 100))))),
      ]
      : null);
}

function renderManual(o) {
  const d = o.draft ?? {};
  const form = h("form", { class: "form", novalidate: true });
  const num = (name, value, min, max) => numberInput(name, value == null ? null : one(value), min, max);

  const report = o.report ? renderAllergenReport(o.report) : null;
  const error = h("p", { class: "error", hidden: true }, t("fieldInvalid"));
  form.append(
    field(t("foodName"), h("input", { name: "name", value: d.name ?? "", maxLength: 80, required: true })),
    field(t("grams"), num("grams", d.grams ?? 100, 0.1, 5000)),
    h("h3", {}, t("per100")),
    h("div", { class: "row2" },
      field(t("kcal"), num("kcal", d.kcal100, 0, 900)),
      field(t("protein") + `, ${t("g")}`, num("protein", d.protein100 ?? 0, 0, 100)),
      field(t("fat") + `, ${t("g")}`, num("fat", d.fat100 ?? 0, 0, 100)),
      field(t("carbs") + `, ${t("g")}`, num("carbs", d.carbs100 ?? 0, 0, 100))),
    o.noKcal ? h("p", { class: "notice small" }, t("barcodeNoKcal")) : null,
    report,
    d.barcode ? h("p", { class: "muted small" }, t("barcodeSource")) : null,
    error,
    h("button", { class: "primary", type: "submit" }, t("add")),
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const n = (k) => readNumber(form.elements[k]);
    const draft = {
      name: String(f.get("name")).trim(),
      grams: n("grams"),
      kcal100: n("kcal"),
      protein100: n("protein"),
      fat100: n("fat"),
      carbs100: n("carbs"),
      source: d.source ?? "Manual",
      barcode: d.barcode ?? null,
      allergens: d.allergens ?? [],
    };
    form.elements.name.classList.toggle("invalid", !draft.name);
    const numbers = [draft.grams, draft.kcal100, draft.protein100, draft.fat100, draft.carbs100];
    const bad = !draft.name || numbers.some(Number.isNaN) || draft.protein100 + draft.fat100 + draft.carbs100 > 100.5;
    error.hidden = !bad;
    if (bad) return haptic("error");
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true;
    try {
      if (await saveEntry(draft, o.meal)) {
        haptic("success");
        state.overlays = [];
        render();
      } else submit.disabled = false;
    } catch (err) {
      submit.disabled = false;
      await alertBox(errorText(err));
    }
  };
  return h("main", { class: "page" }, h("h1", {}, t("addTitle", { meal: t("meal" + o.meal) })), form);
}

function renderAllergenReport(r) {
  if (!state.profile.allergens.length) return null;
  const lines = [];
  if (r.contains.length) lines.push(h("p", { class: "danger-text" }, t("allergenContains", { list: r.contains.map(allergenName).join(", ") })));
  if (r.mayContain.length) lines.push(h("p", { class: "warn-text" }, t("allergenMayContain", { list: r.mayContain.map(allergenName).join(", ") })));
  if (r.likely.length) lines.push(h("p", { class: "warn-text" }, t("allergenSuspected", { list: r.likely.map(allergenName).join(", ") })));
  if (!lines.length) lines.push(h("p", { class: "muted small" }, r.unknown ? t("allergenNoData") : t("allergenNoneFound")));
  return h("div", { class: "allergens" }, lines);
}

function renderBarcode(o) {
  const input = h("input", { type: "text", inputMode: "numeric", pattern: "[0-9]*", maxLength: 14, placeholder: "4006381333931", value: o.code ?? "" });
  const status = h("p", { class: "muted small" });
  const video = h("video", { class: "scanner", playsInline: true, muted: true, hidden: true });

  async function find(code) {
    code = code.replace(/\D/g, "");
    if (!/^[0-9]{6,14}$/.test(code)) {
      input.classList.add("invalid");
      return haptic("error");
    }
    status.textContent = t("loading");
    try {
      const product = await lookupBarcode(code, lang());
      if (!product) {
        status.textContent = t("barcodeNotFound");
        return void (await alertBox(t("barcodeNotFound")));
      }
      const hits = userAllergenHits(product.declared, product.traces, []);
      // Everything the database names is kept on the entry: the diary warns on any of them later.
      const allergens = [...new Set([...(product.declared ?? []), ...product.traces])];
      stopCamera();
      state.overlays.pop();
      push({
        kind: "manual",
        meal: o.meal,
        draft: { ...product, grams: 100, source: "Barcode", allergens },
        noKcal: product.kcal100 == null,
        report: { ...hits, unknown: product.declared === null },
      });
    } catch {
      status.textContent = t("barcodeUnavailable");
    }
  }

  let stream = null;
  let timer = null;
  function stopCamera() {
    clearInterval(timer);
    stream?.getTracks().forEach((tr) => tr.stop());
    stream = null;
  }
  o.cleanup = stopCamera;

  async function scan() {
    if (!("BarcodeDetector" in window) || !navigator.mediaDevices?.getUserMedia) {
      return void (await alertBox(t("barcodeCameraUnsupported")));
    }
    try {
      const detector = new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] });
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      video.srcObject = stream;
      video.hidden = false;
      await video.play();
      timer = setInterval(async () => {
        const codes = await detector.detect(video).catch(() => []);
        if (codes.length) {
          haptic("success");
          stopCamera();
          video.hidden = true;
          input.value = codes[0].rawValue;
          find(codes[0].rawValue);
        }
      }, 300);
    } catch {
      stopCamera();
      video.hidden = true;
      await alertBox(t("barcodeCameraUnsupported"));
    }
  }

  return h("main", { class: "page" },
    h("h1", {}, t("addBarcode")),
    h("button", { class: "big", onclick: scan }, "📷 ", t("barcodeScan")),
    video,
    field(t("barcodeNumber"), input),
    h("button", { class: "primary", onclick: () => find(input.value) }, t("barcodeFind")),
    status,
    h("p", { class: "muted small" }, t("barcodeSource")));
}

// ---------------------------------------------------------------------------
// Photo recognition
// ---------------------------------------------------------------------------

/** Downscales the photo on the phone (~1000 px long side) and returns base64 JPEG. */
async function prepareImage(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => createImageBitmap(file));
  const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function scansLeft() {
  const quota = state.tiers[state.profile.tier]?.scans_per_day ?? 0;
  return Math.max(quota - state.scansUsed, 0);
}

function renderPhoto(o) {
  if (state.profile.tier === "free") {
    return h("main", { class: "page" },
      h("h1", {}, t("addPhoto")),
      h("p", {}, t("photoNoPlan")),
      h("button", { class: "primary", onclick: () => ((state.overlays = []), (state.tab = "plans"), render()) }, t("plansTitle")));
  }
  if (o.result) return renderPhotoReview(o);

  const card = h("input", { type: "checkbox" });
  const fileInput = h("input", { type: "file", accept: "image/*", capture: "environment", hidden: true });
  const status = h("p", { class: "muted" }, t("photoLeft", { n: scansLeft() }));
  const pickButton = h("button", { class: "primary", disabled: scansLeft() === 0, onclick: () => fileInput.click() }, "📷 ", t("photoPick"));

  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    pickButton.disabled = true;
    status.textContent = t("photoWorking");
    try {
      const image = await prepareImage(file);
      const result = await api.scan({ image, reference: card.checked ? "card" : "none", locale: lang(), day: localDay() });
      state.scansUsed += 1;
      if (!result.isFood || !result.items.length) {
        status.textContent = t("photoNotFood");
        pickButton.disabled = scansLeft() === 0;
        return haptic("warning");
      }
      haptic("success");
      o.result = result;
      o.grams = result.items.map((i) => i.grams);
      o.keep = result.items.map(() => true);
      render();
    } catch (e) {
      pickButton.disabled = false;
      const code = e instanceof ApiError ? e.code : "";
      status.textContent = code === "disabled" || code === "global_cap"
        ? t("photoDisabled")
        : e instanceof ApiError && e.status === 402
        ? t("photoQuotaUsed")
        : errorText(e);
      if (e instanceof ApiError && e.status === 402) pickButton.disabled = true;
    }
  };

  return h("main", { class: "page" },
    h("h1", {}, t("addPhoto")),
    h("label", { class: "check" }, card, h("span", {}, t("photoCard"))),
    pickButton,
    fileInput,
    status,
    h("p", { class: "notice small" }, t("safetyText")));
}

function renderPhotoReview(o) {
  const r = o.result;
  const list = h("ul", { class: "entries card" }, r.items.map((item, i) => {
    const grams = h("input", {
      type: "number", inputMode: "decimal", min: 1, max: 2000, value: round(o.grams[i]), class: "grams",
      oninput: (e) => ((o.grams[i] = Number(e.target.value)), updateKcal()),
    });
    const kcal = h("span", { class: "kcal" });
    const updateKcal = () => (kcal.textContent = round(item.kcal * (o.grams[i] || 0) / 100));
    updateKcal();
    const hits = userAllergenHits([], [], item.allergens);
    return h("li", { class: "entry" },
      h("input", { type: "checkbox", checked: o.keep[i], onchange: (e) => (o.keep[i] = e.target.checked) }),
      h("div", { class: "entry-main" },
        h("span", {}, hits.likely.length ? "⚠️ " : "", item.label),
        h("span", { class: "muted small" },
          [item.estimated ? t("photoEstimated") : null, item.confidence === "low" ? t("confidenceLow") : null].filter(Boolean).join(" · ")),
        hits.likely.length ? h("span", { class: "warn-text small" }, t("allergenSuspected", { list: hits.likely.map(allergenName).join(", ") })) : null),
      grams,
      kcal);
  }));

  const save = h("button", { class: "primary" }, t("photoAddAll"));
  save.onclick = async () => {
    save.disabled = true;
    try {
      for (const [i, item] of r.items.entries()) {
        if (!o.keep[i] || !(o.grams[i] > 0)) continue;
        const ok = await saveEntry({
          name: item.label,
          grams: Math.min(o.grams[i], 5000),
          kcal100: Math.min(item.kcal, 900),
          protein100: item.protein,
          fat100: item.fat,
          carbs100: item.carbs,
          source: "Photo",
          allergens: item.allergens,
        }, o.meal);
        if (!ok) continue;
      }
      haptic("success");
      state.overlays = [];
      render();
    } catch (e) {
      save.disabled = false;
      await alertBox(errorText(e));
    }
  };

  return h("main", { class: "page" },
    h("h1", {}, t("photoReview")),
    r.needsSidePhoto ? h("p", { class: "notice small" }, t("photoSide")) : null,
    list,
    save,
    h("p", { class: "muted small" }, t("photoLeft", { n: scansLeft() })));
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function renderHistory() {
  const box = h("div", {}, h("p", { class: "muted" }, t("loading")));
  const to = localDay();
  const from = shiftDay(to, -29);
  api.history(from, to).then(({ days }) => {
    const target = dailyTarget(state.profile).kcal;
    if (!days.length) return box.replaceChildren(h("p", { class: "muted" }, t("historyEmpty")));
    const byDay = new Map(days.map((d) => [d.day, d]));
    const max = Math.max(target * 1.3, ...days.map((d) => d.kcal));
    const rows = [];
    for (let i = 0; i < 30; i++) {
      const day = shiftDay(to, -i);
      const d = byDay.get(day);
      const kcal = d?.kcal ?? 0;
      rows.push(h("li", { class: "hist" },
        h("span", { class: "hist-day" }, dayLabel(day)),
        h("div", { class: "bar" },
          h("div", { class: kcal > target * 1.1 ? "fill over" : "fill energy", style: `width:${(kcal / max) * 100}%` }),
          h("div", { class: "target-mark", style: `left:${(target / max) * 100}%` })),
        h("span", { class: "hist-kcal" }, kcal ? round(kcal) : "—")));
    }
    const avg = days.reduce((a, d) => a + d.kcal, 0) / days.length;
    box.replaceChildren(h("p", { class: "muted" }, t("historyAverage", { kcal: round(avg) })), h("ul", { class: "card history" }, rows));
  }).catch((e) => box.replaceChildren(h("p", { class: "error" }, errorText(e))));
  return [h("h1", {}, t("historyTitle")), box];
}

// ---------------------------------------------------------------------------
// Plans (Telegram Stars)
// ---------------------------------------------------------------------------

async function buy(tier, button) {
  button.disabled = true;
  try {
    const { link } = await api.invoice(tier);
    const status = await new Promise((resolve) => {
      if (tg?.openInvoice) tg.openInvoice(link, resolve);
      else {
        openLink(link);
        resolve("pending");
      }
    });
    if (status === "paid") {
      haptic("success");
      // The bot grants the days when Telegram confirms the payment; that can take a moment.
      for (let i = 0; i < 5; i++) {
        await loadDay();
        if (state.profile.tier !== "free") break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      await alertBox(t("plansThanks"));
    } else if (status === "failed") {
      haptic("error");
      await alertBox(t("plansFailed"));
    }
  } catch (e) {
    await alertBox(errorText(e));
  } finally {
    button.disabled = false;
    render();
  }
}

function renderPlans() {
  const p = state.profile;
  const active = p.tier !== "free" && p.tierExpiresAt;
  return [
    h("h1", {}, t("plansTitle")),
    h("p", {}, t("plansText")),
    active ? h("p", { class: "notice ok" }, t("plansActive", { tier: TIER_NAMES[p.tier], date: formatDate(p.tierExpiresAt) })) : null,
    active ? h("p", { class: "muted" }, t("photoLeft", { n: scansLeft() })) : null,
    TIERS.filter((id) => state.tiers[id]).map((id) => {
      const c = state.tiers[id];
      const button = h("button", { class: id === p.tier ? "primary" : "secondary" },
        id === p.tier ? t("plansExtend", { stars: c.stars }) : t("plansBuy", { stars: c.stars }));
      button.onclick = () => buy(id, button);
      return h("section", { class: id === p.tier ? "card plan current" : "card plan" },
        h("div", { class: "plan-head" }, h("strong", {}, TIER_NAMES[id]), h("span", {}, t("plansPerDay", { n: c.scans_per_day }))),
        button);
    }),
    h("p", { class: "muted small" }, t("plansNote")),
    h("p", { class: "muted small" }, t("plansTerms").split(/(\{terms\})/).map((part) =>
      part === "{terms}"
        ? h("a", { href: "#", onclick: (e) => (e.preventDefault(), openLink(legalUrl("terms", lang()))) }, t("termsLink"))
        : part
    )),
  ];
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function renderProfile() {
  const p = state.profile;
  const target = dailyTarget(p);
  return [
    h("h1", {}, p.name),
    h("section", { class: "card" },
      h("h3", {}, t("dailyTarget")),
      h("p", {}, h("strong", {}, `${round(target.kcal)} ${t("kcal")}`)),
      h("p", { class: "muted" },
        `${t("protein")} ${round(target.protein)} ${t("g")} · ${t("fat")} ${round(target.fat)} ${t("g")} · ${t("carbs")} ${round(target.carbs)} ${t("g")}`),
      h("p", { class: "muted small" }, t("disclaimer"))),
    h("section", { class: "card" },
      h("p", {}, `${t("sex" + p.sex)} · ${p.ageYears} · ${one(p.heightCm)} ${t("cm")} · ${one(p.weightKg)} ${t("kg")}`),
      h("p", { class: "muted" }, `${t("activity" + p.activity)} · ${t("goal" + p.goal)}`),
      p.allergens.length ? h("p", { class: "muted" }, `${t("allergiesTitle")}: ${p.allergens.map(allergenName).join(", ")}`) : null,
      h("button", { class: "secondary", onclick: () => push({ kind: "profileForm" }) }, t("profileEdit"))),
    h("section", { class: "card" },
      h("h3", {}, t("legal")),
      [["terms", t("termsTitle")], ["privacy", t("privacyTitle")], ["impressum", "Impressum"]].map(([doc, label]) =>
        h("p", {}, h("a", { href: "#", onclick: (e) => (e.preventDefault(), openLink(legalUrl(doc, lang()))) }, label)))),
    h("button", {
      class: "danger-button",
      onclick: async () => {
        if (!(await confirmBox(t("deleteConfirm")))) return;
        try {
          await api.deleteMe();
          try {
            localStorage.removeItem(RECENT_KEY);
          } catch {
            // Nothing stored.
          }
          await alertBox(t("deleted"));
          tg?.close?.();
          state.profile = null;
          renderConsent();
        } catch (e) {
          await alertBox(errorText(e));
        }
      },
    }, t("deleteData")),
  ];
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function start() {
  tg?.ready?.();
  tg?.expand?.();
  setLang(langOf(tg?.initDataUnsafe?.user?.language_code ?? navigator.language));
  tg?.BackButton?.onClick(() => {
    const top = state.overlays.at(-1);
    top?.cleanup?.();
    if (top?.onboarding) {
      // Back from the first profile form leads to the consent screen, not to an empty diary.
      state.overlays = [];
      tg.BackButton.hide();
      renderConsent();
      return;
    }
    pop();
  });

  let initData = tg?.initData ?? "";
  if (!initData && ["localhost", "127.0.0.1"].includes(location.hostname)) {
    // Local preview in a normal browser: fake backend, nothing leaves the machine.
    const { mockFetch, MOCK_INIT_DATA } = await import("./mock.js");
    api = createApi(MOCK_INIT_DATA, mockFetch);
  } else if (!initData) {
    root.replaceChildren(renderMessage(t("errorAuth")));
    return;
  } else {
    api = createApi(initData);
  }

  root.replaceChildren(renderMessage(t("loading")));
  try {
    const me = await api.me(state.day);
    state.profile = me.profile;
    state.tiers = me.tiers;
    state.scansUsed = me.scansUsed;
    if (me.profile.language) setLang(me.profile.language);
    if (!me.profile.onboarded || (me.profile.acceptedTermsVersion ?? 0) < TERMS_VERSION) {
      renderConsent();
      return;
    }
    await loadDay();
  } catch (e) {
    root.replaceChildren(renderMessage(errorText(e), h("button", { class: "primary", onclick: start }, t("retry"))));
  }
}

start();
