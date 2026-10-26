import { fpl, news, youtube, pool, clearMemory } from './api.js';
import * as M from './model.js';

// ---------- settings & state ----------
// FPL team IDs for creators aren't public knowledge we can rely on, so the user fills them in.
const DEFAULT_CREATORS = [
  { name: "Let's Talk FPL", yt: '@LetsTalkFPL', ytId: 'UCxeOc7eFxq37yW_Nc-69deA', fplId: null },
  { name: 'FPL Harry', yt: '@FPLHarry', ytId: null, fplId: null },
];
const DEFAULTS = { teamId: null, leagues: [], above: 5, below: 3, horizon: 5, notify: false, creators: DEFAULT_CREATORS };
const settings = { ...DEFAULTS, ...readLS('gaffer:settings', {}) };
const state = { creators: null, ctx: null, entry: null, history: null, picks: null, live: null, leagues: new Map(), news: null, updates: [] };

function readLS(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function writeLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
const saveSettings = () => writeLS('gaffer:settings', settings);

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 1) => (n == null || Number.isNaN(n) ? '–' : Number(n).toFixed(d));
const int = (n) => (n == null ? '–' : Number(n).toLocaleString('en-GB'));
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
const team = (id) => state.ctx.teams.get(id);
const tShort = (id) => team(id)?.short_name ?? '?';
const pct = (v) => `${Math.round(v * 100)}%`;

function fxChips(fxs) {
  if (!fxs.length) return `<span class="fdr fdr-b">—</span>`;
  return fxs.map((f) => `<span class="fdr fdr-${f.diff}">${esc(tShort(f.opp))}${f.home ? '' : '<small>a</small>'}</span>`).join('');
}
function fxRun(teamId, n = state.settings?.horizon || settings.horizon) {
  return M.fixtureRun(teamId, state.ctx, n).map((g) => `<span class="fxgw">${fxChips(g.fxs)}</span>`).join('');
}
function statusDot(p) {
  if (p.status === 'a' && p.chance_of_playing_next_round == null) return '';
  const c = p.status === 'd' ? 'amber' : p.status === 'a' ? 'amber' : 'red';
  const pctTxt = p.chance_of_playing_next_round != null ? `${p.chance_of_playing_next_round}%` : p.status === 's' ? 'Susp' : 'Out';
  return `<span class="dot ${c}" title="${esc(p.news)}">${pctTxt}</span>`;
}
function playerLink(p, extra = '') {
  return `<button class="plink" data-player="${p.id}">${esc(p.web_name)}</button>${extra}`;
}
function timeAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function countdown(iso) {
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return 'Deadline passed';
  const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.floor((ms % 36e5) / 6e4);
  return d ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
}
const card = (title, body, extra = '') => `<section class="card ${extra}"><h2>${title}</h2>${body}</section>`;
const empty = (msg) => `<p class="muted">${msg}</p>`;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 3000);
}

// ---------- loading ----------
async function loadCore(fresh = false) {
  if (fresh) clearMemory();
  const [boot, fixtures] = await Promise.all([fpl.bootstrap({ fresh }), fpl.fixtures({ fresh })]);
  state.ctx = M.buildContext(boot, fixtures);
  state.settings = settings;
  if (!settings.teamId) return;
  const id = settings.teamId;
  const [entry, history] = await Promise.all([fpl.entry(id, { fresh }), fpl.history(id, { fresh })]);
  state.entry = entry;
  state.history = history;
  const gw = state.ctx.current?.id;
  state.picks = gw ? await fpl.picks(id, gw, { fresh }).catch(() => null) : null;
  if (!state.picks && entry?.current_event && entry.current_event !== gw) {
    state.picks = await fpl.picks(id, entry.current_event, { fresh }).catch(() => null);
  }
  state.live = gw && !state.ctx.current.finished ? await fpl.live(gw, { fresh }).catch(() => null) : null;
}

async function loadLeague(leagueId, fresh = false) {
  const ctx = state.ctx;
  const meId = settings.teamId;
  let page = 1, rows = [], league = null, hasNext = true, meRow = null;
  while (hasNext && page <= 6 && !meRow) {
    const s = await fpl.standings(leagueId, page, { fresh });
    if (!s) break;
    league = s.league;
    rows = rows.concat(s.standings.results);
    meRow = rows.find((r) => r.entry === meId);
    hasNext = s.standings.has_next;
    page++;
  }
  if (!league) throw new Error('League not found');
  const idx = rows.findIndex((r) => r.entry === meId);
  let rivalsRows;
  if (idx === -1) rivalsRows = rows.slice(0, settings.above + settings.below);
  else rivalsRows = [...rows.slice(Math.max(0, idx - settings.above), idx), ...rows.slice(idx + 1, idx + 1 + settings.below)];
  if (idx === 0) rivalsRows = rows.slice(1, 1 + settings.above + settings.below);

  const gw = ctx.current?.id;
  const rivals = await pool(rivalsRows, 4, async (r) => {
    const [picks, history, transfers] = await Promise.all([
      gw ? fpl.picks(r.entry, gw, { fresh }).catch(() => null) : null,
      fpl.history(r.entry, { fresh }).catch(() => null),
      fpl.transfers(r.entry, { fresh }).catch(() => []),
    ]);
    return { entry: r.entry, name: r.entry_name, player: r.player_name, rank: r.rank, lastRank: r.last_rank, total: r.total, eventTotal: r.event_total, picks, history, transfers };
  });
  const me = {
    entry: meId,
    name: state.entry?.name || 'You',
    player: `${state.entry?.player_first_name || ''} ${state.entry?.player_last_name || ''}`.trim(),
    rank: meRow?.rank ?? null,
    lastRank: meRow?.last_rank ?? null,
    total: meRow?.total ?? state.entry?.summary_overall_points ?? 0,
    eventTotal: meRow?.event_total ?? state.entry?.summary_event_points ?? 0,
    picks: effectivePicks(),
    history: state.history,
  };
  const valid = rivals.filter(Boolean);
  const cmp = M.compareRivals(me, valid, ctx, { horizon: settings.horizon });
  const plan = M.leaguePlan(cmp, me, ctx, settings.horizon);
  if (state.live) for (const r of cmp.rows) r.live = M.livePoints(r.isMe ? state.picks : r.picks, state.live);
  const data = { id: leagueId, league, rows, me, meFound: idx !== -1, rivals: valid, cmp, plan, loadedAt: Date.now() };
  state.leagues.set(leagueId, data);
  recordSnapshot(data);
  return data;
}

// ---------- "since you last checked" ----------
function recordSnapshot(data) {
  const key = `gaffer:snap:${data.id}`;
  const prev = readLS(key, null);
  const now = {
    t: Date.now(),
    gw: state.ctx.current?.id,
    rows: Object.fromEntries(data.cmp.rows.map((r) => [r.entry, { rank: r.rank, total: r.total, name: r.name }])),
    squads: Object.fromEntries(data.cmp.rows.map((r) => [r.entry, r.picks ? r.picks.picks.map((p) => p.element) : []])),
    chips: Object.fromEntries(data.cmp.rows.map((r) => [r.entry, r.chips.used.map((c) => `${c.name}:${c.event}`)])),
  };
  const ups = [];
  if (prev) {
    const ln = data.league.name;
    for (const r of data.cmp.rows) {
      const p = prev.rows[r.entry];
      if (!p) continue;
      if (p.rank != null && r.rank != null && p.rank !== r.rank) {
        ups.push({ league: ln, text: `${r.isMe ? 'You' : esc(r.name)} moved ${r.rank < p.rank ? 'up' : 'down'} ${p.rank} → ${r.rank}`, tone: r.isMe ? (r.rank < p.rank ? 'good' : 'bad') : 'info' });
      }
      const ps = new Set(prev.squads[r.entry] || []);
      const ins = (now.squads[r.entry] || []).filter((id) => ps.size && !ps.has(id));
      if (!r.isMe && ins.length) ups.push({ league: ln, text: `${esc(r.name)} brought in ${ins.map((id) => esc(state.ctx.players.get(id)?.web_name)).join(', ')}`, tone: 'info' });
      const pc = new Set(prev.chips[r.entry] || []);
      for (const c of now.chips[r.entry] || []) if (!pc.has(c) && !r.isMe) ups.push({ league: ln, text: `${esc(r.name)} played ${M.chipLabel(c.split(':')[0])} (GW${c.split(':')[1]})`, tone: 'warn' });
    }
  }
  // Only roll the snapshot forward when something changed, so updates stay visible until they're stale.
  if (!prev || ups.length || prev.gw !== now.gw) writeLS(key, now);
  const stored = readLS('gaffer:updates', []);
  const fresh = ups.map((u) => ({ ...u, t: Date.now() }));
  const merged = [...fresh, ...stored].slice(0, 40);
  writeLS('gaffer:updates', merged);
  state.updates = merged;
  if (fresh.length) notify(`${fresh.length} league update${fresh.length > 1 ? 's' : ''}`, fresh.map((u) => u.text.replace(/&[^;]+;/g, '')).slice(0, 3).join('\n'));
}

async function notify(title, body) {
  if (!settings.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg) reg.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'gaffer' });
    else new Notification(title, { body });
  } catch {}
}

function deadlineReminder() {
  const nx = state.ctx?.next;
  if (!nx || !settings.notify) return;
  const ms = new Date(nx.deadline_time) - Date.now();
  const key = `gaffer:remind:${nx.id}`;
  if (ms > 0 && ms < 24 * 36e5 && !readLS(key, false)) {
    writeLS(key, true);
    notify(`${nx.name} deadline in ${countdown(nx.deadline_time)}`, 'Check your transfers and captain in Gaffer.');
  }
}

// ---------- views ----------
const views = { coach: viewCoach, creators: viewCreators, home: viewHome, team: viewTeam, leagues: viewLeagues, insights: viewInsights, news: viewNews, settings: viewSettings };
let currentLeague = null;

async function render() {
  const route = (location.hash.slice(1) || 'home').split('/')[0];
  const name = views[route] ? route : 'home';
  document.querySelectorAll('nav.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
  const main = $('#main');
  if (!state.ctx) {
    main.innerHTML = `<div class="loading">Loading FPL data…</div>`;
    return;
  }
  if (!settings.teamId && name !== 'settings' && name !== 'insights' && name !== 'news') {
    location.hash = 'settings';
    return;
  }
  try {
    main.innerHTML = await views[name]();
  } catch (err) {
    console.error(err);
    main.innerHTML = card('Something went wrong', `<p>${esc(err.message)}</p><button class="btn" data-action="refresh">Try again</button>`);
  }
  main.scrollTop = 0;
}

// ---------- planner: your team for the next deadline ----------
// FPL keeps new transfers private until the deadline, so the manager records them here.
const planGw = () => state.ctx?.next?.id || null;
const planKey = () => `gaffer:plan:${settings.teamId}:${planGw()}`;
const emptyPlan = () => ({ moves: [], captain: null, vice: null });
function getPlan() { return planGw() ? { ...emptyPlan(), ...readLS(planKey(), {}) } : emptyPlan(); }
function hasPlan() { const p = getPlan(); return !!(planGw() && state.picks && (p.moves.length || p.captain || p.vice)); }

/** Picks with planned transfers and captaincy applied (or the real picks if no plan). */
function effectivePicks() {
  if (!state.picks || !hasPlan()) return state.picks;
  const p = getPlan(), P = state.ctx.players;
  const swap = new Map(p.moves.map((m) => [m.out, m.in]));
  const picks = state.picks.picks.map((pk) => ({ ...pk, element: swap.get(pk.element) ?? pk.element }));
  const has = (id) => id && picks.some((x) => x.element === id);
  const cap = has(p.captain) ? p.captain : picks.find((x) => x.is_captain)?.element;
  let vice = has(p.vice) ? p.vice : picks.find((x) => x.is_vice_captain)?.element;
  if (vice === cap) vice = picks.find((x) => x.position <= 11 && x.element !== cap)?.element;
  for (const x of picks) {
    x.is_captain = x.element === cap;
    x.is_vice_captain = x.element === vice;
    x.multiplier = x.position > 11 ? 0 : x.is_captain ? 2 : 1;
  }
  const spent = p.moves.reduce((sum, m) => sum + ((P.get(m.in)?.now_cost || 0) - (P.get(m.out)?.now_cost || 0)), 0);
  const eh = state.picks.entry_history || {};
  return { ...state.picks, active_chip: null, picks, planned: true, entry_history: { ...eh, bank: (eh.bank ?? 0) - spent } };
}

function savePlan(p) {
  writeLS(planKey(), p);
  recomputeComparisons();
  render();
}
function planTransfer(outId, inId) {
  const p = getPlan();
  const prev = p.moves.find((m) => m.in === outId); // selling someone you planned to buy
  if (prev) {
    if (prev.out === inId) p.moves = p.moves.filter((m) => m !== prev); // back to the original player
    else prev.in = inId;
  } else p.moves.push({ out: outId, in: inId });
  if (p.captain === outId) p.captain = null;
  if (p.vice === outId) p.vice = null;
  savePlan(p);
  closeSheet();
  const P = state.ctx.players;
  toast(`Planned: ${P.get(outId)?.web_name} → ${P.get(inId)?.web_name}`);
}
function myPickIds() { return new Set((effectivePicks()?.picks || []).map((p) => p.element)); }

// Re-run rival comparisons against your planned squad (no refetch needed).
function recomputeComparisons() {
  for (const d of state.leagues.values()) {
    d.me = { ...d.me, picks: effectivePicks() };
    d.cmp = M.compareRivals(d.me, d.rivals, state.ctx, { horizon: settings.horizon });
    d.plan = M.leaguePlan(d.cmp, d.me, state.ctx, settings.horizon);
    if (state.live) for (const r of d.cmp.rows) r.live = M.livePoints(r.isMe ? state.picks : r.picks, state.live);
  }
  state.creators = null;
}

function myPlayers() {
  const p = effectivePicks();
  return p ? M.squadFromPicks(p, state.ctx) : [];
}
function bank() {
  const h = effectivePicks()?.entry_history || state.history?.current?.at(-1);
  return h ? h.bank : 0;
}

async function viewHome() {
  const ctx = state.ctx, e = state.entry;
  if (!e) return card('Team not found', `<p>Check your team ID in <a href="#settings">Settings</a>.</p>`);
  const cur = ctx.current, nx = ctx.next;
  const live = M.livePoints(state.picks, state.live);
  const gwPts = live ? live.total : state.picks?.entry_history?.points ?? e.summary_event_points;
  const last = state.history?.current?.at(-1);
  const squad = myPlayers().map((x) => x.player);

  const flagged = squad.filter((p) => M.availability(p, 0) < 1);
  const caps = M.captainOptions(squad, ctx);
  const ideas = M.transferIdeas(squad, bank(), ctx, { horizon: settings.horizon, limit: 3 });

  const alerts = [];
  for (const p of flagged) alerts.push(`<li class="warn">${playerLink(p)} ${statusDot(p)} <span class="muted">${esc(p.news)}</span></li>`);
  if (caps[0]) alerts.push(`<li class="info">Captain: ${playerLink(caps[0].p)} projects ${fmt(caps[0].pts)} pts next GW${caps[1] ? `, ahead of ${esc(caps[1].p.web_name)} (${fmt(caps[1].pts)})` : ''}.</li>`);
  if (ideas.points[0]) {
    const i = ideas.points[0];
    alerts.push(`<li class="good">Best transfer: ${playerLink(i.out)} → ${playerLink(i.in)} (£${M.price(i.in)}m), +${fmt(i.gain)} projected pts over ${settings.horizon} GWs.</li>`);
  }

  const leagueCards = settings.leagues.map((id) => {
    const d = state.leagues.get(id);
    if (!d) return `<div class="lg-card" data-league="${id}"><div class="muted">Loading league…</div></div>`;
    const me = d.cmp.rows.find((r) => r.isMe);
    const leader = d.cmp.rows.reduce((a, b) => (b.total > a.total ? b : a));
    const above = d.cmp.rows.filter((r) => r.gap > 0).sort((a, b) => a.gap - b.gap)[0];
    const below = d.cmp.rows.filter((r) => !r.isMe && r.gap <= 0).sort((a, b) => b.gap - a.gap)[0];
    const move = me.lastRank && me.rank ? me.lastRank - me.rank : 0;
    return `<a class="lg-card" href="#leagues/${id}">
      <div class="lg-name">${esc(d.league.name)}</div>
      <div class="lg-rank">${me.rank ?? '–'}<small>${move > 0 ? `<span class="up">▲${move}</span>` : move < 0 ? `<span class="down">▼${-move}</span>` : ''}</small></div>
      <div class="lg-gaps">
        ${leader.isMe ? '<span class="good">You lead</span>' : `<span>Leader <b>${signed(-(leader.total - me.total))}</b></span>`}
        ${above && !leader.isMe ? `<span>Next up <b>${signed(-above.gap)}</b></span>` : ''}
        ${below ? `<span>Behind you <b>${signed(-below.gap)}</b></span>` : ''}
      </div></a>`;
  });

  const ups = state.updates.slice(0, 6);
  const headlines = (state.news?.items || []).slice(0, 5);

  return `
  <section class="hero">
    <div class="hero-top"><div><div class="hero-team">${esc(e.name)}</div><div class="muted">${esc(e.player_first_name)} ${esc(e.player_last_name)}</div></div>
      <button class="icon-btn" data-action="refresh" aria-label="Refresh">⟳</button></div>
    <div class="stats4">
      <div><span>${cur ? `GW${cur.id}` : 'GW'}${live ? ' <em class="live">LIVE</em>' : ''}</span><b>${gwPts ?? '–'}</b></div>
      <div><span>Total</span><b>${int(e.summary_overall_points)}</b></div>
      <div><span>Overall rank</span><b>${int(e.summary_overall_rank)}</b></div>
      <div><span>Value · Bank</span><b>£${fmt((last?.value ?? 0) / 10)}m</b><small>£${fmt(bank() / 10)}m ITB</small></div>
    </div>
    ${nx ? `<div class="deadline">${esc(nx.name)} deadline <b data-countdown="${nx.deadline_time}">${countdown(nx.deadline_time)}</b> <span class="muted">${new Date(nx.deadline_time).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></div>` : ''}
  </section>
  ${card('Your leagues', settings.leagues.length ? `<div class="lg-grid">${leagueCards.join('')}</div>` : empty('Pick the leagues you want to win in <a href="#settings">Settings</a>.'))}
  ${card('To do this week', alerts.length ? `<ul class="alerts">${alerts.join('')}</ul>` : empty('Nothing urgent. Your squad is fit.'))}
  ${card('Since you last checked', ups.length ? `<ul class="alerts">${ups.map((u) => `<li class="${u.tone}"><span class="tag">${esc(u.league)}</span> ${u.text} <span class="muted">${timeAgo(new Date(u.t).toISOString())}</span></li>`).join('')}</ul>` : empty('No rival moves since your last visit. Rank changes, rival transfers and chips will show here.'))}
  ${card('Latest headlines', headlines.length ? newsList(headlines) : empty('Loading news…'), '')}
  `;
}

function pitchChip(pk, ctx, showLive = true) {
  const p = pk.player;
  const fx = M.fixtureRun(p.team, ctx, 1)[0];
  const pr = M.project(p, ctx, 1).next;
  const livePts = showLive && state.live ? state.live.elements.find((e) => e.id === p.id)?.stats.total_points : null;
  return `<button class="pchip" data-player="${p.id}">
    <span class="shirt" style="--c:${teamColor(p.team)}">${esc(tShort(p.team))}</span>
    ${pk.is_captain ? '<span class="cap">C</span>' : pk.is_vice_captain ? '<span class="cap v">V</span>' : ''}
    ${statusDot(p)}
    <span class="pname">${esc(p.web_name)}</span>
    <span class="pfx">${livePts != null ? `<b>${livePts * (pk.multiplier || 1)}</b> pts` : fx ? fxChips(fx.fxs) : ''}</span>
    <span class="pproj">${fmt(pr)} xP</span>
  </button>`;
}

async function viewTeam() {
  const ctx = state.ctx;
  const sq = myPlayers();
  if (!sq.length) return card('No squad yet', empty('Your picks will appear once the first deadline has passed.'));
  const planned = hasPlan();
  const xi = sq.filter((x) => x.position <= 11), bench = sq.filter((x) => x.position > 11);
  const rows = [1, 2, 3, 4].map((t) => `<div class="prow">${xi.filter((x) => x.player.element_type === t).map((x) => pitchChip(x, ctx, !planned)).join('')}</div>`);
  const pl = getPlan(), P = ctx.players;
  const planCard = planGw() ? card(`Your team for GW${planGw()}`, `
    ${planned ? `<ul class="plan-moves">${pl.moves.map((m, i) => `<li><span class="bad">${esc(P.get(m.out)?.web_name)}</span> → <b class="good">${esc(P.get(m.in)?.web_name)}</b> <span class="muted">£${M.price(P.get(m.in))}m</span><button class="x" data-action="plan-undo" data-i="${i}" aria-label="Undo">✕</button></li>`).join('')}
      ${pl.captain ? `<li>Captain: <b>${esc(P.get(pl.captain)?.web_name)}</b></li>` : ''}${pl.vice ? `<li>Vice-captain: <b>${esc(P.get(pl.vice)?.web_name)}</b></li>` : ''}</ul>
      <p class="small">${pl.moves.length} transfer${pl.moves.length === 1 ? '' : 's'} · £${fmt(bank() / 10)}m left in the bank${bank() < 0 ? ' <b class="bad">(over budget)</b>' : ''}</p>
      <button class="btn ghost small-btn" data-action="plan-reset">Clear plan</button>`
    : `<p class="small">FPL keeps your new transfers private until the deadline, so this shows your GW${ctx.current?.id} team. Made transfers or changed captain for GW${planGw()}? Tap a player on the pitch → <b>Transfer out</b> or <b>Make captain</b>. Everything in the app, including the Coach and league comparisons, then uses your new team.</p>`}`, planned ? 'plan-on' : '') : '';
  const players = sq.map((x) => x.player);

  const lg = currentLeague && state.leagues.get(currentLeague) || state.leagues.get(settings.leagues[0]);
  const own = lg?.cmp.own || new Map();
  const caps = M.captainOptions(players, ctx, lg?.cmp.caps, lg?.cmp.n);
  const ideas = M.transferIdeas(players, bank(), ctx, { horizon: settings.horizon, own });
  const ideaRow = (i, rel) => `<tr><td>${playerLink(i.out)}<div class="sub">${fmt(i.outProj)} xP</div></td><td class="arrow">→</td>
    <td>${playerLink(i.in)} <span class="muted">£${M.price(i.in)}</span><div class="sub">${fmt(i.inProj)} xP · ${tShort(i.in.team)} ${lg ? `· ${pct(i.candOwn)} rivals own` : ''}</div></td>
    <td class="num ${rel ? '' : 'good'}">+${fmt(rel ? i.rel : i.gain)}${planGw() ? `<div><button class="mini" data-plan-in="${i.in.id}" data-out="${i.out.id}">Add to plan</button></div>` : ''}</td></tr>`;

  const sorted = [...players].sort((a, b) => a.element_type - b.element_type || M.project(b, ctx, settings.horizon).total - M.project(a, ctx, settings.horizon).total);
  return `
  ${planCard}
  <section class="pitch">
    ${planned ? `<div class="chip-on">Planned team · GW${planGw()}</div>` : ''}
    ${rows.join('')}
    <div class="bench"><span class="muted">Bench</span>${bench.map((x) => pitchChip(x, ctx, !planned)).join('')}</div>
    ${!planned && state.picks.active_chip ? `<div class="chip-on">${M.chipLabel(state.picks.active_chip)} active</div>` : ''}
  </section>
  ${card('Captain picks — next GW', `<table class="tbl"><thead><tr><th>Player</th><th>Fixture</th><th class="num">xP</th>${lg ? '<th class="num">Rivals capt.</th>' : ''}</tr></thead><tbody>
    ${caps.map((c) => `<tr><td>${playerLink(c.p)}</td><td>${fxChips(M.fixtureRun(c.p.team, ctx, 1)[0]?.fxs || [])}</td><td class="num">${fmt(c.pts)}</td>${lg ? `<td class="num">${pct(c.rivalCap)}</td>` : ''}</tr>`).join('')}
  </tbody></table>${lg ? `<p class="note">Captaining someone your rivals haven't is how you gain ground; matching them protects a lead.</p>` : ''}`)}
  ${card(`Transfer ideas — next ${settings.horizon} GWs`, `
    <h3>Most projected points</h3>
    ${ideas.points.length ? `<table class="tbl ideas"><tbody>${ideas.points.slice(0, 5).map((i) => ideaRow(i, false)).join('')}</tbody></table>` : empty('No clear upgrades within budget.')}
    ${lg ? `<h3>Best for beating your rivals <span class="muted">(${esc(lg.league.name)})</span></h3>
    ${ideas.rivals.length ? `<table class="tbl ideas"><tbody>${ideas.rivals.slice(0, 5).map((i) => ideaRow(i, true)).join('')}</tbody></table>` : empty('No rival-beating moves found.')}
    <p class="note">"Beating rivals" counts only the points your rivals won't also get: a player half of them own is worth half as much to you in this league.</p>` : ''}
    <p class="note">Budget uses current prices plus £${fmt(bank() / 10)}m in the bank. Your real selling prices may be a little lower.</p>`)}
  ${card('Squad detail', `<div class="scroll-x"><table class="tbl dense"><thead><tr><th>Player</th><th class="num">£</th><th class="num">Form</th><th class="num">xGI/90</th><th class="num">Own</th>${lg ? '<th class="num">Rivals</th>' : ''}<th>Next ${settings.horizon}</th><th class="num">xP</th></tr></thead><tbody>
    ${sorted.map((p) => `<tr><td>${playerLink(p, ' ' + statusDot(p))}<div class="sub">${M.POS[p.element_type]} · ${tShort(p.team)}</div></td><td class="num">${M.price(p)}</td><td class="num">${p.form}</td><td class="num">${fmt(M.per90(p, 'expected_goal_involvements'), 2)}</td><td class="num">${fmt(+p.selected_by_percent, 0)}%</td>${lg ? `<td class="num">${pct(own.get(p.id) || 0)}</td>` : ''}<td class="fxrow">${fxRun(p.team)}</td><td class="num"><b>${fmt(M.project(p, ctx, settings.horizon).total)}</b></td></tr>`).join('')}
  </tbody></table></div>`)}
  `;
}

async function viewLeagues() {
  if (!settings.leagues.length) return card('No leagues tracked', `<p>Choose your leagues in <a href="#settings">Settings</a>.</p>`);
  const hashId = +location.hash.split('/')[1];
  currentLeague = settings.leagues.includes(hashId) ? hashId : currentLeague && settings.leagues.includes(currentLeague) ? currentLeague : settings.leagues[0];
  let d = state.leagues.get(currentLeague);
  if (!d) {
    $('#main').innerHTML = `<div class="loading">Loading league and rival squads…</div>`;
    d = await loadLeague(currentLeague);
  }
  const ctx = state.ctx, cmp = d.cmp;
  const tabs = settings.leagues.map((id) => `<a class="seg ${id === currentLeague ? 'on' : ''}" href="#leagues/${id}">${esc(state.leagues.get(id)?.league.name || state.entry?.leagues?.classic?.find((l) => l.id === id)?.name || `League ${id}`)}</a>`).join('');
  const rows = [...cmp.rows].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  const showLive = !!state.live;

  const table = `<div class="scroll-x"><table class="tbl dense rivals"><thead><tr><th>#</th><th>Team</th><th class="num">Total</th><th class="num">Gap</th><th class="num">GW${showLive ? ' live' : ''}</th><th class="num">xP ${settings.horizon}GW</th><th class="num">Shared</th><th>Captain</th><th>Chips <span class="muted">(left · <s>used</s>)</span></th><th class="num">Value</th><th class="num">Hits</th></tr></thead><tbody>
    ${rows.map((r) => {
      const mv = r.lastRank && r.rank ? r.lastRank - r.rank : 0;
      return `<tr class="${r.isMe ? 'me' : ''}" ${r.isMe ? '' : `data-rival="${r.entry}"`}>
      <td>${r.rank ?? '–'}${mv > 0 ? '<span class="up">▲</span>' : mv < 0 ? '<span class="down">▼</span>' : ''}</td>
      <td><b>${esc(r.name)}</b><div class="sub">${esc(r.player)}</div></td>
      <td class="num">${int(r.total)}</td>
      <td class="num ${r.gap > 0 ? 'bad' : r.gap < 0 ? 'good' : ''}">${r.isMe ? '–' : signed(r.gap)}</td>
      <td class="num">${showLive && r.live ? r.live.total : r.eventTotal ?? '–'}${r.chip ? `<div class="sub">${M.chipLabel(r.chip)}</div>` : ''}</td>
      <td class="num">${fmt(r.proj, 0)}</td>
      <td class="num">${r.isMe ? '–' : `${r.shared}/15`}</td>
      <td>${r.captain ? esc(r.captain.web_name) : '–'}</td>
      <td class="chips">${r.chips.available.map((c) => `<span class="chipb" title="${M.chipLabel(c.name)} available until GW${c.until}">${chipShort(c.name)}</span>`).join('') || '<span class="muted">none left</span>'}${r.chips.used.length ? `<div class="sub">${r.chips.used.map((c) => `<s title="${M.chipLabel(c.name)} played GW${c.event}">${chipShort(c.name)}</s> GW${c.event}`).join(', ')}</div>` : ''}</td>
      <td class="num">${r.value != null ? `£${fmt(r.value)}` : '–'}${r.bank != null ? `<div class="sub">£${fmt(r.bank)} itb</div>` : ''}</td>
      <td class="num">${r.hits ? `-${r.hits}` : 0}</td></tr>`;
    }).join('')}
  </tbody></table></div>
  <p class="note">Tap a rival to see their squad. ${d.meFound ? '' : 'You weren\'t found in the first 300 places of this league, so the table shows the top of the league.'} ${showLive ? 'Live points exclude auto-subs.' : ''}</p>`;

  const threats = cmp.threats.length
    ? `<table class="tbl"><thead><tr><th>Player</th><th class="num">Rivals own</th><th class="num">xP</th><th>Next</th></tr></thead><tbody>${cmp.threats.map((t) => `<tr><td>${playerLink(t.p)} <span class="muted">£${M.price(t.p)}</span></td><td class="num">${pct(t.own)}</td><td class="num">${fmt(t.proj)}</td><td class="fxrow">${fxRun(t.p.team, 3)}</td></tr>`).join('')}</tbody></table>`
    : empty('Your rivals own nobody you don\'t.');
  const edges = cmp.edges.length
    ? `<table class="tbl"><thead><tr><th>Player</th><th class="num">Rivals own</th><th class="num">xP</th></tr></thead><tbody>${cmp.edges.slice(0, 8).map((t) => `<tr><td>${playerLink(t.p)}</td><td class="num">${pct(t.own)}</td><td class="num">${fmt(t.proj)}</td></tr>`).join('')}</tbody></table>`
    : empty('No picks yet.');

  return `
  <div class="segs">${tabs}</div>
  <div class="row-between"><h1>${esc(d.league.name)}</h1><button class="icon-btn" data-action="reload-league" data-id="${currentLeague}" aria-label="Refresh">⟳</button></div>
  <p class="muted small">Updated ${timeAgo(new Date(d.loadedAt).toISOString())} · comparing you with ${cmp.n} rivals (${settings.above} above, ${settings.below} below)</p>
  ${card('Game plan', `<ul class="alerts">${d.plan.map((t) => `<li class="${t.tone}">${esc(t.text)}</li>`).join('')}</ul>`)}
  ${card('You vs rivals', table)}
  <div class="two">
    ${card('Threats — rivals have, you don\'t', threats)}
    ${card('Your edge — your least-shared players', edges)}
  </div>
  ${card('Full standings', `<details><summary>Show ${d.rows.length} rows</summary><table class="tbl dense"><tbody>${d.rows.map((r) => `<tr class="${r.entry === settings.teamId ? 'me' : ''}"><td>${r.rank}</td><td>${esc(r.entry_name)}<div class="sub">${esc(r.player_name)}</div></td><td class="num">${r.event_total}</td><td class="num"><b>${int(r.total)}</b></td></tr>`).join('')}</tbody></table></details>`)}
  `;
}
const chipShort = (n) => ({ wildcard: 'WC', freehit: 'FH', bboost: 'BB', '3xc': 'TC', manager: 'AM' }[n] || n);

function rivalSheet(entryId) {
  const d = state.leagues.get(currentLeague);
  const r = d?.cmp.rows.find((x) => x.entry === entryId);
  if (!r) return;
  const ctx = state.ctx;
  const mine = myPickIds();
  const sq = r.picks ? M.squadFromPicks(r.picks, ctx) : [];
  const gw = ctx.current?.id;
  const recent = (r.transfers || []).filter((t) => t.event >= (gw || 0) - 2).slice(0, 10);
  openSheet(`
    <h2>${esc(r.name)}</h2><p class="muted">${esc(r.player)} · Rank ${r.rank} · ${signed(r.gap)} pts vs you</p>
    <h3>Squad (GW${gw})</h3>
    <ul class="squad-list">${sq.map((x) => `<li class="${mine.has(x.element) ? 'shared' : 'diff'} ${x.multiplier === 0 ? 'benched' : ''}">${playerLink(x.player)} ${x.is_captain ? '<span class="cap">C</span>' : ''} <span class="muted">${M.POS[x.player.element_type]} · ${tShort(x.player.team)}</span><span class="tag2">${mine.has(x.element) ? 'shared' : 'differential'}</span></li>`).join('') || '<li>Squad hidden until the deadline passes.</li>'}</ul>
    <h3>Recent transfers</h3>
    ${recent.length ? `<ul class="plain">${recent.map((t) => `<li>GW${t.event}: ${esc(ctx.players.get(t.element_out)?.web_name)} → <b>${esc(ctx.players.get(t.element_in)?.web_name)}</b></li>`).join('')}</ul>` : empty('None in the last 3 GWs.')}
    <h3>Chips</h3>
    <p>Used: ${r.chips.used.map((c) => `${M.chipLabel(c.name)} (GW${c.event})`).join(', ') || 'none'}<br>Left now: ${r.chips.available.map((c) => `${M.chipLabel(c.name)} (until GW${c.until})`).join(', ') || 'none'}${r.chips.later.length ? `<br><span class="muted">New set from GW${r.chips.later[0].from}: ${r.chips.later.map((c) => M.chipLabel(c.name)).join(', ')}</span>` : ''}</p>
  `);
}

async function viewInsights() {
  const ctx = state.ctx;
  const L = M.insightLists(ctx, settings.horizon);
  const mine = myPickIds();
  const mark = (p) => (mine.has(p.id) ? ' <span class="mine">●</span>' : '');
  const pos = +(location.hash.split('/')[1] || 3);
  const posTabs = [1, 2, 3, 4].map((t) => `<a class="seg ${t === pos ? 'on' : ''}" href="#insights/${t}">${M.POS[t]}</a>`).join('');

  const ticker = `<div class="scroll-x"><table class="tbl dense ticker"><thead><tr><th>Team</th>${M.fixtureRun(1, ctx, 6).map((g) => `<th>GW${g.gw}</th>`).join('')}</tr></thead><tbody>
    ${L.teamsByEase.map(({ t }) => `<tr><td><b>${esc(t.short_name)}</b></td>${M.fixtureRun(t.id, ctx, 6).map((g) => `<td>${fxChips(g.fxs)}</td>`).join('')}</tr>`).join('')}
  </tbody></table></div><p class="note">Sorted easiest first over the next ${settings.horizon} GWs. Colours are FPL's difficulty ratings.</p>`;

  return `
  <h1>Insights</h1>
  <p class="muted small">Built on FPL's official stats, which come from Opta: expected goals (xG), expected assists (xA), expected goals conceded (xGC), defensive contributions and bonus points. "xP" is Gaffer's projected points: those rates × likely minutes × fixture difficulty. ● = in your squad.</p>
  ${card(`Top projected — next ${settings.horizon} GWs`, `<div class="segs">${posTabs}</div>
    <div class="scroll-x"><table class="tbl"><thead><tr><th>Player</th><th class="num">£</th><th class="num">Own</th><th>Fixtures</th><th class="num">xP</th></tr></thead><tbody>
    ${L.byPos[pos].map((x) => `<tr><td>${playerLink(x.p, mark(x.p) + ' ' + statusDot(x.p))}<div class="sub">${tShort(x.p.team)}</div></td><td class="num">${M.price(x.p)}</td><td class="num">${fmt(+x.p.selected_by_percent, 0)}%</td><td class="fxrow">${fxRun(x.p.team)}</td><td class="num"><b>${fmt(x.proj)}</b></td></tr>`).join('')}
    </tbody></table></div>`)}
  ${card('Fixture ticker', ticker)}
  <div class="two">
  ${card('Due a goal — xG well above goals', L.dueGoal.length ? `<table class="tbl"><thead><tr><th>Player</th><th class="num">G</th><th class="num">xG</th><th class="num">Gap</th></tr></thead><tbody>${L.dueGoal.map((x) => `<tr><td>${playerLink(x.p, mark(x.p))}</td><td class="num">${x.p.goals_scored}</td><td class="num">${fmt(+x.p.expected_goals)}</td><td class="num good">+${fmt(x.diff)}</td></tr>`).join('')}</tbody></table>` : empty('Nobody is significantly under-performing their xG yet.'))}
  ${card('Running hot — goals well above xG', L.hot.length ? `<table class="tbl"><thead><tr><th>Player</th><th class="num">G</th><th class="num">xG</th><th class="num">Gap</th></tr></thead><tbody>${L.hot.map((x) => `<tr><td>${playerLink(x.p, mark(x.p))}</td><td class="num">${x.p.goals_scored}</td><td class="num">${fmt(+x.p.expected_goals)}</td><td class="num bad">+${fmt(x.diff)}</td></tr>`).join('')}</tbody></table><p class="note">Likely to cool off. Don't pay up for finishing alone.</p>` : empty('No big over-performers yet.'))}
  ${card('Best xGI per 90 (450+ mins)', `<table class="tbl"><tbody>${L.xgi.map((x) => `<tr><td>${playerLink(x.p, mark(x.p))}<div class="sub">${M.POS[x.p.element_type]} · ${tShort(x.p.team)} · £${M.price(x.p)}</div></td><td class="num"><b>${fmt(x.v, 2)}</b></td></tr>`).join('')}</tbody></table>`)}
  ${card('Differentials (under 10% owned)', `<table class="tbl"><tbody>${L.diffs.map((x) => `<tr><td>${playerLink(x.p, mark(x.p))}<div class="sub">${M.POS[x.p.element_type]} · ${tShort(x.p.team)} · ${x.p.selected_by_percent}%</div></td><td class="num"><b>${fmt(x.proj)}</b> xP</td></tr>`).join('')}</tbody></table>`)}
  ${card('Best value (xP per £m)', `<table class="tbl"><tbody>${L.value.map((x) => `<tr><td>${playerLink(x.p, mark(x.p))}<div class="sub">${M.POS[x.p.element_type]} · £${M.price(x.p)}</div></td><td class="num"><b>${fmt(x.ppm, 2)}</b></td></tr>`).join('')}</tbody></table>`)}
  ${card('Transfers this GW', `<h3>Most in</h3><table class="tbl"><tbody>${L.transfersIn.map((p) => `<tr><td>${playerLink(p, mark(p))}</td><td class="num good">+${int(p.transfers_in_event)}</td></tr>`).join('')}</tbody></table>
    <h3>Most out</h3><table class="tbl"><tbody>${L.transfersOut.map((p) => `<tr><td>${playerLink(p, mark(p))}</td><td class="num bad">-${int(p.transfers_out_event)}</td></tr>`).join('')}</tbody></table>`)}
  </div>
  ${card('Price changes this GW', L.priceMoves.length ? `<div class="pills">${L.priceMoves.map((p) => `<button class="pill ${p.cost_change_event > 0 ? 'good' : 'bad'}" data-player="${p.id}">${esc(p.web_name)} ${p.cost_change_event > 0 ? '▲' : '▼'} £${M.price(p)}</button>`).join('')}</div>` : empty('No price changes yet this GW.'))}
  `;
}

function newsList(items) {
  return `<ul class="news">${items.map((n) => `<li><a href="${esc(n.link)}" target="_blank" rel="noopener">
    ${n.image ? `<img src="${esc(n.image)}" alt="" loading="lazy">` : ''}
    <div><div class="ntitle">${esc(n.title)}</div><div class="sub">${esc(n.source)} · ${timeAgo(n.published)}</div></div></a></li>`).join('')}</ul>`;
}

async function viewNews() {
  const ctx = state.ctx;
  if (!state.news) state.news = await news().catch(() => ({ items: [], sources: [] }));
  const filter = decodeURIComponent(location.hash.split('/')[1] || 'all');
  const sources = state.news.sources || [];
  const items = state.news.items.filter((n) => filter === 'all' || (filter === 'fpl' ? n.fpl : n.source === filter));
  const mine = myPickIds();
  const rivalOwn = new Map();
  for (const id of settings.leagues) {
    const d = state.leagues.get(id);
    if (d) for (const [pid, v] of d.cmp.own) rivalOwn.set(pid, Math.max(rivalOwn.get(pid) || 0, v));
  }
  const avail = M.availabilityNews(ctx);
  const relevant = avail.filter((p) => mine.has(p.id) || (rivalOwn.get(p.id) || 0) > 0);
  const others = avail.filter((p) => !relevant.includes(p)).slice(0, 25);
  const availRow = (p) => `<li>${playerLink(p)} ${statusDot(p)} <span class="muted">${tShort(p.team)}</span>
    ${mine.has(p.id) ? '<span class="tag">your squad</span>' : ''}${rivalOwn.get(p.id) ? `<span class="tag2">${pct(rivalOwn.get(p.id))} rivals</span>` : ''}
    <div class="sub">${esc(p.news)} · ${timeAgo(p.news_added)}</div></li>`;

  const chips = ['all', 'fpl', ...sources.filter((s) => s.ok).map((s) => s.source)];
  return `
  <h1>News</h1>
  ${card('Injuries & availability — your players and rivals\'', relevant.length ? `<ul class="avail">${relevant.map(availRow).join('')}</ul>` : empty('No injury news affecting you or your rivals.'))}
  ${card('Headlines', `<div class="segs wrap">${chips.map((c) => `<a class="seg ${c === filter ? 'on' : ''}" href="#news/${encodeURIComponent(c)}">${c === 'all' ? 'All' : c === 'fpl' ? 'FPL' : esc(c)}</a>`).join('')}</div>
    ${items.length ? newsList(items.slice(0, 40)) : empty('No headlines available right now.')}
    ${sources.some((s) => !s.ok) ? `<p class="note">Couldn't reach: ${sources.filter((s) => !s.ok).map((s) => esc(s.source)).join(', ')}.</p>` : ''}`)}
  ${card('Other injury news', `<details><summary>Show latest ${others.length}</summary><ul class="avail">${others.map(availRow).join('')}</ul></details>`)}
  `;
}


// ---------- AI coach ----------
const COACH_KEY = 'gaffer:coach';
const coach = { messages: readLS(COACH_KEY, []), busy: false, status: null };
const saveCoach = () => writeLS(COACH_KEY, coach.messages.slice(-30));

// Everything the coach needs to know, as compact text.
function coachContext() {
  const ctx = state.ctx, H = settings.horizon;
  const L = [];
  const p2 = (p) => {
    const pr = M.project(p, ctx, H);
    const fx = M.fixtureRun(p.team, ctx, H).map((g) => g.fxs.length ? g.fxs.map((f) => `${tShort(f.opp)}${f.home ? '(H)' : '(A)'}${f.diff}`).join('+') : 'blank').join(' ');
    return `${p.web_name} [${M.POS[p.element_type]} ${tShort(p.team)} £${M.price(p)}m] form ${p.form}, pts ${p.total_points}, mins ${p.minutes}, G ${p.goals_scored} xG ${(+p.expected_goals).toFixed(1)}, A ${p.assists} xA ${(+p.expected_assists).toFixed(1)}, xGI/90 ${M.per90(p, 'expected_goal_involvements').toFixed(2)}, owned ${p.selected_by_percent}%, xP next ${pr.next.toFixed(1)} / ${H}GW ${pr.total.toFixed(1)}${p.news ? `, NEWS: ${p.news}` : ''} | fixtures: ${fx}`;
  };
  L.push(`Current GW: ${ctx.current?.id ?? '-'}${ctx.current && !ctx.current.finished ? ' (in progress)' : ''}. Next deadline: ${ctx.next ? `${ctx.next.name} ${new Date(ctx.next.deadline_time).toUTCString()}` : 'none'}. Fixture difficulty 1 (easy) to 5 (hard).`);
  const e = state.entry;
  if (e) {
    const last = state.history?.current?.at(-1);
    L.push(`\n## Manager: ${e.name}. Total ${e.summary_overall_points} pts, overall rank ${e.summary_overall_rank}, GW pts ${e.summary_event_points}. Team value £${((last?.value ?? 0) / 10).toFixed(1)}m, bank £${(bank() / 10).toFixed(1)}m.`);
    const ch = M.chipsStatus(state.history, ctx);
    L.push(`Chips used: ${ch.used.map((c) => `${M.chipLabel(c.name)} GW${c.event}`).join(', ') || 'none'}. Chips available now: ${ch.available.map((c) => `${M.chipLabel(c.name)} (until GW${c.until})`).join(', ') || 'none'}.`);
    const recent = (state.history?.current || []).slice(-5).map((g) => `GW${g.event}: ${g.points}pts${g.event_transfers_cost ? ` (-${g.event_transfers_cost} hit)` : ''}, bench ${g.points_on_bench}`).join('; ');
    if (recent) L.push(`Recent GWs: ${recent}.`);
  }
  const sq = myPlayers();
  if (sq.length) {
    if (hasPlan()) {
      const pl = getPlan();
      L.push(`\n## Squad for GW${planGw()} INCLUDING the manager's planned/made transfers (${pl.moves.length}): ${pl.moves.map((m) => `${ctx.players.get(m.out)?.web_name} -> ${ctx.players.get(m.in)?.web_name}`).join(', ') || 'none'}. Bank after these: £${(bank() / 10).toFixed(1)}m.`);
    } else L.push(`\n## Squad (as picked for GW${ctx.current?.id}${state.picks?.active_chip ? `, chip active: ${M.chipLabel(state.picks.active_chip)}` : ''}; the manager may have made transfers for GW${planGw() ?? '-'} that FPL doesn't show until the deadline, so ask if unsure)`);
    for (const x of sq) L.push(`- ${x.position > 11 ? 'BENCH ' : ''}${x.is_captain ? '(C) ' : x.is_vice_captain ? '(VC) ' : ''}${p2(x.player)}`);
    const ideas = M.transferIdeas(sq.map((x) => x.player), bank(), ctx, { horizon: H, limit: 5 });
    if (ideas.points.length) L.push(`App's top transfer ideas (xP gain over ${H} GWs): ${ideas.points.map((i) => `${i.out.web_name} -> ${i.in.web_name} £${M.price(i.in)}m (+${i.gain.toFixed(1)})`).join('; ')}`);
  }
  for (const id of settings.leagues) {
    const d = state.leagues.get(id);
    if (!d) continue;
    L.push(`\n## Mini-league: ${d.league.name} (${d.rows.length}${d.rows.length >= 50 ? '+' : ''} teams)`);
    for (const r of [...d.cmp.rows].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))) {
      L.push(`- ${r.rank ?? '?'}. ${r.isMe ? 'YOU' : r.name}: ${r.total} pts (${r.isMe ? '-' : (r.gap > 0 ? '+' : '') + r.gap + ' vs you'}), GW ${r.eventTotal ?? '-'}, captain ${r.captain?.web_name ?? '-'}, chips left ${r.chips.available.map((c) => chipShort(c.name)).join('/') || 'none'}, value £${r.value ?? '-'}m, xP ${H}GW ${r.proj?.toFixed(0) ?? '-'}${r.isMe ? '' : `, shares ${r.shared}/15`}`);
    }
    if (d.cmp.threats.length) L.push(`Rival-owned players you lack: ${d.cmp.threats.map((t) => `${t.p.web_name} ${Math.round(t.own * 100)}%`).join(', ')}`);
    L.push(`Rival ownership of your players: ${d.cmp.edges.map((t) => `${t.p.web_name} ${Math.round(t.own * 100)}%`).join(', ')}`);
  }
  const cr = state.creators;
  if (cr?.cmp) {
    L.push(`\n## FPL creators followed`);
    for (const c of cr.list.filter((c) => c.picks)) {
      const cap = c.picks.picks.find((p) => p.is_captain);
      const tr = (c.transfers || []).filter((t) => t.event >= (ctx.current?.id || 0) - 1).map((t) => `${ctx.players.get(t.element_out)?.web_name}->${ctx.players.get(t.element_in)?.web_name} (GW${t.event})`);
      L.push(`- ${c.player}: rank ${c.overallRank ?? '-'}, captain ${ctx.players.get(cap?.element)?.web_name ?? '-'}, squad: ${c.picks.picks.map((p) => ctx.players.get(p.element)?.web_name).join(', ')}${tr.length ? `; recent transfers ${tr.join(', ')}` : ''}`);
    }
  }
  const vidLines = (settings.creators || []).flatMap((c) => (videoCache.get(ytKey(c))?.items || []).slice(0, 2).map((v) => `${c.name}: "${v.title}"`));
  if (vidLines.length) L.push(`Latest creator videos: ${vidLines.join('; ')}`);
  const I = M.insightLists(ctx, H);
  L.push(`\n## Best projected players (next ${H} GWs), for transfer targets`);
  for (const t of [1, 2, 3, 4]) L.push(`${M.POS[t]}: ${I.byPos[t].slice(0, 8).map((x) => `${x.p.web_name} ${tShort(x.p.team)} £${M.price(x.p)}m xP ${x.proj.toFixed(1)} own ${x.p.selected_by_percent}%`).join('; ')}`);
  L.push(`Differentials (<10% owned): ${I.diffs.slice(0, 8).map((x) => `${x.p.web_name} £${M.price(x.p)}m ${x.proj.toFixed(1)}`).join('; ')}`);
  L.push(`Easiest fixtures: ${I.teamsByEase.slice(0, 6).map(({ t }) => t.short_name).join(', ')}. Hardest: ${I.teamsByEase.slice(-5).map(({ t }) => t.short_name).join(', ')}.`);
  return L.join('\n');
}

// Small, safe markdown -> HTML (escape first, then format).
function md(text) {
  const inline = (s) => esc(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^#{1,4}\s+(.*)/))) { close(); out.push(`<h4>${inline(m[1])}</h4>`); }
    else if (!line.trim()) { close(); }
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return out.join('');
}

const COACH_SUGGESTIONS = [
  'Who should I captain this week?',
  'What transfer should I make this week?',
  'Is a -4 hit worth it this week?',
  'How do I catch the leader in my mini-league?',
  'When should I play my chips?',
  'Which creator picks should I copy?',
];

function coachMsgHtml(m, i) {
  return `<div class="msg ${m.role}" data-i="${i}">${m.role === 'user' ? `<p>${esc(m.content)}</p>` : md(m.content) || '<p class="muted">…</p>'}</div>`;
}

let coachStatus = null;
async function viewCoach() {
  if (!coachStatus) coachStatus = await fetch('/api/coach/status').then((r) => r.json()).catch(() => ({ configured: false }));
  if (!coachStatus.configured) {
    return `<h1>AI Coach</h1>${card('One-time setup', `<p>The coach uses Claude and needs an Anthropic API key on your server.</p>
      <ol class="steps"><li>Get a key at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a> (add a little credit under Billing).</li>
      <li>In Render, open your <b>gaffer</b> service → <b>Environment</b> → add <code>ANTHROPIC_API_KEY</code> with your key.</li>
      <li>Also add <code>COACH_PASSCODE</code> with any word you like, so only you can use your credit.</li>
      <li>Save. Render restarts the app; then come back here.</li></ol>`)}`;
  }
  const msgs = coach.messages;
  return `<div class="coach">
    <div class="row-between"><h1>AI Coach</h1>${msgs.length ? '<button class="btn ghost small-btn" data-action="coach-new">New chat</button>' : ''}</div>
    <p class="muted small">Ask anything about your team. The coach sees your squad, bank, chips, fixtures, leagues, rivals and creators, and can check the latest news.</p>
    ${coachStatus.passcode && !settings.coachCode ? card('Passcode', `<form id="coach-code" class="inline"><input name="code" placeholder="Coach passcode" required><button class="btn">Save</button></form>`) : ''}
    <div id="chat" class="chat">${msgs.map(coachMsgHtml).join('')}${coach.busy ? '' : ''}</div>
    <div id="coach-status" class="muted small">${coach.status ? esc(coach.status) : ''}</div>
    ${msgs.length ? '' : `<div class="pills">${COACH_SUGGESTIONS.map((q) => `<button class="pill" data-ask="${esc(q)}">${esc(q)}</button>`).join('')}</div>`}
    <form id="coach-form" class="ask"><textarea name="q" rows="2" placeholder="e.g. Should I sell Salah for Palmer?" ${coach.busy ? 'disabled' : ''}></textarea><button class="btn" ${coach.busy ? 'disabled' : ''}>Ask</button></form>
    <p class="note">AI advice can be wrong. Check prices and team news before the deadline.</p>
  </div>`;
}

// Drop failed exchanges (an error note and the question that caused it) from what the coach sees.
function coachHistory(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].role === 'user' && list[i + 1]?.error) { i++; continue; }
    if (!list[i].error) out.push({ role: list[i].role, content: list[i].content });
  }
  return out;
}

async function askCoach(q) {
  q = q.trim();
  if (!q || coach.busy) return;
  coach.messages.push({ role: 'user', content: q });
  const answer = { role: 'assistant', content: '' };
  coach.messages.push(answer);
  coach.busy = true;
  coach.status = 'Thinking…';
  saveCoach();
  await render();
  const chat = $('#chat');
  const el = () => chat?.querySelector('.msg.assistant:last-child');
  const scroll = () => el()?.scrollIntoView({ block: 'end' });
  scroll();
  try {
    if (settings.teamId && !state.creators) await loadCreators().catch(() => {});
    const res = await fetch('/api/coach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: coachHistory(coach.messages.slice(0, -1)), context: coachContext(), passcode: settings.coachCode || undefined }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (err.error === 'passcode_required') { settings.coachCode = ''; saveSettings(); throw new Error('Wrong or missing passcode. Enter it above.'); }
      if (err.error === 'rate_limited') throw new Error("You've asked a lot this hour. Try again later.");
      if (err.error === 'not_configured') { coachStatus = null; throw new Error('The coach is not set up on the server yet.'); }
      throw new Error('The coach is unavailable right now.');
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.t === 'text') { answer.content += ev.v; coach.status = null; }
        else if (ev.t === 'status') coach.status = ev.v;
        else if (ev.t === 'error') { if (!answer.content.trim()) answer.error = true; answer.content += (answer.content ? '\n\n' : '') + `_${ev.v}_`; }
        const node = el();
        if (node) node.innerHTML = md(answer.content) || '<p class="muted">…</p>';
        const st = $('#coach-status'); if (st) st.textContent = coach.status || '';
      }
    }
  } catch (err) {
    if (!answer.content.trim()) answer.error = true;
    answer.content += (answer.content ? '\n\n' : '') + `_${err.message}_`;
  }
  if (!answer.content.trim()) { answer.content = '_No answer came back. Try again._'; answer.error = true; }
  coach.busy = false;
  coach.status = null;
  saveCoach();
  if ((location.hash.slice(1) || '').startsWith('coach')) { await render(); scroll(); }
}

// ---------- creators ----------
function parseFplId(v) {
  const m = String(v || '').match(/entry\/(\d+)/) || String(v || '').match(/^\s*(\d{1,9})\s*$/);
  return m ? +m[1] : null;
}
function parseYt(v) {
  v = String(v || '').trim();
  let m = v.match(/(UC[\w-]{22})/);
  if (m) return { ytId: m[1], yt: null };
  m = v.match(/@([\w.-]{3,40})/) || v.match(/^([\w.-]{3,40})$/);
  return m ? { yt: '@' + m[1], ytId: null } : { yt: null, ytId: null };
}

// YouTube videos load separately so a slow YouTube never holds up the page.
const videoCache = new Map(); // creator key -> {items} | null (failed); missing = still loading
const ytKey = (c) => c.ytId || c.yt || '';
function loadCreatorVideos(fresh = false) {
  for (const c of settings.creators || []) {
    const k = ytKey(c);
    if (!k || (!fresh && videoCache.has(k))) continue;
    const timeout = new Promise((r) => setTimeout(() => r(null), 20000));
    Promise.race([youtube(c, { fresh }).catch(() => null), timeout]).then((v) => {
      videoCache.set(k, v && v.items?.length ? v : null);
      if ((location.hash.slice(1) || '').startsWith('creators') && !$('#creators-form')?.contains(document.activeElement)) render();
    });
  }
}

async function loadCreators(fresh = false) {
  const ctx = state.ctx, gw = ctx.current?.id;
  const list = settings.creators || [];
  loadCreatorVideos(fresh);
  const out = await pool(list, 3, async (c) => {
    const [entry, picks, history, transfers] = await Promise.all([
      c.fplId ? fpl.entry(c.fplId, { fresh }).catch(() => null) : null,
      c.fplId && gw ? fpl.picks(c.fplId, gw, { fresh }).catch(() => null) : null,
      c.fplId ? fpl.history(c.fplId, { fresh }).catch(() => null) : null,
      c.fplId ? fpl.transfers(c.fplId, { fresh }).catch(() => []) : [],
    ]);
    return { ...c, entryData: entry, entry: c.fplId, rank: null, overallRank: entry?.summary_overall_rank, total: entry?.summary_overall_points ?? 0, eventTotal: picks?.entry_history?.points ?? entry?.summary_event_points, picks, history, transfers, player: c.name || 'Creator', name: entry?.name || c.name || 'Creator' };
  });
  const withTeams = out.filter((c) => c && c.picks);
  const me = { entry: settings.teamId, name: state.entry?.name || 'You', player: 'You', rank: null, total: state.entry?.summary_overall_points ?? 0, eventTotal: state.entry?.summary_event_points, picks: effectivePicks(), history: state.history };
  let cmp = null;
  try { cmp = withTeams.length && effectivePicks() ? M.compareRivals(me, withTeams, ctx, { horizon: settings.horizon }) : null; } catch (e) { console.warn('creator compare', e); }
  state.creators = { list: out.filter(Boolean), cmp, loadedAt: Date.now() };
  if (cmp) { try { recordSnapshot({ id: 'creators', league: { name: 'Creators' }, cmp }); } catch (e) { console.warn(e); } }
  return state.creators;
}

async function viewCreators() {
  if (!state.creators) {
    $('#main').innerHTML = `<div class="loading">Loading creators…</div>`;
    await Promise.race([loadCreators().catch((e) => console.warn(e)), new Promise((r) => setTimeout(r, 12000))]);
    if (!state.creators) state.creators = { list: (settings.creators || []).map((c) => ({ ...c, player: c.name, name: c.name, entry: c.fplId })), cmp: null, loadedAt: Date.now() };
  }
  const ctx = state.ctx, { list, cmp } = state.creators;
  const gw = ctx.current?.id;
  const mine = myPickIds();

  const creatorCard = (c, i) => {
    const vk = ytKey(c);
    const vstate = vk ? (videoCache.has(vk) ? videoCache.get(vk) : 'loading') : null;
    const vids = vstate && vstate !== 'loading' ? vstate.items.slice(0, 3) : [];
    const e = c.entryData;
    const cap = c.picks?.picks.find((p) => p.is_captain);
    const tIn = (c.transfers || []).filter((t) => t.event === gw);
    const row = cmp?.rows.find((r) => r.entry === c.entry);
    return `<section class="card">
      <div class="row-between"><h2>${esc(c.player)}</h2>${c.yt || c.ytId ? `<a class="small" href="https://www.youtube.com/${c.ytId ? 'channel/' + esc(c.ytId) : esc(c.yt)}" target="_blank" rel="noopener">YouTube ↗</a>` : ''}</div>
      ${e ? `<div class="cstats">
          <div><span>Team</span><b>${esc(e.name)}</b></div>
          <div><span>GW${gw ?? ''}</span><b>${c.eventTotal ?? '–'}</b></div>
          <div><span>Total</span><b>${int(e.summary_overall_points)}</b></div>
          <div><span>Overall rank</span><b>${int(e.summary_overall_rank)}</b></div>
        </div>
        <p class="small">Captain: <b>${cap ? esc(ctx.players.get(cap.element)?.web_name) : '–'}</b>${c.picks?.active_chip ? ` · Chip: <b>${M.chipLabel(c.picks.active_chip)}</b>` : ''}${row ? ` · Shares <b>${row.shared}/15</b> with you` : ''}
        ${tIn.length ? `<br>GW${gw} transfers: ${tIn.map((t) => `${esc(ctx.players.get(t.element_out)?.web_name)} → <b>${esc(ctx.players.get(t.element_in)?.web_name)}</b>`).join(', ')}` : ''}</p>
        <button class="btn ghost small-btn" data-creator="${c.entry}">See full squad</button>`
      : c.fplId ? `<p class="muted">Couldn't load FPL team ${c.fplId}. Check the ID below.</p>` : `<p class="muted">Add their FPL team ID below to see their squad.</p>`}
      <h3>Latest videos</h3>
      ${vids.length ? `<ul class="news">${vids.map((v) => `<li><a href="${esc(v.link)}" target="_blank" rel="noopener">${v.image ? `<img src="${esc(v.image)}" alt="" loading="lazy">` : ''}<div><div class="ntitle">${esc(v.title)}</div><div class="sub">${timeAgo(v.published)}</div></div></a></li>`).join('')}</ul>`
        : vstate === 'loading' ? empty('Loading videos…') : vk ? empty(`Couldn't load videos right now. <a href="https://www.youtube.com/${c.ytId ? 'channel/' + esc(c.ytId) : esc(c.yt)}/videos" target="_blank" rel="noopener">Open on YouTube</a>`) : empty('No YouTube channel set.')}
    </section>`;
  };

  let consensus = '';
  if (cmp) {
    const n = cmp.n;
    const owned = [...cmp.own].map(([id, o]) => ({ p: ctx.players.get(id), o })).filter((x) => x.p).sort((a, b) => b.o - a.o || M.project(b.p, ctx, settings.horizon).total - M.project(a.p, ctx, settings.horizon).total);
    const missing = owned.filter((x) => !mine.has(x.p.id)).slice(0, 10);
    const caps = [...cmp.caps].sort((a, b) => b[1] - a[1]);
    consensus = card(`What the creators have that you don't`, missing.length
      ? `<table class="tbl"><thead><tr><th>Player</th><th class="num">Creators</th><th class="num">xP ${settings.horizon}GW</th><th>Next</th></tr></thead><tbody>${missing.map((x) => `<tr><td>${playerLink(x.p)} ${statusDot(x.p)} <span class="muted">£${M.price(x.p)}</span></td><td class="num">${Math.round(x.o * n)}/${n}</td><td class="num">${fmt(M.project(x.p, ctx, settings.horizon).total)}</td><td class="fxrow">${fxRun(x.p.team, 3)}</td></tr>`).join('')}</tbody></table>`
      : empty('You own every player the creators own.'))
      + card('Creator captains this GW', caps.length ? `<p>${caps.map(([id, c]) => `${playerLink(ctx.players.get(id))} <span class="muted">(${c}/${n})</span>`).join(' · ')}</p>` : empty('No captains yet.'));
  }

  const editor = card('Creators you follow', `
    <form id="creators-form" class="stack">
      ${(settings.creators || []).map((c, i) => `<fieldset class="creator-row">
        <label>Name <input name="name" value="${esc(c.name)}" required></label>
        <label>YouTube <input name="yt" value="${esc(c.ytId || c.yt || '')}" placeholder="@handle or channel link"></label>
        <label>FPL team ID or link <input name="fpl" value="${c.fplId ?? ''}" placeholder="e.g. 1234567"></label>
        <button type="button" class="btn ghost" data-action="remove-creator" data-i="${i}">Remove</button>
      </fieldset>`).join('')}
      <div class="inline"><button type="button" class="btn ghost" data-action="add-creator">+ Add creator</button><button class="btn" type="submit">Save</button></div>
    </form>
    <p class="note"><b>Finding a creator's FPL team ID:</b> creators usually show their team or link it in the video description or on X/Twitter. On the FPL site or app, open their team from a league you're both in, or from their shared link; the number after <code>/entry/</code> is the ID. You can paste the whole link here.</p>`);

  return `<h1>Creators</h1>
    <p class="muted small">Their latest videos, their FPL teams and how your squad compares.</p>
    ${list.map(creatorCard).join('')}
    ${consensus}
    ${editor}`;
}

function creatorSheet(entryId) {
  const c = state.creators?.list.find((x) => x.entry === entryId);
  if (!c?.picks) return;
  const ctx = state.ctx, gw = ctx.current?.id;
  const mine = myPickIds();
  const sq = M.squadFromPicks(c.picks, ctx);
  const chips = M.chipsStatus(c.history, ctx);
  const recent = (c.transfers || []).filter((t) => t.event >= (gw || 0) - 2).slice(0, 10);
  openSheet(`
    <h2>${esc(c.player)} · ${esc(c.name)}</h2>
    <p class="muted">Overall rank ${int(c.overallRank)} · ${int(c.total)} pts</p>
    <h3>Squad (GW${gw})</h3>
    <ul class="squad-list">${sq.map((x) => `<li class="${mine.has(x.element) ? 'shared' : 'diff'} ${x.multiplier === 0 ? 'benched' : ''}">${playerLink(x.player)} ${x.is_captain ? '<span class="cap">C</span>' : ''} <span class="muted">${M.POS[x.player.element_type]} · ${tShort(x.player.team)} · £${M.price(x.player)}</span><span class="tag2">${mine.has(x.element) ? 'you have' : 'you don\'t'}</span></li>`).join('')}</ul>
    <h3>Recent transfers</h3>
    ${recent.length ? `<ul class="plain">${recent.map((t) => `<li>GW${t.event}: ${esc(ctx.players.get(t.element_out)?.web_name)} → <b>${esc(ctx.players.get(t.element_in)?.web_name)}</b></li>`).join('')}</ul>` : empty('None in the last 3 GWs.')}
    <h3>Chips</h3>
    <p>Used: ${chips.used.map((u) => `${M.chipLabel(u.name)} (GW${u.event})`).join(', ') || 'none'}<br>Left now: ${chips.available.map((a) => M.chipLabel(a.name)).join(', ') || 'none'}</p>`);
}

let foundLeagues = null;
async function viewSettings() {
  const e = state.entry;
  const leagues = foundLeagues || e?.leagues?.classic || [];
  const list = leagues.length
    ? `<ul class="checks">${leagues.map((l) => `<li><label><input type="checkbox" name="league" value="${l.id}" ${settings.leagues.includes(l.id) ? 'checked' : ''}> ${esc(l.name)} <span class="muted">rank ${int(l.entry_rank)}${l.league_type === 's' ? ' · public' : ''}</span></label></li>`).join('')}</ul>`
    : '';
  return `
  <h1>Settings</h1>
  ${card('Your FPL team', `
    <form id="team-form" class="stack">
      <label>Team ID <input name="teamId" inputmode="numeric" pattern="[0-9]+" value="${settings.teamId ?? ''}" placeholder="e.g. 1234567" required></label>
      <p class="note">Find it on the FPL website: open <b>Points</b>, and the number in the address after <code>/entry/</code> is your ID.</p>
      <button class="btn" type="submit">Find my team</button>
    </form>
    ${e ? `<p>Signed in as <b>${esc(e.name)}</b> (${esc(e.player_first_name)} ${esc(e.player_last_name)}).</p>` : ''}`)}
  ${leagues.length ? card('Leagues to win', `<p class="muted">Pick the leagues you care about (most people pick two).</p>
    <form id="league-form" class="stack">${list}
      <div class="inline"><label>Rivals above me <input type="number" name="above" min="0" max="10" value="${settings.above}"></label>
      <label>Rivals below me <input type="number" name="below" min="0" max="10" value="${settings.below}"></label>
      <label>Plan ahead (GWs) <input type="number" name="horizon" min="1" max="8" value="${settings.horizon}"></label></div>
      <button class="btn" type="submit">Save leagues</button></form>`) : ''}
  ${card('Updates', `<label class="switch"><input type="checkbox" id="notify" ${settings.notify ? 'checked' : ''}> Notify me about rival moves and deadlines</label>
    <p class="note">Notifications are sent when Gaffer is open or reopened.</p>`)}
  ${card('Install on Android', `<p><b>Android app:</b> <a href="/gaffer.apk" download>download gaffer.apk</a> (about 40 KB) on your phone, then open it from Downloads to install.</p><p class="small muted">Or open this site in Chrome and tap <b>⋮ → Install app</b>.</p><button class="btn ghost" id="install-btn" hidden>Install now</button>`)}
  ${card('About the data', `<p class="small">Squads, leagues, prices and stats come from the official Fantasy Premier League API. FPL's expected stats (xG, xA, xGC), defensive contributions and bonus points are supplied by Opta. Headlines link to Fantasy Football Scout, BBC Sport, The Guardian and Sky Sports. Gaffer is not affiliated with the Premier League, FPL, Opta or any publisher.</p>
    <button class="btn ghost" data-action="reset">Clear saved data</button>`)}
  `;
}

// ---------- player sheet ----------
async function playerSheet(id) {
  const ctx = state.ctx, p = ctx.players.get(id);
  if (!p) return;
  const proj = M.project(p, ctx, settings.horizon);
  const stat = (l, v) => `<div><span>${l}</span><b>${v}</b></div>`;
  const body = (hist) => `
    <div class="ph"><span class="shirt big" style="--c:${teamColor(p.team)}">${esc(tShort(p.team))}</span>
      <div><h2>${esc(p.first_name)} ${esc(p.second_name)}</h2><p class="muted">${M.POS[p.element_type]} · ${esc(team(p.team)?.name)} · £${M.price(p)}m · ${p.selected_by_percent}% owned</p></div></div>
    ${p.news ? `<p class="warnbox">${statusDot(p)} ${esc(p.news)}</p>` : ''}
    ${planGw() && myPickIds().has(p.id) ? `<div class="inline sheet-actions">
      <button class="btn small-btn" data-action="plan-out" data-id="${p.id}">Transfer out</button>
      <button class="btn ghost small-btn" data-action="plan-cap" data-id="${p.id}">Make captain</button>
      <button class="btn ghost small-btn" data-action="plan-vice" data-id="${p.id}">Make vice</button></div>` : ''}
    <div class="statgrid">
      ${stat('Points', p.total_points)}${stat('Form', p.form)}${stat('Mins', int(p.minutes))}${stat('Starts', p.starts ?? '–')}
      ${stat('Goals', p.goals_scored)}${stat('xG', fmt(+p.expected_goals, 2))}${stat('Assists', p.assists)}${stat('xA', fmt(+p.expected_assists, 2))}
      ${stat('xGI/90', fmt(M.per90(p, 'expected_goal_involvements'), 2))}${stat('xGC/90', fmt(M.per90(p, 'expected_goals_conceded'), 2))}${stat('Clean sheets', p.clean_sheets)}${stat('Bonus', p.bonus)}
      ${stat('ICT', p.ict_index)}${stat('BPS', p.bps)}${p.defensive_contribution != null ? stat('Def. contr./90', fmt(M.per90(p, 'defensive_contribution'), 1)) : ''}${p.element_type === 1 ? stat('Saves', p.saves) : ''}
      ${stat('FPL xP next', p.ep_next ?? '–')}${stat('Price Δ GW', p.cost_change_event ? (p.cost_change_event / 10).toFixed(1) : '0')}
    </div>
    <h3>Gaffer projection</h3>
    <table class="tbl"><tbody>${proj.perGw.map((g) => `<tr><td>GW${g.gw}</td><td>${fxChips(g.fxs)}</td><td class="num"><b>${fmt(g.pts)}</b></td></tr>`).join('')}
      <tr><td colspan="2"><b>Total</b></td><td class="num"><b>${fmt(proj.total)}</b></td></tr></tbody></table>
    <h3>Recent matches</h3>
    ${hist ? (hist.length ? `<div class="scroll-x"><table class="tbl dense"><thead><tr><th>GW</th><th>Opp</th><th class="num">Mins</th><th class="num">G</th><th class="num">A</th><th class="num">xG</th><th class="num">xA</th><th class="num">Pts</th></tr></thead><tbody>
      ${hist.slice(-6).reverse().map((h) => `<tr><td>${h.round}</td><td>${esc(tShort(h.opponent_team))}${h.was_home ? '' : ' (a)'}</td><td class="num">${h.minutes}</td><td class="num">${h.goals_scored}</td><td class="num">${h.assists}</td><td class="num">${fmt(+h.expected_goals, 2)}</td><td class="num">${fmt(+h.expected_assists, 2)}</td><td class="num"><b>${h.total_points}</b></td></tr>`).join('')}
    </tbody></table></div>` : empty('No matches yet.')) : '<p class="muted">Loading…</p>'}`;
  openSheet(body(null));
  const s = await fpl.element(id).catch(() => null);
  if ($('#sheet').classList.contains('open')) $('#sheet-body').innerHTML = body(s?.history || []);
}

function transferPicker(outId, query = '') {
  const ctx = state.ctx, out = ctx.players.get(outId);
  if (!out) return;
  const squad = myPlayers().map((x) => x.player);
  const ids = new Set(squad.map((p) => p.id));
  const club = new Map();
  for (const p of squad) club.set(p.team, (club.get(p.team) || 0) + 1);
  const budget = out.now_cost + bank();
  const q = query.trim().toLowerCase();
  const list = [...ctx.players.values()]
    .filter((p) => p.element_type === out.element_type && !ids.has(p.id) && !['u', 'n'].includes(p.status))
    .filter((p) => !q || `${p.web_name} ${p.first_name} ${p.second_name} ${tShort(p.team)} ${team(p.team)?.name}`.toLowerCase().includes(q))
    .map((p) => ({ p, xp: M.project(p, ctx, settings.horizon).total, ok: p.now_cost <= budget && ((club.get(p.team) || 0) - (p.team === out.team ? 1 : 0)) < 3 }))
    .sort((a, b) => b.ok - a.ok || b.xp - a.xp)
    .slice(0, 40);
  const rows = list.map(({ p, xp, ok }) => `<li class="${ok ? '' : 'dim'}"><button class="pick" ${ok ? `data-plan-in="${p.id}" data-out="${outId}"` : 'disabled'}>
      <span><b>${esc(p.web_name)}</b> ${statusDot(p)}<div class="sub">${tShort(p.team)} · £${M.price(p)}m · ${p.selected_by_percent}% · ${ok ? `${fmt(xp)} xP` : p.now_cost > budget ? 'too expensive' : '3 from this club already'}</div></span>
      <span class="fxrow">${fxRun(p.team, 3)}</span></button></li>`).join('');
  const html = `<h2>Replace ${esc(out.web_name)}</h2>
    <p class="muted small">${M.POS[out.element_type]} · budget £${fmt(budget / 10)}m (their price + bank). Your real selling price may be a little lower.</p>
    <input id="picker-search" data-out="${outId}" placeholder="Search name or club" value="${esc(query)}" autocomplete="off">
    <ul class="picker">${rows || '<li class="muted">No players match.</li>'}</ul>`;
  if ($('#sheet').classList.contains('open') && $('#picker-search')) {
    $('.picker').outerHTML = `<ul class="picker">${rows || '<li class="muted">No players match.</li>'}</ul>`;
  } else {
    openSheet(html);
    setTimeout(() => $('#picker-search')?.focus(), 50);
  }
}

function openSheet(html) {
  $('#sheet-body').innerHTML = html;
  $('#sheet').classList.add('open');
  $('#sheet').setAttribute('aria-hidden', 'false');
}
function closeSheet() {
  $('#sheet').classList.remove('open');
  $('#sheet').setAttribute('aria-hidden', 'true');
}

// Team colours for the little shirt badges (by FPL short name).
const COLORS = { ARS: '#EF0107', AVL: '#670E36', BOU: '#DA291C', BRE: '#E30613', BHA: '#0057B8', BUR: '#6C1D45', CHE: '#034694', CRY: '#1B458F', EVE: '#003399', FUL: '#222', IPS: '#3a64a3', LEE: '#1D428A', LEI: '#003090', LIV: '#C8102E', MCI: '#6CABDD', MUN: '#DA291C', NEW: '#241F20', NFO: '#DD0000', SHU: '#EE2737', SOU: '#D71920', SUN: '#EB172B', TOT: '#132257', WHU: '#7A263A', WOL: '#FDB913', MID: '#E21A23', COV: '#59CBE8', WAT: '#FBEE23', NOR: '#00A650', HUL: '#F5A12D' };
const teamColor = (id) => COLORS[tShort(id)] || '#5b4b8a';

// ---------- events ----------
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-plan-in],[data-player],[data-action],[data-rival],[data-creator],[data-ask],.sheet-close,#sheet');
  if (!t) return;
  if (t.id === 'sheet') { if (ev.target === t) closeSheet(); return; }
  if (t.classList.contains('sheet-close')) return closeSheet();
  if (t.dataset.planIn) return planTransfer(+t.dataset.out, +t.dataset.planIn);
  if (t.dataset.player) { ev.preventDefault(); return playerSheet(+t.dataset.player); }
  if (t.dataset.rival) return rivalSheet(+t.dataset.rival);
  if (t.dataset.creator) return creatorSheet(+t.dataset.creator);
  if (t.dataset.ask) return askCoach(t.dataset.ask);
  const a = t.dataset.action;
  if (a === 'refresh') return refreshAll(true);
  if (a === 'reload-league') {
    $('#main').innerHTML = `<div class="loading">Refreshing league…</div>`;
    await loadLeague(+t.dataset.id, true).catch((e) => toast(e.message));
    return render();
  }
  if (a === 'plan-out') return transferPicker(+t.dataset.id);
  if (a === 'plan-cap' || a === 'plan-vice') {
    const p = getPlan(), id = +t.dataset.id;
    if (a === 'plan-cap') { if (p.vice === id) p.vice = null; p.captain = id; } else { if (p.captain === id) p.captain = null; p.vice = id; }
    closeSheet();
    savePlan(p);
    return toast(`${state.ctx.players.get(id)?.web_name} is ${a === 'plan-cap' ? 'captain' : 'vice-captain'}`);
  }
  if (a === 'plan-undo') { const p = getPlan(); p.moves.splice(+t.dataset.i, 1); return savePlan(p); }
  if (a === 'plan-reset') { if (confirm('Clear your planned transfers and captain?')) savePlan(emptyPlan()); return; }
  if (a === 'coach-new') {
    if (coach.busy) return;
    coach.messages = [];
    saveCoach();
    return render();
  }
  if (a === 'add-creator' || a === 'remove-creator') {
    saveCreatorsForm(false);
    if (a === 'add-creator') settings.creators.push({ name: '', yt: null, ytId: null, fplId: null });
    else settings.creators.splice(+t.dataset.i, 1);
    saveSettings();
    return render();
  }
  if (a === 'reset') {
    if (!confirm('Clear your team ID, leagues and saved data on this device?')) return;
    localStorage.clear();
    location.hash = 'settings';
    location.reload();
  }
});

document.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  if (f.id === 'team-form') {
    const id = +new FormData(f).get('teamId');
    if (!id) return;
    const btn = f.querySelector('button');
    btn.disabled = true; btn.textContent = 'Looking…';
    const entry = await fpl.entry(id, { fresh: true }).catch(() => null);
    btn.disabled = false; btn.textContent = 'Find my team';
    if (!entry || !entry.id) return toast('No FPL team with that ID');
    if (settings.teamId !== id) { settings.leagues = []; state.leagues.clear(); }
    settings.teamId = id;
    saveSettings();
    foundLeagues = entry.leagues?.classic || [];
    // Pre-select private leagues (most likely the ones with friends/work).
    if (!settings.leagues.length) settings.leagues = foundLeagues.filter((l) => l.league_type === 'x').slice(0, 2).map((l) => l.id);
    saveSettings();
    await loadCore(true).catch((e) => toast(e.message));
    toast(`Found ${entry.name}`);
    render();
  }
  if (f.id === 'coach-form') {
    const q = new FormData(f).get('q');
    return askCoach(String(q || ''));
  }
  if (f.id === 'coach-code') {
    settings.coachCode = String(new FormData(f).get('code') || '').trim();
    saveSettings();
    return render();
  }
  if (f.id === 'creators-form') {
    saveCreatorsForm(true);
    state.creators = null;
    loadCreatorVideos();
    toast('Saved');
    return render();
  }
  if (f.id === 'league-form') {
    const fd = new FormData(f);
    settings.leagues = fd.getAll('league').map(Number);
    settings.above = Math.max(0, Math.min(10, +fd.get('above') || 0));
    settings.below = Math.max(0, Math.min(10, +fd.get('below') || 0));
    const h = Math.max(1, Math.min(8, +fd.get('horizon') || 5));
    if (h !== settings.horizon) state.ctx._proj.clear();
    settings.horizon = h;
    saveSettings();
    state.leagues.clear();
    toast('Saved');
    location.hash = 'leagues';
    loadLeaguesInBackground();
  }
});

document.addEventListener('change', async (ev) => {
  if (ev.target.id === 'notify') {
    if (ev.target.checked && 'Notification' in window) {
      const perm = await Notification.requestPermission();
      settings.notify = perm === 'granted';
      ev.target.checked = settings.notify;
      if (!settings.notify) toast('Notifications are blocked in your browser settings');
    } else settings.notify = false;
    saveSettings();
  }
});

window.addEventListener('hashchange', render);
document.addEventListener('input', (ev) => {
  if (ev.target.id === 'picker-search') transferPicker(+ev.target.dataset.out, ev.target.value);
});
// Show unexpected errors instead of failing silently.
window.addEventListener('error', (e) => toast(`Something went wrong: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => toast(`Something went wrong: ${e.reason?.message || e.reason}`));
document.addEventListener('keydown', (ev) => {
  if (ev.target.matches?.('#coach-form textarea') && ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    ev.target.form.requestSubmit();
  }
});

let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  const b = $('#install-btn');
  if (b) b.hidden = false;
});
document.addEventListener('click', async (e) => {
  if (e.target.id === 'install-btn' && deferredInstall) {
    deferredInstall.prompt();
    deferredInstall = null;
  }
});

setInterval(() => document.querySelectorAll('[data-countdown]').forEach((el) => (el.textContent = countdown(el.dataset.countdown))), 30000);

// ---------- boot ----------
function saveCreatorsForm(dropEmpty) {
  const form = $('#creators-form');
  if (!form) return;
  const rows = [...form.querySelectorAll('.creator-row')].map((fs) => {
    const v = (n) => fs.querySelector(`[name=${n}]`).value;
    return { name: v('name').trim(), ...parseYt(v('yt')), fplId: parseFplId(v('fpl')) };
  });
  settings.creators = dropEmpty ? rows.filter((r) => r.name || r.yt || r.ytId || r.fplId) : rows;
  saveSettings();
}

async function loadLeaguesInBackground(fresh = false) {
  for (const id of settings.leagues) {
    try { await loadLeague(id, fresh); } catch (e) { console.warn('league', id, e); }
    const route = location.hash.slice(1).split('/')[0] || 'home';
    if (route === 'home') render();
  }
}

async function refreshAll(fresh = false) {
  if (fresh) toast('Refreshing…');
  try {
    await loadCore(fresh);
  } catch (e) {
    $('#main').innerHTML = card("Can't reach FPL", `<p>${esc(e.message)}. The FPL site may be updating (it goes offline briefly between gameweeks).</p><button class="btn" data-action="refresh">Try again</button>`);
    return;
  }
  state.updates = readLS('gaffer:updates', []);
  render();
  deadlineReminder();
  news({ fresh }).then((n) => { state.news = n; if ((location.hash.slice(1) || 'home').startsWith('home')) render(); }).catch(() => {});
  if (settings.teamId) {
    state.creators = null;
    loadCreators(fresh).then(() => { if (location.hash.startsWith('#creators')) render(); }).catch(() => {});
    state.leagues.clear();
    await loadLeaguesInBackground(fresh);
    if (!(location.hash.slice(1) || 'home').startsWith('home')) render();
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
refreshAll();
// Live gameweeks: refresh every 2 minutes while the app is open.
setInterval(() => { if (state.live && document.visibilityState === 'visible' && !$('#sheet').classList.contains('open')) refreshAll(true); }, 120000);
