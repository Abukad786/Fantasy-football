import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../public/js/model.js';

const base = (o) => ({ id: 1, team: 1, element_type: 3, status: 'a', chance_of_playing_next_round: null, minutes: 720, starts: 8,
  expected_goals: '3', expected_assists: '2', expected_goals_conceded: '8', saves: 0, bonus: 4, now_cost: 80, selected_by_percent: '20', ...o });
const boot = (els) => ({
  teams: [{ id: 1, short_name: 'AAA', name: 'A' }, { id: 2, short_name: 'BBB', name: 'B' }],
  elements: els,
  events: Array.from({ length: 38 }, (_, i) => ({ id: i + 1, is_current: i + 1 === 9, is_next: i + 1 === 10, finished: i + 1 < 9 })),
});
const fx = (gw, diffA) => ({ event: gw, team_h: 1, team_a: 2, team_h_difficulty: diffA, team_a_difficulty: 3, finished: gw < 9 });

test('easier fixtures project more points', () => {
  const p = base({});
  const easy = M.buildContext(boot([p]), [10, 11, 12].map((g) => fx(g, 2)));
  const hard = M.buildContext(boot([p]), [10, 11, 12].map((g) => fx(g, 5)));
  assert.ok(M.project(p, easy, 3).total > M.project(p, hard, 3).total);
});

test('blank gameweek gives zero, double gives more', () => {
  const p = base({});
  const ctx = M.buildContext(boot([p]), [fx(11, 3), fx(12, 3), fx(12, 3)]);
  const r = M.project(p, ctx, 3);
  assert.equal(r.perGw[0].pts, 0); // GW10 blank
  assert.ok(r.perGw[2].pts > r.perGw[1].pts * 1.8);
});

test('injured player projects zero next GW', () => {
  const p = base({ status: 'i', chance_of_playing_next_round: 0 });
  const ctx = M.buildContext(boot([p]), [fx(10, 3)]);
  assert.equal(M.project(p, ctx, 1).next, 0);
});

test('rival comparison: threats and ownership', () => {
  const ps = Array.from({ length: 4 }, (_, i) => base({ id: i + 1 }));
  const ctx = M.buildContext(boot(ps), [fx(10, 3)]);
  const mk = (entry, ids, cap) => ({ entry, name: 'T' + entry, total: 100, picks: { picks: ids.map((id, k) => ({ element: id, position: k + 1, multiplier: id === cap ? 2 : 1, is_captain: id === cap })) }, history: { current: [], chips: [] } });
  const me = mk(1, [1, 2], 1);
  const cmp = M.compareRivals(me, [mk(2, [1, 3], 3), mk(3, [3, 4], 3)], ctx, { horizon: 1 });
  assert.equal(cmp.own.get(3), 1);
  assert.equal(cmp.threats[0].p.id, 3);
  assert.equal(cmp.caps.get(3), 2);
});

test('transfer ideas respect budget and 3-per-club', () => {
  const ps = [base({ id: 1, now_cost: 50, expected_goals: '0.1' }), base({ id: 2, now_cost: 200, expected_goals: '9' }), base({ id: 3, now_cost: 55, expected_goals: '5' })];
  const ctx = M.buildContext(boot(ps), [fx(10, 3)]);
  const ideas = M.transferIdeas([ps[0]], 10, ctx, { horizon: 1 });
  assert.equal(ideas.points[0].in.id, 3);
});

test('chips status uses API chip windows', () => {
  const ctx = M.buildContext({ ...boot([base({})]), chips: [{ name: 'wildcard', number: 1, start_event: 1, stop_event: 19 }, { name: 'wildcard', number: 1, start_event: 20, stop_event: 38 }, { name: '3xc', number: 1, start_event: 1, stop_event: 19 }] }, []);
  const s = M.chipsStatus({ chips: [{ name: 'wildcard', event: 4 }] }, ctx);
  assert.deepEqual(s.available.map((c) => c.name).sort(), ['3xc', 'wildcard']);
  assert.equal(s.available.find((c) => c.name === 'wildcard').until, 38);
});
