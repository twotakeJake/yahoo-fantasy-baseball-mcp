/**
 * Normalize a player name for fuzzy matching.
 * Strips parentheticals like "(Batter)", removes accents, lowercases, strips non-alpha.
 */
export function normalizeName(name: string): string {
  return name
    .replace(/\(.*?\)/g, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .trim();
}

/**
 * Look up a player's age by name + jersey number.
 * If multiple players share a normalized name, jersey number breaks the tie.
 * Returns undefined if not found or ambiguous.
 */
export function lookupAge(
  ageMap: Map<string, { age: number; jersey: string }[]>,
  name: string,
  jerseyNumber: string
): number | undefined {
  const entries = ageMap.get(normalizeName(name));
  if (!entries || entries.length === 0) return undefined;
  if (entries.length === 1) return entries[0]!.age;
  const match = entries.find((e) => e.jersey === jerseyNumber);
  return match?.age;
}

/**
 * Pull a value out of Yahoo's array-of-single-key-objects format.
 * Yahoo returns player info as: [{ player_key: '...' }, { name: {...} }, ...]
 */
export function extractField(arr: any[], key: string): any {
  for (const item of arr) {
    if (item && typeof item === 'object' && !Array.isArray(item) && key in item) {
      return item[key];
    }
  }
  return null;
}

/**
 * Parse a Yahoo player info array into a flat object.
 */
export function parsePlayerInfo(infoArray: any[]) {
  return {
    name: extractField(infoArray, 'name')?.full || '',
    position: extractField(infoArray, 'display_position') || '',
    mlbTeam: extractField(infoArray, 'editorial_team_abbr') || '',
    playerKey: extractField(infoArray, 'player_key') || '',
    jerseyNumber: extractField(infoArray, 'uniform_number') || '',
  };
}

/**
 * Extract the players map from Yahoo's roster response object.
 * Yahoo returns roster as { "0": { players: {...} } }.
 */
export function extractPlayersMap(rosterObj: any): Record<string, any> {
  return rosterObj[0]?.players ?? rosterObj['0']?.players ?? {};
}
