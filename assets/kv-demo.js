/*
 * 格子写成 "."、"A1"、"~A1"、"A1:hit"，"~" 表示空闲但还挂着哈希，":" 后是标记。
 * 颜色默认取标签的第一个字母（A～E、P），也可以写 "7@A" 显式指定，S 灰紫、R 红、G 灰。
 * 可选的 config：
 *   grid_label: 格子上方的标题，{n} 换成格子数
 *   index: true 时在格子左上角显示位置编号
 *   legend: [{swatch: used|cached|empty, color: A, text: 说明}]
 *   rows: [{key: running, name: 运行队列, optional: true}]，optional 的行在这一步没给数据时隐藏
 *   marks: {lost: 丢失}，标记文字；没列出的标记原样显示
 * 队列行的条目同样可以写 "7@A"；行数据写成字符串时原样显示。
 *   grids: [{key: g0, label: 卡 0, aria_name: 卡 0, columns: 8}]，画多组格子，每一步用 key 给出各组的格子，
 *          不再用 blocks；每一步可写 grid_labels: {g0: 新标题} 换掉这一步的标题
 */
(() => {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const split = (s) => {
    const at = s.lastIndexOf('@');
    return at > 0 ? [s.slice(0, at), s.slice(at + 1)] : [s, ''];
  };

  const parse = (s) => {
    if (s === '.') return { kind: 'empty', label: '' };
    const cached = s.startsWith('~');
    const body = cached ? s.slice(1) : s;
    const colon = body.indexOf(':');
    const [label, color] = split(colon < 0 ? body : body.slice(0, colon));
    const mark = colon < 0 ? '' : body.slice(colon + 1);
    return { kind: cached ? 'cached' : 'used', label, req: color || label[0], mark };
  };

  const chips = (box, items) => {
    box.textContent = '';
    if (typeof items === 'string') { box.appendChild(el('span', 'kvd-val', items)); return; }
    if (!items || !items.length) { box.appendChild(el('span', 'kvd-none', '空')); return; }
    items.forEach((raw) => {
      const [name, color] = split(String(raw));
      const c = el('span', 'kvd-chip', name);
      if (color) c.dataset.req = color;
      else if (name.length === 1) c.dataset.req = name;
      box.appendChild(c);
    });
  };

  const defaultRows = [
    { key: 'running', name: '运行队列' },
    { key: 'waiting', name: '等待队列（左边是最前面）' },
    { key: 'free', name: '空闲队列（从左边取）', optional: true },
  ];
  const defaultLegend = [
    { swatch: 'used', text: '被请求占用' },
    { swatch: 'cached', text: '空闲，还挂着哈希，可被命中' },
    { swatch: 'empty', text: '空闲' },
  ];

  function init(root) {
    if (root.classList.contains('kvd-ready')) return;
    const src = root.querySelector('.kv-demo-data');
    if (!src) return;
    let steps;
    let cfg = {};
    try { steps = JSON.parse(src.textContent); } catch (e) { return; }
    if (!steps.length) return;
    const cfgSrc = root.querySelector('.kv-demo-config');
    if (cfgSrc) { try { cfg = JSON.parse(cfgSrc.textContent) || {}; } catch (e) { cfg = {}; } }
    const marks = Object.assign({ hit: '命中', re: '重算' }, cfg.marks || {});
    const multi = Array.isArray(cfg.grids) && cfg.grids.length > 0;
    const specs = multi ? cfg.grids : [{ key: 'blocks', label: cfg.grid_label || 'KV Cache（{n} 个 block）' }];
    if (specs.some((g) => !Array.isArray(steps[0][g.key]))) return;

    const stage = el('div', 'kvd-stage');
    const grids = specs.map((spec) => {
      const n = steps[0][spec.key].length;
      const label = el('div', 'kvd-label', (spec.label || '').replace('{n}', n));
      const grid = el('div', 'kvd-grid');
      grid.style.setProperty('--kvd-n', spec.columns || n);
      const cells = [];
      for (let i = 0; i < n; i++) {
        const c = el('div', 'kvd-cell');
        if (cfg.index) c.appendChild(el('span', 'kvd-index', String(i)));
        c.appendChild(el('span', 'kvd-tag'));
        c.appendChild(el('span', 'kvd-mark'));
        grid.appendChild(c);
        cells.push(c);
      }
      return { spec, n, label, grid, cells };
    });

    const queues = el('div', 'kvd-queues');
    const rows = (cfg.rows || defaultRows).map((spec) => {
      const r = el('div', 'kvd-row');
      r.appendChild(el('span', 'kvd-row-name', spec.name));
      const box = el('span', 'kvd-row-items');
      r.appendChild(box);
      queues.appendChild(r);
      return { spec, r, box };
    });

    const legend = el('div', 'kvd-legend');
    (cfg.legend || defaultLegend).forEach((item) => {
      const i = el('span', 'kvd-legend-item');
      const sw = el('span', `kvd-swatch kvd-${item.swatch || 'used'}`);
      if (item.color) sw.dataset.req = item.color;
      i.appendChild(sw);
      i.appendChild(document.createTextNode(item.text));
      legend.appendChild(i);
    });

    const text = el('p', 'kvd-text');
    text.setAttribute('aria-live', 'polite');

    const controls = el('div', 'kvd-controls');
    const prev = el('button', 'kvd-btn', '上一步');
    const counter = el('span', 'kvd-counter');
    const next = el('button', 'kvd-btn kvd-primary', '下一步');
    const play = el('button', 'kvd-btn', '自动播放');
    const reset = el('button', 'kvd-btn', '从头开始');
    const speeds = [1, 2, 0.5];
    let speedIdx = 0;
    const speed = el('button', 'kvd-btn kvd-speed', '速度 1×');
    speed.setAttribute('aria-label', '切换自动播放速度，当前 1×');
    [prev, next, play, reset, speed].forEach((b) => { b.type = 'button'; });
    controls.append(prev, counter, next, play, reset, speed);

    grids.forEach((g) => stage.append(g.label, g.grid));
    stage.append(legend, queues, text, controls);
    const fallback = root.querySelector('.kv-demo-fallback');
    if (fallback) fallback.hidden = true;
    root.insertBefore(stage, src);
    root.classList.add('kvd-ready');

    let cur = 0;
    let timer = null;
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

    function render(idx) {
      const s = steps[idx];
      grids.forEach(({ spec, n, label, cells }) => {
        const labels = s.grid_labels || {};
        if (multi) label.textContent = (labels[spec.key] || spec.label || '').replace('{n}', n);
        const before = idx > 0 ? steps[idx - 1][spec.key] : null;
        (s[spec.key] || []).forEach((raw, i) => {
          const b = parse(raw);
          const c = cells[i];
          if (!c) return;
          c.className = `kvd-cell kvd-${b.kind}`;
          if (b.req) c.dataset.req = b.req; else delete c.dataset.req;
          c.querySelector('.kvd-tag').textContent = b.label;
          const mark = b.mark ? (marks[b.mark] != null ? marks[b.mark] : b.mark) : '';
          c.querySelector('.kvd-mark').textContent = mark;
          if (b.mark === 'hit' || b.mark === 're') c.classList.add(`kvd-${b.mark}`);
          const changed = before && before[i] !== raw;
          if (changed && !reduce) {
            c.classList.remove('kvd-changed');
            void c.offsetWidth;
            c.classList.add('kvd-changed');
          } else if (changed) {
            c.classList.add('kvd-changed-static');
          }
          let state;
          if (cfg.aria === 'label') state = `${b.label || '空'}${mark ? '，' + mark : ''}`;
          else state = b.kind === 'empty' ? '空闲' : b.kind === 'cached' ? `空闲，可命中的 ${b.label}${mark ? '，' + mark : ''}` : `${b.label}${mark ? '，' + mark : ''}`;
          const where = multi ? `${spec.aria_name || spec.key} 第 ${i} 格` : `block ${i}`;
          c.setAttribute('aria-label', cfg.aria === 'label' ? state : `${where}：${state}`);
        });
      });
      rows.forEach(({ spec, r, box }) => {
        const v = s[spec.key];
        if (spec.optional && v == null) { r.hidden = true; return; }
        r.hidden = false;
        chips(box, v);
      });
      text.textContent = s.text;
      counter.textContent = `${idx + 1} / ${steps.length}`;
      prev.disabled = idx === 0;
      next.disabled = idx === steps.length - 1;
    }

    const interval = () => 2000 / speeds[speedIdx];
    const tick = () => {
      if (cur >= steps.length - 1) { stop(); return; }
      go(cur + 1);
    };
    function stop() {
      if (timer) { clearInterval(timer); timer = null; }
      play.textContent = '自动播放';
      play.setAttribute('aria-pressed', 'false');
    }
    function go(idx) { cur = Math.max(0, Math.min(steps.length - 1, idx)); render(cur); }

    prev.addEventListener('click', () => { stop(); go(cur - 1); });
    next.addEventListener('click', () => { stop(); go(cur + 1); });
    reset.addEventListener('click', () => { stop(); go(0); });
    play.addEventListener('click', () => {
      if (timer) { stop(); return; }
      if (cur === steps.length - 1) go(0);
      play.textContent = '暂停';
      play.setAttribute('aria-pressed', 'true');
      timer = setInterval(tick, interval());
    });
    speed.addEventListener('click', () => {
      speedIdx = (speedIdx + 1) % speeds.length;
      const v = speeds[speedIdx];
      speed.textContent = `速度 ${v}×`;
      speed.setAttribute('aria-label', `切换自动播放速度，当前 ${v}×`);
      root.style.setProperty('--kvd-dur', `${0.35 / v}s`);
      if (timer) { clearInterval(timer); timer = setInterval(tick, interval()); }
    });

    go(0);
  }

  const run = () => document.querySelectorAll('.kv-demo').forEach(init);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
