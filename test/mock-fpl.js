// Synthetic FPL API for local testing (same shapes as the real API, made-up numbers).
// Usage: node test/mock-fpl.js   → http://localhost:4100/api/...
import http from 'node:http';

let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const r2 = (n) => Math.round(n * 100) / 100;

const TEAMS = ['Arsenal:ARS', 'Aston Villa:AVL', 'Bournemouth:BOU', 'Brentford:BRE', 'Brighton:BHA', 'Burnley:BUR', 'Chelsea:CHE', 'Crystal Palace:CRY', 'Everton:EVE', 'Fulham:FUL', 'Leeds:LEE', 'Liverpool:LIV', 'Man City:MCI', 'Man Utd:MUN', 'Newcastle:NEW', "Nott'm Forest:NFO", 'Sunderland:SUN', 'Spurs:TOT', 'West Ham:WHU', 'Wolves:WOL']
  .map((s, i) => { const [name, short_name] = s.split(':'); return { id: i + 1, name, short_name, strength: 2 + Math.floor(rnd() * 4) }; });

const CUR = 9; // current gameweek, in progress
const now = Date.now();
const events = Array.from({ length: 38 }, (_, i) => {
  const id = i + 1;
  const deadline = new Date(now + (id - CUR) * 7 * 864e5 - 2 * 864e5 + (id > CUR ? 3 * 864e5 : 0));
  return { id, name: `Gameweek ${id}`, deadline_time: deadline.toISOString(), is_current: id === CUR, is_next: id === CUR + 1, is_previous: id === CUR - 1, finished: id < CUR, average_entry_score: 50 };
});

const SUR = ['Smith', 'Silva', 'Jones', 'Gomes', 'Saka', 'Haaland', 'Palmer', 'Salah', 'Isak', 'Watkins', 'Rice', 'Gordon', 'Mbeumo', 'Wood', 'Cunha', 'Bowen', 'Eze', 'Son', 'Raya', 'Pickford', 'Gvardiol', 'Alexander', 'Robinson', 'Munoz', 'Semenyo', 'Kluivert', 'Wissa', 'Solanke', 'Mateta', 'Wirtz', 'Ekitike', 'Gyokeres', 'Sesko', 'Reijnders', 'Cherki', 'Guehi', 'Timber', 'Gabriel', 'Saliba', 'Virgil', 'Konate', 'Dalot', 'Mazraoui', 'Tarkowski', 'Andersen', 'Lacroix'];
const elements = [];
let pid = 1;
for (const t of TEAMS) {
  const plan = [[1, 2], [2, 6], [3, 7], [4, 3]];
  for (const [type, count] of plan) {
    for (let k = 0; k < count; k++) {
      const starter = k < (type === 1 ? 1 : type === 2 ? 4 : type === 3 ? 4 : 1);
      const quality = (t.strength / 5) * (0.5 + rnd());
      const starts = starter ? CUR - 1 - Math.floor(rnd() * 2) : Math.floor(rnd() * 3);
      const minutes = starts * (78 + Math.floor(rnd() * 12)) + Math.floor(rnd() * 60);
      const m90 = minutes / 90;
      const xg90 = type === 4 ? 0.35 + quality * 0.35 : type === 3 ? 0.1 + quality * 0.3 : type === 2 ? 0.04 + quality * 0.05 : 0;
      const xa90 = type === 3 ? 0.1 + quality * 0.2 : type === 4 ? 0.08 + quality * 0.12 : type === 2 ? 0.04 + quality * 0.1 : 0.01;
      const xg = r2(xg90 * m90), xa = r2(xa90 * m90);
      const goals = Math.max(0, Math.round(xg + (rnd() - 0.5) * 3));
      const assists = Math.max(0, Math.round(xa + (rnd() - 0.5) * 2));
      const xgc90 = 1.9 - t.strength * 0.22;
      const cost = Math.round((type === 1 ? 45 : type === 2 ? 45 : 55) + quality * (type >= 3 ? 55 : 20) + (starter ? 5 : 0));
      const st = rnd() < 0.06 ? pick(['i', 'd', 'd', 's']) : 'a';
      const pts = Math.round(starts * 2 + goals * [0, 10, 6, 5, 4][type] + assists * 3 + rnd() * 10);
      const dc90 = type === 2 ? 6 + rnd() * 7 : type === 3 ? 4 + rnd() * 8 : 1 + rnd() * 3;
      elements.push({
        id: pid, web_name: `${pick(SUR)}${pid % 7 === 0 ? '.' + pid : ''}`, first_name: 'Test', second_name: `Player ${pid}`, team: t.id, element_type: type,
        now_cost: cost, cost_change_event: rnd() < 0.05 ? pick([1, -1]) : 0, status: st,
        chance_of_playing_next_round: st === 'a' ? null : st === 'd' ? pick([25, 50, 75]) : 0,
        news: st === 'a' ? '' : st === 'd' ? 'Knock - 50% chance of playing' : st === 's' ? 'Suspended until GW11' : 'Hamstring injury - Expected back late Nov',
        news_added: st === 'a' ? null : new Date(now - rnd() * 5 * 864e5).toISOString(),
        form: (rnd() * 8).toFixed(1), total_points: pts, points_per_game: (pts / Math.max(1, starts)).toFixed(1),
        selected_by_percent: (quality * quality * 25 * (starter ? 1 : 0.1)).toFixed(1),
        minutes, starts, goals_scored: goals, assists, clean_sheets: type <= 2 ? Math.floor(starts * rnd() * 0.5) : 0,
        expected_goals: String(xg), expected_assists: String(xa), expected_goal_involvements: String(r2(xg + xa)), expected_goals_conceded: String(r2(xgc90 * m90)),
        expected_goals_per_90: m90 ? r2(xg / m90) : 0, expected_assists_per_90: m90 ? r2(xa / m90) : 0, expected_goal_involvements_per_90: m90 ? r2((xg + xa) / m90) : 0, expected_goals_conceded_per_90: m90 ? r2(xgc90) : 0,
        saves: type === 1 ? Math.round(starts * 2.8) : 0, bonus: Math.round(rnd() * 8 * quality), bps: Math.round(minutes / 4), ict_index: (rnd() * 80).toFixed(1),
        defensive_contribution: Math.round(dc90 * m90), defensive_contribution_per_90: r2(dc90),
        ep_next: (rnd() * 6).toFixed(1), ep_this: (rnd() * 6).toFixed(1), transfers_in_event: Math.floor(rnd() * rnd() * 300000), transfers_out_event: Math.floor(rnd() * rnd() * 200000),
      });
      pid++;
    }
  }
}

// Round-robin fixtures, with one blank and one double for realism.
const fixtures = [];
let fid = 1;
const ids = TEAMS.map((t) => t.id);
for (let gw = 1; gw <= 38; gw++) {
  const rot = [ids[0], ...ids.slice(1).map((_, i, a) => a[(i + gw) % a.length])];
  for (let i = 0; i < 10; i++) {
    let h = rot[i], a = rot[19 - i];
    if (gw % 2) [h, a] = [a, h];
    if (gw === 12 && i === 0) continue; // blank for two teams in GW12
    const sh = TEAMS[h - 1].strength, sa = TEAMS[a - 1].strength;
    const done = gw < CUR || (gw === CUR && i < 6);
    fixtures.push({ id: fid++, event: gw, team_h: h, team_a: a, team_h_difficulty: Math.min(5, Math.max(2, sa)), team_a_difficulty: Math.min(5, Math.max(2, sh)), kickoff_time: new Date(new Date(events[gw - 1].deadline_time).getTime() + 864e5).toISOString(), finished: done, started: done || (gw === CUR && i < 8), team_h_score: done ? Math.floor(rnd() * 4) : null, team_a_score: done ? Math.floor(rnd() * 3) : null });
  }
  if (gw === 14) fixtures.push({ id: fid++, event: 14, team_h: rot[0], team_a: rot[19], team_h_difficulty: 3, team_a_difficulty: 3, kickoff_time: events[13].deadline_time, finished: false, started: false, team_h_score: null, team_a_score: null });
}

const chips = [];
for (const [name, half] of [['wildcard', 1], ['freehit', 1], ['bboost', 1], ['3xc', 1], ['wildcard', 2], ['freehit', 2], ['bboost', 2], ['3xc', 2]]) {
  chips.push({ id: chips.length + 1, name, number: 1, start_event: half === 1 ? 1 : 20, stop_event: half === 1 ? 19 : 38, chip_type: 'transfer' });
}
const bootstrap = { events, teams: TEAMS, elements, element_types: [1, 2, 3, 4].map((id) => ({ id, singular_name_short: ['GKP', 'DEF', 'MID', 'FWD'][id - 1] })), chips };

// Managers & leagues
function squad() {
  const s = [];
  const club = {};
  for (const [type, n] of [[1, 2], [2, 5], [3, 5], [4, 3]]) {
    const pool = elements.filter((e) => e.element_type === type).sort((a, b) => +b.selected_by_percent * (0.5 + rnd()) - +a.selected_by_percent * (0.5 + rnd()));
    for (const p of pool) {
      if (s.filter((x) => x.element_type === type).length >= n) break;
      if ((club[p.team] || 0) >= 3 || s.includes(p)) continue;
      club[p.team] = (club[p.team] || 0) + 1;
      s.push(p);
    }
  }
  return s;
}
const MANAGERS = [];
const names = ['Dream Team FC', 'Klopp Dogg', 'Expected Toulouse', 'Haaland Globetrotters', 'Saka Potatoes', 'Fiesta Del Chorizo', 'Moyes Rorke', 'Lord of the Ings', 'Ctrl Alt Defeat', 'Murder on Zidane’s Floor', 'Netflix & Chilwell', 'Obi-Wan Kenobi', 'Pique Blinders', 'Win Diesel'];
for (let i = 0; i < names.length; i++) {
  const sq = squad();
  const lineup = [...sq].sort((a, b) => a.element_type - b.element_type);
  const xi = [lineup[0], ...lineup.filter((p) => p.element_type === 2).slice(0, 4), ...lineup.filter((p) => p.element_type === 3).slice(0, 4), ...lineup.filter((p) => p.element_type === 4).slice(0, 2)];
  const bench = sq.filter((p) => !xi.includes(p));
  const order = [...xi, ...bench];
  const capt = [...xi].sort((a, b) => +b.selected_by_percent - +a.selected_by_percent)[i % 3];
  const total = 520 - i * 9 + Math.floor(rnd() * 8);
  MANAGERS.push({
    id: 1000 + i, name: names[i], first: ['Sam', 'Alex', 'Jo', 'Chris', 'Pat', 'Robin', 'Jamie', 'Max', 'Ali', 'Kit', 'Lee', 'Sky', 'Dev', 'Ash'][i], last: 'Tester', total,
    picks: order.map((p, k) => ({ element: p.id, position: k + 1, multiplier: k >= 11 ? 0 : p === capt ? 2 : 1, is_captain: p === capt, is_vice_captain: k === 1 })),
    chip: i === 3 ? 'bboost' : null,
    history: Array.from({ length: CUR }, (_, g) => ({ event: g + 1, points: 40 + Math.floor(rnd() * 40), total_points: Math.round((total * (g + 1)) / CUR), rank: 100000, overall_rank: 200000 + i * 5000, bank: 5 + i, value: 1000 + i * 3, event_transfers: 1, event_transfers_cost: g === 5 && i % 3 === 0 ? 4 : 0, points_on_bench: 4 })),
    chips: i % 2 ? [{ name: 'wildcard', time: '', event: 4 }] : i % 5 === 0 ? [{ name: '3xc', time: '', event: 6 }, { name: 'freehit', time: '', event: 8 }] : [],
    transfers: [{ element_in: order[3].id, element_out: elements[50 + i].id, event: CUR, time: new Date().toISOString(), element_in_cost: 60, element_out_cost: 55 }],
  });
}
const ME = MANAGERS[5]; // test user, 6th place
const LEAGUES = [
  { id: 501, name: 'Work League 25/26', members: MANAGERS.slice(0, 12) },
  { id: 502, name: 'Family & Friends', members: [MANAGERS[2], MANAGERS[4], ME, MANAGERS[7], MANAGERS[9], MANAGERS[12], MANAGERS[13]] },
];

const json = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname.replace(/^\/api\//, '');
  let m;
  if (u.pathname === '/rss') {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    return res.end(`<?xml version="1.0"?><rss><channel>${Array.from({ length: 8 }, (_, i) => `<item><title><![CDATA[Test headline ${i + 1}: GW${CUR + 1} captain picks & team news]]></title><link>https://example.com/article-${i}</link><pubDate>${new Date(now - i * 36e5).toUTCString()}</pubDate><description>Sample summary &amp; more.</description></item>`).join('')}</channel></rss>`);
  }
  if (p === 'bootstrap-static/') return json(res, bootstrap);
  if (p === 'fixtures/') return json(res, fixtures);
  if ((m = p.match(/^entry\/(\d+)\/$/))) {
    const mg = MANAGERS.find((x) => x.id === +m[1]);
    if (!mg) return json(res, { detail: 'Not found.' }, 404);
    return json(res, { id: mg.id, name: mg.name, player_first_name: mg.first, player_last_name: mg.last, summary_overall_points: mg.total, summary_overall_rank: 123456, summary_event_points: 61, current_event: CUR,
      leagues: { classic: [...LEAGUES.filter((l) => l.members.includes(mg)).map((l) => ({ id: l.id, name: l.name, entry_rank: l.members.sort((a, b) => b.total - a.total).indexOf(mg) + 1, league_type: 'x' })), { id: 314, name: 'Overall', entry_rank: 123456, league_type: 's' }] } });
  }
  if ((m = p.match(/^entry\/(\d+)\/history\/$/))) { const mg = MANAGERS.find((x) => x.id === +m[1]); return mg ? json(res, { current: mg.history, chips: mg.chips, past: [] }) : json(res, {}, 404); }
  if ((m = p.match(/^entry\/(\d+)\/transfers\/$/))) { const mg = MANAGERS.find((x) => x.id === +m[1]); return mg ? json(res, mg.transfers) : json(res, {}, 404); }
  if ((m = p.match(/^entry\/(\d+)\/event\/(\d+)\/picks\/$/))) {
    const mg = MANAGERS.find((x) => x.id === +m[1]);
    if (!mg) return json(res, {}, 404);
    return json(res, { active_chip: mg.chip, entry_history: { ...mg.history.at(-1), points: 55 }, picks: mg.picks.map((pk) => ({ ...pk, multiplier: mg.chip === 'bboost' && pk.position > 11 ? 1 : pk.multiplier })) });
  }
  if ((m = p.match(/^leagues-classic\/(\d+)\/standings\/$/))) {
    const lg = LEAGUES.find((l) => l.id === +m[1]);
    if (!lg) return json(res, {}, 404);
    const rows = [...lg.members].sort((a, b) => b.total - a.total).map((mg, i) => ({ entry: mg.id, entry_name: mg.name, player_name: `${mg.first} ${mg.last}`, rank: i + 1, last_rank: i + 1 + (i % 3) - 1 || 1, total: mg.total, event_total: mg.history.at(-1).points }));
    return json(res, { league: { id: lg.id, name: lg.name }, standings: { has_next: false, page: 1, results: rows } });
  }
  if ((m = p.match(/^event\/(\d+)\/live\/$/))) return json(res, { elements: elements.map((e) => ({ id: e.id, stats: { minutes: rnd() < 0.6 ? 90 : 0, total_points: Math.floor(rnd() * 10) } })) });
  if ((m = p.match(/^element-summary\/(\d+)\/$/))) {
    return json(res, { fixtures: [], history: Array.from({ length: CUR - 1 }, (_, g) => ({ round: g + 1, opponent_team: 1 + ((g * 3) % 20), was_home: g % 2 === 0, minutes: 90, goals_scored: rnd() < 0.2 ? 1 : 0, assists: rnd() < 0.15 ? 1 : 0, expected_goals: (rnd() * 0.6).toFixed(2), expected_assists: (rnd() * 0.3).toFixed(2), total_points: Math.floor(rnd() * 12) })) });
  }
  json(res, { detail: 'Not found.' }, 404);
}).listen(4100, () => console.log('Mock FPL on http://localhost:4100 — test team ID', ME.id));
