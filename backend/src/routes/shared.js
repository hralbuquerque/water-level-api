// Helpers shared by more than one route module.

/**
 * Response fields every readings endpoint includes. Every reading also carries
 * datum/units, but these make the basis explicit at the top level; retrievedAt
 * records when NOAA's preliminary/verified flags were observed, which matters
 * for settlement.
 */
export const meta = (resolution) => ({
  resolution,
  datum: 'MLLW',
  units: 'english',
  timeZone: 'GMT',
  retrievedAt: new Date().toISOString(),
});
