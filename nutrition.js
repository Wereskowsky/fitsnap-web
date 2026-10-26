// Daily targets, same math as android/.../domain/NutritionCalculator.kt (Mifflin–St Jeor).

const ACTIVITY_FACTOR = { Sedentary: 1.2, Light: 1.375, Moderate: 1.55, Active: 1.725, VeryActive: 1.9 };
const GOAL = {
  LoseWeight: { adjust: -0.15, proteinPerKg: 2.0 },
  Maintain: { adjust: 0, proteinPerKg: 1.6 },
  GainMuscle: { adjust: 0.10, proteinPerKg: 1.8 },
};
const FAT_SHARE = 0.30;
// Never suggest a target below these without a doctor in the loop.
const MIN_KCAL = { Female: 1200, Male: 1500 };

export function dailyTarget(p) {
  const bmr = 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.ageYears + (p.sex === "Male" ? 5 : -161);
  const goal = GOAL[p.goal];
  const kcal = Math.max(bmr * ACTIVITY_FACTOR[p.activity] * (1 + goal.adjust), MIN_KCAL[p.sex]);
  const protein = p.weightKg * goal.proteinPerKg;
  const fat = kcal * FAT_SHARE / 9;
  const carbs = Math.max(kcal - protein * 4 - fat * 9, 0) / 4;
  return { kcal, protein, fat, carbs };
}

/** Nutrients of one diary entry (values are stored per 100 g). */
export function entryTotals(e) {
  const k = e.grams / 100;
  return { kcal: e.kcal100 * k, protein: e.protein100 * k, fat: e.fat100 * k, carbs: e.carbs100 * k };
}

export function sum(entries) {
  return entries.map(entryTotals).reduce(
    (a, b) => ({ kcal: a.kcal + b.kcal, protein: a.protein + b.protein, fat: a.fat + b.fat, carbs: a.carbs + b.carbs }),
    { kcal: 0, protein: 0, fat: 0, carbs: 0 },
  );
}

/** Local calendar day as yyyy-mm-dd: the diary and the photo quota follow the user's own day. */
export function localDay(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function shiftDay(day, delta) {
  const [y, m, d] = day.split("-").map(Number);
  return localDay(new Date(y, m - 1, d + delta));
}
