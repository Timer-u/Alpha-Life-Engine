import type { LCHAllocation } from '../types/api';

import { calculateLCHRatios } from './lch-constants';

export { getAge } from './lch-constants';

export function calculateLCHAllocation(birthYear: number, birthMonth: number = 6, birthDay: number = 15): LCHAllocation {
  const { safeRatio, ambitionRatio, age } = calculateLCHRatios(birthYear, birthMonth, birthDay);
  return {
    safe_ratio: safeRatio,
    ambition_ratio: ambitionRatio,
    source: 'lch',
    age,
  };
}
