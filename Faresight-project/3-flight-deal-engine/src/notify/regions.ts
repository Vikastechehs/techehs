// Region of a destination airport, for alert filters. Mirrors GROUPS in src/routes.ts (which isn't exported).
export const REGION_DESTS: Record<string, string[]> = {
  seAsia:   ['BKK', 'HKT', 'KUL', 'SIN', 'DPS', 'SGN', 'HAN', 'CGK', 'MNL', 'DMK'],
  saGulf:   ['CMB', 'MLE', 'KTM', 'DXB', 'AUH', 'SHJ', 'DOH', 'MCT'],
  eastAsia: ['NRT', 'ICN', 'HKG', 'ALA', 'TAS', 'GYD', 'TBS'],
  europe:   ['LHR', 'CDG', 'AMS', 'FRA', 'MUC', 'FCO', 'MXP', 'BCN', 'IST', 'PRG', 'VIE'],
  longHaul: ['JFK', 'SFO', 'YYZ', 'SYD'],
};

/** 'seAsia' | 'saGulf' | 'eastAsia' | 'europe' | 'longHaul', or null for an unknown airport. */
export function regionOf(iata: string): string | null {
  for (const [region, dests] of Object.entries(REGION_DESTS)) if (dests.includes(iata)) return region;
  return null;
}
