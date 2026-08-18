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

/**
 * Standings tier for a given rank, calibrated for a 10-team league:
 * ranks 1-4 = "top", 5-7 = "mid", 8-10 = "bottom".
 */
export function rankBand(rank: number): 'top' | 'mid' | 'bottom' {
  if (rank <= 4) return 'top';
  if (rank <= 7) return 'mid';
  return 'bottom';
}

/**
 * Classify a matchup by both teams' standings ranks into one of six
 * order-independent competitive tiers (e.g. top_vs_top, top_vs_bottom).
 * A week of top_vs_top matchups compresses the standings ("chaos week");
 * a week of top_vs_bottom matchups lets the strong teams pad their records.
 * Returns 'unknown' if either rank is missing/invalid.
 */
export function competitiveTier(
  rankA: number | null | undefined,
  rankB: number | null | undefined
):
  | 'top_vs_top'
  | 'top_vs_mid'
  | 'top_vs_bottom'
  | 'mid_vs_mid'
  | 'mid_vs_bottom'
  | 'bottom_vs_bottom'
  | 'unknown' {
  if (
    rankA == null || rankB == null ||
    !Number.isFinite(rankA) || !Number.isFinite(rankB)
  ) {
    return 'unknown';
  }
  // Order the two bands so the label is deterministic regardless of home/away.
  const order = { top: 0, mid: 1, bottom: 2 } as const;
  const bands = [rankBand(rankA), rankBand(rankB)].sort(
    (x, y) => order[x] - order[y]
  );
  return `${bands[0]}_vs_${bands[1]}` as
    | 'top_vs_top'
    | 'top_vs_mid'
    | 'top_vs_bottom'
    | 'mid_vs_mid'
    | 'mid_vs_bottom'
    | 'bottom_vs_bottom';
}

/**
 * Map Yahoo's scoreboard matchup status (preevent/midevent/postevent) to the
 * schedule vocabulary. Falls back to comparing the week against the current
 * week when Yahoo's status string is missing or unrecognized.
 */
export function mapMatchupStatus(
  yahooStatus: string | null | undefined,
  week: number,
  currentWeek: number
): 'completed' | 'in_progress' | 'upcoming' {
  switch (yahooStatus) {
    case 'postevent':
      return 'completed';
    case 'midevent':
      return 'in_progress';
    case 'preevent':
      return 'upcoming';
  }
  if (week < currentWeek) return 'completed';
  if (week === currentWeek) return 'in_progress';
  return 'upcoming';
}

/**
 * Build the default list of weeks for get_schedule when none are supplied:
 * remaining regular-season weeks (currentWeek..regularSeasonEndWeek), or the
 * full regular season when includeCompleted is set. Always sorted ascending
 * and clamped to at least one week.
 */
export function defaultScheduleWeeks(
  currentWeek: number,
  startWeek: number,
  regularSeasonEndWeek: number,
  includeCompleted: boolean
): number[] {
  const from = includeCompleted ? startWeek : currentWeek;
  const weeks: number[] = [];
  for (let w = from; w <= regularSeasonEndWeek; w++) weeks.push(w);
  // If the regular season is already over (or we're past it), fall back to the
  // current week clamped into the valid range so the tool still returns data.
  if (weeks.length === 0) {
    weeks.push(Math.min(Math.max(currentWeek, startWeek), regularSeasonEndWeek));
  }
  return weeks;
}
