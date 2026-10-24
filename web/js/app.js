/* ═══════════════════════════════════════════════════════
   点亮山河 · 原型核心逻辑
   纯静态：GeoJSON 地图渲染 + 奇遇画卷 + 答题 + 点亮引擎
   ═══════════════════════════════════════════════════════ */
"use strict";

/* ───────── 全局状态 ───────── */
const STORE_KEY = "dlsx-progress-v1";
const S = {
  content: { provinces: [], cities: [], counties: [], quizzes: [] }, // 内容库
  index: {},            // regionCode -> content node {data, level, parent, code}
  geoByName: {},        // GeoJSON name -> feature
  codeByGeo: {},        // GeoJSON name -> regionCode
  progress: null,       // 用户进度
  view: "intro",        // intro | map | scroll | hall
  currentRegion: null,  // 当前画卷地区 code
  quizCtx: null,        // 闯关上下文
  tutorialDone: false,
};

/* 省级行政区 code ↔ 标准地图名称（硬映射，确保与 GeoJSON 对齐） */
const GEO_MAP = {
  BJ:"北京市",TJ:"天津市",HEB:"河北省",SHX:"山西省",NMG:"内蒙古自治区",
  LN:"辽宁省",JL:"吉林省",HLJ:"黑龙江省",SH:"上海市",JS:"江苏省",ZJ:"浙江省",
  AH:"安徽省",FJ:"福建省",JX:"江西省",SD:"山东省",HEN:"河南省",HB:"湖北省",
  HN:"湖南省",GD:"广东省",GX:"广西壮族自治区",HI:"海南省",CQ:"重庆市",
  SC:"四川省",GZ:"贵州省",YN:"云南省",XZ:"西藏自治区",SAX:"陕西省",
  GS:"甘肃省",QH:"青海省",NX:"宁夏回族自治区",XJ:"新疆维吾尔自治区",
  TW:"台湾省",HK:"香港特别行政区",MO:"澳门特别行政区",
};
// 旧别名（内容文件可能出现）
const CODE_ALIAS = { HE:"HEB", SX:"SHX", IM:"NMG", SN:"SAX", SHA:"SAX" };

/* ───────── 工具 ───────── */
const $ = (id) => document.getElementById(id);
const normCode = (c) => CODE_ALIAS[c] || c;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[m]));
function hash(str) { // 确定性伪随机
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}
const seededRand = (seed) => () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
function toast(msg, ms = 2200) {
  const t = $("toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

/* ───────── 进度存取 ───────── */
function defaultProgress() {
  return { home: null, regions: {}, badges: [], cards: [], settings: { exam: false, theme: "mo" }, firstRun: true, tutorialSeen: false };
}
function loadProgress() {
  try { const raw = localStorage.getItem(STORE_KEY); if (raw) return JSON.parse(raw); } catch (e) {}
  return defaultProgress();
}
function saveProgress() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S.progress)); }
  catch (e) { toast("⚠ 浏览器存储不可用，进度可能无法保存"); }
}
function regionState(code) {
  code = normCode(code);
  if (!S.progress.regions[code]) S.progress.regions[code] = { explored: [], answers: {}, sets: {}, frags: {} };
  if (!S.progress.regions[code].frags) S.progress.regions[code].frags = {};
  return S.progress.regions[code];
}

/* ───────── 内容加载 ───────── */
async function fetchJSON(url) {
  const r = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now());
  if (!r.ok) throw new Error(url + " " + r.status);
  return r.json();
}
async function loadContent() {
  const groups = ["provinces", "cities", "counties", "quizzes"];
  const list = { provinces: [], cities: [], counties: [], quizzes: [] };
  await Promise.all(groups.map(async (g) => {
    let names;
    try { names = await fetchJSON(`data/content/${g}/__index.json`); }
    catch (e) {
      // 无索引时退回目录约定：使用内置名单
      names = { provinces: ["SD-山东.json","GX-广西.json"], cities: ["HEZE-菏泽.json"],
        counties: ["SD-HEZE-9县.json"], quizzes: ["SD-题库.json"] }[g] || [];
    }
    for (const n of names) {
      try { list[g].push(await fetchJSON(`data/content/${g}/` + encodeURIComponent(n))); }
      catch (e) { console.warn("内容缺失", n); }
    }
  }));
  S.content = list;
  // 建索引
  for (const g of ["provinces", "cities", "counties"]) {
    for (const node of list[g]) {
      const code = normCode(node.region.code);
      S.index[code] = { data: node, level: node.region.level, parent: node.region.parent ? normCode(node.region.parent) : null, code };
    }
  }
  // 挂载独立题库文件（quizzes/*.json）到对应地区，使闯关题/考点标注题进入题池
  for (const quizNode of list.quizzes) {
    const code = normCode(quizNode.region);
    if (S.index[code]) {
      S.index[code].data.sets = (S.index[code].data.sets || []).concat(quizNode.sets || []);
    }
  }
}

/* ───────── 地图渲染（手写 Albers 等积圆锥投影） ───────── */
function albersProjection() {
  const rad = Math.PI / 180;
  const phi1 = 25 * rad, phi2 = 47 * rad, phi0 = 36 * rad, lam0 = 105 * rad;
  const n = (Math.sin(phi1) + Math.sin(phi2)) / 2;
  const C = Math.cos(phi1) ** 2 + 2 * n * Math.sin(phi1);
  const rho0 = Math.sqrt(C - 2 * n * Math.sin(phi0)) / n;
  return {
    project(lam, phi) {
      lam *= rad; phi *= rad;
      const rho = Math.sqrt(Math.max(0, C - 2 * n * Math.sin(phi))) / n;
      const theta = n * (lam - lam0);
      // SVG y 轴向下：数学坐标 y 需翻转，否则南北颠倒
      return { x: rho * Math.sin(theta) * 1000, y: (rho * Math.cos(theta) - rho0) * 1000 };
    },
  };
}
function geoBounds(features) {
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  const proj = albersProjection();
  const walk = (coords) => {
    for (const c of coords) {
      if (typeof c[0] === "number") {
        const p = proj.project(c[0], c[1]);
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      } else walk(c);
    }
  };
  for (const f of features) walk(f.geometry.coordinates);
  return { minX, minY, maxX, maxY };
}
function renderMap() {
  const svg = $("china-map");
  svg.innerHTML = "";
  const features = S.geoFeatures;
  const b = geoBounds(features);
  const W = b.maxX - b.minX, H = b.maxY - b.minY, PAD = 30;
  svg.setAttribute("viewBox", `${b.minX - PAD} ${b.minY - PAD} ${W + PAD * 2} ${H + PAD * 2}`);
  const NS = "http://www.w3.org/2000/svg";
  const g = document.createElementNS(NS, "g");

  // 注入渐变与滤镜定义（stop 用类挂色，颜色随皮肤主题切换）
  const defs = document.createElementNS(NS, "defs");
  defs.innerHTML = `
    <linearGradient id="gradUn" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" class="stop-i"/><stop offset="1" class="stop-j"/>
    </linearGradient>
    <linearGradient id="gradGlimmer" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" class="stop-a"/><stop offset="1" class="stop-b"/>
    </linearGradient>
    <linearGradient id="gradHalf" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" class="stop-c"/><stop offset="0.52" class="stop-d"/>
      <stop offset="0.54" class="stop-e"/><stop offset="1" class="stop-f"/>
    </linearGradient>
    <linearGradient id="gradFull" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" class="stop-g"/><stop offset="1" class="stop-h"/>
    </linearGradient>
    <filter id="mapShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="${(W / 90).toFixed(1)}" stdDeviation="${(W / 110).toFixed(1)}" flood-color="#000" flood-opacity="0.5"/>
    </filter>`;
  g.appendChild(defs);

  // ── 海面 + 祥云 + 罗盘装饰层（随主题换装） ──
  const bg = document.createElementNS(NS, "g");
  const cloud = "M0,0 q12,-20 30,-10 q8,-14 26,-7 q18,-7 27,7 q18,1 13,14 q-12,11 -46,9 q-38,3 -47,-5 q-9,-9 -3,-8 z";
  bg.innerHTML = `
    <rect class="sea" x="${b.minX - PAD * 4}" y="${b.minY - PAD * 4}" width="${W + PAD * 8}" height="${H + PAD * 8}" rx="${(W * 0.025).toFixed(1)}"/>
    <g class="decor">
      <path d="${cloud}" transform="translate(${(b.minX + W * 0.03).toFixed(0)},${(b.minY + H * 0.04).toFixed(0)}) scale(${(W / 900).toFixed(2)})"/>
      <path d="${cloud}" transform="translate(${(b.minX + W * 0.86).toFixed(0)},${(b.minY + H * 0.9).toFixed(0)}) scale(${(W / 700).toFixed(2)})"/>
      <path d="${cloud}" transform="translate(${(b.minX + W * 0.78).toFixed(0)},${(b.minY + H * 0.05).toFixed(0)}) scale(${(W / 1300).toFixed(2)})"/>
      <circle cx="${(b.minX + W * 0.965).toFixed(0)}" cy="${(b.minY + H * 0.085).toFixed(0)}" r="${(W / 38).toFixed(0)}" fill="none" stroke-width="1.5"/>
      <circle cx="${(b.minX + W * 0.965).toFixed(0)}" cy="${(b.minY + H * 0.085).toFixed(0)}" r="${(W / 60).toFixed(0)}" fill="none" stroke-width="1"/>
      <path d="M${(b.minX + W * 0.965 - W / 45).toFixed(0)},${(b.minY + H * 0.085).toFixed(0)} H${(b.minX + W * 0.965 + W / 45).toFixed(0)} M${(b.minX + W * 0.965).toFixed(0)},${(b.minY + H * 0.085 - W / 45).toFixed(0)} V${(b.minY + H * 0.085 + W / 45).toFixed(0)}" fill="none" stroke-width="1"/>
    </g>`;
  g.appendChild(bg);

  const land = document.createElementNS(NS, "g");
  land.setAttribute("filter", "url(#mapShadow)");

  const mountainGroups = [];
  const labelEls = [];
  for (const f of features) {
    const name = f.properties.name;
    const code = S.codeByGeo[name];
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", buildPathD(f.geometry));
    path.classList.add("province");
    const hasContent = code && S.index[code];
    path.classList.add(hasContent ? "p-unexplored" : "p-none");
    if (!hasContent) { path.style.pointerEvents = "none"; }
    else {
      const tier = computeTier(code).tier;
      path.dataset.code = code;
      applyTierClass(path, tier);
      path.addEventListener("click", () => onProvinceClick(code, name));
      path.addEventListener("mousemove", (ev) => showMapTip(ev, code, name));
      path.addEventListener("mouseleave", () => $("map-tooltip").classList.add("hidden"));
    }
    land.appendChild(path);

    // 山形肌理：大省份内随机点缀水墨小山（裁剪在省界内，随主题换色）
    if (hasContent && code) {
      const coords = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
      let ring = null, ringLen = 0;
      for (const poly of coords) { if (poly[0].length > ringLen) { ringLen = poly[0].length; ring = poly[0]; } }
      if (ring && ringLen > 60) {
        const xs = ring.map(c => c[0]), ys = ring.map(c => c[1]);
        const pA = albersProjection().project(Math.min(...xs), Math.min(...ys));
        const pB = albersProjection().project(Math.max(...xs), Math.max(...ys));
        const bx0 = Math.min(pA.x, pB.x), bx1 = Math.max(pA.x, pB.x);
        const by0 = Math.min(pA.y, pB.y), by1 = Math.max(pA.y, pB.y);
        if (bx1 - bx0 > W * 0.04 && by1 - by0 > H * 0.04) {
          defs.innerHTML += `<clipPath id="clip-${code}"><path d="${buildPathD(f.geometry)}"/></clipPath>`;
          const rnd = seededRand(hash("mount" + code));
          const n = 3 + Math.floor(rnd() * 4);
          let items = "";
          for (let k = 0; k < n; k++) {
            const cx = bx0 + (bx1 - bx0) * (0.18 + rnd() * 0.64);
            const cy = by0 + (by1 - by0) * (0.2 + rnd() * 0.6);
            const mw = Math.max(5, W * (0.011 + rnd() * 0.008));
            const mh = mw * (0.72 + rnd() * 0.4);
            items += `<path class="mount" d="M${(cx - mw / 2).toFixed(1)},${cy.toFixed(1)} L${cx.toFixed(1)},${(cy - mh).toFixed(1)} L${(cx + mw / 2).toFixed(1)},${cy.toFixed(1)} Z"/>`;
            if (rnd() > 0.5) items += `<path class="mount" d="M${(cx + mw * 0.55).toFixed(1)},${cy.toFixed(1)} L${(cx + mw * 0.95).toFixed(1)},${(cy - mh * 0.62).toFixed(1)} L${(cx + mw * 1.35).toFixed(1)},${cy.toFixed(1)} Z"/>`;
          }
          mountainGroups.push(`<g clip-path="url(#clip-${code})">${items}</g>`);
        }
      }
    }

    // 省份标签：牌签式（随主题换装），无内容要素与港澳跳过
    const c = featureCenter(f);
    if (c && hasContent && !["澳门特别行政区","香港特别行政区"].includes(name)) {
      const p = albersProjection().project(c[0], c[1]);
      const nm = shortName(name);
      const fs = Math.max(9, Math.min(13, W / 92));
      const wpx = nm.length * fs * 1.18 + fs * 0.9;
      const label = document.createElementNS(NS, "g");
      label.setAttribute("class", "prov-label");
      label.innerHTML = `<rect class="chip-bg" x="${(p.x - wpx / 2).toFixed(1)}" y="${(p.y - fs * 0.95).toFixed(1)}" width="${wpx.toFixed(1)}" height="${(fs * 1.9).toFixed(1)}" rx="${(fs * 0.4).toFixed(1)}"/>` +
        `<text class="chip-text" x="${p.x.toFixed(1)}" y="${(p.y + fs * 0.38).toFixed(1)}" text-anchor="middle" font-size="${fs.toFixed(1)}">${esc(nm)}</text>`;
      label.style.pointerEvents = "none";
      labelEls.push(label);
    }
  }
  // 图层顺序：陆地(填色+山形) → 标签牌
  const mountLayer = document.createElementNS(NS, "g");
  mountLayer.innerHTML = mountainGroups.join("");
  land.appendChild(mountLayer);
  g.appendChild(land);
  for (const el of labelEls) g.appendChild(el);
  svg.appendChild(g);
  refreshMapStatus();
}
function buildPathD(geometry) {
  const proj = albersProjection();
  const line = (coords) => coords.map((c, i) => {
    const p = proj.project(c[0], c[1]);
    return (i === 0 ? "M" : "L") + p.x.toFixed(1) + "," + p.y.toFixed(1);
  }).join("");
  const poly = (coords) => (typeof coords[0][0] === "number" ? [coords] : coords)
    .map(ring => line(ring)).join("");
  if (geometry.type === "Polygon") return poly(geometry.coordinates) + "Z";
  if (geometry.type === "MultiPolygon") return geometry.coordinates.map(p => poly(p)).join("Z") + "Z";
  return "";
}
function featureCenter(f) {
  // 粗略取最大 ring 的坐标平均
  const coords = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
  let best = null, bestLen = 0;
  for (const poly of coords) { const ring = poly[0]; if (ring.length > bestLen) { bestLen = ring.length; best = ring; } }
  if (!best) return null;
  let x = 0, y = 0;
  for (const c of best) { x += c[0]; y += c[1]; }
  return [x / best.length, y / best.length];
}
const shortName = (geoName) =>
  geoName.replace(/(省|市|维吾尔自治区|壮族自治区|回族自治区|自治区|特别行政区)$/, "");
function showMapTip(ev, code, geoName) {
  const tip = $("map-tooltip");
  const st = computeTier(code);
  tip.innerHTML = `${esc(shortName(geoName))}<span class="tt-tier">${TIER_NAMES[st.tier]} · ${st.score}%</span>`;
  tip.style.left = ev.clientX + "px"; tip.style.top = ev.clientY + "px";
  tip.classList.remove("hidden");
}
function applyTierClass(path, tier) {
  path.classList.remove("p-unexplored", "p-glimmer", "p-half", "p-full");
  path.classList.add(["p-unexplored", "p-glimmer", "p-half", "p-full"][tier]);
}

/* ───────── 了解度引擎（PRD US-03） ─────────
   了解度 = 探索分×40% + 答题分×60%
   探索分 = 已点亮奇遇/奇遇总数×100
   答题分 = 首答正确率 × 题库覆盖率
   单调递增；首答计分不刷分 */
function encountersOf(code) {
  code = normCode(code);
  const node = S.index[code];
  if (!node) return [];
  if (node.data.encounters) return node.data.encounters;
  if (node.data.counties) return node.data.counties.flatMap(c => c.encounters || []);
  return [];
}
function quizPoolOf(code) {
  // 闯关题池：地区题库 + 各奇遇内嵌小测（统一编 qid）
  const pool = [];
  const node = S.index[normCode(code)];
  if (node && node.data.sets) {
    for (const set of node.data.sets) for (const q of set.questions)
      pool.push({ id: q.id, q, setId: set.setId });
  }
  for (const e of encountersOf(code)) {
    if (e.quiz) pool.push({ id: e.id + "-Q", q: {
      question: e.quiz.question, options: e.quiz.options,
      answer: e.quiz.answer, explanation: e.quiz.explanation,
      examPoint: e.examPoint, examMeta: null,
    }, setId: "enc" });
  }
  return pool;
}
function computeTier(code) {
  code = normCode(code);
  const st = regionState(code);
  const encs = encountersOf(code);
  const pool = quizPoolOf(code);
  const explored = new Set(st.explored);
  const exploreScore = encs.length ? Math.min(100, explored.size / encs.length * 100) : 0;
  let firstTry = 0, correct = 0;
  for (const item of pool) { // answers: qid -> 0/1（仅记录首答）
    if (st.answers[item.id] !== undefined) { firstTry++; if (st.answers[item.id]) correct++; }
  }
  const coverage = pool.length ? firstTry / pool.length : 0;
  const acc = firstTry ? correct / firstTry : 0;
  const quizScore = Math.min(100, acc * coverage * 100);
  const score = Math.round(exploreScore * 0.4 + quizScore * 0.6);
  const tier = score >= 90 ? 3 : score >= 70 ? 2 : score >= 40 ? 1 : 0;
  return { score, tier, explored: explored.size, total: encs.length };
}
const TIER_NAMES = ["水墨留白", "微光初现", "半壁生辉", "华彩全亮"];
const TIER_ICON = ["🌑", "🌤", "🌗", "🌕"];

/* ───────── 皮肤系统（四套画卷皮肤） ───────── */
const THEMES = [
  { id: "mo", name: "墨渊鎏金" },
  { id: "ty", name: "桃源手账" },
  { id: "xj", name: "仙剑云海" },
  { id: "qd", name: "碧海群岛" },
];
function applyTheme(id) {
  if (!THEMES.some(t => t.id === id)) id = "mo";
  document.body.classList.remove(...THEMES.map(t => "theme-" + t.id));
  document.body.classList.add("theme-" + id);
  document.querySelectorAll(".swatch").forEach(s => s.classList.toggle("active", s.dataset.theme === id));
  if (S.progress && S.progress.settings) { S.progress.settings.theme = id; saveProgress(); }
}

/* ───────── 视图切换 ───────── */
function show(view) {
  for (const v of ["intro", "map-view", "scroll-view", "hall-view"]) $(v).classList.add("hidden");
  $("topbar").classList.toggle("hidden", view === "intro");
  const id = { intro: "intro", map: "map-view", scroll: "scroll-view", hall: "hall-view" }[view];
  if (id) $(id).classList.remove("hidden");
  S.view = view;
  $("crumb").textContent = "";
  if (view === "map") refreshMapStatus();
}
function refreshMapStatus() {
  let provLit = 0, cityLit = 0, countyLit = 0;
  for (const [code] of Object.entries(S.progress.regions)) {
    if (!S.index[code]) continue;
    const t = computeTier(code).tier;
    if (S.index[code].level === "province" && t >= 1) provLit++;
    if (S.index[code].level === "city" && t >= 1) cityLit++;
    if (S.index[code].level === "county-group" && t >= 1) countyLit++;
  }
  const provTotal = Object.values(S.index).filter(n => n.level === "province").length;
  const cityTotal = Object.values(S.index).filter(n => n.level === "city").length;
  const countyTotal = Object.values(S.index).filter(n => n.level === "county-group").length;
  $("progress-line").textContent =
    `点亮进度：省 ${provLit}/${provTotal || "…"} · 市 ${cityLit}/${cityTotal} · 县 ${countyTotal ? countyLit + "/" + countyTotal : "0/9"}`;
  const e = S.currentRegion ? computeTier(S.currentRegion) : null;
  $("today-line").textContent = e ? `当前：${e.explored}/${e.total} 奇遇` : "";
}

/* ───────── 省份点击 & 选家乡 ───────── */
function onProvinceClick(code, geoName) {
  code = normCode(code);
  if (!S.index[code]) { toast("此城尚在绘制中，敬请期待"); return; }
  if (S.progress.firstRun && !S.progress.home) {
    S.progress.home = code; S.progress.firstRun = false;
    awardBadge(`home-${code}`, shortName(geoName), "🏠 乡关何处", "家乡徽章");
    toast(`家乡已定：${shortName(geoName)}。看看你对家乡了解多少！`);
    saveProgress();
  }
  openScroll(code);
}

/* ───────── 画卷（奇遇场景） ───────── */
function openScroll(code) {
  code = normCode(code);
  const node = S.index[code];
  if (!node) return;
  S.currentRegion = code;
  const encs = encountersOf(code);
  const field = $("encounter-field");
  field.innerHTML = "";
  // 背景山水
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  bg.setAttribute("class", "bg-svg");
  bg.setAttribute("viewBox", "0 0 1400 700"); bg.setAttribute("preserveAspectRatio", "xMidYMax slice");
  bg.innerHTML = `
    <path d="M0,700 L0,520 Q150,380 320,470 T640,430 T980,490 T1300,440 L1400,470 L1400,700Z" fill="rgba(200,164,92,0.07)"/>
    <path d="M0,700 L0,580 Q220,470 430,545 T860,530 T1240,560 L1400,540 L1400,700Z" fill="rgba(10,9,7,0.55)"/>
    <path d="M0,700 L0,640 Q300,580 620,625 T1060,618 T1400,640 L1400,700Z" fill="rgba(10,9,7,0.82)"/>
    <path d="M60,540 q30,-90 60,0" stroke="rgba(200,164,92,.22)" fill="none" stroke-width="1.5"/>
    <path d="M1180,500 q40,-110 80,0" stroke="rgba(200,164,92,.18)" fill="none" stroke-width="1.5"/>
    <circle cx="240" cy="180" r="46" fill="rgba(232,200,122,.045)"/>
    <circle cx="1130" cy="150" r="60" fill="rgba(232,200,122,.035)"/>`;
  field.appendChild(bg);

  // 今日奇遇（按日期+地区确定性随机 3 个）
  const today = new Date().toISOString().slice(0, 10);
  const todaySet = new Set();
  if (encs.length) {
    const rnd = seededRand(hash(today + code));
    const idxs = encs.map((_, i) => i).sort(() => rnd() - 0.5).slice(0, Math.min(3, encs.length));
    idxs.forEach(i => todaySet.add(encs[i].id));
  }
  // 奇遇点散布（确定性伪随机位置，5 行错落）
  const st = regionState(code);
  const done = new Set(st.explored);
  encs.forEach((e, i) => {
    const rnd = seededRand(hash(e.id + code));
    const x = 90 + (i * (1260 / Math.max(encs.length - 1, 1))) + rnd() * 60;
    const row = i % 5;
    const y = 130 + row * 108 + rnd() * 46;
    const dot = document.createElement("button");
    dot.className = "enc-dot" + (done.has(e.id) ? " done" : "") + (todaySet.has(e.id) && !done.has(e.id) ? " today" : "");
    dot.style.left = x + "px"; dot.style.top = y + "px";
    dot.innerHTML = `<span class="halo"></span>` +
      (done.has(e.id) ? `<span class="emo">${typeEmoji(e.type)}</span>` : `<span style="font-size:23px;letter-spacing:-2px">？</span>`) +
      (done.has(e.id) ? `<span class="enc-label">${esc(e.title)}</span>` : "");
    dot.title = done.has(e.id) ? e.title : "未知的奇遇";
    dot.addEventListener("click", () => openEncounter(code, e.id));
    field.appendChild(dot);
  });

  // 闯关牌坊
  const pool = quizPoolOf(code);
  if (pool.length >= 5) {
    const arch = document.createElement("button");
    arch.className = "arch-btn"; arch.id = "arch-btn";
    const tier = computeTier(code).tier;
    arch.textContent = tier >= 3 ? "再战问剑" : "问 剑 闯 关";
    arch.addEventListener("click", () => startQuiz(code));
    field.appendChild(arch);
  }

  // 下钻面板
  renderDrillPanel(code);

  // 头部
  $("scroll-title").textContent = node.level === "city" ? node.data.region.name + " · 市"
    : node.level === "county-group" ? "九县画卷" : node.data.region.name;
  updateScrollHeader();
  show("scroll");
  if (!S.progress.tutorialSeen) { $("tutorial-tip").classList.remove("hidden"); }
}
function typeEmoji(t) {
  return { 名人:"👤", 风物:"🍲", 山水:"⛰", 事件:"📜", 热梗:"🔥", 考点:"📖" }[t] || "✦";
}

/* ── 碎片式呈现（游戏感）：钩子句 + 盲盒碎片 + 小测解锁 ── */
const TYPE_FLAVOR = {
  名人: "画卷深处，一位故人向你走来",
  山水: "云雾散开，眼前豁然开朗",
  风物: "一缕香气把你引了过来",
  事件: "泥土里露出半块残碑",
  热梗: "江湖上悄悄传着一句暗语",
  考点: "先生缓缓展开一卷考题",
};
const FRAG_NUMS = ["壹","贰","叁","肆","伍","陆","柒","捌"];
function firstSentence(text) {
  const m = String(text).match(/^.{0,44}?[。！？!?]/);
  return m ? m[0] : String(text).slice(0, 44) + "……";
}
function openedFrags(regionCode, encId) {
  return new Set(regionState(regionCode).frags[encId] || []);
}
function updateScrollHeader() {
  const { score, tier } = computeTier(S.currentRegion);
  $("knowledge-bar").style.width = score + "%";
  $("knowledge-num").textContent = score + "%";
  const badge = $("tier-badge");
  badge.textContent = TIER_NAMES[tier];
  badge.className = "tier-badge tier-" + tier;
  refreshMapStatus();
}
function renderDrillPanel(code) {
  code = normCode(code);
  const panel = $("drill-panel");
  const node = S.index[code];
  const info = computeTier(code);
  let html = `<h4>层层下钻</h4><div class="drill-note">${esc(node.data.region.name)}：${TIER_NAMES[info.tier]}（${info.score}%）<br>`;
  if (node.level === "province") {
    html += info.tier >= 2 ? "已解锁市级下钻 ✅" : "了解度≥70%（半壁生辉）解锁市级下钻";
    if (info.tier >= 2) {
      const cities = Object.values(S.index).filter(n => n.parent === code && n.level === "city");
      const heze = S.index["HEZE"];
      const items = [...cities];
      if (code === "SD" && heze && !cities.some(c => c.code === "HEZE")) items.push(heze);
      html += items.map(c => {
        const t = computeTier(c.code);
        return `<div class="drill-item" data-code="${c.code}"><span>${esc(c.data.region.name)}</span><span class="d-tier">${TIER_NAMES[t.tier]}</span></div>`;
      }).join("") +
      `<div class="drill-note">15座明星城市与菏泽试点已开放，其余城市绘制中</div>`;
    }
  } else if (node.level === "city") {
    const county = Object.values(S.index).find(n => n.level === "county-group" && n.parent === code);
    if (county) {
      html += info.tier >= 3 ? "已解锁县级下钻 ✅" : "市了解度≥90%（华彩全亮）解锁县级下钻";
      if (info.tier >= 3) {
        html += `<div class="drill-item" data-code="${county.code}"><span>进入九县区</span><span class="d-tier">→</span></div>`;
      }
    } else html += "该市暂无县级下钻";
  } else if (node.level === "county-group") {
    html += "已到最深层级 · 县区画卷";
  }
  html += `</div>`;
  panel.innerHTML = html;
  panel.classList.remove("hidden");
  panel.querySelectorAll(".drill-item").forEach(el =>
    el.addEventListener("click", () => openScroll(el.dataset.code)));
}

/* ───────── 奇遇卡 ───────── */
function openEncounter(regionCode, encId) {
  const e = encountersOf(regionCode).find(x => x.id === encId);
  if (!e) return;
  const card = $("encounter-card");
  $("card-rarity").textContent = e.rarity;
  $("card-rarity").className = "rarity-tag rarity-" + e.rarity;
  $("card-credibility").textContent = e.credibility === "史实" ? "" : e.credibility;
  $("card-credibility").className = "credibility-tag cred-" + e.credibility;
  $("card-type").textContent = "· " + e.type + " · " + typeEmoji(e.type);
  $("card-title").textContent = e.title;
  $("card-place").textContent = "📍 " + (e.place || "") + (e.rarity === "SSR" ? "　✧ 传说级偶遇" : "");
  const exam = $("card-exam");
  if (S.progress.settings.exam && e.examPoint) { exam.classList.remove("hidden"); exam.textContent = "📖 考点 · " + e.examPoint; }
  else exam.classList.add("hidden");
  // 碎片式呈现：钩子 + 盲盒碎片；长文默认折叠
  const hookEl = $("card-hook"), fragEl = $("card-frags");
  const contentEl = $("card-content"), expandBtn = $("card-expand");
  const frags = e.knowledgeDensity || [];
  const opened = openedFrags(regionCode, encId);
  contentEl.textContent = e.content;
  if (frags.length >= 2) {
    hookEl.classList.remove("hidden");
    hookEl.innerHTML = `<span class="fl">✦ ${esc(TYPE_FLAVOR[e.type] || "画卷微光一闪")}</span>「${esc(firstSentence(e.content))}」`;
    fragEl.classList.remove("hidden");
    const allDone = opened.size >= frags.length;
    fragEl.innerHTML = `<div class="frag-head ${allDone ? "done" : ""}">${allDone ? "✦ 碎片补全 · 小测已解锁" : "知识碎片 <span id=\"frag-count\">" + opened.size + "/" + frags.length + "</span>"}</div>` +
      frags.map((f, i) => `<button class="frag-chip ${opened.has(i) ? "open" : ""}" data-i="${i}">
        <span class="frag-idx">${FRAG_NUMS[i] || i + 1}</span>
        <span class="frag-text">${opened.has(i) ? esc(f) : "？？？"}</span></button>`).join("");
    fragEl.querySelectorAll(".frag-chip:not(.open)").forEach(chip => chip.addEventListener("click", () => {
      const i = +chip.dataset.i;
      chip.classList.add("open");
      chip.querySelector(".frag-text").textContent = frags[i];
      const st = regionState(regionCode);
      (st.frags[encId] ??= []).push(i);
      saveProgress();
      const total = frags.length, done = st.frags[encId].length;
      if (done >= total) {
        const head = fragEl.querySelector(".frag-head");
        head.classList.add("done");
        head.textContent = "✦ 碎片补全 · 小测已解锁";
        renderCardQuiz(regionCode, e);
        toast("✦ 碎片补全，小测已解锁");
      } else {
        const cnt = fragEl.querySelector("#frag-count");
        if (cnt) cnt.textContent = done + "/" + total;
      }
    }));
    contentEl.classList.add("hidden");
    expandBtn.classList.remove("hidden");
    expandBtn.textContent = "展开细读全文";
  } else {
    hookEl.classList.add("hidden");
    fragEl.classList.add("hidden");
    contentEl.classList.remove("hidden");
    expandBtn.classList.add("hidden");
  }
  const q = $("card-quote");
  if (e.quote && e.quote.text) {
    q.classList.remove("hidden");
    q.innerHTML = `「${esc(e.quote.text)}」<br><span style="font-size:12.5px">—— ${esc(e.quote.author)}《${esc(e.quote.work)}》</span>`;
  } else q.classList.add("hidden");
  $("card-sources").textContent = "📎 来源：" + (e.sources || []).join("；");
  renderCardQuiz(regionCode, e);
  $("ask-answer").classList.add("hidden");
  card.classList.remove("hidden");

  // 首次点开即计探索分（防刷：Set 去重）
  const st = regionState(regionCode);
  if (!st.explored.includes(encId)) {
    st.explored.push(encId);
    awardCard(e, regionCode);
    saveProgress();
    const before = computeTier(regionCode).tier;
    updateScrollHeader(); renderDrillPanel(regionCode);
    checkTierUp(regionCode, before);
    // 刷新画卷上的点
    refreshDots(regionCode);
  }
}
function refreshDots(regionCode) {
  // 重新打开画卷刷新奇遇点状态（轻量：重开）
  openScroll(regionCode);
  // openScroll 会重建 field，重新打开当前奇遇卡保持上下文
}
function renderCardQuiz(regionCode, e) {
  const box = $("card-quiz");
  if (!e.quiz) { box.innerHTML = ""; return; }
  const qid = e.id + "-Q";
  const answered = regionState(regionCode).answers[qid] !== undefined;
  if (answered) {
    box.innerHTML = `<p class="quiz-q">✦ ${esc(e.quiz.question)}</p>
      <p class="quiz-done-note">已完成小测（首答计分）· 正确答案：${esc(e.quiz.options[e.quiz.answer])}</p>`;
    return;
  }
  // 碎片未补全 → 小测上锁（闯关牌坊不受影响）
  const frags = e.knowledgeDensity || [];
  const need = frags.length >= 2;
  const openedN = (regionState(regionCode).frags[e.id] || []).length;
  if (need && openedN < frags.length) {
    box.innerHTML = `<p class="quiz-q">✦ ${esc(e.quiz.question)}</p>
      <p class="quiz-lock">🔒 补全全部知识碎片（${openedN}/${frags.length}）后解锁小测</p>`;
    return;
  }
  box.innerHTML = `<p class="quiz-q">✦ ${esc(e.quiz.question)}</p>` +
    e.quiz.options.map((o, i) => `<button class="quiz-opt" data-i="${i}">${"ABCD"[i] || "·"}．${esc(o)}</button>`).join("");
  box.querySelectorAll(".quiz-opt").forEach(btn => btn.addEventListener("click", () => {
    const pick = +btn.dataset.i, correct = pick === e.quiz.answer;
    regionState(regionCode).answers[qid] = correct ? 1 : 0;
    saveProgress();
    box.querySelectorAll(".quiz-opt").forEach(b => {
      b.disabled = true;
      if (+b.dataset.i === e.quiz.answer) b.classList.add("correct");
      else if (+b.dataset.i === pick) b.classList.add("wrong");
    });
    const ex = document.createElement("div");
    ex.className = "quiz-explain";
    ex.innerHTML = (correct ? "✅ 答对了！" : "❌ 答错了。") + " " + esc(e.quiz.explanation || "");
    box.appendChild(ex);
    const before = computeTier(regionCode).tier;
    updateScrollHeader(); renderDrillPanel(regionCode);
    setTimeout(() => checkTierUp(regionCode, before), 600);
  }));
}

/* ───────── 闯关（自动组卷：题库不足时用奇遇小测补足5题） ───────── */
function startQuiz(regionCode) {
  const node = S.index[normCode(regionCode)];
  const pool = quizPoolOf(regionCode);
  const st = regionState(regionCode);
  // 未作答的优先，凑5题
  let candidates = pool.filter(p => st.answers[p.id] === undefined);
  if (candidates.length < 5) candidates = candidates.concat(pool.filter(p => st.answers[p.id] !== undefined));
  const rnd = seededRand(hash(regionCode + Date.now()));
  const picked = candidates.sort(() => rnd() - 0.5).slice(0, 5);
  if (!picked.length) { toast("此地的题都被你答完了，去看看别的奇遇吧"); return; }
  const setName = node.data.sets && node.data.sets[0] ? node.data.sets[0].name : "山水问剑";
  S.quizCtx = { regionCode, items: picked, idx: 0, correct: 0 };
  $("quiz-name").textContent = "🏛 " + setName;
  $("quiz-view").classList.remove("hidden");
  renderQuizQuestion();
}
function renderQuizQuestion() {
  const { items, idx, correct } = S.quizCtx;
  const item = items[idx];
  const q = item.q;
  $("quiz-step").textContent = `第 ${idx + 1} / ${items.length} 题 · 已对 ${correct}`;
  const examTag = (S.progress.settings.exam && q.examPoint) ? `<span class="quiz-exam-tag">考点·${esc(q.examPoint)}</span>` : "";
  const body = $("quiz-body");
  const opts = q.type === "boolean" || q.options.length === 2
    ? q.options.map((o, i) => `<button class="quiz-opt" data-i="${i}">${i ? "错" : "对"}．${esc(o)}</button>`).join("")
    : q.options.map((o, i) => `<button class="quiz-opt" data-i="${i}">${"ABCD"[i]}．${esc(o)}</button>`).join("");
  body.innerHTML = `<p class="quiz-q-main">${esc(q.question)}${examTag}</p><div id="q-opts">${opts}</div><div id="q-explain"></div>`;
  body.querySelectorAll(".quiz-opt").forEach(btn => btn.addEventListener("click", () => {
    const pick = +btn.dataset.i;
    const isCorrect = pick === q.answer;
    if (isCorrect) S.quizCtx.correct++;
    // 首答计分（regionState.answers 已有则不覆盖）
    const st = regionState(S.quizCtx.regionCode);
    if (st.answers[item.id] === undefined) st.answers[item.id] = isCorrect ? 1 : 0;
    saveProgress();
    document.querySelectorAll("#q-opts .quiz-opt").forEach(b => {
      b.disabled = true;
      if (+b.dataset.i === q.answer) b.classList.add("correct");
      else if (+b.dataset.i === pick) b.classList.add("wrong");
    });
    $("q-explain").innerHTML = `<div class="quiz-explain">${isCorrect ? "✅" : "❌"} ${esc(q.explanation || "")}</div>
      <button class="btn-solid btn-next" id="q-next">${idx + 1 === items.length ? "看结算" : "下一题"}</button>`;
    $("q-next").addEventListener("click", () => {
      if (idx + 1 === items.length) finishQuiz();
      else { S.quizCtx.idx++; renderQuizQuestion(); }
    });
  }));
}
function finishQuiz() {
  const { regionCode, items, correct } = S.quizCtx;
  const rate = Math.round(correct / items.length * 100);
  const before = computeTier(regionCode).tier;
  updateScrollHeader(); renderDrillPanel(regionCode);
  const after = computeTier(regionCode);
  $("quiz-step").textContent = "";
  $("quiz-body").innerHTML = `<div class="quiz-result">
    <div class="score">${rate}<span style="font-size:22px">分</span></div>
    <p class="r-line">答对 ${correct} / ${items.length} · ${esc(S.index[regionCode].data.region.name)}了解度 ${after.score}%（${TIER_NAMES[after.tier]}）</p>
    ${rate >= 80 ? `<p class="r-line">📜 再遇几个奇遇，此地灯火可期。</p>` : `<p class="r-line">📜 去画卷里多走几步，奇遇里藏着答案。</p>`}
    <button class="btn-solid btn-next" id="q-close">回画卷</button></div>`;
  $("q-close").addEventListener("click", () => {
    $("quiz-view").classList.add("hidden");
    checkTierUp(regionCode, before);
    openScroll(regionCode);
  });
  saveProgress();
}

/* ───────── 升档 & 点亮动画 & 勋章 ───────── */
function checkTierUp(regionCode, beforeTier) {
  const { tier, score } = computeTier(regionCode);
  if (tier > beforeTier && tier >= 1) {
    const name = S.index[normCode(regionCode)].data.region.name;
    const badgeName = { 1: "微光初现", 2: "半壁生辉", 3: "华彩全亮" }[tier];
    awardBadge(`${regionCode}-t${tier}`, name, badgeName, "地区冰箱贴");
    if (tier === 3) awardBadge(`${regionCode}-gold`, name, "鎏金印章", "全亮成就");
    $("lightup-tier").textContent = "✦ " + TIER_NAMES[tier] + " ✦";
    $("lightup-region").textContent = name;
    $("lightup-badge").textContent = `获得冰箱贴「${name}·${badgeName}」`;
    $("lightup-overlay").classList.remove("hidden");
    // 地图上高亮（若已渲染）
    const path = document.querySelector(`.province[data-code="${normCode(regionCode)}"]`);
    if (path) { applyTierClass(path, tier); path.classList.add("lit-anim"); }
    saveProgress();
  }
}
function awardBadge(id, regionName, label, kind) {
  if (!S.progress.badges.some(b => b.id === id)) {
    S.progress.badges.push({ id, region: regionName, label, kind, at: Date.now() });
  }
}
function awardCard(enc, regionCode) {
  const id = "card-" + enc.id;
  if (!S.progress.cards.some(c => c.id === id)) {
    S.progress.cards.push({ id, title: enc.title, rarity: enc.rarity, type: enc.type, region: S.index[normCode(regionCode)]?.data.region.name, at: Date.now() });
    if (enc.rarity === "SSR" || enc.rarity === "SR") toast(`✨ 获得奇遇卡牌【${enc.rarity}】${enc.title}`);
  }
}

/* ───────── 成就殿堂 ───────── */
function renderHall() {
  const body = $("hall-body");
  const tab = document.querySelector(".hall-tab.active").dataset.tab;
  if (tab === "badges") {
    const owned = S.progress.badges;
    const all = [];
    for (const [code, node] of Object.entries(S.index)) {
      for (const t of [1, 2, 3]) all.push({ id: `${code}-t${t}`, name: node.data.region.name, tier: t });
    }
    const ownedIds = new Set(owned.map(b => b.id));
    const rows = all.map(a => {
      const o = owned.find(b => b.id === a.id);
      const labels = { 1: "微光初现", 2: "半壁生辉", 3: "华彩全亮" };
      return `<div class="badge-card ${o ? "owned" : "locked"}">
        <div class="b-icon">${["", "🌤", "🌗", "🌕"][a.tier]}</div>
        <div class="b-name">${esc(a.name)}</div>
        <div class="b-sub">${labels[a.tier]}${o ? " · " + new Date(o.at).toLocaleDateString() : ""}</div></div>`;
    }).join("");
    body.innerHTML = `<div class="section-title">地区冰箱贴（${owned.length}/${all.length}）</div><div class="badge-grid">${rows}</div>`;
  } else {
    const cards = S.progress.cards;
    const order = { SSR: 0, SR: 1, R: 2, N: 3 };
    const sorted = [...cards].sort((a, b) => order[a.rarity] - order[b.rarity] || b.at - a.at);
    const counts = ["SSR", "SR", "R", "N"].map(r => `${r} ${cards.filter(c => c.rarity === r).length}`).join(" / ");
    body.innerHTML = `<div class="section-title">奇遇卡牌（${cards.length}）</div>
      <div class="rarity-count">${counts}</div>
      <div class="badge-grid">${sorted.map(c => `
        <div class="badge-card owned">
          <div class="b-icon">${typeEmoji(c.type)}</div>
          <div class="b-name">${esc(c.title)}</div>
          <div class="b-sub">${esc(c.rarity)} · ${esc(c.region)}</div></div>`).join("") ||
      `<p style="color:var(--ink-faint)">去画卷里点亮第一个奇遇吧</p>`}</div>`;
  }
}

/* ───────── 问遍山河（元宝 API 预留位） ───────── */
async function askYuanbao(question, regionName) {
  // 产品化时：请求后端代理 /api/ask → 腾讯云联网搜索 API（SearchPro）
  // 密钥存于服务端环境变量，绝不下发前端（见 PRD US-08 与 CONTENT-SPEC §7）
  const box = $("ask-answer");
  box.classList.remove("hidden");
  box.innerHTML = `<span class="ink-loading">墨迹晕开中……</span>`;
  await new Promise(r => setTimeout(r, 700));
  box.innerHTML = `🌫 <b>问遍山河</b>将在联网后接入元宝搜索（腾讯云联网搜索 API）。<br>
    届时这里会返回带来源的实时回答。原型期可先探索「${esc(regionName)}」的 ${encountersOf(S.currentRegion).length} 个奇遇与闯关牌坊。`;
}

/* ───────── 事件绑定 & 启动 ───────── */
function bind() {
  $("intro-skip").addEventListener("click", () => {
    $("intro").classList.add("leaving");
    setTimeout(() => { show("map"); if (S.progress.firstRun) $("home-hint").classList.remove("hidden"); }, 850);
  });
  $("btn-back").addEventListener("click", () => { show("map"); });
  $("card-close").addEventListener("click", () => $("encounter-card").classList.add("hidden"));
  $("card-expand").addEventListener("click", () => {
    const c = $("card-content");
    const willShow = c.classList.contains("hidden");
    c.classList.toggle("hidden");
    if (willShow) c.classList.add("shown"); else c.classList.remove("shown");
    $("card-expand").textContent = willShow ? "收起全文" : "展开细读全文";
  });
  $("btn-hall").addEventListener("click", () => { renderHall(); show("hall"); });
  $("hall-close").addEventListener("click", () => show(S.currentRegion ? "scroll" : "map"));
  document.querySelectorAll(".hall-tab").forEach(t => t.addEventListener("click", () => {
    document.querySelectorAll(".hall-tab").forEach(x => x.classList.remove("active"));
    t.classList.add("active"); renderHall();
  }));
  $("exam-mode").addEventListener("change", (e) => {
    S.progress.settings.exam = e.target.checked; saveProgress();
    toast(e.target.checked ? "📖 考点模式已开启：奇遇带考点角标，题目标注考点" : "考点模式已关闭");
  });
  document.querySelectorAll(".swatch").forEach(s =>
    s.addEventListener("click", () => { applyTheme(s.dataset.theme); toast("皮肤已切换：" + THEMES.find(t => t.id === s.dataset.theme).name); }));
  $("tutorial-close").addEventListener("click", () => {
    $("tutorial-tip").classList.add("hidden");
    S.progress.tutorialSeen = true; saveProgress();
  });
  $("lightup-ok").addEventListener("click", () => $("lightup-overlay").classList.add("hidden"));
  $("ask-btn").addEventListener("click", () => {
    const v = $("ask-input").value.trim();
    if (v) askYuanbao(v, S.index[normCode(S.currentRegion)]?.data.region.name || "");
  });
  $("ask-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("ask-btn").click(); });
  $("btn-reset").addEventListener("click", () => {
    if (confirm("清除全部本地进度？（重置后不可恢复）")) {
      localStorage.removeItem(STORE_KEY); S.progress = loadProgress(); renderMap(); show("map"); toast("已重置");
    }
  });
}

async function main() {
  S.progress = loadProgress();
  applyTheme(S.progress.settings.theme || "mo");
  bind();
  // 载入地图与内容
  const [geo] = await Promise.all([
    fetchJSON("data/geo/china.json"),
    loadContent(),
  ]);
  S.geoFeatures = geo.features;
  for (const f of geo.features) {
    const name = f.properties.name; S.geoByName[name] = f;
    const short = shortName(name);
    const code = Object.entries(GEO_MAP).find(([, v]) => v === name)?.[0] ||
      Object.entries(GEO_MAP).find(([, v]) => shortName(v) === short)?.[0];
    if (code) S.codeByGeo[name] = code;
  }
  $("exam-mode").checked = !!S.progress.settings.exam;
  renderMap();
  // 非首访直接进地图
  if (!S.progress.firstRun) {
    $("intro").classList.add("leaving");
    setTimeout(() => { $("intro").style.display = "none"; show("map"); }, 300);
  }
}
main().catch(err => {
  console.error(err);
  document.body.insertAdjacentHTML("beforeend",
    `<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;z-index:999;background:#f5f0e4">
     <div style="font-size:22px">山高路远，稍后再试</div>
     <div style="color:#8a7f70;font-size:14px">请通过本地服务器访问（如 python3 -m http.server）</div></div>`);
});
