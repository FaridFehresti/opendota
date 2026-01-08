const OPENDOTA = "https://api.opendota.com/api";

// Single-request fetch only (NO pagination).
const SINGLE_FETCH_LIMIT = 10000;

// Distinct, high-contrast palette (cycled for N players)
const PALETTE = [
  { line: "rgba(122,162,255,0.95)", fill: "rgba(122,162,255,0.10)", point: "rgba(122,162,255,1)" }, // blue
  { line: "rgba(43,213,118,0.95)", fill: "rgba(43,213,118,0.10)", point: "rgba(43,213,118,1)" },   // green
  { line: "rgba(255,180,90,0.95)", fill: "rgba(255,180,90,0.10)", point: "rgba(255,180,90,1)" },   // orange
  { line: "rgba(255,107,107,0.95)", fill: "rgba(255,107,107,0.10)", point: "rgba(255,107,107,1)" }, // red
  { line: "rgba(186,104,200,0.95)", fill: "rgba(186,104,200,0.10)", point: "rgba(186,104,200,1)" }, // purple
  { line: "rgba(76,201,240,0.95)", fill: "rgba(76,201,240,0.10)", point: "rgba(76,201,240,1)" },    // cyan
  { line: "rgba(255,209,102,0.95)", fill: "rgba(255,209,102,0.10)", point: "rgba(255,209,102,1)" }, // yellow
  { line: "rgba(173,181,189,0.95)", fill: "rgba(173,181,189,0.10)", point: "rgba(173,181,189,1)" }  // gray
];

const $ = (id) => document.getElementById(id);

function setStatus(msg, kind = "ok") {
  const el = $("status");
  if (!el) return;
  el.className = "status " + (kind === "error" ? "error" : "ok");
  el.textContent = msg;
}

function isoDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfYear(d = new Date()) { return new Date(d.getFullYear(), 0, 1); }
function startOfMonth(d = new Date()) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d = new Date()) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }

function applyPreset(preset) {
  const now = new Date();
  let from, to;

  if (preset === "7d") { to = now; from = new Date(now); from.setDate(from.getDate() - 7); }
  else if (preset === "30d") { to = now; from = new Date(now); from.setDate(from.getDate() - 30); }
  else if (preset === "90d") { to = now; from = new Date(now); from.setDate(from.getDate() - 90); }
  else if (preset === "ytd") { to = now; from = startOfYear(now); }
  else if (preset === "prev_month") {
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    from = startOfMonth(prev);
    to = endOfMonth(prev);
  } else return;

  $("fromDate").value = isoDate(from);
  $("toDate").value = isoDate(to);
}

function epochSecondsFromIso(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d, 0, 0, 0);
  return Math.floor(dt.getTime() / 1000);
}

function toExclusiveEpoch(toIso) {
  return Math.floor(luxon.DateTime.fromISO(toIso).plus({ days: 1 }).startOf("day").toSeconds());
}

// --- Heroes ---
let HERO_MAP = null;
async function loadHeroesOnce() {
  if (HERO_MAP) return HERO_MAP;
  const res = await fetch(`${OPENDOTA}/heroes`);
  if (!res.ok) throw new Error(`Failed to load heroes: HTTP ${res.status}`);
  const heroes = await res.json();
  HERO_MAP = new Map(heroes.map(h => [h.id, h.localized_name]));
  return HERO_MAP;
}

// --- Profiles (avatar/name) ---
async function fetchPlayerProfile(accountId) {
  const res = await fetch(`${OPENDOTA}/players/${encodeURIComponent(accountId)}`);
  if (!res.ok) throw new Error(`Failed to load player profile ${accountId}: HTTP ${res.status}`);
  const p = await res.json();
  const profile = p?.profile || {};
  return {
    accountId,
    personaname: profile.personaname || `Player ${accountId}`,
    avatarfull: profile.avatarfull || profile.avatarmedium || profile.avatar || "",
    profileurl: profile.profileurl || "",
    steamid: profile.steamid || "",
    rank_tier: p?.rank_tier ?? null,
    leaderboard_rank: p?.leaderboard_rank ?? null
  };
}

function rankTierToText(rt) {
  if (!rt || typeof rt !== "number") return "—";
  const medal = Math.floor(rt / 10);
  const star = rt % 10;
  const medals = {
    1: "Herald", 2: "Guardian", 3: "Crusader", 4: "Archon",
    5: "Legend", 6: "Ancient", 7: "Divine", 8: "Immortal"
  };
  const m = medals[medal] || "—";
  if (m === "Immortal") return "Immortal";
  if (m === "—") return "—";
  return `${m} ${star || 1}`;
}

// --- Fetch matches (single request only) ---
async function fetchPlayerMatchesSingleBatch(accountId) {
  const url = new URL(`${OPENDOTA}/players/${encodeURIComponent(accountId)}/matches`);
  url.searchParams.set("significant", "0");
  url.searchParams.set("limit", String(SINGLE_FETCH_LIMIT));

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenDota matches error for ${accountId}: HTTP ${res.status}${text ? " — " + text : ""}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function isWinForPlayer(match) {
  const isRadiant = match.player_slot < 128;
  return (isRadiant && match.radiant_win) || (!isRadiant && !match.radiant_win);
}

function filterRanked(matches, mode) {
  if (mode === "all") return matches;
  return matches.filter(m => m.lobby_type === 7);
}

// Build ALL-TIME cumulative winrate points (based on fetched history), then slice for display.
function buildAllTimeCumulativeSeries(allMatchesFiltered) {
  const sorted = [...allMatchesFiltered]
    .filter(m => typeof m.start_time === "number")
    .sort((a, b) => a.start_time - b.start_time);

  let wins = 0;
  const points = sorted.map((m, idx) => {
    const win = isWinForPlayer(m);
    if (win) wins++;

    const playedAllTime = idx + 1;
    const wrAllTimeAtThatMoment = (wins / playedAllTime) * 100;

    return {
      xTimeMs: m.start_time * 1000,
      y: Number(wrAllTimeAtThatMoment.toFixed(4)),
      match: m,
      idx: playedAllTime
    };
  });

  return { points, totalAllTime: sorted.length, winsAllTime: wins };
}

function slicePointsByRange(pointsAllTime, fromEpochInclusive, toEpochExclusive) {
  const fromMs = fromEpochInclusive * 1000;
  const toMs = toEpochExclusive * 1000;
  return pointsAllTime.filter(p => p.xTimeMs >= fromMs && p.xTimeMs < toMs);
}

// Re-map x to sequential index so multiple same-day matches are spaced out.
function remapToSequentialX(pointsInRange) {
  const sorted = [...pointsInRange].sort((a, b) => a.xTimeMs - b.xTimeMs);
  const dayLabelByX = new Map();

  let lastDay = null;
  const remapped = sorted.map((p, i) => {
    const day = luxon.DateTime.fromMillis(p.xTimeMs).toISODate();
    if (day !== lastDay) {
      dayLabelByX.set(i, day);
      lastDay = day;
    }
    return {
      x: i,
      y: p.y,
      match: p.match,
      idx: p.idx,
      xTimeMs: p.xTimeMs
    };
  });

  return { points: remapped, dayLabelByX };
}

// Empty "column" at end (extra x padding)
function xAxisMaxWithPadding(points) {
  if (!points || points.length === 0) return 1;
  return (points.length - 1) + 1;
}

// --- Dynamic Y bounds (zoom) ---
function computeDynamicYBounds(datasetsPointsInRange) {
  let min = Infinity;
  let max = -Infinity;
  let count = 0;

  for (const pts of datasetsPointsInRange) {
    for (const p of pts) {
      if (typeof p?.y !== "number") continue;
      min = Math.min(min, p.y);
      max = Math.max(max, p.y);
      count++;
    }
  }

  if (!count || !isFinite(min) || !isFinite(max)) return { min: 0, max: 100, step: 10 };

  const span = max - min;
  const safeSpan = span < 1e-6 ? 0.1 : span;
  const pad = Math.max(safeSpan * 0.18, 0.02);

  let yMin = Math.max(0, min - pad);
  let yMax = Math.min(100, max + pad);

  const targetTicks = 6;
  const rawStep = (yMax - yMin) / targetTicks;
  const step = toNiceStep(rawStep);

  yMin = Math.floor(yMin / step) * step;
  yMax = Math.ceil(yMax / step) * step;

  yMin = Math.max(0, yMin);
  yMax = Math.min(100, yMax);

  if (yMax - yMin < step) yMax = Math.min(100, yMin + step * 2);

  return { min: Number(yMin.toFixed(4)), max: Number(yMax.toFixed(4)), step };
}

function toNiceStep(step) {
  if (!isFinite(step) || step <= 0) return 10;
  const exp = Math.floor(Math.log10(step));
  const base = step / Math.pow(10, exp);

  let niceBase;
  if (base <= 1) niceBase = 1;
  else if (base <= 2) niceBase = 2;
  else if (base <= 2.5) niceBase = 2.5;
  else if (base <= 5) niceBase = 5;
  else niceBase = 10;

  return niceBase * Math.pow(10, exp);
}

function formatPercentSmart(v) {
  const abs = Math.abs(v);
  if (abs < 1) return v.toFixed(3) + "%";
  if (abs < 10) return v.toFixed(2) + "%";
  return v.toFixed(1) + "%";
}

function pct(n, d, digits = 2) {
  if (!d) return "—";
  return ((n / d) * 100).toFixed(digits) + "%";
}

// --- Party (any pair) ---
function buildPartySharedAllTime(pAType, pBType) {
  const mapB = new Map(pBType.map(m => [m.match_id, m]));
  const shared = [];
  for (const a of pAType) {
    const b = mapB.get(a.match_id);
    if (b && typeof a.start_time === "number")
      shared.push({ a, b, match_id: a.match_id, start_time: a.start_time });
  }
  shared.sort((u, v) => u.start_time - v.start_time);

  let wins = 0;
  const points = shared.map((s, idx) => {
    const winA = isWinForPlayer(s.a);
    if (winA) wins++;

    const played = idx + 1;
    const wr = (wins / played) * 100;

    const combined = {
      match_id: s.match_id,
      start_time: s.start_time,
      duration: s.a.duration ?? s.b.duration,
      radiant_win: s.a.radiant_win,
      hero_id_a: s.a.hero_id,
      hero_id_b: s.b.hero_id,
      a: s.a,
      b: s.b
    };

    return {
      xTimeMs: s.start_time * 1000,
      y: Number(wr.toFixed(4)),
      match: combined,
      idx: played
    };
  });

  return { points, totalAllTime: shared.length, winsAllTime: wins, shared };
}

// --- UI: players list ---
function addPlayerRow(initialValue = "") {
  const list = $("playersList");
  if (!list) return;

  const row = document.createElement("div");
  row.className = "playerRow";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "account_id (32-bit), e.g. 123456789";
  input.value = initialValue;
  input.setAttribute("data-player-input", "1");

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "miniBtn";
  remove.textContent = "Remove";

  remove.addEventListener("click", () => {
    row.remove();
    if (list.children.length === 0) addPlayerRow("");
    syncPartySelectors();
  });

  row.appendChild(input);
  row.appendChild(remove);
  list.appendChild(row);

  input.addEventListener("input", () => syncPartySelectors());
}

function getPlayerIdsFromUI() {
  const inputs = Array.from(document.querySelectorAll('[data-player-input="1"]'));
  return inputs.map(i => String(i.value || "").trim()).filter(Boolean);
}

function syncPartySelectors(playerMetaList) {
  const ids = playerMetaList?.map(p => p.playerId) || getPlayerIdsFromUI();
  const a = $("partyA");
  const b = $("partyB");
  if (!a || !b) return;

  const currentA = a.value;
  const currentB = b.value;

  a.innerHTML = "";
  b.innerHTML = "";

  const opt = (val, label) => {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = label;
    return o;
  };

  if (ids.length === 0) {
    a.appendChild(opt("", "—"));
    b.appendChild(opt("", "—"));
    return;
  }

  const labelFor = (id) => {
    const m = playerMetaList?.find(x => x.playerId === id);
    if (!m) return id;
    return `${m.profile.personaname} (${id})`;
  };

  ids.forEach(id => a.appendChild(opt(id, labelFor(id))));
  ids.forEach(id => b.appendChild(opt(id, labelFor(id))));

  if (currentA && ids.includes(currentA)) a.value = currentA;
  else a.value = ids[0];

  if (currentB && ids.includes(currentB)) b.value = currentB;
  else b.value = ids.length > 1 ? ids[1] : ids[0];

  if (ids.length > 1 && a.value === b.value) {
    b.value = ids.find(x => x !== a.value) || b.value;
  }
}

// --- Heatmap ---
function buildDailyCounts(matchesInRange) {
  const map = new Map(); // YYYY-MM-DD -> count
  for (const m of matchesInRange) {
    if (typeof m.start_time !== "number") continue;
    const d = luxon.DateTime.fromSeconds(m.start_time).toISODate();
    map.set(d, (map.get(d) || 0) + 1);
  }
  return map;
}

function datesBetween(fromIso, toIsoInclusive) {
  const start = luxon.DateTime.fromISO(fromIso).startOf("day");
  const end = luxon.DateTime.fromISO(toIsoInclusive).startOf("day");
  const out = [];
  let cur = start;
  while (cur <= end) {
    out.push(cur);
    cur = cur.plus({ days: 1 });
  }
  return out;
}

function renderHeatmap(container, fromIso, toIso, countMap) {
  container.innerHTML = "";

  const days = datesBetween(fromIso, toIso);
  if (days.length === 0) return;

  const first = days[0];
  const firstWeekStart = first.minus({ days: (first.weekday - 1) });
  const last = days[days.length - 1];
  const lastWeekEnd = last.plus({ days: (7 - last.weekday) });
  const all = [];
  let cur = firstWeekStart;
  while (cur <= lastWeekEnd) {
    all.push(cur);
    cur = cur.plus({ days: 1 });
  }

  let max = 0;
  for (const d of days) {
    const k = d.toISODate();
    max = Math.max(max, countMap.get(k) || 0);
  }

  const scale = (c) => {
    if (!c || max === 0) return { s: .55, bg: "rgba(255,255,255,.05)", bd: "rgba(255,255,255,.08)" };
    const t = c / max;
    const s = 0.65 + t * 0.70;
    const alpha = 0.10 + t * 0.22;
    const border = 0.18 + t * 0.20;
    return {
      s,
      bg: `rgba(215,181,109,${alpha.toFixed(3)})`,
      bd: `rgba(242,210,139,${border.toFixed(3)})`
    };
  };

  const weeks = [];
  for (let i = 0; i < all.length; i += 7) {
    weeks.push(all.slice(i, i + 7));
  }

  weeks.forEach(week => {
    const col = document.createElement("div");
    col.className = "heatCol";

    week.forEach(d => {
      const dot = document.createElement("div");
      dot.className = "heatDot";

      const iso = d.toISODate();
      const isInRange = (d >= days[0] && d <= days[days.length - 1]);
      const c = isInRange ? (countMap.get(iso) || 0) : 0;
      const st = scale(c);

      dot.style.transform = `scale(${st.s.toFixed(3)})`;
      dot.style.background = st.bg;
      dot.style.borderColor = st.bd;

      if (!isInRange) {
        dot.style.opacity = "0.20";
        dot.style.transform = "scale(.45)";
      } else {
        dot.title = `${iso}: ${c} match${c === 1 ? "" : "es"}`;
      }

      col.appendChild(dot);
    });

    container.appendChild(col);
  });

  const tip = $("heatTip");
  if (tip) {
    const total = Array.from(countMap.values()).reduce((a, b) => a + b, 0);
    tip.textContent = `Hover dots to see date + matches. Total in window: ${total}. (Size scales per-window.)`;
  }
}

// --- Chart helpers ---
function baseChartOptions(yBounds, xMax, dayLabelByXForTicks) {
  const tickCb = (value) => {
    const v = Math.round(value);
    const label = dayLabelByXForTicks?.get(v);
    return label || "";
  };

  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    normalized: true,
    interaction: { mode: "nearest", intersect: false, axis: "x" },
    plugins: {
      legend: {
        display: true,
        labels: {
          color: "rgba(239,233,218,.92)",
          boxWidth: 10,
          boxHeight: 10,
          usePointStyle: true,
          pointStyle: "circle"
        }
      },
      tooltip: {
        enabled: true,
        displayColors: true,
        padding: 12,
        backgroundColor: "rgba(8,8,12,.92)",
        borderColor: "rgba(215,181,109,.26)",
        borderWidth: 1,
        titleColor: "rgba(242,210,139,.98)",
        bodyColor: "rgba(239,233,218,.94)"
      }
    },
    scales: {
      x: {
        type: "linear",
        min: 0,
        max: Math.max(1, xMax),
        ticks: {
          autoSkip: true,
          maxTicksLimit: 10,
          color: "rgba(185,173,146,.92)",
          callback: tickCb
        },
        grid: { color: "rgba(255,255,255,.06)" }
      },
      y: {
        min: yBounds.min,
        max: yBounds.max,
        ticks: {
          stepSize: yBounds.step,
          color: "rgba(185,173,146,.92)",
          callback: (v) => formatPercentSmart(v)
        },
        grid: { color: "rgba(255,255,255,.06)" }
      }
    }
  };
}

function datasetForPlayer(label, points, color) {
  return {
    label,
    data: points,
    parsing: false,
    showLine: true,
    borderWidth: 2,
    tension: 0,
    borderColor: color.line,
    backgroundColor: color.fill,
    fill: true,
    pointRadius: 2.8,
    pointHoverRadius: 7,
    pointHitRadius: 14,
    pointBackgroundColor: color.point,
    pointBorderColor: "rgba(0,0,0,0)"
  };
}

function attachTooltipCallbacks(chart, heroMap, mode) {
  chart.options.plugins.tooltip.callbacks = {
    title: (items) => {
      const p = items[0].raw;
      return new Date(p.xTimeMs).toLocaleString();
    },
    label: (item) => {
      const p = item.raw;

      if (mode === "party") {
        const m = p.match;
        const heroA = heroMap?.get(m.hero_id_a) || `Hero #${m.hero_id_a}`;
        const heroB = heroMap?.get(m.hero_id_b) || `Hero #${m.hero_id_b}`;
        const winA = isWinForPlayer(m.a);
        const kdaA = `${m.a.kills ?? "?"}/${m.a.deaths ?? "?"}/${m.a.assists ?? "?"}`;
        const kdaB = `${m.b.kills ?? "?"}/${m.b.deaths ?? "?"}/${m.b.assists ?? "?"}`;
        const durMin = m.duration ? Math.round(m.duration / 60) : "?";
        const prefix = item.dataset?.label ? `${item.dataset.label}: ` : "";
        return `${prefix}${p.y.toFixed(3)}% • ${winA ? "WIN" : "LOSS"} • P1 ${heroA} (${kdaA}) • P2 ${heroB} (${kdaB}) • ${durMin}m • match ${m.match_id}`;
      }

      const m = p.match;
      const hero = heroMap?.get(m.hero_id) || `Hero #${m.hero_id}`;
      const win = isWinForPlayer(m);
      const kda = `${m.kills ?? "?"}/${m.deaths ?? "?"}/${m.assists ?? "?"}`;
      const durMin = m.duration ? Math.round(m.duration / 60) : "?";
      const prefix = item.dataset?.label ? `${item.dataset.label}: ` : "";
      return `${prefix}${p.y.toFixed(3)}% • ${win ? "WIN" : "LOSS"} • ${hero} • KDA ${kda} • ${durMin}m • match ${m.match_id}`;
    }
  };
}

const charts = new Map();
function destroyChartsByPrefix(prefix) {
  for (const [id, c] of charts.entries()) {
    if (id.startsWith(prefix)) { c.destroy(); charts.delete(id); }
  }
}
function destroyChart(id) {
  const c = charts.get(id);
  if (c) { c.destroy(); charts.delete(id); }
}

// --- Summary rendering ---
function renderSummary({ fromIso, toIso, filterLabel, fetched, partyStats }) {
  $("k_window").textContent = `${fromIso} → ${toIso}`;
  $("k_window_sub").textContent = `Filter: ${filterLabel} • Players: ${fetched.length}`;

  const combinedMatches = fetched.reduce((acc, p) => acc + p.matchesInRangeCount, 0);
  const combinedWins = fetched.reduce((acc, p) => acc + p.winsInRange, 0);
  $("k_combined_matches").textContent = combinedMatches.toString();
  $("k_combined_sub").textContent = `Range winrate (sum): ${pct(combinedWins, combinedMatches)} • Total wins (sum): ${combinedWins}`;

  $("k_party_matches").textContent = partyStats?.matchesInRange?.toString() ?? "—";
  $("k_party_sub").textContent = partyStats
    ? `Range party WR: ${pct(partyStats.winsInRange, partyStats.matchesInRange)} • All-time party: ${pct(partyStats.winsAllTime, partyStats.matchesAllTime)}`
    : "Select two players for party mode.";

  const wrap = $("playerCards");
  wrap.innerHTML = "";

  fetched.forEach((p, i) => {
    const color = PALETTE[i % PALETTE.length];

    const card = document.createElement("div");
    card.className = "pCard";

    const av = document.createElement("div");
    av.className = "avatar";
    const img = document.createElement("img");
    img.alt = p.profile.personaname;
    img.src = p.profile.avatarfull || "";
    img.onerror = () => { img.style.display = "none"; };
    av.appendChild(img);

    const meta = document.createElement("div");
    meta.className = "pMeta";

    const name = document.createElement("div");
    name.className = "pName";
    const strong = document.createElement("strong");
    strong.textContent = p.profile.personaname;

    const tag = document.createElement("div");
    tag.className = "tag";
    tag.textContent = `P${i + 1}`;

    name.appendChild(strong);
    name.appendChild(tag);

    const stats = document.createElement("div");
    stats.className = "pStats";

    const mk = (k, v) => {
      const s = document.createElement("div");
      s.className = "stat";
      s.innerHTML = `<div class="k">${k}</div><div class="v">${v}</div>`;
      return s;
    };

    const allWr = pct(p.allTime.winsAllTime, p.allTime.totalAllTime);
    const rangeWr = pct(p.winsInRange, p.matchesInRangeCount);

    stats.appendChild(mk("Account", p.playerId));
    stats.appendChild(mk("Rank", rankTierToText(p.profile.rank_tier)));
    stats.appendChild(mk("All-time WR", `${allWr} (${p.allTime.winsAllTime}/${p.allTime.totalAllTime})`));
    stats.appendChild(mk("Range W/L", `${p.winsInRange}/${p.matchesInRangeCount} (${rangeWr})`));

    card.style.boxShadow = `0 0 0 1px rgba(255,255,255,.08) inset, 0 0 0 2px ${color.line} inset`;

    meta.appendChild(name);

    const linkRow = document.createElement("div");
    linkRow.style.marginTop = "2px";
    linkRow.style.fontSize = "12px";
    linkRow.style.color = "rgba(185,173,146,.92)";
    if (p.profile.profileurl) {
      linkRow.innerHTML = `Steam: <a href="${p.profile.profileurl}" target="_blank" rel="noreferrer">Open profile</a>`;
    } else {
      linkRow.textContent = "Steam: —";
    }

    meta.appendChild(linkRow);
    meta.appendChild(stats);

    card.appendChild(av);
    card.appendChild(meta);
    wrap.appendChild(card);
  });
}

// --- Charts rendering ---
function renderCharts({ fetched, heroMap, partyData, filterLabel }) {
  const overlayDatasets = fetched.map((p, i) => {
    const color = PALETTE[i % PALETTE.length];
    return datasetForPlayer(`P${i + 1} · ${escapeHtml(p.profile.personaname)}`, p.pointsInRange, color);
  });

  const yOverlay = computeDynamicYBounds(fetched.map(p => p.pointsInRange));
  const maxLen = Math.max(0, ...fetched.map(p => p.pointsInRange.length));
  const xMaxOverlay = Math.max(1, (maxLen - 1) + 1);
  const dayLabelsForOverlay = fetched[0]?.dayLabelByX || new Map();

  destroyChart("chartOverlay");
  const overlayChart = new Chart($("chartOverlay").getContext("2d"), {
    type: "line",
    data: { datasets: overlayDatasets },
    options: baseChartOptions(yOverlay, xMaxOverlay, dayLabelsForOverlay)
  });
  attachTooltipCallbacks(overlayChart, heroMap, "overlay");
  charts.set("chartOverlay", overlayChart);

  $("overlayMeta").textContent =
    `Players: ${fetched.length} • Window matches (sum): ${fetched.reduce((a,p)=>a+p.matchesInRangeCount,0)} • ${filterLabel}`;

  destroyChart("chartParty");
  const partyPts = partyData?.pointsInRange || [];
  const partyDayLabels = partyData?.dayLabelByX || new Map();
  const yParty = computeDynamicYBounds([partyPts]);
  const xMaxParty = xAxisMaxWithPadding(partyPts);

  const partyDataset = datasetForPlayer("Party (A+B)", partyPts, {
    line: "rgba(215,181,109,.95)",
    fill: "rgba(215,181,109,.12)",
    point: "rgba(242,210,139,1)"
  });

  const partyChart = new Chart($("chartParty").getContext("2d"), {
    type: "line",
    data: { datasets: [partyDataset] },
    options: baseChartOptions(yParty, xMaxParty, partyDayLabels)
  });
  attachTooltipCallbacks(partyChart, heroMap, "party");
  charts.set("chartParty", partyChart);

  $("partyMeta").textContent = partyData?.metaText || "Select two distinct players for party mode.";

  const perWrap = $("perPlayerCharts");
  perWrap.innerHTML = "";
  destroyChartsByPrefix("chartPlayer_");

  fetched.forEach((p, i) => {
    const color = PALETTE[i % PALETTE.length];
    const y = computeDynamicYBounds([p.pointsInRange]);
    const xMax = xAxisMaxWithPadding(p.pointsInRange);

    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="cardInner">
        <div class="cardTitle">
          <h2>Player ${i + 1} · ${escapeHtml(p.profile.personaname)}</h2>
          <div class="sub">${p.playerId} · All-time WR windowed</div>
        </div>
        <canvas class="chartCanvas" id="chartPlayer_${i}"></canvas>
        <div class="chartMetaRow">
          <div>Range: ${p.winsInRange}/${p.matchesInRangeCount} (${pct(p.winsInRange,p.matchesInRangeCount)}) · All-time: ${pct(p.allTime.winsAllTime,p.allTime.totalAllTime)}</div>
          <div>Rank: ${rankTierToText(p.profile.rank_tier)}</div>
        </div>
      </div>
    `;
    perWrap.appendChild(card);

    const chart = new Chart($(`chartPlayer_${i}`).getContext("2d"), {
      type: "line",
      data: { datasets: [datasetForPlayer(`P${i + 1}`, p.pointsInRange, color)] },
      options: baseChartOptions(y, xMax, p.dayLabelByX)
    });
    attachTooltipCallbacks(chart, heroMap, "player");
    charts.set(`chartPlayer_${i}`, chart);
  });
}

function escapeHtml(s){
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;"
  }[c]));
}

// --- Init ---
(function init(){
  applyPreset($("preset").value || "30d");

  $("preset").addEventListener("change", (e) => {
    applyPreset(e.target.value);
  });

  $("addPlayerBtn").addEventListener("click", () => {
    addPlayerRow("");
    syncPartySelectors();
  });

  addPlayerRow("");
  syncPartySelectors();

  if ($("account1")?.value?.trim()) addPlayerRow($("account1").value.trim());
  if ($("account2")?.value?.trim()) addPlayerRow($("account2").value.trim());

  $("partyA").addEventListener("change", () => {});
  $("partyB").addEventListener("change", () => {});
})();

// --- Submit handler ---
$("controls").addEventListener("submit", async (e) => {
  e.preventDefault();

  const fromIso = $("fromDate").value;
  const toIso = $("toDate").value;
  const matchFilterMode = $("rankedOnly").value;
  const runBtn = $("runBtn");

  const playerIds = getPlayerIdsFromUI();

  if (!playerIds.length) { setStatus("Please add at least one player account_id.", "error"); return; }
  if (!fromIso || !toIso) { setStatus("Please choose From and To dates (or use a preset).", "error"); return; }

  const fromEpoch = epochSecondsFromIso(fromIso);
  const toEpochExclusive = toExclusiveEpoch(toIso);
  if (toEpochExclusive <= fromEpoch) {
    setStatus("Invalid date range: 'To' must be same as or after 'From'.", "error");
    return;
  }

  runBtn.disabled = true;

  const filterLabel = (matchFilterMode === "ranked") ? "Ranked only (lobby_type=7)" : "All matches";

  try {
    setStatus("Loading heroes…", "ok");
    const heroMap = await loadHeroesOnce();

    setStatus(`Loading player profiles (${playerIds.length})…`, "ok");
    const profiles = await Promise.all(playerIds.map(id => fetchPlayerProfile(id)));

    setStatus(`Fetching match history (single request each, limit=${SINGLE_FETCH_LIMIT})…`, "ok");

    const fetched = await Promise.all(playerIds.map(async (pid) => {
      const raw = await fetchPlayerMatchesSingleBatch(pid);
      const filteredType = filterRanked(raw, matchFilterMode);

      const allTime = buildAllTimeCumulativeSeries(filteredType);
      const inRangeRawPts = slicePointsByRange(allTime.points, fromEpoch, toEpochExclusive);
      const remap = remapToSequentialX(inRangeRawPts);

      const matchesInRange = filteredType.filter(m => typeof m.start_time === "number" && m.start_time >= fromEpoch && m.start_time < toEpochExclusive);
      const winsInRange = matchesInRange.reduce((acc, m) => acc + (isWinForPlayer(m) ? 1 : 0), 0);

      const profile = profiles.find(p => p.accountId === pid) || {
        accountId: pid,
        personaname: `Player ${pid}`,
        avatarfull: "",
        profileurl: ""
      };

      return {
        playerId: pid,
        profile,
        raw,
        filteredType,
        allTime,
        pointsInRange: remap.points,
        dayLabelByX: remap.dayLabelByX,
        matchesInRange,
        matchesInRangeCount: matchesInRange.length,
        winsInRange
      };
    }));

    syncPartySelectors(fetched);

    const partyA = $("partyA").value;
    const partyB = $("partyB").value;

    let partyStats = null;
    let partyData = { pointsInRange: [], dayLabelByX: new Map(), metaText: "Select two distinct players for party mode." };

    if (partyA && partyB && partyA !== partyB) {
      const A = fetched.find(x => x.playerId === partyA);
      const B = fetched.find(x => x.playerId === partyB);

      if (A && B) {
        const partyAllTime = buildPartySharedAllTime(A.filteredType, B.filteredType);
        const partyInRangeRaw = slicePointsByRange(partyAllTime.points, fromEpoch, toEpochExclusive);
        const partyRemap = remapToSequentialX(partyInRangeRaw);

        const partyWinsInRange = partyRemap.points.reduce((acc, p) => acc + (isWinForPlayer(p.match.a) ? 1 : 0), 0);

        partyStats = {
          matchesInRange: partyRemap.points.length,
          winsInRange: partyWinsInRange,
          matchesAllTime: partyAllTime.totalAllTime,
          winsAllTime: partyAllTime.winsAllTime
        };

        const Aname = A.profile.personaname;
        const Bname = B.profile.personaname;

        partyData = {
          pointsInRange: partyRemap.points,
          dayLabelByX: partyRemap.dayLabelByX,
          metaText: `A: ${Aname} • B: ${Bname} • Range shared: ${partyStats.matchesInRange} • Range WR: ${pct(partyStats.winsInRange, partyStats.matchesInRange)}`
        };
      }
    }

    const combinedMatchesInRange = fetched.flatMap(p => p.matchesInRange);
    const combinedCountMap = buildDailyCounts(combinedMatchesInRange);
    renderHeatmap($("heatGrid"), fromIso, toIso, combinedCountMap);

    renderSummary({
      fromIso,
      toIso,
      filterLabel,
      fetched,
      partyStats
    });

    renderCharts({
      fetched,
      heroMap,
      partyData,
      filterLabel
    });

    setStatus(
      `Done.\n` +
      `Players: ${fetched.length}\n` +
      `Range: ${fromIso} → ${toIso}\n` +
      `Filter: ${filterLabel}\n` +
      `X-axis: per-match sequence (same-day games are spaced)\n` +
      `Y-axis: all-time cumulative winrate (auto-zoom within window)\n` +
      `Note: no pagination; OpenDota may cap returned history per player.`,
      "ok"
    );

  } catch (err) {
    console.error(err);
    setStatus(String(err?.message || err), "error");
  } finally {
    runBtn.disabled = false;
  }
});
