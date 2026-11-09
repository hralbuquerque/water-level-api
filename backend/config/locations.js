export const LOCATIONS = {
  nyc: {
    name: 'New York City',
    stations: ['8516945', '8518750', '8531680']
  },
  upper_bay: {
    name: 'Upper Bay',
    stations: ['1611400']
  }
};

export function getStationsForLocation(loc) {
  const key = Object.keys(LOCATIONS).find(k => k.toLowerCase() === String(loc).toLowerCase());
  return key ? LOCATIONS[key].stations : [];
}
