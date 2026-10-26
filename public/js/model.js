// Gaffer analytics. Pure functions over official FPL API data.
// FPL's expected stats (xG, xA, xGC, ICT, BPS, defensive contributions) are supplied by Opta.

export const POS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };
const GOAL_PTS = { 1: 10, 2: 6, 3: 5, 4: 4 };
const CS_PTS = { 1: 4, 2: 4, 3: 1, 4: 0 };
const DC_THRESHOLD = { 2: 10, 3: 12, 4: 12 }; // defensive contribution points threshold (2025/26 rules)
const ATT_MULT = { 1: 1.3, 2: 1.15, 3: 1.0, 4: 0.85, 5: 0.7 };
const DEF_MULT = { 1: 0.7, 2: 0.85, 3: 1.0, 4: 1.2, 5: 1.4 };

const num = (v) => (v == null || v === '' || Number.isNaN(+v) ? 0 : +v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const price = (p) => (p.now_cost / 10).toFixed(1);

// ---------- context ----------
export function buildContext(bootstrap, fixtures) {
  const teams = new Map(bootstrap.teams.map((t) => [t.id, t]));
  const players = new Map(bootstrap.elements.map((p) => [p.id, p]));
  const events = bootstrap.events;
  const current = events.find((e) => e.is_current) || null;
  const next = events.find((e) => e.is_next) || null;
  const finishedGws = events.filter((e) => e.finished).length;
  const lastGw = events.length ? events[events.length - 1].id : 38;

  // team -> gw -> [{opp, home, diff, kickoff, finished, score}]
  const teamFx = new Map();
  for (const t of bootstrap.teams) teamFx.set(t.id, new Map());
  for (const f of fixtures) {
    if (!f.event) continue;
    const add = (team, opp, home, diff, gf, ga) => {
      const m = teamFx.get(team);
      if (!m) return;
      if (!m.has(f.event)) m.set(f.event, []);
      m.get(f.event).push({ opp, home, diff, kickoff: f.kickoff_time, finished: f.finished, started: f.started, gf, ga });
    };
    add(f.team_h, f.team_a, true, f.team_h_difficulty, f.team_h_score, f.team_a_score);
    add(f.team_a, f.team_h, false, f.team_a_difficulty, f.team_a_score, f.team_h_score);
  }

  // Team games played so far (for start-rate).
  const teamPlayed = new Map();
  for (const [tid, m] of teamFx) {
    let n = 0;
    for (const list of m.values()) n += list.filter((x) => x.finished).length;
    teamPlayed.set(tid, n || finishedGws);
  }

  const ctx = {
    bootstrap, fixtures, teams, players, events, current, next, finishedGws, lastGw, teamFx, teamPlayed,
    startGw: next ? next.id : current ? current.id : 1,
    chipsDef: bootstrap.chips || null,
  };
  ctx.priors = positionPriors(ctx);
  ctx._proj = new Map();
  return ctx;
}

// Position averages used to steady small samples early in the season.
function positionPriors(ctx) {
  const out = {};
  for (const type of [1, 2, 3, 4]) {
    const pool = [...ctx.players.values()].filter((p) => p.element_type === type && num(p.minutes) >= 450);
    const avg = (f) => (pool.length ? pool.reduce((s, p) => s + per90(p, f), 0) / pool.length : 0);
    out[type] = {
      expected_goals: avg('expected_goals'),
      expected_assists: avg('expected_assists'),
      expected_goals_conceded: avg('expected_goals_conceded') || 1.35,
      saves: avg('saves'),
      bonus: avg('bonus'),
      defensive_contribution: avg('defensive_contribution'),
    };
  }
  return out;
}

export function per90(p, field) {
  const direct = p[`${field}_per_90`];
  if (direct != null && direct !== '') return num(direct);
  const mins = num(p.minutes);
  return mins > 0 ? (num(p[field]) / mins) * 90 : 0;
}

function shrunk(p, field, ctx) {
  const mins = num(p.minutes);
  const w = mins / (mins + 450);
  const prior = ctx.priors[p.element_type]?.[field] ?? 0;
  return w * per90(p, field) + (1 - w) * prior;
}

// ---------- availability & minutes ----------
export function availability(p, gwOffset) {
  const chance = p.chance_of_playing_next_round;
  switch (p.status) {
    case 'u':
    case 'n':
      return 0;
    case 'i':
    case 's':
      if (gwOffset === 0) return chance != null ? chance / 100 : 0;
      return gwOffset === 1 ? 0.25 : 0.6;
    case 'd':
      if (gwOffset === 0) return chance != null ? chance / 100 : 0.5;
      return 0.9;
    default:
      return gwOffset === 0 && chance != null ? chance / 100 : 1;
  }
}

export function startRate(p, ctx) {
  const played = ctx.teamPlayed.get(p.team) || ctx.finishedGws || 1;
  if (p.starts != null) return clamp(num(p.starts) / played, 0, 1);
  return clamp(num(p.minutes) / (played * 90), 0, 1);
}

// ---------- expected points ----------
export function xPtsVs(p, fx, ctx, gwOffset) {
  const t = p.element_type;
  const avail = availability(p, gwOffset);
  if (!avail) return 0;
  const sr = startRate(p, ctx);
  // Early season with few games: lean on FPL's own selection signal a little.
  const pStart = clamp(avail * (ctx.finishedGws < 3 ? Math.max(sr, num(p.selected_by_percent) > 15 ? 0.8 : 0.4) : sr), 0, 1);
  const pSub = clamp(avail * 0.6 - pStart, 0, 0.4) * (1 - pStart);
  const minsPerStart = num(p.starts) > 0 ? clamp(num(p.minutes) / num(p.starts), 45, 90) : 80;
  const share = minsPerStart / 90;

  const fa = ATT_MULT[fx.diff] * (fx.home ? 1.05 : 0.95);
  const fd = DEF_MULT[fx.diff] * (fx.home ? 0.92 : 1.08);

  const xg = shrunk(p, 'expected_goals', ctx);
  const xa = shrunk(p, 'expected_assists', ctx);
  const xgc = shrunk(p, 'expected_goals_conceded', ctx) * fd;
  const attack = (xg * GOAL_PTS[t] + xa * 3) * fa;

  let pts = pStart * 2 + pSub * 1;
  pts += attack * (pStart * share + pSub * 0.25);
  if (CS_PTS[t]) pts += pStart * (minsPerStart >= 60 ? 1 : 0.5) * CS_PTS[t] * Math.exp(-xgc);
  if (t <= 2) pts -= pStart * (xgc / 2) * 0.85; // -1 per 2 conceded
  if (t === 1) pts += pStart * (shrunk(p, 'saves', ctx) / 3);
  pts += pStart * shrunk(p, 'bonus', ctx) * (fa > 1 ? 1.1 : 0.95);
  if (DC_THRESHOLD[t] && (p.defensive_contribution != null || p.defensive_contribution_per_90 != null)) {
    const dc = shrunk(p, 'defensive_contribution', ctx);
    const thr = DC_THRESHOLD[t];
    pts += pStart * 2 * clamp((dc - 0.55 * thr) / (0.9 * thr), 0, 0.85);
  }
  return Math.max(0, pts);
}

/** Projected points per GW from ctx.startGw for `horizon` gameweeks. Handles blanks & doubles. */
export function project(p, ctx, horizon = 5) {
  const key = `${p.id}:${horizon}`;
  if (ctx._proj.has(key)) return ctx._proj.get(key);
  const perGw = [];
  for (let i = 0; i < horizon; i++) {
    const gw = ctx.startGw + i;
    if (gw > ctx.lastGw) break;
    const fxs = ctx.teamFx.get(p.team)?.get(gw) || [];
    perGw.push({ gw, fxs, pts: fxs.reduce((s, fx) => s + xPtsVs(p, fx, ctx, i), 0) });
  }
  const r = { perGw, total: perGw.reduce((s, g) => s + g.pts, 0), next: perGw[0]?.pts ?? 0 };
  ctx._proj.set(key, r);
  return r;
}

export function fixtureRun(teamId, ctx, n = 6, fromGw = ctx.startGw) {
  const out = [];
  for (let gw = fromGw; gw < fromGw + n && gw <= ctx.lastGw; gw++) {
    out.push({ gw, fxs: ctx.teamFx.get(teamId)?.get(gw) || [] });
  }
  return out;
}

export function fixtureEase(teamId, ctx, n = 5) {
  const run = fixtureRun(teamId, ctx, n);
  let s = 0;
  for (const g of run) {
    if (!g.fxs.length) s += 0; // blank
    for (const f of g.fxs) s += 6 - f.diff;
  }
  return s;
}

// ---------- squad ----------
export function squadFromPicks(picks, ctx) {
  return picks.picks.map((pk) => ({ ...pk, player: ctx.players.get(pk.element) })).filter((x) => x.player);
}

export function bestXI(squadPlayers, ctx, gwIdx = 0) {
  // squadPlayers: array of player objects. Pick a valid formation maximising projected points.
  const proj = (p) => project(p, ctx, Math.max(1, gwIdx + 1)).perGw[gwIdx]?.pts ?? 0;
  const byType = (t) => squadPlayers.filter((p) => p.element_type === t).sort((a, b) => proj(b) - proj(a));
  const gk = byType(1).slice(0, 1);
  const def = byType(2), mid = byType(3), fwd = byType(4);
  const xi = [...gk, ...def.slice(0, 3), ...mid.slice(0, 2), ...fwd.slice(0, 1)];
  const rest = [...def.slice(3, 5), ...mid.slice(2, 5), ...fwd.slice(1, 3)].sort((a, b) => proj(b) - proj(a));
  for (const p of rest) {
    if (xi.length >= 11) break;
    xi.push(p);
  }
  return { xi, total: xi.reduce((s, p) => s + proj(p), 0), proj };
}

export function captainOptions(squadPlayers, ctx, rivalCaptains = new Map(), rivalCount = 0) {
  return squadPlayers
    .map((p) => ({
      p,
      pts: project(p, ctx, 1).next,
      rivalCap: rivalCount ? (rivalCaptains.get(p.id) || 0) / rivalCount : null,
    }))
    .sort((a, b) => b.pts - a.pts)
    .slice(0, 5);
}

/**
 * Transfer ideas. `own` maps player id -> share of rivals who own him (0..1).
 * Gain vs rivals = what you gain over the average rival: proj*(1-own).
 */
export function transferIdeas(squadPlayers, bank, ctx, { horizon = 5, own = new Map(), limit = 8 } = {}) {
  const inSquad = new Set(squadPlayers.map((p) => p.id));
  const clubCount = new Map();
  for (const p of squadPlayers) clubCount.set(p.team, (clubCount.get(p.team) || 0) + 1);
  const pool = [...ctx.players.values()].filter(
    (p) => !inSquad.has(p.id) && availability(p, 0) >= 0.75 && !['u', 'n'].includes(p.status)
  );
  const ideas = [];
  for (const out of squadPlayers) {
    const budget = out.now_cost + bank;
    const outProj = project(out, ctx, horizon).total;
    const outOwn = own.get(out.id) || 0;
    let best = null, bestRel = null;
    for (const cand of pool) {
      if (cand.element_type !== out.element_type || cand.now_cost > budget) continue;
      const cc = (clubCount.get(cand.team) || 0) - (cand.team === out.team ? 1 : 0);
      if (cc >= 3) continue;
      const pr = project(cand, ctx, horizon).total;
      const gain = pr - outProj;
      const candOwn = own.get(cand.id) || 0;
      const rel = pr * (1 - candOwn) - outProj * (1 - outOwn);
      if (!best || gain > best.gain) best = { out, in: cand, gain, rel, inProj: pr, outProj, candOwn };
      if (!bestRel || rel > bestRel.rel) bestRel = { out, in: cand, gain, rel, inProj: pr, outProj, candOwn };
    }
    if (best) ideas.push({ ...best, kind: 'points' });
    if (bestRel && bestRel.in.id !== best?.in.id) ideas.push({ ...bestRel, kind: 'rivals' });
  }
  // One suggestion per player out and per player in, best first.
  const uniq = (list) => {
    const outs = new Set(), ins = new Set();
    return list.filter((i) => (outs.has(i.out.id) || ins.has(i.in.id) ? false : (outs.add(i.out.id), ins.add(i.in.id), true)));
  };
  const points = uniq(ideas.filter((i) => i.kind === 'points' && i.gain > 0.5).sort((a, b) => b.gain - a.gain)).slice(0, limit);
  const rivals = uniq(ideas.filter((i) => i.rel > 0.5).sort((a, b) => b.rel - a.rel)).slice(0, limit);
  return { points, rivals };
}

// ---------- chips ----------
const CHIP_LABEL = { wildcard: 'Wildcard', freehit: 'Free Hit', bboost: 'Bench Boost', '3xc': 'Triple Captain', manager: 'Assistant Manager' };
export const chipLabel = (n) => CHIP_LABEL[n] || n;

/**
 * Chips for the next deadline. FPL gives one set per half-season (GW1-19, GW20-38),
 * so a chip only counts as "left" if it's unused in the window that contains the next GW.
 * `used` = chips played this season; `available` = usable now; `later` = next window's set.
 */
export function chipsStatus(history, ctx) {
  const used = (history?.chips || []).map((c) => ({ name: c.name, event: c.event })).sort((a, b) => a.event - b.event);
  const gw = ctx.startGw;
  const defs = ctx.chipsDef && ctx.chipsDef.length
    ? ctx.chipsDef.map((d) => ({ name: d.name, number: d.number || 1, start: d.start_event, stop: d.stop_event }))
    : ['wildcard', 'freehit', 'bboost', '3xc'].flatMap((name) => [{ name, number: 1, start: 1, stop: 19 }, { name, number: 1, start: 20, stop: 38 }]);
  const unused = (d) => used.filter((u) => u.name === d.name && u.event >= d.start && u.event <= d.stop).length < d.number;
  const available = defs.filter((d) => gw >= d.start && gw <= d.stop && unused(d)).map((d) => ({ name: d.name, until: d.stop }));
  const later = defs.filter((d) => d.start > gw).map((d) => ({ name: d.name, from: d.start }));
  const seen = new Set();
  return { used, available: available.filter((c) => (seen.has(c.name) ? false : seen.add(c.name))), later };
}

// ---------- live ----------
export function livePoints(picks, live) {
  if (!picks || !live) return null;
  const pts = new Map(live.elements.map((e) => [e.id, e.stats.total_points]));
  const mins = new Map(live.elements.map((e) => [e.id, e.stats.minutes]));
  let total = 0;
  for (const pk of picks.picks) total += (pts.get(pk.element) || 0) * pk.multiplier;
  const hit = picks.entry_history?.event_transfers_cost || 0;
  const played = picks.picks.filter((pk) => pk.multiplier > 0 && (mins.get(pk.element) || 0) > 0).length;
  return { total: total - hit, gross: total, hit, played };
}

// ---------- rivals ----------
/**
 * me / rivals: { entry, name, player, rank, total, eventTotal, picks, history, transfers }
 */
export function compareRivals(me, rivals, ctx, { horizon = 5 } = {}) {
  const n = rivals.length;
  const owners = new Map(); // player -> count of rivals (starting XI or bench)
  const starters = new Map();
  const caps = new Map();
  for (const r of rivals) {
    if (!r.picks) continue;
    for (const pk of r.picks.picks) {
      owners.set(pk.element, (owners.get(pk.element) || 0) + 1);
      if (pk.multiplier > 0) starters.set(pk.element, (starters.get(pk.element) || 0) + 1);
      if (pk.is_captain) caps.set(pk.element, (caps.get(pk.element) || 0) + 1);
    }
  }
  const own = new Map([...owners].map(([id, c]) => [id, n ? c / n : 0]));
  const mine = new Set(me.picks ? me.picks.picks.map((pk) => pk.element) : []);

  const threats = [...owners]
    .filter(([id]) => !mine.has(id))
    .map(([id, c]) => ({ p: ctx.players.get(id), own: c / n, proj: project(ctx.players.get(id), ctx, horizon).total }))
    .filter((x) => x.p)
    .map((x) => ({ ...x, risk: x.own * x.proj }))
    .sort((a, b) => b.risk - a.risk)
    .slice(0, 8);

  const edges = [...mine]
    .map((id) => ({ p: ctx.players.get(id), own: own.get(id) || 0, proj: project(ctx.players.get(id), ctx, horizon).total }))
    .filter((x) => x.p)
    .map((x) => ({ ...x, edge: (1 - x.own) * x.proj }))
    .sort((a, b) => b.edge - a.edge);

  const squadProj = (entry) => {
    if (!entry.picks) return null;
    const ps = entry.picks.picks.map((pk) => ctx.players.get(pk.element)).filter(Boolean);
    let tot = 0;
    for (let i = 0; i < horizon; i++) {
      const { xi, proj } = bestXI(ps, ctx, i);
      const pts = xi.map(proj);
      tot += pts.reduce((a, b) => a + b, 0) + Math.max(0, ...pts); // + captain
    }
    return tot;
  };

  const rows = [me, ...rivals].map((r) => {
    const ids = r.picks ? r.picks.picks.map((pk) => pk.element) : [];
    const shared = ids.filter((id) => mine.has(id)).length;
    const capPick = r.picks?.picks.find((pk) => pk.is_captain);
    const hits = (r.history?.current || []).reduce((s, g) => s + (g.event_transfers_cost || 0), 0);
    const last = r.history?.current?.at(-1);
    return {
      ...r,
      isMe: r.entry === me.entry,
      gap: r.total - me.total,
      shared,
      captain: capPick ? ctx.players.get(capPick.element) : null,
      chip: r.picks?.active_chip || null,
      chips: chipsStatus(r.history, ctx),
      hits,
      value: last ? last.value / 10 : null,
      bank: last ? last.bank / 10 : null,
      proj: squadProj(r),
      form5: (r.history?.current || []).slice(-5).reduce((s, g) => s + g.points, 0),
    };
  });

  return { own, starters, caps, threats, edges, rows, n };
}

/** Plain-English plan for a mini-league given the comparison. */
export function leaguePlan(cmp, me, ctx, horizon = 5) {
  const tips = [];
  const meRow = cmp.rows.find((r) => r.isMe);
  const above = cmp.rows.filter((r) => !r.isMe && r.gap > 0).sort((a, b) => a.gap - b.gap);
  const below = cmp.rows.filter((r) => !r.isMe && r.gap <= 0).sort((a, b) => b.gap - a.gap);
  const gwsLeft = Math.max(1, ctx.lastGw - (ctx.current?.finished ? ctx.current.id : (ctx.current?.id || 0) - 1));
  const leader = cmp.rows.reduce((a, b) => (b.total > a.total ? b : a));

  if (leader.isMe) {
    const chaser = below[0];
    tips.push({ tone: 'good', text: `You're top${chaser ? ` by ${-chaser.gap} pts over ${chaser.name}` : ''}. Protect the lead: cover the players your rivals own so their good weeks don't hurt you.` });
  } else {
    const gap = leader.total - me.total;
    tips.push({ tone: gap > 8 * gwsLeft ? 'bad' : 'warn', text: `${gap} pts behind the leader (${leader.name}) with ~${gwsLeft} GWs left: about ${(gap / gwsLeft).toFixed(1)} pts per GW to make up. ${gap > 4 * gwsLeft ? 'You need to take some risks — differentials and a different captain.' : 'Steady gains will do it; avoid unnecessary hits.'}` });
  }
  if (above[0] && !above[0].isMe) {
    tips.push({ tone: 'info', text: `Next target: ${above[0].name}, ${above[0].gap} pts ahead. You share ${above[0].shared}/15 players.` });
  }
  if (meRow?.proj != null) {
    const better = cmp.rows.filter((r) => !r.isMe && r.proj != null && r.proj > meRow.proj + 3);
    if (better.length) tips.push({ tone: 'warn', text: `${better.length} rival squad${better.length > 1 ? 's project' : ' projects'} more points than yours over the next ${horizon} GWs (${better.map((r) => r.name).slice(0, 3).join(', ')}). Look at the transfer ideas below.` });
    else tips.push({ tone: 'good', text: `Your squad projects at least as well as every rival here over the next ${horizon} GWs.` });
  }
  const bigThreat = cmp.threats.find((t) => t.own >= 0.5);
  if (bigThreat) tips.push({ tone: 'warn', text: `${bigThreat.p.web_name} is owned by ${Math.round(bigThreat.own * 100)}% of these rivals and you don't have him. ${leader.isMe ? 'Consider covering him.' : 'Not owning him is a gamble — fine if you need a differential, risky otherwise.'}` });
  const topCap = [...cmp.caps].sort((a, b) => b[1] - a[1])[0];
  if (topCap && cmp.n) tips.push({ tone: 'info', text: `Most rivals captained ${ctx.players.get(topCap[0])?.web_name} this GW (${topCap[1]}/${cmp.n}).` });
  const chipHeavy = cmp.rows.filter((r) => !r.isMe && r.chips.available.length > (meRow?.chips.available.length || 0));
  if (chipHeavy.length) tips.push({ tone: 'info', text: `${chipHeavy.map((r) => r.name).slice(0, 3).join(', ')} ${chipHeavy.length > 1 ? 'have' : 'has'} more chips left than you — expect a swing when they play them.` });
  return tips;
}

// ---------- insights ----------
export function insightLists(ctx, horizon = 5) {
  const all = [...ctx.players.values()].filter((p) => !['u', 'n'].includes(p.status));
  const withProj = all.map((p) => ({ p, proj: project(p, ctx, horizon).total }));
  const byPos = {};
  for (const t of [1, 2, 3, 4]) byPos[t] = withProj.filter((x) => x.p.element_type === t).sort((a, b) => b.proj - a.proj).slice(0, 10);
  const dueGoal = all
    .filter((p) => num(p.minutes) >= 450)
    .map((p) => ({ p, diff: num(p.expected_goals) - num(p.goals_scored) }))
    .filter((x) => x.diff > 0.8)
    .sort((a, b) => b.diff - a.diff)
    .slice(0, 10);
  const hot = all
    .filter((p) => num(p.goals_scored) >= 3 && num(p.goals_scored) - num(p.expected_goals) > 1.5)
    .map((p) => ({ p, diff: num(p.goals_scored) - num(p.expected_goals) }))
    .sort((a, b) => b.diff - a.diff)
    .slice(0, 8);
  const xgi = all
    .filter((p) => num(p.minutes) >= 450)
    .map((p) => ({ p, v: per90(p, 'expected_goal_involvements') }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 12);
  const diffs = withProj.filter((x) => num(x.p.selected_by_percent) < 10 && num(x.p.minutes) >= 270).sort((a, b) => b.proj - a.proj).slice(0, 10);
  const transfersIn = [...all].sort((a, b) => num(b.transfers_in_event) - num(a.transfers_in_event)).slice(0, 8);
  const transfersOut = [...all].sort((a, b) => num(b.transfers_out_event) - num(a.transfers_out_event)).slice(0, 8);
  const priceMoves = all.filter((p) => num(p.cost_change_event) !== 0).sort((a, b) => num(b.cost_change_event) - num(a.cost_change_event));
  const value = withProj.filter((x) => num(x.p.minutes) >= 270).map((x) => ({ ...x, ppm: x.proj / (x.p.now_cost / 10) })).sort((a, b) => b.ppm - a.ppm).slice(0, 10);
  const teamsByEase = [...ctx.teams.values()].map((t) => ({ t, ease: fixtureEase(t.id, ctx, horizon) })).sort((a, b) => b.ease - a.ease);
  return { byPos, dueGoal, hot, xgi, diffs, transfersIn, transfersOut, priceMoves, value, teamsByEase };
}

export function availabilityNews(ctx) {
  return [...ctx.players.values()]
    .filter((p) => p.news && p.news_added)
    .sort((a, b) => b.news_added.localeCompare(a.news_added));
}
