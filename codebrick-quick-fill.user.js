// ==UserScript==
// @name         码砖速填
// @namespace    https://github.com/Neptune153/codebrick-quick-fill
// @version      2.0.2
// @description  在 CodeBrick 答题页批量填答：按已有答案回放 A/B/C/D，可只发指定题号范围，提交仍手动。
// @author       Neptune153
// @updateURL    https://raw.githubusercontent.com/Neptune153/codebrick-quick-fill/main/codebrick-quick-fill.user.js
// @downloadURL  https://raw.githubusercontent.com/Neptune153/codebrick-quick-fill/main/codebrick-quick-fill.user.js
// @match        https://codebrick.tech/*
// @match        https://*.codebrick.tech/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* ------------------------------------------------------------------
 * 用法
 *   1. 打开 codebrick.tech 的答题页，不用先点题目区域
 *   2. 点左边浮动的「答」圆块，或按 Alt + Shift + A
 *   3. 把答案粘进输入框，只认 A/B/C/D，- 表示跳过这题
 *   4. 只答一段题：把「只发」改成 第 X 到 Y 题
 *   5. 点「单步」试一题，确认有反应再点「开始」
 *   6. 停下：点「停止」或按 Esc
 *
 * 对位
 *   「只发」右边的「现在 第 N 题」从页面角标读出。
 *   没到起点按 → 往前翻，越过起点按 ← 退回来，都按「翻页」间隔一下一下走。
 *   读不到题号就退回手动：你自己翻好，脚本把当前这题当成范围第一题。
 *
 * 限流
 *   CodeBrick 限每分钟 30 次答题。默认 2050ms 一题约 29 题/分，40 题约 82 秒。
 *   这个间隔从这一题开始按键算起，不够自动补足，所以三个等待时间只会拖慢单题。
 *
 * 说明
 *   按键是网页内部派发的合成事件，isTrusted 为 false。
 *   站点校验真人按键时这个方案会被拦，得改用 AutoHotkey 一类的系统级模拟。
 *   @match 限定 codebrick.tech，换站点改这两行。
 * ------------------------------------------------------------------ */

(function () {
  'use strict';

  if (window.__cqfLoaded) return;
  window.__cqfLoaded = true;

  const STORE = 'cqf-v1';                 // 配置存在这里
  const STORE_OLD = 'dsh-auto-answer-v1'; // 1.8.0 之前的旧键，读一次搬过来
  const LETTER_VK = { A: 65, B: 66, C: 67, D: 68 };
  const SKIP = '-';
  const FONT = '-apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif';

  const state = { running: false, stop: false, current: 0, stepIndex: 0 };
  let answers = [];

  /* ============ 快捷键（可改，存在本地） ============ */

  const DEFAULT_HOT = { code: 'KeyA', alt: true, shift: true, ctrl: false, meta: false };
  let hot = Object.assign({}, DEFAULT_HOT);

  function hotLabel() {
    const p = [];
    if (hot.ctrl) p.push('Ctrl');
    if (hot.alt) p.push('Alt');
    if (hot.shift) p.push('Shift');
    if (hot.meta) p.push('Win');
    const k = String(hot.code || '')
      .replace(/^Key/, '')
      .replace(/^Digit/, '')
      .replace(/^Numpad/, 'Num');
    p.push(k);
    return p.join(' + ');
  }

  function hotMatches(e) {
    return e.code === hot.code &&
      e.ctrlKey === !!hot.ctrl &&
      e.altKey === !!hot.alt &&
      e.shiftKey === !!hot.shift &&
      e.metaKey === !!hot.meta;
  }

  /* ============ 按键派发 ============ */

  // 统一发到 body：事件顺着 DOM 往上冒泡，document 和 window 上的监听都能收到。
  // 同一个事件只发一次。若在 body、document、window 上各发一遍，document 上的监听会触发两次，一次跳两题。
  function fire(key, code, keyCode, shiftKey) {
    const t = document.body || document.documentElement || document;
    const types = key.length === 1 ? ['keydown', 'keypress', 'keyup'] : ['keydown', 'keyup'];
    let handled = false;
    for (const type of types) {
      const ev = new KeyboardEvent(type, {
        key: key,
        code: code,
        keyCode: keyCode,
        which: keyCode,
        shiftKey: !!shiftKey,
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
      });
      try {
        // dispatchEvent 返回 false，说明页面处理了这次按键并 preventDefault
        if (!t.dispatchEvent(ev)) handled = true;
      } catch (e) { /* 站点可能拦截，忽略 */ }
    }
    return handled;
  }

  function pressLetter(ch, upper) {
    const up = String(ch).toUpperCase();
    return fire(upper ? up : up.toLowerCase(), 'Key' + up, LETTER_VK[up], upper);
  }
  const pressEnter = () => fire('Enter', 'Enter', 13, false);
  const pressRight = () => fire('ArrowRight', 'ArrowRight', 39, false);
  const pressLeft = () => fire('ArrowLeft', 'ArrowLeft', 37, false);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 可中断的等待：返回 false 表示被停止了
  async function wait(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (state.stop) return false;
      await sleep(Math.min(40, end - Date.now()));
    }
    return !state.stop;
  }

  /* ============ 答案解析 ============ */

  // 只认 A~D。- _ ? 算跳过这题：照常按 →，但不发字母
  function parseAnswers(text) {
    let raw = '';
    for (const line of String(text || '').split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;   // # 开头是注释行
      raw += line;
    }
    const out = [];
    for (const ch of raw.toUpperCase()) {
      if (ch >= 'A' && ch <= 'D') out.push(ch);
      else if (ch === '-' || ch === '_' || ch === '?') out.push(SKIP);
    }
    return out;
  }

  // 每 5 个一组，中间空格——粘一长串也看得出第几题
  function fmt(list) {
    const out = [];
    for (let i = 0; i < list.length; i += 5) out.push(list.slice(i, i + 5).join(''));
    return out.join(' ');
  }

  /* ============ 页面题号（对位用） ============ */

  // CodeBrick 把题号写在 article > header 的角标上：
  //   <span class="source-badge sb-real" title="2015 年统考真题 · 第 5 题">真题 2015 · 第 5 题</span>
  // 模拟卷 / 整卷模式没有真题角标，题干顶上写的是纯文本：
  //   <div class="q-meta">第 5 题 · 数据结构 · 三方题 …</div>
  // 这两种都是文字里的「第 N 题」；都没有时再退回读题号导航的当前项。
  // 从最贴近的写法开始试，命中一种就不再往下找，免得被别处的“第 N 题”干扰。
  const Q_RE = /第\s*(\d{1,3})\s*题/;
  const Q_SEL = [
    'article header .source-badge',
    'article header [class*="source-badge"]',
    '.source-badge',
    '[class*="source-badge"]',
    'article header',
    '.q-meta',
    '[class*="q-meta"]',
    '[class*="question-no"]',
    '[class*="qno"]',
  ];

  // 题号导航条（模拟卷 .num-strip / 练习页 .qnumber-rail）里标着当前题的那一格，
  // 文字就是题号本身。注意不能用 [class*="active"] 这种子串匹配，会命中 inactive。
  const Q_RAIL_SEL = ['.num-strip', '.qnumber-rail'];
  const Q_ACTIVE_RE = /(^|\s)(active|is-active|current|is-current|selected)(\s|$)/;

  function qnoFromText(el) {
    const m = Q_RE.exec((el.getAttribute('title') || '') + ' ' + (el.textContent || ''));
    return m ? Number(m[1]) : null;
  }

  function qnoFromCurrent() {
    for (const box of Q_RAIL_SEL) {
      const root = document.querySelector(box);
      if (!root) continue;
      for (const el of root.querySelectorAll('button, a, [role="button"], li, span')) {
        if (!Q_ACTIVE_RE.test(String(el.className || ''))) continue;
        const t = (el.textContent || '').trim();
        if (/^\d{1,3}$/.test(t)) return Number(t);
        const byText = qnoFromText(el);
        if (byText) return byText;
      }
    }
    // 兜底：整页只剩一个「选中的数字按钮」
    for (const el of document.querySelectorAll('button, a')) {
      if (!Q_ACTIVE_RE.test(String(el.className || ''))) continue;
      const t = (el.textContent || '').trim();
      if (/^\d{1,3}$/.test(t)) return Number(t);
    }
    return null;
  }

  function qnoCandidates() {
    const out = [];
    const seen = new Set();
    for (const sel of Q_SEL) {
      let nodes = [];
      try { nodes = document.querySelectorAll(sel); } catch (e) { continue; }
      for (const n of nodes) {
        if (seen.has(n)) continue;
        seen.add(n);
        const num = qnoFromText(n);
        if (num) out.push({ n: num, el: n });
      }
      if (out.length) break;
    }
    return out;
  }

  // 好几道题的角标同时挂在 DOM 里时，取离视口中线最近、且真在屏幕上的那个
  function readQnoFromDom() {
    const list = qnoCandidates();
    if (!list.length) return qnoFromCurrent();
    if (list.length === 1) return list[0].n;
    const h = window.innerHeight || 800;
    const mid = h / 2;
    let best = null;
    for (const c of list) {
      let r;
      try { r = c.el.getBoundingClientRect(); } catch (e) { continue; }
      if (!r.width || !r.height) continue;
      const onScreen = r.bottom > 0 && r.top < h;
      const d = Math.abs((r.top + r.bottom) / 2 - mid) + (onScreen ? 0 : 1e6);
      if (!best || d < best.d) best = { d, n: c.n };
    }
    return (best || list[0]).n;
  }

  /* ============ 样式 ============ */

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .box { width: 320px; background: #fff; color: #17181C; border-radius: 4px;
           box-shadow: 0 14px 34px rgba(20,22,28,.16), 0 2px 6px rgba(20,22,28,.08); /* taste-skill-ignore 浮动面板 */
           font: 12px/1.5 ${FONT}; overflow: hidden; -webkit-font-smoothing: antialiased; }

    /* 标题条 */
    .hd { display: flex; align-items: center; gap: 8px; padding: 11px 14px 9px; cursor: move; user-select: none; }
    .ttl { font-size: 14px; font-weight: 600; letter-spacing: .01em; }
    .cnt { margin-left: auto; display: flex; align-items: baseline; gap: 3px; }
    .cnt b { font-size: 19px; font-weight: 600; letter-spacing: -.02em; font-variant-numeric: tabular-nums; line-height: 1; }
    .cnt i { font-style: normal; font-size: 11px; color: #6A6E78; }
    .x { width: 18px; height: 18px; margin-left: 5px; border-radius: 3px; display: flex; align-items: center;
         justify-content: center; color: #A6A9B0; cursor: pointer; font-size: 15px; line-height: 1; }
    .x:hover { background: #F1F1EE; color: #17181C; }

    /* 进度：只在跑的时候有底 */
    .prog { height: 2px; background: transparent; }
    .prog.run { background: #EDEDE9; }
    .prog i { display: block; height: 100%; width: 0; background: #C8402F; transition: width .2s ease; }

    .bd { padding: 8px 14px 13px; display: flex; flex-direction: column; gap: 10px;
          max-height: calc(100vh - 140px); overflow-y: auto; }
    .bd > * { flex-shrink: 0; }

    /* 粘贴框 */
    textarea.ans { width: 100%; height: 54px; min-height: 54px; resize: none; overflow-y: auto;
                   border: 0; border-radius: 4px; padding: 7px 9px;
                   background: #F1F1EE; color: #17181C; outline: none;
                   font: 500 12.5px/1.55 ${FONT}; letter-spacing: .14em; font-variant-numeric: tabular-nums; }
    textarea.ans::placeholder { letter-spacing: 0; color: #8A9099; font-weight: 400; }
    textarea.ans:focus { background: #fff; box-shadow: inset 0 0 0 2px #17181C; } /* taste-skill-ignore 焦点环 */

    /* 答案卡：10 列，每 5 题之间留一条缝 */
    .card { display: grid; grid-template-columns: repeat(5, 1fr) 8px repeat(5, 1fr);
            column-gap: 1px; row-gap: 1px; }
    .card.empty { display: block; padding: 12px 0 10px; text-align: center; color: #8A9099; font-size: 11.5px; }
    .cell { display: flex; flex-direction: column; align-items: center; padding: 4px 0 5px; border-radius: 3px; cursor: pointer; }
    .cell b { font-size: 9.5px; font-weight: 500; color: #6E747D; line-height: 1.3; font-variant-numeric: tabular-nums; }
    .cell span { font-size: 14px; font-weight: 600; line-height: 1.25; }
    .cell:hover { background: #F1F1EE; }
    .cell.skip span { color: #B7B9BF; }
    .cell.sent { opacity: .4; }
    .cell.cur { background: #C8402F; }
    .cell.cur b, .cell.cur span { color: #fff; }
    .hint { font-size: 11px; color: #6A6E78; line-height: 1.5; margin-top: -4px; min-height: 33px; }

    /* 行 */
    .row { display: flex; align-items: center; gap: 6px; }
    .lab { color: #6A6E78; font-size: 11.5px; min-width: 42px; }
    .unit { color: #A6A9B0; font-size: 11px; }
    input.num { width: 54px; background: #F1F1EE; border: 0; border-radius: 4px; padding: 5px 6px; outline: none;
                color: #17181C; font: 600 12.5px/1.2 ${FONT}; font-variant-numeric: tabular-nums; text-align: center;
                -moz-appearance: textfield; appearance: textfield; }
    input.num:focus { background: #fff; box-shadow: inset 0 0 0 2px #17181C; } /* taste-skill-ignore 焦点环 */
    input.num::-webkit-outer-spin-button, input.num::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    .rate { margin-left: auto; font-size: 11px; color: #8A8D95; font-variant-numeric: tabular-nums; }
    .rate.risky { color: #C8402F; }
    .qnow { margin-left: auto; font-size: 11px; color: #8A8D95; font-variant-numeric: tabular-nums;
      max-width: 132px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .qnow.moving { color: #17181C; }

    /* 按钮 */
    .btn { border: 1px solid transparent; border-radius: 4px; /* taste-skill-ignore 透明边框只为对齐按钮高度 */ cursor: pointer; padding: 8px 10px;
           font: 600 12.5px/1.1 ${FONT}; background: #EDEDE9; color: #17181C; transition: background .12s ease; }
    .btn:hover { background: #E7E7E3; }
    .btn:active { transform: translateY(1px); }
    .btn:focus-visible { outline: 2px solid #C8402F; outline-offset: 1px; }
    .btn[disabled] { cursor: default; opacity: .42; transform: none; }
    .btn.primary { flex: 1.6; background: #17181C; color: #fff; }
    .btn.primary:hover { background: #2C2E34; }
    .btn.primary[disabled] { background: #B7B9BF; cursor: default; transform: none; }
    .btn.wide { flex: 1; }
    .btn.mute { background: transparent; border-color: #DDDED9; color: #17181C; }
    .btn.mute:hover { background: #F7F7F4; border-color: #C7C8C2; }
    .btn.mute.on { background: #EDEDE9; border-color: #C7C8C2; color: #17181C; }

    /* 设置 */
    .more { display: flex; align-items: center; gap: 4px; background: none; border: 0; padding: 0;
            color: #6A6E78; font: 500 11.5px/1.4 ${FONT}; cursor: pointer; }
    .more:hover { color: #17181C; }
    .more .cv { font-size: 9px; transition: transform .15s ease; }
    .more.open .cv { transform: rotate(180deg); }
    .set { display: none; flex-direction: column; gap: 9px; padding: 11px 11px 12px; background: #F7F7F4;
           border-radius: 4px; margin-top: -4px; }
    .set.open { display: flex; }
    .set .lab { min-width: 46px; }
    label.cb { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; color: #3A3D44; font-size: 11.5px; }
    input[type=checkbox] { width: 13px; height: 13px; margin: 0; accent-color: #17181C; }
    input.hot { flex: 1; min-width: 0; background: #fff; border: 0; border-radius: 4px; padding: 5px 8px; outline: none;
                color: #17181C; font: 500 11.5px/1.3 ${FONT}; text-align: center; cursor: pointer; }
    input.hot:focus { box-shadow: inset 0 0 0 2px #17181C; } /* taste-skill-ignore 焦点环 */
    .status { font-size: 11.5px; color: #6A6E78; line-height: 1.5; min-height: 17px; word-break: break-word; }
  `;

  /* ============ 界面 ============ */

  function buildUI() {
    const host = document.createElement('div');
    host.id = 'cqf-panel';
    host.style.cssText = 'all:initial;position:fixed;top:88px;left:16px;z-index:2147483647;display:none;';

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="box">
        <div class="hd">
          <span class="ttl">答题</span>
          <span class="cnt"><b class="cntN">0</b><i class="cntT">题</i></span>
          <span class="x" title="收起（点「答」圆块或快捷键再打开）">×</span>
        </div>
        <div class="prog"><i></i></div>
        <div class="bd">
          <textarea class="ans" spellcheck="false" placeholder="粘贴答案：A/B/C/D，- 表示这题跳过"></textarea>
          <div class="card empty">粘贴后按题号排开</div>
          <div class="hint"></div>

          <div class="row">
            <span class="lab">每题间隔</span>
            <input class="num gap" type="number" value="2050">
            <span class="unit">毫秒</span>
            <span class="rate">≈ 29 题/分</span>
          </div>

          <div class="row">
            <span class="lab">只发</span>
            <span class="unit">第</span>
            <input class="num from" type="number" min="1" step="1" value="1">
            <span class="unit">到</span>
            <input class="num to" type="number" min="1" step="1" value="40">
            <span class="unit">题</span>
            <span class="qnow" title="从页面上读到的题号">现在 ?</span>
          </div>

          <div class="row">
            <button class="btn primary go">开始</button>
            <button class="btn wide step">单步</button>
            <button class="btn wide mute stop">停止</button>
          </div>

          <button class="more"><span>设置</span><span class="cv">▾</span></button>

          <div class="set">
            <div class="row">
              <span class="lab">字母后</span>
              <input class="num d1" type="number" value="150"><span class="unit">毫秒</span>
            </div>
            <div class="row">
              <span class="lab">Enter 后</span>
              <input class="num d2" type="number" value="150"><span class="unit">毫秒</span>
            </div>
            <div class="row">
              <span class="lab">→ 后</span>
              <input class="num d3" type="number" value="150"><span class="unit">毫秒</span>
            </div>
            <div class="row">
              <span class="lab" title="对位时每按一次 → 的间隔；太短会赶在页面渲染完之前读数">翻页</span>
              <input class="num pg" type="number" value="500"><span class="unit">毫秒/次</span>
            </div>
            <div class="row">
              <label class="cb" title="网站若按 key === 'A' 判断，勾上这个"><input class="up" type="checkbox">大写</label>
              <label class="cb" title="有些网站选完直接按 →，不需要 Enter"><input class="noenter" type="checkbox">不发 Enter</label>
              <label class="cb" title="网站若自动跳题，按 → 会跳两题，勾上这个"><input class="noarrow" type="checkbox">不发 →</label>
            </div>
            <div class="row">
              <span class="lab">快捷键</span>
              <input class="hot" type="text" readonly title="点这一格，然后按下你想用的组合键">
            </div>
            <div class="row">
              <button class="btn wide selftest">自检</button>
              <button class="btn wide reset">归零</button>
            </div>
          </div>

          <div class="status">建议先「单步」试一题，确认有反应再「开始」</div>
        </div>
      </div>
    `;

    const $ = (s) => root.querySelector(s);
    const el = {
      ans: $('.ans'), card: $('.card'), hint: $('.hint'),
      cntN: $('.cntN'), cntT: $('.cntT'), prog: $('.prog'), progI: $('.prog i'),
      gap: $('.gap'), rate: $('.rate'),
      from: $('.from'), to: $('.to'), qnow: $('.qnow'),
      d1: $('.d1'), d2: $('.d2'), d3: $('.d3'), pg: $('.pg'),
      up: $('.up'), noenter: $('.noenter'), noarrow: $('.noarrow'),
      go: $('.go'), step: $('.step'), stop: $('.stop'),
      selftest: $('.selftest'), reset: $('.reset'), status: $('.status'),
      hd: $('.hd'), x: $('.x'), hot: $('.hot'), more: $('.more'), set: $('.set'),
    };
    const setStatus = (t) => { el.status.textContent = t; };

    /* ---- 记住/读回配置 ---- */
    const save = () => {
      try {
        localStorage.setItem(STORE, JSON.stringify({
          ans: el.ans.value,
          d1: el.d1.value, d2: el.d2.value, d3: el.d3.value, gap: el.gap.value,
          pg: el.pg.value,
          up: el.up.checked, noenter: el.noenter.checked, noarrow: el.noarrow.checked,
          set: el.set.classList.contains('open'),
          hot: hot,
        }));
      } catch (e) { /* 隐私模式，忽略 */ }
    };

    /* ---- 答案卡 ---- */
    function renderCard() {
      const list = answers;
      el.card.textContent = '';
      el.card.classList.toggle('empty', list.length === 0);
      if (!list.length) {
        el.card.textContent = '粘贴后按题号排开';
        return;
      }
      const frag = document.createDocumentFragment();
      list.forEach((ch, i) => {
        const c = document.createElement('div');
        c.className = 'cell';
        c.dataset.i = String(i);
        const col = i % 10;
        // 每 5 题之间那条 5px 的缝占一列，所以要手动指定列
        c.style.gridColumn = String(col + 1 + (col >= 5 ? 1 : 0));
        const n = document.createElement('b');
        n.textContent = String(i + 1);
        const s = document.createElement('span');
        s.textContent = ch === SKIP ? '—' : ch;
        if (ch === SKIP) {
          c.classList.add('skip');
          c.title = '第 ' + (i + 1) + ' 题跳过（不发字母，照常按 →）';
        }
        c.append(n, s);
        frag.appendChild(c);
      });
      el.card.appendChild(frag);
    }

    function setCounter(n, suffix) {
      el.cntN.textContent = String(n);
      el.cntT.textContent = suffix;
    }

    // ---- 页面题号：读得到就能自己翻到位 ----
    let qno = null;
    let qnoAt = 0;

    function readQno(force) {
      const now = Date.now();
      if (!force && now - qnoAt < 250) return qno;   // 页面 MutationObserver 很吵，节流 250ms
      qnoAt = now;
      qno = readQnoFromDom();
      return qno;
    }

    function setQnow(v) {
      el.qnow.textContent = v == null ? '现在 ?' : `现在 第 ${v} 题`;
      el.qnow.classList.remove('moving');
      el.qnow.title = v == null
        ? '页面上没找到「第 N 题」，对位只能靠你自己先翻好'
        : '从页面读到的题号';
    }

    function refreshQno() {
      const v = readQno(true);
      setQnow(v);
      if (answers.length) showHint(readRange(answers.length), answers.length);
    }

    // ---- 只发第 X 到 Y 题：题号就是答案卡上的序号 ----
    let toAuto = true;   // 「到」还没手动改过，就跟着答案数走

    function readRange(n) {
      const from = Math.max(1, Math.min(n, Math.round(Number(el.from.value) || 1)));
      const to = Math.max(from, Math.min(n, Math.round(Number(el.to.value) || n)));
      return { from, to };
    }

    function syncRange() {
      const n = answers.length;
      if (!n) {
        setCounter(0, '题');
        el.hint.textContent = '';
        if (toAuto) { el.from.value = '1'; el.to.value = '1'; }
        return { from: 1, to: 1 };
      }
      if (toAuto) el.to.value = String(n);
      const r = readRange(n);
      el.from.value = String(r.from);
      el.to.value = String(r.to);
      setCounter(n, '题');
      showHint(r, n);
      return r;
    }

    // 输入过程中只刷新提示，不把值改回去，否则会打断输入
    function hintNow() {
      const n = answers.length;
      if (!n) return;
      showHint(readRange(n), n);
    }

    function showHint(r, n) {
      if (state.running) return;   // 跑起来以后这条就不该再念叨「先翻到第几题」
      const count = r.to - r.from + 1;
      const skipped = answers.slice(r.from - 1, r.to).filter((c) => c === SKIP).length;
      let text = '';
      if (count < n) {
        text = count === 1 ? `只发第 ${r.from} 题` : `只发第 ${r.from}–${r.to} 题，共 ${count} 题`;
      }
      if (skipped) text += (text ? '，' : '') + `其中 ${skipped} 题跳过`;

      // 起点在第 1 题但页面已经翻过去了，也要说清楚，否则用户以为脚本在乱按
      const q = readQno();
      if (q == null) {
        if (r.from > 1) text += (text ? ' · ' : '') + `没认出题号，把当前这题当第 ${r.from} 题`;
      } else if (q < r.from) {
        text += (text ? ' · ' : '') + `会先翻到第 ${r.from} 题`;
      } else if (q > r.from) {
        text += (text ? ' · ' : '') + `会先退到第 ${r.from} 题`;
      }
      el.hint.textContent = text;
      return r;
    }

    function paint(active) {
      for (const c of el.card.children) {
        const k = Number(c.dataset.i);
        if (isNaN(k)) continue;
        c.classList.toggle('cur', k === active);
        c.classList.toggle('sent', active >= 0 && k < active);
      }
    }

    function setProg(p) {
      el.prog.classList.toggle('run', p > 0);
      el.progI.style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + '%';
    }

    function autoGrow() {
      el.ans.style.height = "auto";
      el.ans.style.height = Math.min(el.ans.scrollHeight, 96) + "px";
    }

    // 答案一变，范围就回到「全部」——不然上次留下的 13~15 会悄悄把这次也裁短
    let prevKey = null;

    function syncAnswers() {
      autoGrow();
      const next = parseAnswers(el.ans.value);
      const key = next.join('');
      if (key !== prevKey) {
        prevKey = key;
        el.from.value = '1';
        toAuto = true;
      }
      answers = next;
      renderCard();
      syncRange();
    }

    function readCfg() {
      return {
        d1: Math.max(0, Number(el.d1.value) || 0),
        d2: Math.max(0, Number(el.d2.value) || 0),
        d3: Math.max(0, Number(el.d3.value) || 0),
        gap: Math.max(0, Number(el.gap.value) || 0),
        pg: Math.max(0, Number(el.pg.value) || 0),
        upper: el.up.checked,
        noEnter: el.noenter.checked,
        noArrow: el.noarrow.checked,
      };
    }

    /* ---- 恢复上次的配置 ---- */
    try {
      let raw = localStorage.getItem(STORE);
      if (!raw) {
        raw = localStorage.getItem(STORE_OLD);
        if (raw) {
          localStorage.setItem(STORE, raw);
          localStorage.removeItem(STORE_OLD);
        }
      }
      if (raw) {
        const c = JSON.parse(raw);
        if (c.ans) el.ans.value = c.ans;
        if (c.d1) el.d1.value = c.d1;
        if (c.d2) el.d2.value = c.d2;
        if (c.d3) el.d3.value = c.d3;
        if (c.gap) el.gap.value = c.gap;
        if (c.pg) el.pg.value = c.pg;
        el.up.checked = !!c.up;
        el.noenter.checked = !!c.noenter;
        el.noarrow.checked = !!c.noarrow;
        if (c.set) { el.set.classList.add('open'); el.more.classList.add('open'); }
        if (c.hot && c.hot.code) hot = Object.assign({}, DEFAULT_HOT, c.hot);
      }
    } catch (e) { /* 忽略 */ }
    el.hot.value = hotLabel();
    syncAnswers();

    /* ---- 页面换题时跟着刷新「现在 第 N 题」 ---- */
    refreshQno();
    let qTimer = null;
    try {
      const qMo = new MutationObserver(() => {
        if (qTimer) return;
        qTimer = setTimeout(() => { qTimer = null; refreshQno(); }, 250);
      });
      qMo.observe(document.documentElement, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['title', 'class'],
      });
    } catch (e) { /* 老浏览器，忽略 */ }

    /* ---- 对位：把页面翻到第 from 题。过了就按 ← 退，没到就按 → 走；走不动就停下来说清楚 ---- */
    async function alignTo(from) {
      let cur = readQno(true);
      setQnow(cur);
      if (cur == null) return { ok: true, cur: null };   // 一开始就读不到题号：当前这题当起点

      const cfg = readCfg();
      const hop = Math.max(300, cfg.pg);   // 每次 ←/→ 之后等多久再读数，给页面渲染留时间
      let hops = 0;
      while (cur !== from && hops < 80) {
        if (state.stop) return { ok: false, msg: '已停止' };
        const back = cur > from;   // 页面在起点后面就退回去
        setStatus(back
          ? `对位中 · 退到第 ${from} 题（现在第 ${cur} 题）`
          : `对位中 · 翻到第 ${from} 题（现在第 ${cur} 题）`);
        el.qnow.classList.add('moving');
        if (back) pressLeft(); else pressRight();
        hops++;
        if (!(await wait(hop))) return { ok: false, msg: '已停止' };
        const next = readQno(true);
        setQnow(next);
        if (next == null) {
          // 已经动了却读不到题号，位置就不确定了，不能再闷头发
          return { ok: false, msg: `翻到一半认不出题号了，先手动翻到第 ${from} 题再试` };
        }
        if (back ? next >= cur : next <= cur) {
          return {
            ok: false,
            msg: back
              ? `退不回去：还停在第 ${next} 题 · 起点是第 ${from} 题，把「只发」起点改成 ${next} 再试`
              : `翻不动：还停在第 ${next} 题 · 站点可能要答完这题才放行`,
          };
        }
        cur = next;
      }
      if (cur === from) {
        if (hops) await wait(hop);   // 到位后再等一拍，别赶在题干渲染完之前按字母
        return { ok: true, cur };
      }
      return { ok: false, msg: `对位没走完：停在第 ${cur} 题，起点是第 ${from} 题 · 手动翻一下再试` };
    }

    /* ---- 一轮按键：字母 → Enter → →；pad 时把这一题补足到「每题间隔」 ---- */
    async function oneQuestion(i, list, cfg, pad) {
      const t0 = Date.now();
      const ch = list[i];
      if (ch && ch !== SKIP) {
        pressLetter(ch, cfg.upper);
        if (!(await wait(cfg.d1))) return false;

        if (!cfg.noEnter) {
          pressEnter();
          if (!(await wait(cfg.d2))) return false;
        }
      }

      const isLast = i >= list.length - 1;
      if (!isLast && !cfg.noArrow) {
        pressRight();
        if (!(await wait(cfg.d3))) return false;
      }

      // 限速：从这一题开始算，总耗时不超过 cfg.gap，
      // 让每分钟的答题次数落在站点限额 30 次/分以下。
      if (pad && cfg.gap > 0) {
        const left = cfg.gap - (Date.now() - t0);
        if (left > 0 && !(await wait(left))) return false;
      }
      return true;
    }

    function blurPanel() {
      try {
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      } catch (e) { /* 忽略 */ }
    }

    function setRunning(on) {
      el.go.disabled = on;
      el.step.disabled = on;
      el.stop.classList.toggle('on', on);
      el.stop.disabled = !on;
    }
    setRunning(false);

    // 收尾：按钮复位、按钮文字回来、答案卡不再高亮
    function endRun() {
      state.running = false;
      state.stop = false;
      setRunning(false);
      el.go.textContent = '开始';
      paint(-1);
    }

    /* ---- 开始 ---- */
    async function runAll() {
      if (state.running) return;
      syncAnswers();
      const all = answers.slice();
      if (!all.length) { setStatus('没有读到 A/B/C/D 答案'); return; }

      const { from, to } = readRange(all.length);
      const list = all.slice(from - 1, to);   // 只发这一段

      save();
      state.running = true;
      state.stop = false;
      state.current = from - 1;
      setRunning(true);
      el.go.textContent = '运行中';
      setProg(0);
      el.hint.textContent = '';
      blurPanel();

      // 先对位：页面停在第 1 题、范围从第 5 题开始，就先按 → 翻过去
      const al = await alignTo(from);
      if (!al.ok) {
        endRun();
        setStatus(al.msg);
        syncRange();
        return;
      }
      const blind = from > 1 && al.cur == null;   // 认不出题号，只能把当前这题当起点

      let stopped = false;
      for (let k = 0; k < list.length; k++) {
        const abs = from - 1 + k;             // 真实题号（从 0 数）
        if (state.stop) { stopped = true; state.current = abs; break; }
        state.current = abs;
        const cfg = readCfg();
        const cyc = cfg.gap > 0 ? cfg.gap
          : cfg.d1 + (cfg.noEnter ? 0 : cfg.d2) + (cfg.noArrow ? 0 : cfg.d3);
        const rest = (list.length - 1 - k) * cyc;
        setCounter(abs + 1, '/ ' + to);
        paint(abs);
        setStatus(`第 ${abs + 1} 题 · ${list[k] === SKIP ? '跳过' : list[k]}` +
          (rest > 800 ? ` · 约剩 ${Math.ceil(rest / 1000)} 秒` : ''));
        if (!(await oneQuestion(k, list, cfg, true))) { stopped = true; break; }
        setProg((k + 1) / list.length);
      }

      endRun();

      const span = from === to ? `第 ${from} 题` : `第 ${from}–${to} 题`;
      const countNote = list.length > 1 ? `，共 ${list.length} 题` : '';
      const blindNote = blind ? ` · 没认出题号，按当前这题当第 ${from} 题` : '';
      if (stopped) {
        setStatus(`已停止 · 停在第 ${state.current + 1} 题`);
      } else if (list.length === all.length) {
        setStatus(`全 ${all.length} 题已发完 · 提交按钮没动${blindNote}`);
      } else {
        setStatus(`${span}已发完${countNote} · 提交按钮没动${blindNote}`);
      }
      syncRange();
    }

    /* ---- 单步：只发一轮，用来确认网站吃不吃这套 ---- */
    async function stepOnce() {
      if (state.running) return;
      syncAnswers();
      const all = answers.slice();
      if (!all.length) { setStatus('没有读到 A/B/C/D 答案'); return; }

      const { from, to } = readRange(all.length);
      const list = all.slice(from - 1, to);
      // 单步的游标落在范围内；走到范围末尾就绕回范围开头
      if (state.stepIndex < from - 1 || state.stepIndex > to - 1) state.stepIndex = from - 1;
      const i = state.stepIndex;              // 真实题号（从 0 数）
      const ch = all[i];

      state.stop = false;
      state.running = true;
      setRunning(true);
      el.hint.textContent = '';
      paint(i);
      setStatus(`单步 · 第 ${i + 1} 题 · ${ch === SKIP ? '跳过' : ch}`);
      blurPanel();

      // 单步也对位：页面在哪不重要，落到「这一题」再发
      const al = await alignTo(i + 1);
      if (!al.ok) {
        endRun();
        setStatus(al.msg);
        hintNow();
        return;
      }

      await oneQuestion(i - (from - 1), list, readCfg(), false);

      endRun();
      state.stepIndex = i + 1 > to - 1 ? from - 1 : i + 1;
      const did = ch === SKIP ? `跳过第 ${i + 1} 题` : `发了第 ${i + 1} 题（${ch}）`;
      setStatus(`${did}，下一题从第 ${state.stepIndex + 1} 题开始`);
      hintNow();
    }

    /* ---- 自检：真按一个 A，看页面认不认合成按键 ---- */
    async function selfTest() {
      if (state.running) return;
      setStatus('自检中：会真的按一下 A，可能改变当前这题的选项');

      let mutations = 0;
      const mo = new MutationObserver((ms) => { mutations += ms.length; });
      if (document.body) {
        mo.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      }
      const before = document.body ? document.body.innerHTML.length : 0;

      const handled = pressLetter('A', false);

      await sleep(800);
      mo.disconnect();
      const after = document.body ? document.body.innerHTML.length : 0;

      if (mutations > 0 || after !== before) {
        setStatus('自检：页面有反应，合成按键可用');
      } else if (handled) {
        setStatus('自检：按键被页面处理了，可以用');
      } else {
        setStatus('自检：没反应。站点可能只认真人按键，得改用系统级按键模拟');
      }
    }

    /* ---- 绑定 ---- */
    el.go.addEventListener('click', runAll);
    el.step.addEventListener('click', stepOnce);
    el.stop.addEventListener('click', () => {
      if (!state.running) return;
      state.stop = true;
      setStatus('正在停止…');
    });
    el.selftest.addEventListener('click', selfTest);
    el.reset.addEventListener('click', () => {
      const { from } = readRange(Math.max(1, answers.length));
      state.stepIndex = from - 1;
      state.current = from - 1;
      setStatus(`已归零，从第 ${from} 题开始`);
    });

    el.ans.addEventListener('input', () => { syncAnswers(); save(); });
    // 每题间隔自己挂 input/change，还要顺带刷新题/分，所以不放进上面的批量保存里
    [el.d1, el.d2, el.d3, el.pg, el.up, el.noenter, el.noarrow].forEach((n) => n.addEventListener('change', save));

    // 范围：输入时只刷新提示，失焦/回车时再夹到合法区间
    el.from.addEventListener('input', hintNow);
    el.to.addEventListener('input', () => { toAuto = false; hintNow(); });
    [el.from, el.to].forEach((n) => {
      n.addEventListener('change', syncRange);
      n.addEventListener('keydown', (e) => { if (e.key === 'Enter') n.blur(); });
    });

    // 点某一格改答案：A → B → C → D → 跳过 → A
    el.card.addEventListener('click', (e) => {
      if (state.running) return;
      const c = e.target.closest ? e.target.closest('.cell') : null;
      if (!c || !c.dataset.i) return;
      const i = Number(c.dataset.i);
      const order = ['A', 'B', 'C', 'D', SKIP];
      const cur = answers[i] || 'A';
      answers[i] = order[(order.indexOf(cur) + 1) % order.length];
      el.ans.value = fmt(answers);
      renderCard();
      syncRange();
      save();
    });

    // 设置开合
    el.more.addEventListener('click', () => {
      const open = !el.set.classList.contains('open');
      el.set.classList.toggle('open', open);
      el.more.classList.toggle('open', open);
      save();
    });

    /* ---- 每题间隔 → 折算成「题/分」，超过站点限额标红 ---- */
    const syncRate = () => {
      const g = Math.max(0, Number(el.gap.value) || 0);
      const perMin = g > 0 ? Math.floor(60000 / g) : 0;
      const risky = perMin >= 30;
      el.rate.textContent = perMin > 0 ? `≈ ${perMin} 题/分` : '不限速';
      el.rate.classList.toggle('risky', risky);
      el.rate.title = perMin > 0
        ? `每分钟约 ${perMin} 题` + (risky ? '，接近或超过站点 30 次/分的限额，建议 ≥ 2000 毫秒' : '')
        : '不限速，只按设置里的三个等待时间跑';
    };
    el.gap.addEventListener('input', syncRate);
    el.gap.addEventListener('change', () => { syncRate(); save(); });
    syncRate();

    /* ---- 改快捷键：点一下这格，然后按你要的组合 ---- */
    let recording = false;
    el.hot.addEventListener('focus', () => {
      recording = true;
      el.hot.value = '按下组合键…';
    });
    el.hot.addEventListener('blur', () => {
      recording = false;
      el.hot.value = hotLabel();
    });
    el.hot.addEventListener('keydown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { el.hot.blur(); return; }
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;   // 只按了修饰键，继续等
      const isFn = /^F\d{1,2}$/.test(e.code);
      const hasMod = e.ctrlKey || e.altKey || e.shiftKey || e.metaKey;
      if (!isFn && !hasMod) { el.hot.value = '要带 Ctrl/Alt/Shift 或 F1~F12'; return; }
      hot = { code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
      el.hot.value = hotLabel();
      if (hotBadge) hotBadge.title = '码砖速填 v' + VER + ' · ' + hotLabel() + ' 打开/收起';
      save();
      setTimeout(() => el.hot.blur(), 150);
    });

    /* ---- 拖动 ---- */
    let drag = null;
    el.hd.addEventListener('mousedown', (e) => {
      if (e.target.closest && e.target.closest('.x')) return;
      const r = host.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      host.style.left = Math.max(0, e.clientX - drag.dx) + 'px';
      host.style.top = Math.max(0, e.clientY - drag.dy) + 'px';
      host.style.right = 'auto';
    }, true);
    window.addEventListener('mouseup', () => { drag = null; }, true);

    return { host, el, isRecording: () => recording };
  }

  /* ============ 装配 ============ */

  const rootNode = () => document.body || document.documentElement;

  const VER = '2.0.2';     // 只给圆块的 title 用，和头部 @version 一起改
  let hotBadge = null;   // 圆块的 title 要跟着快捷键改

  const panel = buildUI();
  rootNode().appendChild(panel.host);

  // 左上角浮动「答」圆块：不用记快捷键也能打开面板，可拖动
  const badge = document.createElement('div');
  badge.id = 'cqf-badge';
  badge.textContent = '答';
  hotBadge = badge;
  badge.title = '码砖速填 v' + VER + ' · ' + hotLabel() + ' 打开/收起';
  badge.style.cssText =
    'all:initial;position:fixed;top:88px;left:16px;width:28px;height:28px;border-radius:50%;' +
    'background:#17181C;color:#fff;font:600 12px/28px ' + FONT + ';' +
    'text-align:center;cursor:pointer;z-index:2147483646;opacity:.32;' +
    'user-select:none;transition:opacity .15s ease;';
  rootNode().appendChild(badge);
  badge.addEventListener('mouseenter', () => { badge.style.opacity = '.9'; });
  badge.addEventListener('mouseleave', () => { badge.style.opacity = '.32'; });

  function setOpen(open) {
    panel.host.style.display = open ? 'block' : 'none';
    badge.style.display = open ? 'none' : 'block';
    if (open) {
      // 隐藏状态下量不出高度，展开后按内容重新定一次输入框高度
      panel.el.ans.style.height = 'auto';
      panel.el.ans.style.height = Math.min(panel.el.ans.scrollHeight, 96) + 'px';
    }
  }
  setOpen(false);

  // 拖圆块：拖动改位置，原地点一下才打开面板
  let bdrag = null;
  badge.addEventListener('mousedown', (e) => {
    const r = badge.getBoundingClientRect();
    bdrag = { dx: e.clientX - r.left, dy: e.clientY - r.top, x: e.clientX, y: e.clientY, moved: false };
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!bdrag) return;
    if (Math.abs(e.clientX - bdrag.x) + Math.abs(e.clientY - bdrag.y) > 4) bdrag.moved = true;
    badge.style.left = Math.max(0, e.clientX - bdrag.dx) + 'px';
    badge.style.top = Math.max(0, e.clientY - bdrag.dy) + 'px';
    badge.style.right = 'auto';
  }, true);
  window.addEventListener('mouseup', () => {
    if (bdrag && !bdrag.moved) setOpen(true);
    bdrag = null;
  }, true);

  // 收起按钮
  panel.el.x.addEventListener('click', () => setOpen(false));

  // 站点把 1 / 2 / 3 / 4 抢去当 A / B / C / D 的快捷键，会 preventDefault 掉，
  // 结果在面板输入框里打不出这 4 个数字。这里在 window 捕获阶段就把事件截住，
  // 站点收不到自然没法拦；stopPropagation 不影响浏览器自身的文字输入。
  function typedInPanel(e) {
    const path = e.composedPath ? e.composedPath() : [];
    return path.indexOf(panel.host) !== -1;
  }
  function shieldPanelKeys(e) {
    if (!typedInPanel(e)) return;
    if (panel.isRecording()) return;          // 正在录快捷键，放行给它自己
    if (hotMatches(e)) return;                // 面板自己的快捷键照常
    if (e.key === 'Escape') return;           // Esc 要能传到下面的「停止」
    e.stopImmediatePropagation();
  }
  window.addEventListener('keydown', shieldPanelKeys, true);
  window.addEventListener('keypress', shieldPanelKeys, true);
  window.addEventListener('keyup', shieldPanelKeys, true);

  // 快捷键开关面板，Esc 停止
  window.addEventListener('keydown', (e) => {
    if (panel.isRecording()) return;          // 正在录快捷键，别抢
    if (hotMatches(e)) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(panel.host.style.display === 'none');
      return;
    }
    if (e.key === 'Escape' && state.running) {
      state.stop = true;
    }
  }, true);
})();
