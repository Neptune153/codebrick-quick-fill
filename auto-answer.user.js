// ==UserScript==
// @name         答题键盘模拟（ABCD → Enter → →）
// @namespace    https://local.auto-answer
// @version      1.3.1
// @description  按给定答案自动模拟键盘：字母 → Enter → 右方向键，循环 N 题。点右下角「答」或按快捷键打开面板。
// @author       local
// @match        https://www.codebrick.tech/*
// @match        https://codebrick.tech/*
// @match        https://*.codebrick.tech/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* ------------------------------------------------------------------
 * 用法
 *   1. 打开 https://www.codebrick.tech/ 的答题页（不用先点题目区域）
 *   2. 点右侧那个浮动的「答」圆块，或按 Alt + Shift + A，打开面板
 *   3. 把答案粘进输入框 → 点「单步」试一题 → 确认有反应再点「开始」
 *   4. 想停下：点「停止」，或按 Esc
 *
 * 限流
 *   CodeBrick 限「每分钟 30 次」答题。面板里的「每题间隔」控制节奏：
 *   默认 2200ms ≈ 27 题/分，40 题约 88 秒；调小会让「≈ N 题/分」变橙色。
 *   这个间隔是从"这一题开始按键"算起的总时长，不足会自动补足，
 *   所以字母后/Enter后/→后 三个等待只会拖慢单题，不会让总节奏超过设定值。
 *
 * 快捷键
 *   默认 Alt + Shift + A。嫌冲突就在面板里点「快捷键」那一格，
 *   直接按下你想用的组合（要带 Ctrl/Alt/Shift 或 F1~F12），会被记住。
 *   不想用快捷键也行——点那个浮动的「答」圆块即可。
 *
 * 说明
 *   - 按键是网页内部派发的合成事件（isTrusted = false）。
 *     用 keydown / keyup 监听选项的网站基本都能用；
 *     如果站点校验"真人按键"，这个方案会被拦，只能改用系统级按键模拟
 *     （AutoHotkey 之类的工具）。
 *   - @match 已限定在 codebrick.tech。想换站点就改这几行。
 *   - 面板出现在"当前有焦点的那个 frame"，题目在 iframe 里也能用。
 * ------------------------------------------------------------------ */

(function () {
  'use strict';

  if (window.__autoAnswerLoaded) return;
  window.__autoAnswerLoaded = true;

  const STORE = 'dsh-auto-answer-v1';
  const LETTER_VK = { A: 65, B: 66, C: 67, D: 68 };

  const state = { running: false, stop: false, current: 0, stepIndex: 0 };

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
    return p.join('+');
  }

  function hotMatches(e) {
    return e.code === hot.code &&
      e.ctrlKey === !!hot.ctrl &&
      e.altKey === !!hot.alt &&
      e.shiftKey === !!hot.shift &&
      e.metaKey === !!hot.meta;
  }

  /* ============ 按键派发 ============ */

  // 统一发到 body：事件顺着 DOM 往上冒泡，document / window 上的监听都能收到。
  // 只发一次就够——同一个事件在 body/document/window 上各发一遍，document 上的监听会被触发两次，会一次跳两题。
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
        // dispatchEvent 返回 false 说明页面确实处理了这次按键（调了 preventDefault）
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

  function parseAnswers(text) {
    let out = '';
    for (const line of String(text || '').split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;   // # 开头是注释行
      out += line;
    }
    return out.toUpperCase().replace(/[^A-D]/g, '').split('').filter(Boolean);
  }

  /* ============ 界面 ============ */

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
    .box { width: 306px; background: #1f2430; color: #e8eaf0; border: 1px solid #3a4257;
           border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.45); font-size: 12px; overflow: hidden; }
    .hd { display: flex; justify-content: space-between; align-items: center; padding: 8px 10px;
          background: #2a3142; cursor: move; font-weight: 600; user-select: none; }
    .hd .x { cursor: pointer; padding: 0 5px; color: #9aa3b8; font-size: 14px; line-height: 1; }
    .hd .x:hover { color: #fff; }
    .bd { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
    textarea { width: 100%; height: 56px; resize: vertical; background: #151a23; color: #e8eaf0;
               border: 1px solid #3a4257; border-radius: 6px; padding: 6px; font-family: Consolas, monospace;
               font-size: 12px; outline: none; }
    textarea:focus { border-color: #2563eb; }
    .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .lab { color: #8f9bb5; }
    input[type=number] { width: 52px; background: #151a23; color: #e8eaf0; border: 1px solid #3a4257;
                         border-radius: 4px; padding: 2px 4px; font-size: 12px; outline: none; }
    label { display: inline-flex; gap: 4px; align-items: center; cursor: pointer; color: #b8c1d9; }
    input[type=checkbox] { accent-color: #2563eb; margin: 0; }
    input.hot { flex: 1; background: #151a23; color: #e8eaf0; border: 1px solid #3a4257; border-radius: 4px;
                padding: 3px 6px; font-size: 12px; outline: none; cursor: pointer; min-width: 0; }
    input.hot:focus { border-color: #2563eb; }
    button { flex: 1; cursor: pointer; padding: 6px 8px; border-radius: 6px; border: 1px solid #3a4257;
             background: #2a3142; color: #e8eaf0; font-size: 12px; }
    button:hover { background: #364058; }
    button:active { transform: translateY(1px); }
    button.go { background: #2563eb; border-color: #2563eb; font-weight: 600; }
    button.go:hover { background: #1d4ed8; }
    button.stop { background: #7f1d1d; border-color: #7f1d1d; }
    button.stop:hover { background: #991b1b; }
    button.ghost { flex: 0 0 auto; padding: 6px 10px; }
    .status { min-height: 17px; color: #9fb4d8; line-height: 1.5; word-break: break-all; }
    .tip { color: #6b7793; font-size: 11px; line-height: 1.5; }
  `;

  function buildUI() {
    const host = document.createElement('div');
    host.id = 'dsh-auto-answer';
    host.style.cssText = 'all:initial;position:fixed;top:80px;right:16px;z-index:2147483647;display:none;';

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="box">
        <div class="hd"><span>答题键盘模拟</span><span class="x" title="收起（点「答」圆块或快捷键再打开）">×</span></div>
        <div class="bd">
          <textarea class="ans" placeholder="粘贴答案：只认 A/B/C/D，空格、题号、换行自动忽略"></textarea>
          <div class="row">
            <span class="lab">字母后</span><input class="d1" type="number" value="150"><span class="lab">ms</span>
            <span class="lab">Enter后</span><input class="d2" type="number" value="250"><span class="lab">ms</span>
            <span class="lab">→后</span><input class="d3" type="number" value="800"><span class="lab">ms</span>
          </div>
          <div class="row">
            <span class="lab">每题间隔</span><input class="gap" type="number" value="2200"><span class="lab">ms</span>
            <span class="lab">≈</span><span class="rate">27</span><span class="lab">题/分</span>
          </div>
          <div class="row">
            <label title="网站若按 key==='A' 判断，勾上这个"><input class="up" type="checkbox">大写</label>
            <label title="有些网站选完直接按 →，不需要 Enter"><input class="noenter" type="checkbox">不发Enter</label>
            <label title="网站若自动跳题，按 → 会跳两题，勾上这个"><input class="noarrow" type="checkbox">不发→</label>
          </div>
          <div class="row">
            <span class="lab">快捷键</span>
            <input class="hot" type="text" readonly title="点这里，然后按下你想用的组合键">
          </div>
          <div class="row">
            <button class="go">开始</button>
            <button class="step">单步</button>
            <button class="stop">停止</button>
          </div>
          <div class="row">
            <button class="selftest ghost">自检（敲一次 a）</button>
            <button class="reset ghost">归零</button>
          </div>
          <div class="status">把答案粘进来，先「单步」试一题</div>
          <div class="tip">把答案粘进来，先「单步」试一题，再「开始」跑全部。站点限 30 次/分，所以默认每题间隔 2200ms（≈27 题/分，40 题约 88 秒）</div>
        </div>
      </div>
    `;

    const $ = (s) => root.querySelector(s);
    const el = {
      ans: $('.ans'), d1: $('.d1'), d2: $('.d2'), d3: $('.d3'),
      gap: $('.gap'), rate: $('.rate'),
      up: $('.up'), noenter: $('.noenter'), noarrow: $('.noarrow'),
      go: $('.go'), step: $('.step'), stop: $('.stop'),
      selftest: $('.selftest'), reset: $('.reset'), status: $('.status'),
      hd: $('.hd'), x: $('.x'), hot: $('.hot'),
    };
    const setStatus = (t) => { el.status.textContent = t; };

    /* ---- 记住/读回配置 ---- */
    const save = () => {
      try {
        localStorage.setItem(STORE, JSON.stringify({
          ans: el.ans.value,
          d1: el.d1.value, d2: el.d2.value, d3: el.d3.value, gap: el.gap.value,
          up: el.up.checked, noenter: el.noenter.checked, noarrow: el.noarrow.checked,
          hot: hot,
        }));
      } catch (e) { /* 隐私模式，忽略 */ }
    };
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) {
        const c = JSON.parse(raw);
        if (c.ans) el.ans.value = c.ans;
        if (c.d1) el.d1.value = c.d1;
        if (c.d2) el.d2.value = c.d2;
        if (c.d3) el.d3.value = c.d3;
        if (c.gap) el.gap.value = c.gap;
        el.up.checked = !!c.up;
        el.noenter.checked = !!c.noenter;
        el.noarrow.checked = !!c.noarrow;
        if (c.hot && c.hot.code) hot = Object.assign({}, DEFAULT_HOT, c.hot);
      }
    } catch (e) { /* 忽略 */ }
    el.hot.value = hotLabel();

    const readCfg = () => ({
      d1: Math.max(0, Number(el.d1.value) || 0),
      d2: Math.max(0, Number(el.d2.value) || 0),
      d3: Math.max(0, Number(el.d3.value) || 0),
      gap: Math.max(0, Number(el.gap.value) || 0),
      upper: el.up.checked,
      noEnter: el.noenter.checked,
      noArrow: el.noarrow.checked,
    });

    /* ---- 一轮按键：字母 → Enter → →；pad 时把这一题补足到「每题间隔」 ---- */
    async function oneQuestion(i, list, cfg, pad) {
      const t0 = Date.now();
      pressLetter(list[i], cfg.upper);
      if (!(await wait(cfg.d1))) return false;

      if (!cfg.noEnter) {
        pressEnter();
        if (!(await wait(cfg.d2))) return false;
      }

      const isLast = i >= list.length - 1;
      if (!isLast && !cfg.noArrow) {
        pressRight();
        if (!(await wait(cfg.d3))) return false;
      }

      // 限速：从这一题开始算，总耗时不超过 cfg.gap，
      // 让每分钟提交次数稳定落在站点限额（如 30 次/分）以下。
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

    /* ---- 开始 ---- */
    async function runAll() {
      if (state.running) return;
      const list = parseAnswers(el.ans.value);
      if (!list.length) { setStatus('没有读到 A/B/C/D 答案'); return; }

      save();
      state.running = true;
      state.stop = false;
      el.go.textContent = '运行中…';
      blurPanel();

      for (let i = 0; i < list.length; i++) {
        if (state.stop) break;
        state.current = i;
        const cfg = readCfg();
        const cyc = cfg.gap > 0 ? cfg.gap
          : cfg.d1 + (cfg.noEnter ? 0 : cfg.d2) + (cfg.noArrow ? 0 : cfg.d3);
        const rest = (list.length - 1 - i) * cyc;
        setStatus(`第 ${i + 1}/${list.length} 题 → ${list[i]}` +
          (rest > 500 ? `（约剩 ${Math.ceil(rest / 1000)} 秒）` : ''));
        if (!(await oneQuestion(i, list, cfg, true))) break;
      }

      const stopped = state.stop;
      state.running = false;
      state.stop = false;
      el.go.textContent = '开始';
      setStatus(stopped
        ? `已停止：停在第 ${state.current + 1} 题`
        : `完成 ${list.length} 题。自己检查一遍再提交。`);
    }

    /* ---- 单步：只发一轮，用来确认网站吃不吃这套 ---- */
    async function stepOnce() {
      if (state.running) return;
      const list = parseAnswers(el.ans.value);
      if (!list.length) { setStatus('没有读到 A/B/C/D 答案'); return; }

      const i = Math.min(state.stepIndex, list.length - 1);
      state.stop = false;
      state.running = true;
      setStatus(`单步：第 ${i + 1}/${list.length} 题 → ${list[i]}`);
      blurPanel();

      await oneQuestion(i, list, readCfg(), false);

      state.running = false;
      state.stepIndex = Math.min(i + 1, list.length - 1);
      setStatus(`单步发了第 ${i + 1} 题（${list[i]}），下一次从第 ${state.stepIndex + 1} 题开始`);
    }

    /* ---- 自检：发一个 a，看看页面有没有反应 ---- */
    async function selfTest() {
      if (state.running) return;
      setStatus('自检中，观察 0.8 秒…');

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
        setStatus('自检：页面有反应 ✅ 合成按键可用，可以点「开始」');
      } else if (handled) {
        setStatus('自检：按键被页面处理了 ✅ 可以点「开始」');
      } else {
        setStatus('自检：没检测到反应 ⚠ 站点可能只认真人按键，需要改用系统级按键模拟（如 AutoHotkey）');
      }
    }

    /* ---- 绑定 ---- */
    el.go.addEventListener('click', runAll);
    el.step.addEventListener('click', stepOnce);
    el.stop.addEventListener('click', () => { state.stop = true; setStatus('正在停止…'); });
    el.selftest.addEventListener('click', selfTest);
    el.reset.addEventListener('click', () => {
      state.stepIndex = 0;
      state.current = 0;
      setStatus('已归零，从第 1 题开始');
    });
    el.ans.addEventListener('input', () => {
      const n = parseAnswers(el.ans.value).length;
      setStatus(`已读入 ${n} 个答案` + (n && n !== 40 ? '（不是 40 个，确认一下）' : ''));
      save();
    });
    [el.d1, el.d2, el.d3, el.gap, el.up, el.noenter, el.noarrow].forEach((n) => n.addEventListener('change', save));

    /* ---- 每题间隔 → 折算成「题/分」，低于站点限额时标红 ---- */
    const syncRate = () => {
      const g = Math.max(0, Number(el.gap.value) || 0);
      const perMin = g > 0 ? Math.floor(60000 / g) : 0;
      const risky = perMin >= 30;
      el.rate.textContent = perMin > 0 ? String(perMin) : '—';
      el.rate.style.color = risky ? '#e5a04a' : '#8f9bb5';
      el.rate.title = perMin > 0
        ? `每分钟约 ${perMin} 题` + (risky ? '，接近或超过站点 30 次/分的限额，建议 ≥ 2200ms（≤27 题/分）' : '')
        : '未限速，只按上面三个等待时间跑';
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
      save();
      setTimeout(() => el.hot.blur(), 150);
    });

    /* ---- 拖动 ---- */
    let drag = null;
    el.hd.addEventListener('mousedown', (e) => {
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

  const rootNode = document.body || document.documentElement;

  const panel = buildUI();
  rootNode.appendChild(panel.host);

  // 右侧浮动「答」圆块：不用记快捷键也能打开面板，可拖动
  const badge = document.createElement('div');
  badge.id = 'dsh-auto-answer-badge';
  badge.textContent = '答';
  badge.title = '答题键盘模拟（' + hotLabel() + '）';
  badge.style.cssText =
    'all:initial;position:fixed;top:96px;right:16px;width:30px;height:30px;border-radius:50%;' +
    'background:#2563eb;color:#fff;font:600 14px/30px -apple-system,"Microsoft YaHei",sans-serif;' +
    'text-align:center;cursor:pointer;z-index:2147483646;opacity:.4;' +
    'box-shadow:0 2px 10px rgba(0,0,0,.35);user-select:none;';
  rootNode.appendChild(badge);

  function setOpen(open) {
    panel.host.style.display = open ? 'block' : 'none';
    badge.style.display = open ? 'none' : 'block';
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
