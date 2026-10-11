/* 台股 大盤 K 線 + 籌碼資料表 */
(() => {
  'use strict';
  const LWC = window.LightweightCharts;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  // rows: [d, o, h, l, c, amt(百萬), vol(張), trades, fi, it, dl, mb(百萬), ss(張)]
  const I = { d: 0, o: 1, h: 2, l: 3, c: 4, amt: 5, vol: 6, tr: 7, fi: 8, it: 9, dl: 10, mb: 11, ss: 12 };
  const PERIOD_NAME = { D: '日', W: '週', M: '月', H: '半年', Y: '年' };
  const MA = [{ n: 5, c: '#f59e0b' }, { n: 20, c: '#a855f7' }, { n: 60, c: '#3b82f6' }];
  const PAGE = 250;

  const state = {
    market: 'twse', period: 'D', sub: 'amt', group: 'px',
    from: null, to: null, quick: '1y', shown: PAGE,
    cache: {}, bars: [], tableRows: [],
  };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };

  // ------------------------------------------------------------ utils
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const pad = (n) => String(n).padStart(2, '0');
  const ymdToISO = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  const isoToYmd = (s) => s.replace(/-/g, '');
  const toTime = (d) => ({ year: +d.slice(0, 4), month: +d.slice(4, 6), day: +d.slice(6, 8) });
  const timeKey = (t) => (typeof t === 'object' ? `${t.year}${pad(t.month)}${pad(t.day)}` : String(t));
  const nz = (v) => v !== null && v !== undefined && !Number.isNaN(v);
  const fmt = (v, dp = 2, sign = false) => {
    if (!nz(v)) return '—';
    const s = Number(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    return sign && v > 0 ? '+' + s : s;
  };
  // Goodinfo 風格：大數少位數，小數多位數（3 位有效）
  const fmtAuto = (v, sign = true) => {
    if (!nz(v)) return '—';
    const a = Math.abs(v);
    const dp = a >= 100 ? 0 : a >= 10 ? 1 : 2;
    return fmt(v, dp, sign);
  };
  const cls = (v) => (!nz(v) || v === 0 ? 'flat' : v > 0 ? 'up' : 'down');

  // ------------------------------------------------------------ data
  async function loadMarket(mk) {
    if (state.cache[mk]) return state.cache[mk];
    const res = await fetch(`data/${mk}.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`data/${mk}.json ${res.status}`);
    const j = await res.json();
    state.cache[mk] = j;
    return j;
  }

  function periodKey(d, p) {
    const y = +d.slice(0, 4), m = +d.slice(4, 6), day = +d.slice(6, 8);
    if (p === 'D') return d;
    if (p === 'M') return d.slice(0, 6);
    if (p === 'H') return `${y}H${m <= 6 ? 1 : 2}`;
    if (p === 'Y') return String(y);
    // W：ISO 週（以週一為鍵）
    const dt = new Date(Date.UTC(y, m - 1, day));
    const wd = (dt.getUTCDay() + 6) % 7;
    dt.setUTCDate(dt.getUTCDate() - wd);
    return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}`;
  }

  const sumN = (a, b) => (nz(b) ? (nz(a) ? a : 0) + b : a);

  /** 依週期聚合日資料 → bars（含衍生欄位） */
  function aggregate(rows, p) {
    const out = [];
    let cur = null, curKey = null;
    for (const r of rows) {
      if (!nz(r[I.c])) continue;
      const k = periodKey(r[I.d], p);
      if (k !== curKey) {
        if (cur) out.push(cur);
        curKey = k;
        cur = {
          key: k, d: r[I.d], dLast: r[I.d], days: 0,
          o: r[I.o] ?? r[I.c], h: r[I.h] ?? r[I.c], l: r[I.l] ?? r[I.c], c: r[I.c],
          amt: null, vol: null, tr: null, fi: null, it: null, dl: null, mb: null, ss: null,
        };
      }
      cur.days++;
      cur.dLast = r[I.d];
      cur.h = Math.max(cur.h, r[I.h] ?? r[I.c]);
      cur.l = Math.min(cur.l, r[I.l] ?? r[I.c]);
      cur.c = r[I.c];
      cur.amt = sumN(cur.amt, r[I.amt]);
      cur.vol = sumN(cur.vol, r[I.vol]);
      cur.tr = sumN(cur.tr, r[I.tr]);
      cur.fi = sumN(cur.fi, r[I.fi]);
      cur.it = sumN(cur.it, r[I.it]);
      cur.dl = sumN(cur.dl, r[I.dl]);
      if (nz(r[I.mb])) cur.mb = r[I.mb];
      if (nz(r[I.ss])) cur.ss = r[I.ss];
    }
    if (cur) out.push(cur);

    // 衍生欄位
    let prev = null;
    for (const b of out) {
      b.pc = prev ? prev.c : null;
      b.chg = prev ? b.c - prev.c : null;
      b.pct = prev ? (b.chg / prev.c) * 100 : null;
      b.amp = prev ? ((b.h - b.l) / prev.c) * 100 : null;
      b.avgLot = nz(b.vol) && b.tr ? b.vol / b.tr : null;
      b.inst = nz(b.fi) || nz(b.it) || nz(b.dl) ? (b.fi || 0) + (b.it || 0) + (b.dl || 0) : null;
      b.mbChg = prev && nz(b.mb) && nz(prev.mb) ? b.mb - prev.mb : null;
      b.ssChg = prev && nz(b.ss) && nz(prev.ss) ? b.ss - prev.ss : null;
      prev = b;
    }
    return out;
  }

  function dateLabel(b, p) {
    const y2 = b.d.slice(2, 4);
    if (p === 'D') return `'${y2}/${b.d.slice(4, 6)}/${b.d.slice(6, 8)}`;
    if (p === 'W') {
      // ISO 週次
      const t = new Date(Date.UTC(+b.key.slice(0, 4), +b.key.slice(4, 6) - 1, +b.key.slice(6, 8) + 3)); // 該週週四
      const y = t.getUTCFullYear();
      const wk = 1 + Math.floor((t - Date.UTC(y, 0, 1)) / 864e5 / 7);
      return `'${String(y).slice(2)}W${pad(wk)}`;
    }
    if (p === 'M') return `'${y2}/${b.d.slice(4, 6)}M`;
    if (p === 'H') return `'${y2}H${b.key.slice(-1)}`;
    return b.d.slice(0, 4);
  }

  // ------------------------------------------------------------ charts
  let main, sub, candle, volS, maS = [], subS = [];

  function chartTheme() {
    return {
      layout: { background: { type: 'solid', color: css('--panel') }, textColor: css('--muted'), fontSize: 12,
        fontFamily: css('--font') || 'sans-serif' },
      grid: { vertLines: { color: css('--line-soft') }, horzLines: { color: css('--line-soft') } },
      rightPriceScale: { borderColor: css('--line') },
      timeScale: { borderColor: css('--line') },
      crosshair: { mode: 0 },
    };
  }

  function initCharts() {
    const base = {
      autoSize: true,
      localization: { locale: 'zh-TW', dateFormat: 'yyyy/MM/dd' },
      handleScale: { axisPressedMouseMove: true },
    };
    main = LWC.createChart($('#chartMain'), { ...base, ...chartTheme(),
      timeScale: { borderColor: css('--line'), rightOffset: 4, minBarSpacing: 0.5 } });
    sub = LWC.createChart($('#chartSub'), { ...base, ...chartTheme(),
      timeScale: { visible: true, borderColor: css('--line'), rightOffset: 4, minBarSpacing: 0.5 },
      rightPriceScale: { borderColor: css('--line'), scaleMargins: { top: 0.12, bottom: 0.04 } } });

    candle = main.addCandlestickSeries({
      upColor: css('--up'), downColor: css('--down'), borderUpColor: css('--up'), borderDownColor: css('--down'),
      wickUpColor: css('--up'), wickDownColor: css('--down'), priceLineVisible: true,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });
    candle.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.08 } });
    maS = MA.map((m) => main.addLineSeries({ color: m.c, lineWidth: 1.4, priceLineVisible: false,
      lastValueVisible: false, crosshairMarkerVisible: false }));

    // 時間軸同步
    let syncing = false;
    const link = (a, b) => a.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (syncing || !r) return;
      syncing = true; b.timeScale().setVisibleLogicalRange(r); syncing = false;
    });
    link(main, sub); link(sub, main);

    let xh = false; // 防止兩圖十字線互相觸發
    main.subscribeCrosshairMove((p) => {
      if (xh) return;
      updateLegend(p && p.time ? timeKey(p.time) : null);
      xh = true;
      if (p && p.time && subS[0]) sub.setCrosshairPosition(0, p.time, subS[0]); else sub.clearCrosshairPosition();
      xh = false;
    });
    sub.subscribeCrosshairMove((p) => {
      if (xh) return;
      updateLegend(p && p.time ? timeKey(p.time) : null);
      xh = true;
      if (p && p.time) main.setCrosshairPosition(candleValAt(p.time), p.time, candle);
      else main.clearCrosshairPosition();
      xh = false;
    });
    main.subscribeClick((p) => { if (p && p.time) focusRow(timeKey(p.time)); });
  }

  const barByKey = new Map();
  function candleValAt(t) { const b = barByKey.get(timeKey(t)); return b ? b.c : 0; }

  function maCalc(bars, n) {
    const out = []; let s = 0;
    for (let i = 0; i < bars.length; i++) {
      s += bars[i].c; if (i >= n) s -= bars[i - n].c;
      if (i >= n - 1) out.push({ time: toTime(bars[i].d), value: +(s / n).toFixed(2) });
    }
    return out;
  }

  function drawMain() {
    const bars = state.bars;
    barByKey.clear();
    bars.forEach((b) => barByKey.set(b.d, b));
    candle.setData(bars.map((b) => ({ time: toTime(b.d), open: b.o, high: b.h, low: b.l, close: b.c })));
    MA.forEach((m, i) => maS[i].setData(maCalc(bars, m.n)));
    drawSub();
    const n = bars.length;
    const show = { D: 160, W: 130, M: 120, H: 60, Y: 40 }[state.period];
    const w = $('#chartMain').clientWidth;
    const fit = Math.min(n, w < 640 ? Math.round(show * 0.5) : show);
    main.timeScale().setVisibleLogicalRange({ from: n - fit, to: n + 3 });
    updateLegend(null);
  }

  function drawSub() {
    subS.forEach((s) => sub.removeSeries(s));
    subS = [];
    const bars = state.bars;
    const up = css('--up'), dn = css('--down');
    const T = (b) => toTime(b.d);
    if (state.sub === 'amt') {
      const s = sub.addHistogramSeries({ priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false });
      s.setData(bars.filter((b) => nz(b.amt)).map((b) => ({ time: T(b), value: b.amt / 100,
        color: (b.c >= b.o ? up : dn) + 'cc' })));
      s.applyOptions({ priceFormat: { type: 'custom', formatter: (v) => fmtAuto(v, false) + '億' } });
      subS.push(s);
    } else if (state.sub === 'inst') {
      const s = sub.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false,
        priceFormat: { type: 'custom', formatter: (v) => fmtAuto(v) + '億' } });
      s.setData(bars.map((b) => nz(b.inst) ? { time: T(b), value: b.inst / 100, color: (b.inst >= 0 ? up : dn) + 'cc' }
        : { time: T(b) }));
      subS.push(s);
    } else {
      const s = sub.addAreaSeries({ lineColor: '#f59e0b', topColor: '#f59e0b55', bottomColor: '#f59e0b05', lineWidth: 1.6,
        priceLineVisible: false, priceFormat: { type: 'custom', formatter: (v) => fmt(v, 0) + '億' } });
      s.setData(bars.map((b) => nz(b.mb) ? { time: T(b), value: b.mb / 100 } : { time: T(b) }));
      subS.push(s);
    }
  }

  function updateLegend(key) {
    const bars = state.bars;
    if (!bars.length) return;
    const b = (key && barByKey.get(key)) || bars[bars.length - 1];
    const idx = bars.indexOf(b);
    const c = cls(b.chg);
    const maVals = MA.map((m) => {
      if (idx < m.n - 1) return `<span class="ma" style="color:${m.c}">MA${m.n} —</span>`;
      let s = 0; for (let i = idx - m.n + 1; i <= idx; i++) s += bars[i].c;
      return `<span class="ma" style="color:${m.c}">MA${m.n} ${fmt(s / m.n)}</span>`;
    }).join('');
    $('#legend').innerHTML =
      `<b>${dateLabel(b, state.period)}</b>` +
      `<span>開 <b class="${cls(b.o - b.pc)}">${fmt(b.o)}</b></span>` +
      `<span>高 <b class="${cls(b.h - b.pc)}">${fmt(b.h)}</b></span>` +
      `<span>低 <b class="${cls(b.l - b.pc)}">${fmt(b.l)}</b></span>` +
      `<span>收 <b class="${c}">${fmt(b.c)}</b></span>` +
      `<span class="${c}">${fmt(b.chg, 2, true)} (${fmt(b.pct, 2, true)}%)</span>` + maVals;
    let subTxt = '';
    if (state.sub === 'amt') subTxt = `成交金額 <b>${fmtAuto(b.amt / 100, false)} 億</b>`;
    else if (state.sub === 'inst') subTxt = `外資 <b class="${cls(b.fi)}">${fmtAuto(b.fi / 100)}</b>　投信 <b class="${cls(b.it)}">${fmtAuto(b.it / 100)}</b>　自營 <b class="${cls(b.dl)}">${fmtAuto(b.dl / 100)}</b>　合計 <b class="${cls(b.inst)}">${fmtAuto(b.inst / 100)}</b> 億`;
    else subTxt = `融資餘額 <b>${fmt(nz(b.mb) ? b.mb / 100 : null, 0)} 億</b>　增減 <b class="${cls(b.mbChg)}">${fmtAuto(nz(b.mbChg) ? b.mbChg / 100 : null)}</b>`;
    $('#legendSub').innerHTML = `<span>${subTxt}</span>`;
  }

  function applyChartTheme() {
    if (!main) return;
    const t = chartTheme();
    main.applyOptions(t); sub.applyOptions(t);
    candle.applyOptions({ upColor: css('--up'), downColor: css('--down'), borderUpColor: css('--up'),
      borderDownColor: css('--down'), wickUpColor: css('--up'), wickDownColor: css('--down') });
    if (state.bars.length) drawSub();
  }

  // ------------------------------------------------------------ table
  function td(v, c = '', klass = '') { return `<td class="${klass} ${c}">${v}</td>`; }

  function rowHTML(b) {
    const p = state.period;
    const e = (v) => (nz(v) ? v / 100 : null); // 百萬 → 億
    const pc = b.pc;
    const k = (v) => (pc ? cls(v - pc) : 'flat');
    const na = (v) => (nz(v) ? '' : 'na');
    return `<tr data-d="${b.d}">` +
      td(dateLabel(b, p), '', 'c-date') +
      td(fmt(b.o), k(b.o), 'px') + td(fmt(b.h), k(b.h), 'px') + td(fmt(b.l), k(b.l), 'px') + td(fmt(b.c), k(b.c), 'px') +
      td(fmt(b.chg, 2, true), cls(b.chg), 'px') + td(fmt(b.pct, 2, true), cls(b.pct), 'px') +
      td(fmt(b.amp, 2), '', 'px') +
      td(fmt(e(b.amt), 2), na(b.amt), 'px') +
      td(fmt(b.avgLot, 2), na(b.avgLot), 'px') +
      td(fmtAuto(e(b.fi)), cls(b.fi) + ' ' + na(b.fi), 'inst c-fi') +
      td(fmtAuto(e(b.it)), cls(b.it) + ' ' + na(b.it), 'inst') +
      td(fmtAuto(e(b.dl)), cls(b.dl) + ' ' + na(b.dl), 'inst') +
      td(fmtAuto(e(b.inst)), cls(b.inst) + ' ' + na(b.inst), 'inst') +
      td(fmt(e(b.mb), 0), na(b.mb), 'mg c-mb') +
      td(fmtAuto(e(b.mbChg)), cls(b.mbChg) + ' ' + na(b.mbChg), 'mg') +
      td(nz(b.ss) ? fmt(b.ss / 1e4, b.ss >= 1e6 ? 0 : 1) : '—', na(b.ss), 'mg c-ss') +
      td(nz(b.ssChg) ? fmt(b.ssChg / 1e4, 2, true) : '—', cls(b.ssChg) + ' ' + na(b.ssChg), 'mg') +
      `</tr>`;
  }

  function filteredRows() {
    const f = state.from ? isoToYmd(state.from) : '0';
    const t = state.to ? isoToYmd(state.to) : '99999999';
    return state.bars.filter((b) => b.dLast >= f && b.d <= t).reverse();
  }

  function renderTable() {
    const rows = filteredRows();
    state.tableRows = rows;
    const shown = rows.slice(0, state.shown);
    $('#tbody').innerHTML = shown.map(rowHTML).join('') ||
      `<tr><td class="c-date na" colspan="18">此期間無資料</td></tr>`;
    $('#rowInfo').textContent = `${PERIOD_NAME[state.period]}資料 ${rows.length.toLocaleString()} 筆` +
      (rows.length > shown.length ? `，已顯示 ${shown.length}` : '');
    $('#moreBtn').hidden = rows.length <= shown.length;
    syncHeaderOffset();
  }

  function syncHeaderOffset() {
    // 第二列表頭貼齊在群組標題（第一列）下方
    const g = $('#tbl thead th.grp');
    const gh = g ? g.getBoundingClientRect().height : 0;
    if (gh) $$('#tbl thead tr:nth-child(2) th').forEach((th) => (th.style.top = `${Math.round(gh)}px`));
  }

  function focusRow(d) {
    const tr = $(`#tbody tr[data-d="${d}"]`);
    $$('#tbody tr.sel').forEach((x) => x.classList.remove('sel'));
    if (tr) {
      tr.classList.add('sel');
      const wrap = $('#tblWrap');
      wrap.scrollTo({ top: tr.offsetTop - wrap.clientHeight / 2, behavior: 'smooth' });
    }
  }

  function exportCSV() {
    const head = ['交易日期', '開盤', '最高', '最低', '收盤', '漲跌', '漲跌(%)', '振幅(%)', '成交(億元)', '成交均張',
      '外資(億)', '投信(億)', '自營(億)', '法人合計(億)', '融資餘額(億)', '融資增減(億)', '融券餘額(萬張)', '融券增減(萬張)'];
    const r2 = (v, dp = 2) => (nz(v) ? (+v).toFixed(dp) : '');
    const lines = state.tableRows.map((b) => [
      dateLabel(b, state.period).replace("'", '20'), r2(b.o), r2(b.h), r2(b.l), r2(b.c), r2(b.chg), r2(b.pct), r2(b.amp),
      r2(nz(b.amt) ? b.amt / 100 : null), r2(b.avgLot), r2(nz(b.fi) ? b.fi / 100 : null), r2(nz(b.it) ? b.it / 100 : null),
      r2(nz(b.dl) ? b.dl / 100 : null), r2(nz(b.inst) ? b.inst / 100 : null), r2(nz(b.mb) ? b.mb / 100 : null),
      r2(nz(b.mbChg) ? b.mbChg / 100 : null), r2(nz(b.ss) ? b.ss / 1e4 : null, 3), r2(nz(b.ssChg) ? b.ssChg / 1e4 : null, 3),
    ].join(','));
    const blob = new Blob(['﻿' + [head.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.market}_${state.period}_${isoToYmd(state.from || '')}-${isoToYmd(state.to || '')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ------------------------------------------------------------ quote
  function renderQuote(j) {
    const daily = aggregate(j.rows, 'D');
    const b = daily[daily.length - 1];
    if (!b) return;
    $('#qName').textContent = `${j.label}・${j.name}`;
    $('#qDate').textContent = `${b.d.slice(0, 4)}/${b.d.slice(4, 6)}/${b.d.slice(6)}`;
    $('#qClose').textContent = fmt(b.c);
    $('#qClose').className = cls(b.chg);
    $('#qChg').innerHTML = `${b.chg > 0 ? '▲' : b.chg < 0 ? '▼' : ''} ${fmt(Math.abs(b.chg ?? 0))}　${fmt(b.pct, 2, true)}%`;
    $('#qChg').className = 'q-chg ' + cls(b.chg);
    $('#qO').textContent = fmt(b.o); $('#qO').className = cls(b.o - b.pc);
    $('#qH').textContent = fmt(b.h); $('#qH').className = cls(b.h - b.pc);
    $('#qL').textContent = fmt(b.l); $('#qL').className = cls(b.l - b.pc);
    $('#qAmt').textContent = fmt(nz(b.amt) ? b.amt / 100 : null, 0);
    $('#qInst').textContent = fmtAuto(nz(b.inst) ? b.inst / 100 : null); $('#qInst').className = cls(b.inst);
    $('#qMg').textContent = fmtAuto(nz(b.mbChg) ? b.mbChg / 100 : null); $('#qMg').className = cls(b.mbChg);
    $('#updInfo').textContent = j.updated ? `最後更新：${j.updated}（台北時間）` : '';
    document.title = `${j.name} ${fmt(b.c)}｜台股`;
  }

  // ------------------------------------------------------------ flow
  function setQuickRange(q) {
    state.quick = q;
    const j = state.cache[state.market];
    const last = j && j.rows.length ? j.rows[j.rows.length - 1][0] : null;
    if (!last) return;
    const end = new Date(Date.UTC(+last.slice(0, 4), +last.slice(4, 6) - 1, +last.slice(6, 8)));
    const st = new Date(end);
    if (q === '3m') st.setUTCMonth(st.getUTCMonth() - 3);
    else if (q === '1y') st.setUTCFullYear(st.getUTCFullYear() - 1);
    else if (q === '3y') st.setUTCFullYear(st.getUTCFullYear() - 3);
    const iso = (d) => d.toISOString().slice(0, 10);
    state.from = q === 'all' ? ymdToISO(j.rows[0][0]) : iso(st);
    state.to = iso(end);
    $('#dFrom').value = state.from; $('#dTo').value = state.to;
    $$('#quick button').forEach((b) => b.classList.toggle('on', b.dataset.q === q));
  }

  const DEFAULT_QUICK = { D: '1y', W: '3y', M: 'all', H: 'all', Y: 'all' };

  async function refresh({ resetRange = false } = {}) {
    $('#chartMain').classList.add('loading');
    let j;
    try { j = await loadMarket(state.market); }
    catch (e) {
      $('#chartMain').classList.remove('loading');
      $('#tbody').innerHTML = `<tr><td colspan="18" class="na" style="text-align:center;padding:30px">資料載入失敗：${e.message}</td></tr>`;
      return;
    }
    $('#chartMain').classList.remove('loading');
    renderQuote(j);
    state.bars = aggregate(j.rows, state.period);
    if (resetRange || !state.from) setQuickRange(DEFAULT_QUICK[state.period]);
    state.shown = PAGE;
    drawMain();
    renderTable();
  }

  function setGroup(g) {
    state.group = g;
    const t = $('#tbl');
    t.classList.remove('g-px', 'g-inst', 'g-mg', 'g-all');
    t.classList.add('g-' + g);
    $$('#colSeg button').forEach((b) => b.classList.toggle('on', b.dataset.g === g));
    store.set('ql-group', g);
    requestAnimationFrame(syncHeaderOffset);
  }

  function bind() {
    $$('.mkt-tabs button').forEach((b) => b.addEventListener('click', () => {
      if (state.market === b.dataset.market) return;
      state.market = b.dataset.market;
      $$('.mkt-tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      store.set('ql-market', state.market);
      history.replaceState(null, '', `#${state.market}-${state.period}`);
      refresh({ resetRange: true });
    }));
    $$('#periodSeg button').forEach((b) => b.addEventListener('click', () => {
      state.period = b.dataset.p;
      $$('#periodSeg button').forEach((x) => x.classList.toggle('on', x === b));
      history.replaceState(null, '', `#${state.market}-${state.period}`);
      refresh({ resetRange: true });
    }));
    $$('#subSeg button').forEach((b) => b.addEventListener('click', () => {
      state.sub = b.dataset.s;
      $$('#subSeg button').forEach((x) => x.classList.toggle('on', x === b));
      store.set('ql-sub', state.sub);
      drawSub(); updateLegend(null);
    }));
    $$('#quick button').forEach((b) => b.addEventListener('click', () => {
      setQuickRange(b.dataset.q); state.shown = PAGE; renderTable();
    }));
    $('#filters').addEventListener('submit', (e) => {
      e.preventDefault();
      state.from = $('#dFrom').value || null; state.to = $('#dTo').value || null;
      $$('#quick button').forEach((x) => x.classList.remove('on'));
      state.shown = PAGE; renderTable();
    });
    $('#moreBtn').addEventListener('click', () => { state.shown += PAGE; renderTable(); });
    $('#csvBtn').addEventListener('click', exportCSV);
    $$('#colSeg button').forEach((b) => b.addEventListener('click', () => setGroup(b.dataset.g)));
    $('#tbody').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-d]'); if (!tr) return;
      $$('#tbody tr.sel').forEach((x) => x.classList.remove('sel'));
      tr.classList.add('sel');
      const i = state.bars.findIndex((b) => b.d === tr.dataset.d);
      if (i >= 0) {
        const r = main.timeScale().getVisibleLogicalRange();
        const half = r ? (r.to - r.from) / 2 : 60;
        main.timeScale().setVisibleLogicalRange({ from: i - half, to: i + half });
        updateLegend(tr.dataset.d);
      }
    });
    $('#themeBtn').addEventListener('click', () => {
      const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', t);
      store.set('ql-theme', t);
      applyChartTheme();
      updateLegend(null);
    });
    window.addEventListener('resize', () => requestAnimationFrame(syncHeaderOffset));
  }

  function restore() {
    const h = location.hash.replace('#', '').split('-');
    const mk = ['twse', 'tpex'].includes(h[0]) ? h[0] : store.get('ql-market');
    if (mk === 'twse' || mk === 'tpex') state.market = mk;
    if (PERIOD_NAME[h[1]]) state.period = h[1];
    const s = store.get('ql-sub'); if (['amt', 'inst', 'margin'].includes(s)) state.sub = s;
    $$('.mkt-tabs button').forEach((x) => x.setAttribute('aria-selected', String(x.dataset.market === state.market)));
    $$('#periodSeg button').forEach((x) => x.classList.toggle('on', x.dataset.p === state.period));
    $$('#subSeg button').forEach((x) => x.classList.toggle('on', x.dataset.s === state.sub));
    const g = store.get('ql-group');
    setGroup(['px', 'inst', 'mg', 'all'].includes(g) ? g : (innerWidth > 1100 ? 'all' : 'px'));
  }

  restore();
  initCharts();
  bind();
  refresh({ resetRange: true });
})();
