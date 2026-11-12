(() => {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const parse = (s) => {
    if (s === '.') return { label: '', mark: 'empty' };
    const [label, mark] = s.split(':');
    return { label, mark: mark || 'has' };
  };

  function init(root) {
    const src = root.querySelector('.fwd-demo-data');
    if (!src) return;
    let demo;
    try { demo = JSON.parse(src.textContent); } catch (e) { return; }
    const steps = demo.steps || [];
    if (!steps.length) return;

    const stage = el('div', 'kvd-stage');
    const kind = el('div', 'fwd-kind');
    const body = el('div', 'fwd-body');

    const stageList = el('ol', 'fwd-stages');
    const stageItems = demo.stages.map((name) => {
      const li = el('li', 'fwd-stage', name);
      stageList.appendChild(li);
      return li;
    });

    const side = el('div', 'fwd-side');
    const tokLabel = el('div', 'kvd-label', '这一步喂进模型的 token');
    const toks = el('div', 'fwd-tokens');

    const kvLabel = el('div', 'kvd-label', 'KV Cache');
    const kv = el('div', 'fwd-kv');
    const width = steps[0].kv[0].length;
    const kvCells = demo.kv_layers.map((name) => {
      const r = el('div', 'fwd-kv-row');
      r.appendChild(el('span', 'fwd-kv-name', name));
      const cells = [];
      for (let i = 0; i < width; i++) {
        const c = el('span', 'fwd-cell');
        r.appendChild(c);
        cells.push(c);
      }
      kv.appendChild(r);
      return cells;
    });
    const legend = el('div', 'kvd-legend');
    [['w', '这一步写入'], ['r', '这一步读出'], ['has', '已有']].forEach(([k, t]) => {
      const i = el('span', 'kvd-legend-item');
      i.appendChild(el('span', `fwd-swatch fwd-${k}`));
      i.appendChild(document.createTextNode(t));
      legend.appendChild(i);
    });

    const total = demo.weights_total;
    const wLabel = el('div', 'kvd-label', '这一步读过的权重');
    const meter = el('div', 'fwd-meter');
    const bars = [];
    for (let i = 0; i < total; i++) { const b = el('span', 'fwd-bar'); meter.appendChild(b); bars.push(b); }
    const wText = el('span', 'fwd-meter-text');
    meter.appendChild(wText);

    side.append(tokLabel, toks, kvLabel, kv, legend, wLabel, meter);
    body.append(stageList, side);

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

    stage.append(kind, body, text, controls);
    const fallback = root.querySelector('.kv-demo-fallback');
    if (fallback) fallback.hidden = true;
    root.insertBefore(stage, src);
    root.classList.add('kvd-ready');

    let cur = 0;
    let timer = null;
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const flash = (n) => {
      if (reduce) { n.classList.add('kvd-changed-static'); return; }
      n.classList.remove('kvd-changed');
      void n.offsetWidth;
      n.classList.add('kvd-changed');
    };

    function render(idx) {
      const s = steps[idx];
      const before = idx > 0 ? steps[idx - 1] : null;
      kind.textContent = s.kind === 'prefill' ? 'prefill 一步：喂整段 prompt' : 'decode 一步：只喂 1 个新 token';
      kind.dataset.kind = s.kind;

      stageItems.forEach((li, i) => {
        const on = s.stage.includes(i);
        li.classList.toggle('fwd-on', on);
        if (on) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
      });

      toks.textContent = '';
      s.tokens.forEach((t) => toks.appendChild(el('span', 'fwd-tok', t)));
      if (s.out) {
        toks.appendChild(el('span', 'fwd-arrow', '→ 采样得到'));
        const o = el('span', 'fwd-tok fwd-out', s.out);
        toks.appendChild(o);
        flash(o);
      }

      s.kv.forEach((rowData, li) => {
        rowData.forEach((raw, i) => {
          const b = parse(raw);
          const c = kvCells[li][i];
          c.className = `fwd-cell fwd-${b.mark}`;
          c.textContent = b.label;
          const state = b.mark === 'empty' ? '空' : b.mark === 'w' ? `${b.label}，这一步写入` : b.mark === 'r' ? `${b.label}，这一步读出` : b.label;
          c.setAttribute('aria-label', `${demo.kv_layers[li]}位置 ${i}：${state}`);
          if (before && before.kv[li][i] !== raw && (b.mark === 'w' || b.mark === 'r')) flash(c);
        });
      });

      bars.forEach((b, i) => {
        const on = i < s.weights;
        b.classList.remove('kvd-changed', 'kvd-changed-static');
        b.classList.toggle('fwd-bar-on', on);
        if (on && before && before.kind === s.kind && i >= before.weights) flash(b);
      });
      wText.textContent = `${s.weights} / ${total} 份`;
      meter.setAttribute('aria-label', `这一步读过的权重：${s.weights} / ${total} 份`);

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

  const run = () => document.querySelectorAll('.fwd-demo').forEach(init);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
