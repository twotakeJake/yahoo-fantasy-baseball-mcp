import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeName,
  lookupAge,
  extractField,
  parsePlayerInfo,
  extractPlayersMap,
  computeCategoryRankings,
  buildOptimalLineup,
  adpTier,
  generateBatterSignals,
  generatePitcherSignals,
  rankBand,
  competitiveTier,
  mapMatchupStatus,
  defaultScheduleWeeks,
} from '../utils/transforms.js';

// ---------------------------------------------------------------------------
// normalizeName
// ---------------------------------------------------------------------------

describe('normalizeName', () => {
  it('lowercases ascii names', () => {
    assert.equal(normalizeName('Mike Trout'), 'mike trout');
  });

  it('strips accent marks', () => {
    assert.equal(normalizeName('José Ramírez'), 'jose ramirez');
  });

  it('strips parentheticals like (Batter) or (Pitcher)', () => {
    assert.equal(normalizeName('Shohei Ohtani (Batter)'), 'shohei ohtani');
  });

  it('strips parentheticals and accents together', () => {
    assert.equal(normalizeName('Félix (Closer) Hernández'), 'felix  hernandez');
  });

  it('trims leading and trailing whitespace', () => {
    assert.equal(normalizeName('  Aaron Judge  '), 'aaron judge');
  });

  it('strips non-alpha characters other than spaces', () => {
    assert.equal(normalizeName("Jo-el Márquez Jr."), 'joel marquez jr');
  });

  it('returns empty string for empty input', () => {
    assert.equal(normalizeName(''), '');
  });
});

// ---------------------------------------------------------------------------
// lookupAge
// ---------------------------------------------------------------------------

describe('lookupAge', () => {
  it('returns age when player is found uniquely', () => {
    const map = new Map([['mike trout', [{ age: 32, jersey: '27' }]]]);
    assert.equal(lookupAge(map, 'Mike Trout', '27'), 32);
  });

  it('normalizes the lookup name before searching', () => {
    const map = new Map([['jose ramirez', [{ age: 31, jersey: '11' }]]]);
    assert.equal(lookupAge(map, 'José Ramírez', '11'), 31);
  });

  it('returns undefined for unknown player', () => {
    const map = new Map<string, { age: number; jersey: string }[]>();
    assert.equal(lookupAge(map, 'Unknown Player', '99'), undefined);
  });

  it('disambiguates same-name players by jersey number', () => {
    const map = new Map([
      ['max muncy', [
        { age: 34, jersey: '13' },
        { age: 22, jersey: '75' },
      ]],
    ]);
    assert.equal(lookupAge(map, 'Max Muncy', '75'), 22);
    assert.equal(lookupAge(map, 'Max Muncy', '13'), 34);
  });

  it('returns undefined when same-name jersey does not match', () => {
    const map = new Map([
      ['max muncy', [
        { age: 34, jersey: '13' },
        { age: 22, jersey: '75' },
      ]],
    ]);
    assert.equal(lookupAge(map, 'Max Muncy', '99'), undefined);
  });
});

// ---------------------------------------------------------------------------
// extractField
// ---------------------------------------------------------------------------

describe('extractField', () => {
  it('extracts a value from an array of single-key objects', () => {
    const arr = [{ player_key: '458.p.1234' }, { display_position: 'SS' }];
    assert.equal(extractField(arr, 'display_position'), 'SS');
  });

  it('returns null when key is not present', () => {
    const arr = [{ player_key: '458.p.1234' }];
    assert.equal(extractField(arr, 'uniform_number'), null);
  });

  it('returns null for empty array', () => {
    assert.equal(extractField([], 'name'), null);
  });

  it('skips array items that are themselves arrays', () => {
    const arr: any[] = [['nested', 'array'], { name: { full: 'Aaron Judge' } }];
    assert.deepEqual(extractField(arr, 'name'), { full: 'Aaron Judge' });
  });

  it('skips null items without throwing', () => {
    const arr = [null, { display_position: '1B' }];
    assert.equal(extractField(arr, 'display_position'), '1B');
  });
});

// ---------------------------------------------------------------------------
// parsePlayerInfo
// ---------------------------------------------------------------------------

describe('parsePlayerInfo', () => {
  const sampleInfoArray = [
    { player_key: '458.p.9988' },
    { name: { full: 'Aaron Judge', first: 'Aaron', last: 'Judge' } },
    { display_position: 'OF' },
    { editorial_team_abbr: 'NYY' },
    { uniform_number: '99' },
  ];

  it('extracts name', () => {
    assert.equal(parsePlayerInfo(sampleInfoArray).name, 'Aaron Judge');
  });

  it('extracts position', () => {
    assert.equal(parsePlayerInfo(sampleInfoArray).position, 'OF');
  });

  it('extracts mlbTeam', () => {
    assert.equal(parsePlayerInfo(sampleInfoArray).mlbTeam, 'NYY');
  });

  it('extracts playerKey', () => {
    assert.equal(parsePlayerInfo(sampleInfoArray).playerKey, '458.p.9988');
  });

  it('extracts jerseyNumber', () => {
    assert.equal(parsePlayerInfo(sampleInfoArray).jerseyNumber, '99');
  });

  it('returns empty strings for missing fields', () => {
    const result = parsePlayerInfo([]);
    assert.equal(result.name, '');
    assert.equal(result.position, '');
    assert.equal(result.mlbTeam, '');
    assert.equal(result.playerKey, '');
    assert.equal(result.jerseyNumber, '');
  });

  it('extracts status when present', () => {
    const arr = [{ player_key: '458.p.9988' }, { status: 'IL' }];
    assert.equal(parsePlayerInfo(arr).status, 'IL');
  });

  it('extracts injuryNote when present', () => {
    const arr = [{ player_key: '458.p.9988' }, { injury_note: 'left elbow inflammation' }];
    assert.equal(parsePlayerInfo(arr).injuryNote, 'left elbow inflammation');
  });

  it('omits status key when not present', () => {
    const result = parsePlayerInfo([{ player_key: '458.p.9988' }]);
    assert.equal('status' in result, false);
  });

  it('omits injuryNote key when not present', () => {
    const result = parsePlayerInfo([{ player_key: '458.p.9988' }]);
    assert.equal('injuryNote' in result, false);
  });
});

// ---------------------------------------------------------------------------
// extractPlayersMap
// ---------------------------------------------------------------------------

describe('extractPlayersMap', () => {
  it('extracts players from numeric-indexed roster object', () => {
    const players = { 0: { player: [] }, count: 1 };
    const rosterObj = { 0: { players } };
    assert.deepEqual(extractPlayersMap(rosterObj), players);
  });

  it('extracts players from string-indexed roster object', () => {
    const players = { 0: { player: [] }, count: 1 };
    const rosterObj = { '0': { players } };
    assert.deepEqual(extractPlayersMap(rosterObj), players);
  });

  it('returns empty object when roster structure is missing', () => {
    assert.deepEqual(extractPlayersMap({}), {});
  });
});

// ---------------------------------------------------------------------------
// buildOptimalLineup
// ---------------------------------------------------------------------------

describe('buildOptimalLineup', () => {
  it('assigns IL-eligible injured player to IL slot', () => {
    const players = [{ playerKey: 'p1', eligiblePositions: ['SP', 'P', 'IL', 'BN'], isInjured: true }];
    const result = buildOptimalLineup(players, { SP: 1, BN: 3, IL: 1 });
    assert.equal(result.find((r) => r.playerKey === 'p1')?.position, 'IL');
  });

  it('sends injured player to BN when no IL slot available', () => {
    const players = [{ playerKey: 'p1', eligiblePositions: ['SP', 'P', 'BN'], isInjured: true }];
    const result = buildOptimalLineup(players, { SP: 1, BN: 3 });
    assert.equal(result.find((r) => r.playerKey === 'p1')?.position, 'BN');
  });

  it('sends injured player to BN when IL slot exists but player not IL-eligible', () => {
    const players = [{ playerKey: 'p1', eligiblePositions: ['SP', 'P', 'BN'], isInjured: true }];
    const result = buildOptimalLineup(players, { SP: 1, BN: 3, IL: 2 });
    assert.equal(result.find((r) => r.playerKey === 'p1')?.position, 'BN');
  });

  it('assigns healthy player to their position slot', () => {
    const players = [{ playerKey: 'p1', eligiblePositions: ['C', 'Util', 'BN'], isInjured: false }];
    const result = buildOptimalLineup(players, { C: 1, Util: 1, BN: 5 });
    assert.equal(result.find((r) => r.playerKey === 'p1')?.position, 'C');
  });

  it('places most-constrained player in scarce slot before versatile player', () => {
    // p1 can only play C; p2 can play C or Util — p1 should get C
    const players = [
      { playerKey: 'p1', eligiblePositions: ['C', 'BN'], isInjured: false },
      { playerKey: 'p2', eligiblePositions: ['C', 'Util', 'BN'], isInjured: false },
    ];
    const result = buildOptimalLineup(players, { C: 1, Util: 1, BN: 5 });
    assert.equal(result.find((r) => r.playerKey === 'p1')?.position, 'C');
    assert.equal(result.find((r) => r.playerKey === 'p2')?.position, 'Util');
  });

  it('fills multiple OF slots', () => {
    const players = [
      { playerKey: 'p1', eligiblePositions: ['OF', 'BN'], isInjured: false },
      { playerKey: 'p2', eligiblePositions: ['OF', 'BN'], isInjured: false },
      { playerKey: 'p3', eligiblePositions: ['OF', 'BN'], isInjured: false },
    ];
    const result = buildOptimalLineup(players, { OF: 3, BN: 3 });
    const ofAssigned = result.filter((r) => r.position === 'OF').length;
    assert.equal(ofAssigned, 3);
  });

  it('sends healthy player to BN when all active slots are filled', () => {
    const players = [
      { playerKey: 'p1', eligiblePositions: ['SP', 'BN'], isInjured: false },
      { playerKey: 'p2', eligiblePositions: ['SP', 'BN'], isInjured: false },
    ];
    const result = buildOptimalLineup(players, { SP: 1, BN: 5 });
    const bn = result.filter((r) => r.position === 'BN');
    assert.equal(bn.length, 1);
  });

  it('assigns every player exactly once', () => {
    const players = [
      { playerKey: 'p1', eligiblePositions: ['C', 'BN'], isInjured: false },
      { playerKey: 'p2', eligiblePositions: ['SP', 'IL', 'BN'], isInjured: true },
      { playerKey: 'p3', eligiblePositions: ['OF', 'Util', 'BN'], isInjured: false },
    ];
    const result = buildOptimalLineup(players, { C: 1, OF: 1, Util: 1, SP: 1, BN: 3, IL: 1 });
    const keys = result.map((r) => r.playerKey);
    assert.equal(keys.length, players.length);
    assert.equal(new Set(keys).size, players.length);
  });

  it('returns empty array for empty player list', () => {
    assert.deepEqual(buildOptimalLineup([], { C: 1, BN: 5 }), []);
  });
});

// ---------------------------------------------------------------------------
// computeCategoryRankings
// ---------------------------------------------------------------------------

describe('computeCategoryRankings', () => {
  const teams = [
    { teamKey: 'A', value: 150 },
    { teamKey: 'B', value: 200 },
    { teamKey: 'C', value: 100 },
  ];

  it('ranks higher-is-better stats with highest value at rank 1', () => {
    const result = computeCategoryRankings(teams, true);
    const byKey = Object.fromEntries(result.map((r) => [r.teamKey, r.rank]));
    assert.equal(byKey['B'], 1);
    assert.equal(byKey['A'], 2);
    assert.equal(byKey['C'], 3);
  });

  it('ranks lower-is-better stats with lowest value at rank 1', () => {
    const result = computeCategoryRankings(teams, false);
    const byKey = Object.fromEntries(result.map((r) => [r.teamKey, r.rank]));
    assert.equal(byKey['C'], 1);
    assert.equal(byKey['A'], 2);
    assert.equal(byKey['B'], 3);
  });

  it('pushes null values to last rank', () => {
    const input = [
      { teamKey: 'A', value: 50 },
      { teamKey: 'B', value: null },
      { teamKey: 'C', value: 80 },
    ];
    const result = computeCategoryRankings(input, true);
    const byKey = Object.fromEntries(result.map((r) => [r.teamKey, r.rank]));
    assert.equal(byKey['C'], 1);
    assert.equal(byKey['A'], 2);
    assert.equal(byKey['B'], 3); // null → last
  });

  it('assigns same last rank to multiple null-value teams', () => {
    const input = [
      { teamKey: 'A', value: 10 },
      { teamKey: 'B', value: null },
      { teamKey: 'C', value: null },
    ];
    const result = computeCategoryRankings(input, true);
    const byKey = Object.fromEntries(result.map((r) => [r.teamKey, r.rank]));
    assert.equal(byKey['A'], 1);
    assert.equal(byKey['B'], byKey['C']); // both null → same rank
    assert.equal(byKey['B'], 2);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(computeCategoryRankings([], true), []);
  });

  it('handles a single team', () => {
    const result = computeCategoryRankings([{ teamKey: 'A', value: 42 }], true);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.rank, 1);
  });

  it('preserves value in output', () => {
    const result = computeCategoryRankings([{ teamKey: 'A', value: 3.14 }], false);
    assert.equal(result[0]!.value, 3.14);
  });
});

// ---------------------------------------------------------------------------
// adpTier
// ---------------------------------------------------------------------------

describe('adpTier', () => {
  it('returns Top 30 pick for pick <= 30', () => {
    assert.equal(adpTier(1),  'Top 30 pick');
    assert.equal(adpTier(30), 'Top 30 pick');
  });

  it('returns Rounds 2–4 for picks 31–75', () => {
    assert.equal(adpTier(31), 'Rounds 2–4');
    assert.equal(adpTier(75), 'Rounds 2–4');
  });

  it('returns Rounds 5–9 for picks 76–150', () => {
    assert.equal(adpTier(76),  'Rounds 5–9');
    assert.equal(adpTier(150), 'Rounds 5–9');
  });

  it('returns Rounds 10–15 for picks 151–250', () => {
    assert.equal(adpTier(151), 'Rounds 10–15');
    assert.equal(adpTier(250), 'Rounds 10–15');
  });

  it('returns Late/undrafted for picks > 250', () => {
    assert.equal(adpTier(251), 'Late/undrafted');
    assert.equal(adpTier(999), 'Late/undrafted');
  });

  it('returns Undrafted for null', () => {
    assert.equal(adpTier(null), 'Undrafted');
  });

  it('returns Undrafted for undefined', () => {
    assert.equal(adpTier(undefined), 'Undrafted');
  });

  it('returns Undrafted for NaN', () => {
    assert.equal(adpTier(NaN), 'Undrafted');
  });
});

// ---------------------------------------------------------------------------
// generateBatterSignals
// ---------------------------------------------------------------------------

describe('generateBatterSignals', () => {
  it('returns empty array when all inputs are missing', () => {
    assert.deepEqual(generateBatterSignals({}), []);
  });

  it('flags low BABIP as BABIP victim', () => {
    const signals = generateBatterSignals({ babip: 0.240 });
    assert.ok(signals.some((s) => s.includes('BABIP victim')));
  });

  it('flags elevated BABIP regression risk', () => {
    const signals = generateBatterSignals({ babip: 0.360 });
    assert.ok(signals.some((s) => s.includes('Elevated BABIP')));
  });

  it('reports normal BABIP range', () => {
    const signals = generateBatterSignals({ babip: 0.300 });
    assert.ok(signals.some((s) => s.includes('normal range')));
  });

  it('flags elite Barrel%', () => {
    const signals = generateBatterSignals({ barrelPct: 18 });
    assert.ok(signals.some((s) => s.includes('Elite Barrel%')));
  });

  it('flags above-average Barrel%', () => {
    const signals = generateBatterSignals({ barrelPct: 12 });
    assert.ok(signals.some((s) => s.includes('Above-average Barrel%')));
  });

  it('flags low Barrel%', () => {
    const signals = generateBatterSignals({ barrelPct: 3 });
    assert.ok(signals.some((s) => s.includes('Low Barrel%')));
  });

  it('flags elite Hard Hit%', () => {
    const signals = generateBatterSignals({ hardHit: 48 });
    assert.ok(signals.some((s) => s.includes('Elite Hard Hit%')));
  });

  it('flags soft contact concern', () => {
    const signals = generateBatterSignals({ hardHit: 25 });
    assert.ok(signals.some((s) => s.includes('Soft contact concern')));
  });

  it('flags elite wOBA', () => {
    const signals = generateBatterSignals({ woba: 0.400 });
    assert.ok(signals.some((s) => s.includes('Elite wOBA')));
  });

  it('flags below-average wOBA', () => {
    const signals = generateBatterSignals({ woba: 0.270 });
    assert.ok(signals.some((s) => s.includes('Below-average wOBA')));
  });

  it('flags ADP outperformance when pacing >> expected', () => {
    // Top-30 pick (expected ~4 WAR), pacing way above
    const signals = generateBatterSignals({ fwar: 3.0, gamesPlayed: 50, avgPick: 20 });
    assert.ok(signals.some((s) => s.includes('Outperforming ADP')));
  });

  it('flags ADP underperformance when pacing << expected', () => {
    // Top-30 pick (expected ~4 WAR), pacing way below
    const signals = generateBatterSignals({ fwar: 0.1, gamesPlayed: 50, avgPick: 20 });
    assert.ok(signals.some((s) => s.includes('Underperforming ADP')));
  });

  it('skips ADP signal when gamesPlayed < 10', () => {
    const signals = generateBatterSignals({ fwar: 2.0, gamesPlayed: 5, avgPick: 20 });
    assert.ok(!signals.some((s) => s.includes('ADP')));
  });

  it('skips ADP signal when avgPick is null', () => {
    const signals = generateBatterSignals({ fwar: 2.0, gamesPlayed: 50, avgPick: null });
    assert.ok(!signals.some((s) => s.includes('ADP')));
  });

  it('emits multiple signals when multiple inputs provided', () => {
    const signals = generateBatterSignals({
      babip: 0.240, barrelPct: 18, hardHit: 48, woba: 0.400,
      fwar: 3.0, gamesPlayed: 50, avgPick: 20,
    });
    assert.ok(signals.length >= 4);
  });
});

// ---------------------------------------------------------------------------
// generatePitcherSignals
// ---------------------------------------------------------------------------

describe('generatePitcherSignals', () => {
  it('returns empty array when all inputs are missing', () => {
    assert.deepEqual(generatePitcherSignals({}), []);
  });

  it('flags ERA above xERA (pitcher unlucky, ERA should drop)', () => {
    // era > xera → pitcher is pitching better than ERA shows
    const signals = generatePitcherSignals({ era: 5.00, xera: 3.50 });
    assert.ok(signals.some((s) => s.includes('ERA luck') && s.includes('ERA likely to drop')));
  });

  it('flags ERA below xERA (ERA inflation risk)', () => {
    // era < xera → ERA is unsustainably low
    const signals = generatePitcherSignals({ era: 2.50, xera: 3.50 });
    assert.ok(signals.some((s) => s.includes('ERA luck') && s.includes('inflation risk')));
  });

  it('reports ERA aligned with xERA when delta is small', () => {
    const signals = generatePitcherSignals({ era: 3.50, xera: 3.60 });
    assert.ok(signals.some((s) => s.includes('aligned')));
  });

  it('flags elite K%', () => {
    const signals = generatePitcherSignals({ kPct: 32 });
    assert.ok(signals.some((s) => s.includes('Elite K%')));
  });

  it('flags below-average K%', () => {
    const signals = generatePitcherSignals({ kPct: 17 });
    assert.ok(signals.some((s) => s.includes('Below-average K%')));
  });

  it('flags control concern', () => {
    const signals = generatePitcherSignals({ bbPct: 11 });
    assert.ok(signals.some((s) => s.includes('Control concern')));
  });

  it('flags good control', () => {
    const signals = generatePitcherSignals({ bbPct: 5 });
    assert.ok(signals.some((s) => s.includes('Good control')));
  });

  it('flags elite SwStr%', () => {
    const signals = generatePitcherSignals({ swStr: 15 });
    assert.ok(signals.some((s) => s.includes('Elite SwStr%')));
  });

  it('flags high BABIP against', () => {
    const signals = generatePitcherSignals({ babipAgainst: 0.350 });
    assert.ok(signals.some((s) => s.includes('High BABIP against')));
  });

  it('flags low BABIP against (regression risk)', () => {
    const signals = generatePitcherSignals({ babipAgainst: 0.230 });
    assert.ok(signals.some((s) => s.includes('Low BABIP against')));
  });

  it('flags fWAR underperformance for high-ADP pitcher', () => {
    // Top-75 pick with only 0.2 fWAR in 40 IP
    const signals = generatePitcherSignals({ fwar: 0.2, ip: 40, avgPick: 50 });
    assert.ok(signals.some((s) => s.includes('Underperforming ADP')));
  });

  it('flags fWAR outperformance for low-ADP pitcher', () => {
    // Late pick (>150) with 0.8 fWAR in 30 IP
    const signals = generatePitcherSignals({ fwar: 0.8, ip: 30, avgPick: 200 });
    assert.ok(signals.some((s) => s.includes('Outperforming ADP')));
  });

  it('skips fWAR signal when ip <= 10', () => {
    const signals = generatePitcherSignals({ fwar: 0.1, ip: 8, avgPick: 50 });
    assert.ok(!signals.some((s) => s.includes('Underperforming ADP')));
  });

  it('emits multiple signals for a complete stat line', () => {
    const signals = generatePitcherSignals({
      era: 2.50, xera: 3.50, kPct: 32, bbPct: 5, swStr: 15,
      babipAgainst: 0.240, fwar: 0.8, ip: 30, avgPick: 200,
    });
    assert.ok(signals.length >= 5);
  });
});

describe('rankBand', () => {
  it('classifies ranks 1-4 as top', () => {
    assert.equal(rankBand(1), 'top');
    assert.equal(rankBand(4), 'top');
  });
  it('classifies ranks 5-7 as mid', () => {
    assert.equal(rankBand(5), 'mid');
    assert.equal(rankBand(7), 'mid');
  });
  it('classifies ranks 8-10 as bottom', () => {
    assert.equal(rankBand(8), 'bottom');
    assert.equal(rankBand(10), 'bottom');
  });
});

describe('competitiveTier', () => {
  it('labels two top teams top_vs_top', () => {
    assert.equal(competitiveTier(1, 4), 'top_vs_top');
  });
  it('labels top vs bottom regardless of argument order', () => {
    assert.equal(competitiveTier(2, 9), 'top_vs_bottom');
    assert.equal(competitiveTier(9, 2), 'top_vs_bottom');
  });
  it('labels top vs mid', () => {
    assert.equal(competitiveTier(3, 6), 'top_vs_mid');
  });
  it('labels mid vs mid, mid vs bottom, bottom vs bottom', () => {
    assert.equal(competitiveTier(5, 7), 'mid_vs_mid');
    assert.equal(competitiveTier(6, 10), 'mid_vs_bottom');
    assert.equal(competitiveTier(8, 10), 'bottom_vs_bottom');
  });
  it('returns unknown when a rank is missing or invalid', () => {
    assert.equal(competitiveTier(null, 3), 'unknown');
    assert.equal(competitiveTier(3, undefined), 'unknown');
    assert.equal(competitiveTier(NaN, 3), 'unknown');
  });
});

describe('mapMatchupStatus', () => {
  it('maps Yahoo status strings', () => {
    assert.equal(mapMatchupStatus('postevent', 20, 21), 'completed');
    assert.equal(mapMatchupStatus('midevent', 21, 21), 'in_progress');
    assert.equal(mapMatchupStatus('preevent', 22, 21), 'upcoming');
  });
  it('falls back to week comparison when status is missing/unknown', () => {
    assert.equal(mapMatchupStatus(undefined, 20, 21), 'completed');
    assert.equal(mapMatchupStatus(null, 21, 21), 'in_progress');
    assert.equal(mapMatchupStatus('', 22, 21), 'upcoming');
  });
});

describe('defaultScheduleWeeks', () => {
  it('returns remaining regular-season weeks by default', () => {
    assert.deepEqual(defaultScheduleWeeks(21, 1, 23, false), [21, 22, 23]);
  });
  it('includes past weeks when includeCompleted is set', () => {
    assert.deepEqual(defaultScheduleWeeks(3, 1, 4, true), [1, 2, 3, 4]);
  });
  it('falls back to a single clamped week when the regular season is over', () => {
    assert.deepEqual(defaultScheduleWeeks(24, 1, 23, false), [23]);
  });
});
