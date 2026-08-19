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
 * Return the ADP tier label for a given average draft pick.
 * NaN/null → 'Undrafted'.
 */
export function adpTier(avgPick: number | null | undefined): string {
  if (avgPick == null || isNaN(avgPick)) return 'Undrafted';
  if (avgPick <= 30)  return 'Top 30 pick';
  if (avgPick <= 75)  return 'Rounds 2–4';
  if (avgPick <= 150) return 'Rounds 5–9';
  if (avgPick <= 250) return 'Rounds 10–15';
  return 'Late/undrafted';
}

export interface BatterSignalInputs {
  babip?:      number | null;
  woba?:       number | null;
  barrelPct?:  number | null;
  hardHit?:    number | null;
  fwar?:       number | null;
  gamesPlayed?: number;
  avgPick?:    number | null;
}

/**
 * Generate opinionated performance signals for a batter from Statcast metrics.
 * All inputs are optional — only signals with sufficient data are emitted.
 */
export function generateBatterSignals(inputs: BatterSignalInputs): string[] {
  const { babip, woba, barrelPct, hardHit, fwar, gamesPlayed = 0, avgPick } = inputs;
  const signals: string[] = [];

  // BABIP luck
  if (babip != null && !isNaN(babip)) {
    if (babip < 0.255)
      signals.push(`BABIP victim (${babip}) — hit rate suppressed by bad luck; AVG/production likely to improve`);
    else if (babip > 0.340)
      signals.push(`Elevated BABIP (${babip}) — luck-aided; AVG regression risk if contact quality doesn't support it`);
    else
      signals.push(`BABIP (${babip}) in normal range (.255–.340)`);
  }

  // Barrel% power grade
  if (barrelPct != null && !isNaN(barrelPct)) {
    if (barrelPct >= 15)
      signals.push(`Elite Barrel% (${barrelPct}%) — elite raw power, HR pace is sustainable`);
    else if (barrelPct >= 10)
      signals.push(`Above-average Barrel% (${barrelPct}%) — real power`);
    else if (barrelPct < 5)
      signals.push(`Low Barrel% (${barrelPct}%) — HR/SLG upside limited`);
  }

  // Hard Hit% contact quality
  if (hardHit != null && !isNaN(hardHit)) {
    if (hardHit >= 45)
      signals.push(`Elite Hard Hit% (${hardHit}%) — quality contact, stats should follow`);
    else if (hardHit >= 40)
      signals.push(`Above-average Hard Hit% (${hardHit}%)`);
    else if (hardHit < 30)
      signals.push(`Soft contact concern (Hard Hit% ${hardHit}%) — production at risk`);
  }

  // wOBA overall quality
  if (woba != null && !isNaN(woba)) {
    if (woba >= 0.380)
      signals.push(`Elite wOBA (${woba}) — among the best hitters in baseball`);
    else if (woba >= 0.340)
      signals.push(`Above-average wOBA (${woba})`);
    else if (woba < 0.290)
      signals.push(`Below-average wOBA (${woba}) — limited overall offensive value`);
  }

  // ADP vs fWAR pace
  if (fwar != null && !isNaN(fwar) && gamesPlayed >= 10 && avgPick != null && !isNaN(avgPick)) {
    const pacedWar = parseFloat(((fwar / gamesPlayed) * 162).toFixed(1));
    const expected = avgPick <= 30 ? 4.0 : avgPick <= 75 ? 2.5 : avgPick <= 150 ? 1.5 : 1.0;
    const tier = adpTier(avgPick);
    if (pacedWar >= expected * 1.3)
      signals.push(`Outperforming ADP (${tier}, pick ${Math.round(avgPick)}) — pacing ${pacedWar} fWAR/162G vs ~${expected} expected`);
    else if (pacedWar <= expected * 0.6)
      signals.push(`Underperforming ADP (${tier}, pick ${Math.round(avgPick)}) — pacing ${pacedWar} fWAR/162G vs ~${expected} expected`);
    else
      signals.push(`Performing near ADP expectation (${tier}, pick ${Math.round(avgPick)}) — pacing ${pacedWar} fWAR/162G`);
  }

  return signals;
}

export interface PitcherSignalInputs {
  era?:          number | null;
  xera?:         number | null;
  kPct?:         number | null;
  bbPct?:        number | null;
  swStr?:        number | null;
  babipAgainst?: number | null;
  fwar?:         number | null;
  ip?:           number | null;
  avgPick?:      number | null;
}

/**
 * Generate opinionated performance signals for a pitcher from Statcast metrics.
 * All inputs are optional — only signals with sufficient data are emitted.
 */
export function generatePitcherSignals(inputs: PitcherSignalInputs): string[] {
  const { era, xera, kPct, bbPct, swStr, babipAgainst, fwar, ip, avgPick } = inputs;
  const signals: string[] = [];

  // ERA vs xERA luck
  if (era != null && !isNaN(era) && xera != null && !isNaN(xera)) {
    const delta = parseFloat((era - xera).toFixed(2));
    if (delta > 0.75)
      signals.push(`ERA luck: ERA (${era}) is +${delta} above xERA (${xera}) — pitching better than results; ERA likely to drop`);
    else if (delta < -0.75)
      signals.push(`ERA luck: ERA (${era}) is ${delta} below xERA (${xera}) — ERA inflation risk ahead`);
    else
      signals.push(`ERA (${era}) and xERA (${xera}) aligned — results reflect true talent level`);
  }

  // K% tier
  if (kPct != null && !isNaN(kPct)) {
    if (kPct >= 30)
      signals.push(`Elite K% (${kPct}%) — top-tier swing-and-miss, high-upside SP/RP`);
    else if (kPct >= 25)
      signals.push(`Above-average K% (${kPct}%)`);
    else if (kPct >= 20)
      signals.push(`Average K% (${kPct}%) — needs strong ERA/WHIP to be valuable`);
    else
      signals.push(`Below-average K% (${kPct}%) — strikeout upside limited`);
  }

  // Walk rate
  if (bbPct != null && !isNaN(bbPct)) {
    if (bbPct > 9)
      signals.push(`Control concern: BB% ${bbPct}% — WHIP/ERA at risk`);
    else if (bbPct > 7)
      signals.push(`Moderate walk rate (BB% ${bbPct}%) — worth monitoring`);
    else
      signals.push(`Good control (BB% ${bbPct}%)`);
  }

  // SwStr% stuff grade
  if (swStr != null && !isNaN(swStr)) {
    if (swStr >= 14)
      signals.push(`Elite SwStr% (${swStr}%) — plus-plus stuff`);
    else if (swStr >= 11)
      signals.push(`Above-average SwStr% (${swStr}%)`);
  }

  // BABIP against luck
  if (babipAgainst != null && !isNaN(babipAgainst)) {
    if (babipAgainst > 0.330)
      signals.push(`High BABIP against (${babipAgainst}) — may improve with normal hit luck`);
    else if (babipAgainst < 0.255)
      signals.push(`Low BABIP against (${babipAgainst}) — hits-allowed regression risk`);
  }

  // fWAR vs ADP
  if (fwar != null && !isNaN(fwar) && ip != null && !isNaN(ip) && ip > 10 && avgPick != null && !isNaN(avgPick)) {
    const pacedWar = parseFloat(((fwar / ip) * 180).toFixed(1));
    const tier = adpTier(avgPick);
    if (avgPick <= 75 && fwar < 0.3)
      signals.push(`Underperforming ADP (${tier}, pick ${Math.round(avgPick)}) — only ${fwar} fWAR in ${ip} IP`);
    else if (avgPick > 150 && fwar >= 0.6)
      signals.push(`Outperforming ADP (${tier}) — ${fwar} fWAR pacing for ~${pacedWar} over full season`);
  }

  return signals;
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
