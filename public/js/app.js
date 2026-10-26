import { fpl, news, pool, clearMemory } from './api.js';
import * as M from './model.js';

// ---------- settings & state ----------
const DEFAULTS = { teamId: null, leagues: [], above: 5, below: 3, horizon: 5, notify: false };
const settings = { ...DEFAULTS, ...readLS('gaffer:settings', {}) };
const state = { ctx: null, entry: null, history: null, picks: null, live: null, leagues: new Map(), news: null, updates: [] };

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
    picks: state.picks,
    history: state.history,
  };
  const valid = rivals.filter(Boolean);
  const cmp = M.compareRivals(me, valid, ctx, { horizon: settings.horizon });
  const plan = M.leaguePlan(cmp, me, ctx, settings.horizon);
  if (state.live) for (const r of cmp.rows) r.live = M.livePoints(r.picks, state.live);
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
const views = { home: viewHome, team: viewTeam, leagues: viewLeagues, insights: viewInsights, news: viewNews, settings: viewSettings };
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

function myPlayers() {
  return state.picks ? M.squadFromPicks(state.picks, state.ctx) : [];
}
function bank() {
  const h = state.picks?.entry_history || state.history?.current?.at(-1);
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

function pitchChip(pk, ctx) {
  const p = pk.player;
  const fx = M.fixtureRun(p.team, ctx, 1)[0];
  const pr = M.project(p, ctx, 1).next;
  const livePts = state.live ? state.live.elements.find((e) => e.id === p.id)?.stats.total_points : null;
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
  const xi = sq.filter((x) => x.position <= 11), bench = sq.filter((x) => x.position > 11);
  const rows = [1, 2, 3, 4].map((t) => `<div class="prow">${xi.filter((x) => x.player.element_type === t).map((x) => pitchChip(x, ctx)).join('')}</div>`);
  const players = sq.map((x) => x.player);

  const lg = currentLeague && state.leagues.get(currentLeague) || state.leagues.get(settings.leagues[0]);
  const own = lg?.cmp.own || new Map();
  const caps = M.captainOptions(players, ctx, lg?.cmp.caps, lg?.cmp.n);
  const ideas = M.transferIdeas(players, bank(), ctx, { horizon: settings.horizon, own });
  const ideaRow = (i, rel) => `<tr><td>${playerLink(i.out)}<div class="sub">${fmt(i.outProj)} xP</div></td><td class="arrow">→</td>
    <td>${playerLink(i.in)} <span class="muted">£${M.price(i.in)}</span><div class="sub">${fmt(i.inProj)} xP · ${tShort(i.in.team)} ${lg ? `· ${pct(i.candOwn)} rivals own` : ''}</div></td>
    <td class="num ${rel ? '' : 'good'}">+${fmt(rel ? i.rel : i.gain)}</td></tr>`;

  const sorted = [...players].sort((a, b) => a.element_type - b.element_type || M.project(b, ctx, settings.horizon).total - M.project(a, ctx, settings.horizon).total);
  return `
  <section class="pitch">
    ${rows.join('')}
    <div class="bench"><span class="muted">Bench</span>${bench.map((x) => pitchChip(x, ctx)).join('')}</div>
    ${state.picks.active_chip ? `<div class="chip-on">${M.chipLabel(state.picks.active_chip)} active</div>` : ''}
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

  const table = `<div class="scroll-x"><table class="tbl dense rivals"><thead><tr><th>#</th><th>Team</th><th class="num">Total</th><th class="num">Gap</th><th class="num">GW${showLive ? ' live' : ''}</th><th class="num">xP ${settings.horizon}GW</th><th class="num">Shared</th><th>Captain</th><th>Chips left</th><th class="num">Value</th><th class="num">Hits</th></tr></thead><tbody>
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
      <td class="chips">${r.chips.available.map((c) => `<span class="chipb" title="${M.chipLabel(c.name)} (until GW${c.until})">${chipShort(c.name)}</span>`).join('') || '–'}</td>
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
  const mine = new Set((state.picks?.picks || []).map((p) => p.element));
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
    <p>Used: ${r.chips.used.map((c) => `${M.chipLabel(c.name)} (GW${c.event})`).join(', ') || 'none'}<br>Left: ${r.chips.available.map((c) => M.chipLabel(c.name)).join(', ') || 'none'}</p>
  `);
}

async function viewInsights() {
  const ctx = state.ctx;
  const L = M.insightLists(ctx, settings.horizon);
  const mine = new Set((state.picks?.picks || []).map((p) => p.element));
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
  const mine = new Set((state.picks?.picks || []).map((p) => p.element));
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
  ${card('Install on Android', `<p>Open this site in Chrome, tap <b>⋮ → Add to Home screen</b> (or <b>Install app</b>). Gaffer then opens full-screen like a normal app.</p><button class="btn ghost" id="install-btn" hidden>Install now</button>`)}
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
  const t = ev.target.closest('[data-player],[data-action],[data-rival],.sheet-close,#sheet');
  if (!t) return;
  if (t.id === 'sheet') { if (ev.target === t) closeSheet(); return; }
  if (t.classList.contains('sheet-close')) return closeSheet();
  if (t.dataset.player) { ev.preventDefault(); return playerSheet(+t.dataset.player); }
  if (t.dataset.rival) return rivalSheet(+t.dataset.rival);
  const a = t.dataset.action;
  if (a === 'refresh') return refreshAll(true);
  if (a === 'reload-league') {
    $('#main').innerHTML = `<div class="loading">Refreshing league…</div>`;
    await loadLeague(+t.dataset.id, true).catch((e) => toast(e.message));
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
    state.leagues.clear();
    await loadLeaguesInBackground(fresh);
    if (!(location.hash.slice(1) || 'home').startsWith('home')) render();
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
refreshAll();
// Live gameweeks: refresh every 2 minutes while the app is open.
setInterval(() => { if (state.live && document.visibilityState === 'visible' && !$('#sheet').classList.contains('open')) refreshAll(true); }, 120000);
