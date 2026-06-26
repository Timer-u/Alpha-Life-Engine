export const AMBITION_MIN = 0.20;
export const AMBITION_MAX = 0.85;

export function getAge(birthYear: number, birthMonth: number, birthDay: number, currentDate: Date = new Date()): number {
  let age = currentDate.getFullYear() - birthYear;
  const monthDiff = currentDate.getMonth() + 1 - birthMonth;
  if (monthDiff < 0 || (monthDiff === 0 && currentDate.getDate() < birthDay)) {
    age--;
  }
  return age;
}

export function calculateLCHRatios(birthYear: number, birthMonth: number, birthDay: number, currentDate?: Date): { safeRatio: number; ambitionRatio: number; age: number } {
  const age = getAge(birthYear, birthMonth, birthDay, currentDate);
  const ambitionRatio = Math.max(AMBITION_MIN, Math.min(AMBITION_MAX, Math.max(0, (100 - age) / 100)));
  const safeRatio = Number((1 - ambitionRatio).toFixed(4));

  return { safeRatio, ambitionRatio: Number(ambitionRatio.toFixed(4)), age };
}