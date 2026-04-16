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
export function parsePlayerInfo(infoArray: any[]): {
  name: string; position: string; mlbTeam: string; playerKey: string; jerseyNumber: string;
  status?: string; injuryNote?: string;
} {
  const status = extractField(infoArray, 'status') || '';
  const injuryNote = extractField(infoArray, 'injury_note') || '';
  return {
    name: extractField(infoArray, 'name')?.full || '',
    position: extractField(infoArray, 'display_position') || '',
    mlbTeam: extractField(infoArray, 'editorial_team_abbr') || '',
    playerKey: extractField(infoArray, 'player_key') || '',
    jerseyNumber: extractField(infoArray, 'uniform_number') || '',
    ...(status ? { status } : {}),
    ...(injuryNote ? { injuryNote } : {}),
  };
}

/**
 * Extract the players map from Yahoo's roster response object.
 * Yahoo returns roster as { "0": { players: {...} } }.
 */
export function extractPlayersMap(rosterObj: any): Record<string, any> {
  return rosterObj[0]?.players ?? rosterObj['0']?.players ?? {};
}

/**
 * Greedy lineup optimizer.
 *
 * Steps:
 *   1. Injured players that are IL-eligible → fill IL/IL+/NA slots.
 *   2. Remaining healthy players sorted by # of active-eligible positions ascending
 *      (most constrained first) → fill active slots in the order provided by slotCounts keys.
 *   3. Everyone still unassigned → BN.
 *
 * slotCounts: e.g. { C: 1, '1B': 1, OF: 3, SP: 2, RP: 3, BN: 5, IL: 2 }
 * ilSlots: defaults to ['IL', 'IL+', 'NA']
 */
export function buildOptimalLineup(
  players: Array<{ playerKey: string; eligiblePositions: string[]; isInjured: boolean }>,
  slotCounts: Record<string, number>,
  ilSlots: string[] = ['IL', 'IL+', 'NA']
): Array<{ playerKey: string; position: string }> {
  const assignments: Array<{ playerKey: string; position: string }> = [];
  const remaining: Record<string, number> = { ...slotCounts };
  const assigned = new Set<string>();

  const BN = 'BN';
  const activeSlots = Object.keys(remaining).filter((pos) => !ilSlots.includes(pos) && pos !== BN);

  // Step 1: IL-eligible injured players → IL slots
  for (const p of players) {
    if (!p.isInjured) continue;
    const ilSlot = ilSlots.find((il) => (remaining[il] ?? 0) > 0 && p.eligiblePositions.includes(il));
    if (ilSlot) {
      assignments.push({ playerKey: p.playerKey, position: ilSlot });
      remaining[ilSlot]!--;
      assigned.add(p.playerKey);
    }
  }

  // Step 2: Healthy players → active slots (most constrained first)
  const healthy = players
    .filter((p) => !p.isInjured && !assigned.has(p.playerKey))
    .sort((a, b) => {
      const aCount = a.eligiblePositions.filter((pos) => activeSlots.includes(pos)).length;
      const bCount = b.eligiblePositions.filter((pos) => activeSlots.includes(pos)).length;
      return aCount - bCount;
    });

  for (const p of healthy) {
    const slot = activeSlots.find((pos) => (remaining[pos] ?? 0) > 0 && p.eligiblePositions.includes(pos));
    if (slot) {
      assignments.push({ playerKey: p.playerKey, position: slot });
      remaining[slot]!--;
      assigned.add(p.playerKey);
    }
  }

  // Step 3: Everything else → BN
  for (const p of players) {
    if (!assigned.has(p.playerKey)) {
      assignments.push({ playerKey: p.playerKey, position: BN });
    }
  }

  return assignments;
}

/**
 * Rank teams within a single stat category.
 * higherIsBetter=true → highest value gets rank 1 (e.g. HR, R, K).
 * higherIsBetter=false → lowest value gets rank 1 (e.g. ERA, WHIP).
 * Teams with null/NaN values are sorted last and share the same rank.
 * Returns a new array sorted by rank ascending.
 */
export function computeCategoryRankings(
  teams: Array<{ teamKey: string; value: number | null }>,
  higherIsBetter: boolean
): Array<{ teamKey: string; value: number | null; rank: number }> {
  const valid = teams.filter((t) => t.value !== null && !isNaN(t.value as number));
  const invalid = teams.filter((t) => t.value === null || isNaN(t.value as number));

  valid.sort((a, b) =>
    higherIsBetter ? (b.value as number) - (a.value as number) : (a.value as number) - (b.value as number)
  );

  const ranked = valid.map((t, i) => ({ ...t, rank: i + 1 }));
  const lastRank = ranked.length + 1;
  const nullRanked = invalid.map((t) => ({ ...t, rank: lastRank }));

  return [...ranked, ...nullRanked];
}
