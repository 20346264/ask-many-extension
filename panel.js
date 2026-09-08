/*
 * 面板：并排嵌入各家 AI，向每个 iframe 派发指令，收集回答后拼对比 prompt。
 *
 * 通信路径：panel → background(relay, 按 frameId) → 目标 iframe 里的 content script。
 * 不能用 postMessage 直接跟 iframe 说话 —— 跨源，拿不到里面的 window 也收不到回应。
 */

const A = globalThis.AskManyAdapters;
const $ = (s) => document.querySelector(s);
const el = (t, p = {}) => Object.assign(document.createElement(t), p);

const STORE_KEY = 'askmany:enabled';
const STORE_ORDER_KEY = 'askmany:order';
const STORE_LAYOUT_KEY = 'askmany:layout';
const STORE_JUDGE_KEY = 'askmany:judge';
const STORE_AUTO_JUDGE_KEY = 'askmany:auto_judge';
const state = {
  enabled: new Set(),
  order: [], // siteId[] 自定义排序数组
  frames: new Map(), // siteId -> {tabId, frameId}
  busy: false,
  attachments: [], // {name, type, size, data(base64), url(预览用)}
  layout: 'grid', // 'grid' | 'scroll' | 'col-2' | 'col-3'
  collapsed: new Set(), // siteId[]
  maximized: null, // siteId | null
  judgeId: null, // siteId 担任对比裁判，不参与同问，作答完毕后接收提示词
  autoJudge: true, // 其他模型完成后自动派发给裁判
  judgePrompt: '', // 最近一次生成的对比提示词
};

/*
 * 附件走 base64 经 sendMessage 传给 content script（File 对象无法序列化）。
 * base64 比原文件大约 1.33 倍，单文件设上限避免消息通道被撑爆。
 */
const MAX_FILE_MB = 20;
const MAX_TOTAL_MB = 40;
const mb = (n) => n / 1024 / 1024;

const fmtSize = (n) =>
  n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)}KB` : `${mb(n).toFixed(1)}MB`;

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
    fr.onload = () => {
      // dataURL 形如 data:<mime>;base64,xxxx —— 只要逗号后面那段
      const s = String(fr.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    fr.readAsDataURL(file);
  });
}

async function addFiles(fileList) {
  const incoming = [...fileList];
  if (!incoming.length) return;

  const errs = [];
  let total = state.attachments.reduce((s, a) => s + a.size, 0);

  for (const f of incoming) {
    if (mb(f.size) > MAX_FILE_MB) {
      errs.push(`${f.name} 超过 ${MAX_FILE_MB}MB`);
      continue;
    }
    if (mb(total + f.size) > MAX_TOTAL_MB) {
      errs.push(`总大小超过 ${MAX_TOTAL_MB}MB，${f.name} 未添加`);
      continue;
    }
    try {
      const data = await readAsBase64(f);
      state.attachments.push({
        name: f.name,
        type: f.type,
        size: f.size,
        data,
        url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
      });
      total += f.size;
    } catch (e) {
      errs.push(e.message);
    }
  }

  renderChips();
  $('#fileHint').textContent = errs.length ? errs.join('；') : '';
}

function removeAttachment(i) {
  const a = state.attachments[i];
  if (a?.url) URL.revokeObjectURL(a.url); // 不撤销会一直占着内存
  state.attachments.splice(i, 1);
  renderChips();
}

function clearAttachments() {
  for (const a of state.attachments) if (a.url) URL.revokeObjectURL(a.url);
  state.attachments = [];
  renderChips();
  $('#fileHint').textContent = '';
}

function renderChips() {
  const box = $('#chips');
  box.textContent = '';
  state.attachments.forEach((a, i) => {
    const chip = el('div', { className: 'chip', title: `${a.name} (${fmtSize(a.size)})` });
    if (a.url) chip.append(el('img', { src: a.url, alt: a.name }));
    else chip.append(el('span', { className: 'ficon', textContent: '📄' }));
    chip.append(
      el('span', { className: 'fname', textContent: a.name }),
      el('span', { className: 'fsize', textContent: fmtSize(a.size) })
    );
    const del = el('button', { className: 'del', textContent: '×', title: '移除' });
    del.onclick = () => removeAttachment(i);
    chip.append(del);
    box.append(chip);
  });

  // 有附件时提示哪些模型不支持，避免用户以为发过去了
  const unsupported = state.order
    .filter((id) => state.enabled.has(id))
    .map((id) => A.byId(id))
    .filter((s) => s && !s.supportsFiles)
    .map((s) => s.name);
  if (state.attachments.length && unsupported.length) {
    $('#fileHint').textContent = `${unsupported.join('、')} 不支持附件，将只发文字`;
  }
}

// ------------------------------------------------------------------ frame 发现
// content script 启动时会发 frame-ready；面板据此知道每个站点落在哪个 frameId。
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'frame-ready' && sender.tab && sender.frameId != null) {
    state.frames.set(msg.siteId, { tabId: sender.tab.id, frameId: sender.frameId });
    paintDots();
  }
});

function send(siteId, payload, timeoutMs = 200000) {
  const f = state.frames.get(siteId);
  if (!f) return Promise.resolve({ ok: false, error: 'frame 未就绪' });
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: '超时' }), timeoutMs);
    chrome.runtime.sendMessage(
      { type: 'relay', tabId: f.tabId, frameId: f.frameId, payload: { ...payload, siteId } },
      (res) => {
        clearTimeout(timer);
        resolve(res ?? { ok: false, error: chrome.runtime.lastError?.message ?? '无响应' });
      }
    );
  });
}

// --------------------------------------------------------------------- 排序与持久化
async function saveOrder() {
  await chrome.storage.local.set({ [STORE_ORDER_KEY]: state.order });
}

function applyOrder() {
  // 1. 设置侧栏项和列的 CSS order
  state.order.forEach((id, idx) => {
    const item = document.getElementById(`item-${id}`);
    if (item) item.style.order = String(idx);
    const col = document.getElementById(`col-${id}`);
    if (col) col.style.order = String(idx);
  });

  // 2. 根据当前启用（可见）的列更新左移/右移按钮的禁用状态
  const visible = state.order.filter((id) => state.enabled.has(id));
  visible.forEach((id, idx) => {
    const leftBtn = document.getElementById(`btn-left-${id}`);
    const rightBtn = document.getElementById(`btn-right-${id}`);
    if (leftBtn) leftBtn.disabled = (idx === 0);
    if (rightBtn) rightBtn.disabled = (idx === visible.length - 1);
  });
}

async function moveModel(siteId, delta) {
  const visible = state.order.filter((id) => state.enabled.has(id));
  const currIdx = visible.indexOf(siteId);
  if (currIdx === -1) return;
  const targetIdx = currIdx + delta;
  if (targetIdx < 0 || targetIdx >= visible.length) return;

  const targetId = visible[targetIdx];
  const idxA = state.order.indexOf(siteId);
  const idxB = state.order.indexOf(targetId);
  if (idxA === -1 || idxB === -1) return;

  // 交换顺序
  const temp = state.order[idxA];
  state.order[idxA] = state.order[idxB];
  state.order[idxB] = temp;

  await saveOrder();
  applyOrder();
}

// --------------------------------------------------------------------- 渲染
function paintDots() {
  for (const a of A.ADAPTERS) {
    const dot = document.getElementById(`dot-${a.id}`);
    if (!dot) continue;
    const on = state.enabled.has(a.id);
    const ready = state.frames.has(a.id);
    dot.className = 'dot' + (on ? (ready ? ' live' : ' warn') : '');
    dot.title = !on ? '未启用' : ready ? '已就绪' : '加载中或被拦截';
  }
}

const SITE_THEMES = {
  chatgpt: { color: '#10a37f', badge: 'GPT' },
  deepseek: { color: '#4d6bfe', badge: 'DS' },
  claude: { color: '#d97706', badge: 'CL' },
  gemini: { color: '#8b5cf6', badge: 'GEM' },
  qwen: { color: '#6366f1', badge: 'QW' },
  yuanbao: { color: '#f97316', badge: 'YB' },
  kimi: { color: '#00a3ff', badge: 'KM' },
  doubao: { color: '#2563eb', badge: 'DB' },
  chatglm: { color: '#4f46e5', badge: 'GLM' },
  grok: { color: '#111827', badge: 'GROK' },
  perplexity: { color: '#22b8cf', badge: 'PPLX' },
  mimo: { color: '#ff6900', badge: 'MIMO' },
};

let draggedId = null;

function buildHeader() {
  const box = $('#sites');
  box.textContent = '';
  for (const a of A.ADAPTERS) {
    const item = el('div', { className: 'model-item', id: `item-${a.id}` });
    item.draggable = true;

    const handle = el('span', { className: 'drag-handle', textContent: '⋮⋮', title: '按住拖拽排序' });

    const cb = el('input', { type: 'checkbox', id: `chk-${a.id}` });
    cb.checked = state.enabled.has(a.id);
    if (cb.checked) item.classList.add('active');

    cb.onchange = () => {
      if (cb.checked) {
        state.enabled.add(a.id);
        item.classList.add('active');
      } else {
        state.enabled.delete(a.id);
        item.classList.remove('active');
        if (state.judgeId === a.id) {
          setJudge(null);
        }
      }
      chrome.storage.local.set({ [STORE_KEY]: [...state.enabled] });
      buildCols();
      updateCount();
      populateJudgeSelect();
    };

    const theme = SITE_THEMES[a.id] || { color: '#64748b', badge: a.name.slice(0, 2).toUpperCase() };
    const badge = el('span', {
      className: 'model-badge',
      textContent: theme.badge,
      style: `background: ${theme.color}22; color: ${theme.color}; border: 1px solid ${theme.color}44;`,
    });

    const isJudge = state.judgeId === a.id;
    if (isJudge) item.classList.add('is-judge');

    const judgeCrownBtn = el('button', {
      className: 'judge-crown-btn' + (isJudge ? ' active' : ''),
      id: `crown-${a.id}`,
      title: isJudge ? '取消设为裁判' : '设为对比裁判（不参与同问，作答完毕后自动接收对比提示词）',
      textContent: '👑',
    });
    judgeCrownBtn.onclick = (e) => {
      e.stopPropagation();
      if (!state.enabled.has(a.id)) {
        state.enabled.add(a.id);
        cb.checked = true;
        item.classList.add('active');
        chrome.storage.local.set({ [STORE_KEY]: [...state.enabled] });
        buildCols();
        updateCount();
      }
      setJudge(state.judgeId === a.id ? null : a.id);
    };

    const lab = el('label', { htmlFor: `chk-${a.id}`, className: 'model-name', textContent: a.name });
    const dot = el('span', { className: 'model-dot', id: `dot-${a.id}` });

    item.addEventListener('dragstart', (e) => {
      draggedId = a.id;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', a.id);
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      draggedId = null;
      document.querySelectorAll('.model-item').forEach((el) => el.classList.remove('drag-over'));
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (draggedId && draggedId !== a.id) {
        item.classList.add('drag-over');
      }
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over');
    });

    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      if (!draggedId || draggedId === a.id) return;

      const fromIdx = state.order.indexOf(draggedId);
      const toIdx = state.order.indexOf(a.id);
      if (fromIdx === -1 || toIdx === -1) return;

      state.order.splice(fromIdx, 1);
      state.order.splice(toIdx, 0, draggedId);

      await saveOrder();
      applyOrder();
    });

    item.append(handle, cb, badge, lab, judgeCrownBtn, dot);
    box.append(item);
  }
}

function buildCols() {
  const main = $('#cols');

  // 已存在的列保留，避免重建 iframe 把会话刷掉。
  for (const a of A.ADAPTERS) {
    const existing = document.getElementById(`col-${a.id}`);
    const on = state.enabled.has(a.id);
    if (on && !existing) {
      main.append(makeCol(a));
    } else if (!on && existing) {
      existing.remove();
      state.frames.delete(a.id);
      if (state.maximized === a.id) state.maximized = null;
      state.collapsed.delete(a.id);
      if (state.judgeId === a.id) setJudge(null);
    }
  }
  paintDots();
  applyOrder();
  updateCount();
  populateJudgeSelect();
}

function updateCount() {
  const countEl = $('#enabledCount');
  if (countEl) {
    countEl.textContent = `已选 ${state.enabled.size} / ${A.ADAPTERS.length} 个模型`;
  }
}

// --------------------------------------------------------------------- 裁判模型管理
function setJudge(siteId) {
  state.judgeId = siteId || null;
  chrome.storage.local.set({ [STORE_JUDGE_KEY]: state.judgeId });

  // 1. 同步更新下拉框
  const judgeSel = $('#judgeSelect');
  if (judgeSel && judgeSel.value !== (state.judgeId || '')) {
    judgeSel.value = state.judgeId || '';
  }

  // 2. 同步侧边栏皇冠状态
  for (const a of A.ADAPTERS) {
    const item = document.getElementById(`item-${a.id}`);
    const crown = document.getElementById(`crown-${a.id}`);
    const isThis = state.judgeId === a.id;
    if (item) item.classList.toggle('is-judge', isThis);
    if (crown) {
      crown.classList.toggle('active', isThis);
      crown.title = isThis ? '取消设为裁判' : '设为对比裁判（不参与同问，作答完毕后自动接收对比提示词）';
    }
  }

  // 3. 同步列头裁判徽章与按钮
  for (const a of A.ADAPTERS) {
    const col = document.getElementById(`col-${a.id}`);
    const judgeTag = document.getElementById(`judge-badge-${a.id}`);
    const judgeBtn = document.getElementById(`btn-judge-${a.id}`);
    const meta = document.getElementById(`meta-${a.id}`);
    const isThis = state.judgeId === a.id;
    if (col) {
      col.classList.toggle('is-judge', isThis);
      if (judgeTag) judgeTag.style.display = isThis ? 'inline-flex' : 'none';
      if (judgeBtn) {
        judgeBtn.classList.toggle('active', isThis);
        judgeBtn.title = isThis ? '取消设为裁判' : '设为对比裁判';
      }
      if (isThis) {
        const curMeta = meta?.textContent || '';
        if (!curMeta || curMeta === '已发送' || curMeta.includes('✓')) {
          setMeta(a.id, '👑 对比裁判就位');
        }
      } else {
        const curMeta = meta?.textContent || '';
        if (curMeta.startsWith('👑')) {
          setMeta(a.id, '');
        }
      }
    }
  }

  updateDlgJudgeButton();
}

function populateJudgeSelect() {
  const sel = $('#judgeSelect');
  if (!sel) return;
  const current = state.judgeId;
  sel.innerHTML = '<option value="">(不设裁判，全员作答)</option>';

  const enabledList = state.order.filter((id) => state.enabled.has(id));
  enabledList.forEach((id) => {
    const a = A.byId(id);
    if (a) {
      const opt = el('option', { value: id, textContent: a.name });
      sel.append(opt);
    }
  });

  if (current && enabledList.includes(current)) {
    sel.value = current;
  } else if (current) {
    setJudge(null);
  }
}

function updateDlgJudgeButton() {
  const btn = $('#dlgSendJudge');
  if (!btn) return;
  if (state.judgeId && A.byId(state.judgeId)) {
    const name = A.byId(state.judgeId).name;
    btn.innerHTML = `<span>👑 派发给 [${name}] 对比分析</span>`;
    btn.style.display = 'inline-flex';
    btn.onclick = () => {
      $('#dlg').close();
      if (state.judgePrompt) {
        dispatchToJudge(state.judgeId, state.judgePrompt);
      }
    };
  } else {
    btn.style.display = 'none';
  }
}

function toggleMaximize(id) {
  const col = document.getElementById(`col-${id}`);
  const btn = document.getElementById(`btn-max-${id}`);
  if (state.maximized === id) {
    state.maximized = null;
    col?.classList.remove('maximized');
    if (btn) {
      btn.textContent = '⛶';
      btn.title = '全屏聚焦';
    }
  } else {
    if (state.maximized) {
      const prevCol = document.getElementById(`col-${state.maximized}`);
      const prevBtn = document.getElementById(`btn-max-${state.maximized}`);
      prevCol?.classList.remove('maximized');
      if (prevBtn) {
        prevBtn.textContent = '⛶';
        prevBtn.title = '全屏聚焦';
      }
    }
    if (state.collapsed.has(id)) {
      state.collapsed.delete(id);
      col?.classList.remove('collapsed');
    }
    state.maximized = id;
    col?.classList.add('maximized');
    if (btn) {
      btn.textContent = '↙';
      btn.title = '还原视图';
    }
  }
}

function toggleCollapse(id) {
  const col = document.getElementById(`col-${id}`);
  if (!col) return;
  if (state.maximized === id) {
    toggleMaximize(id);
  }
  if (state.collapsed.has(id)) {
    state.collapsed.delete(id);
    col.classList.remove('collapsed');
  } else {
    state.collapsed.add(id);
    col.classList.add('collapsed');
  }
}

function setLayoutMode(mode) {
  const validModes = ['grid', 'scroll', 'col-2', 'col-3'];
  if (!validModes.includes(mode)) mode = 'grid';
  state.layout = mode;

  const main = $('#cols');
  if (main) {
    validModes.forEach((m) => main.classList.remove(`mode-${m}`));
    main.classList.add(`mode-${mode}`);
  }

  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  const scrollNav = $('#scrollNav');
  if (scrollNav) {
    scrollNav.classList.toggle('visible', mode === 'scroll');
  }

  chrome.storage.local.set({ [STORE_LAYOUT_KEY]: mode });
}

async function setEnabledModels(newSet) {
  state.enabled = new Set(newSet);
  if (state.judgeId && !state.enabled.has(state.judgeId)) {
    setJudge(null);
  }
  for (const a of A.ADAPTERS) {
    const cb = document.getElementById(`chk-${a.id}`);
    const item = document.getElementById(`item-${a.id}`);
    if (cb) cb.checked = state.enabled.has(a.id);
    if (item) {
      if (state.enabled.has(a.id)) item.classList.add('active');
      else item.classList.remove('active');
    }
  }
  await chrome.storage.local.set({ [STORE_KEY]: [...state.enabled] });
  buildCols();
}

function selectAllModels() {
  setEnabledModels(A.ADAPTERS.map((a) => a.id));
}

function clearAllModels() {
  setEnabledModels([]);
}

const PRESET_DOMESTIC = ['deepseek', 'yuanbao', 'kimi', 'doubao', 'qwen', 'mimo', 'chatglm'];
const PRESET_GLOBAL = ['chatgpt', 'claude', 'gemini', 'grok', 'perplexity'];

function applyPreset(presetIds) {
  const valid = presetIds.filter((id) => A.byId(id));
  setEnabledModels(valid);
}

function makeCol(a) {
  const isJudge = state.judgeId === a.id;
  const col = el('div', { className: 'col' + (isJudge ? ' is-judge' : ''), id: `col-${a.id}` });
  if (state.maximized === a.id) col.classList.add('maximized');
  if (state.collapsed.has(a.id)) col.classList.add('collapsed');

  const h = el('h2');
  const theme = SITE_THEMES[a.id] || { color: '#64748b', badge: a.name.slice(0, 2).toUpperCase() };

  const brandDot = el('span', {
    className: 'col-brand-dot',
    style: `background: ${theme.color}; box-shadow: 0 0 8px ${theme.color}88;`,
  });
  const nameSpan = el('span', { className: 'name', textContent: a.name });
  const judgeBadge = el('span', {
    className: 'col-judge-badge',
    id: `judge-badge-${a.id}`,
    textContent: '👑 裁判',
    style: isJudge ? 'display: inline-flex;' : 'display: none;',
  });
  const metaSpan = el('span', { className: 'meta', id: `meta-${a.id}` });

  const actions = el('div', { className: 'col-actions' });
  const leftBtn = el('button', {
    className: 'col-btn',
    id: `btn-left-${a.id}`,
    title: '向左移动',
    textContent: '◀',
  });
  leftBtn.onclick = (e) => { e.stopPropagation(); moveModel(a.id, -1); };

  const rightBtn = el('button', {
    className: 'col-btn',
    id: `btn-right-${a.id}`,
    title: '向右移动',
    textContent: '▶',
  });
  rightBtn.onclick = (e) => { e.stopPropagation(); moveModel(a.id, 1); };

  const judgeBtn = el('button', {
    className: 'col-btn btn-judge' + (isJudge ? ' active' : ''),
    id: `btn-judge-${a.id}`,
    title: isJudge ? '取消设为裁判' : '设为对比裁判（不参与同问，作答完毕后自动接收对比提示词）',
    textContent: '👑',
  });
  judgeBtn.onclick = (e) => { e.stopPropagation(); setJudge(state.judgeId === a.id ? null : a.id); };

  const maxBtn = el('button', {
    className: 'col-btn',
    id: `btn-max-${a.id}`,
    title: state.maximized === a.id ? '还原视图' : '全屏聚焦',
    textContent: state.maximized === a.id ? '↙' : '⛶',
  });
  maxBtn.onclick = (e) => { e.stopPropagation(); toggleMaximize(a.id); };

  const colBtn = el('button', {
    className: 'col-btn',
    id: `btn-col-${a.id}`,
    title: '折叠',
    textContent: '−',
  });
  colBtn.onclick = (e) => { e.stopPropagation(); toggleCollapse(a.id); };

  actions.append(leftBtn, rightBtn, judgeBtn, maxBtn, colBtn);
  h.append(brandDot, nameSpan, judgeBadge, metaSpan, actions);

  // 折叠时点击标题栏展开
  h.onclick = () => {
    if (state.collapsed.has(a.id)) {
      toggleCollapse(a.id);
    }
  };

  const frame = el('iframe', { src: a.url, id: `if-${a.id}` });

  const fb = el('div', { className: 'fallback' });
  fb.append(
    el('div', { textContent: `${a.name} 未能嵌入。` }),
    el('div', { textContent: '可能是未登录、需要人机验证，或该站点新增了嵌套限制。' }),
    (() => { const link = el('a', { textContent: '在新标签页打开 →', href: a.url });
             link.target = '_blank'; return link; })()
  );

  col.append(h, frame, fb);

  // iframe 被网络层拦掉时不会触发 error，只能靠"迟迟没有 frame-ready"判断。
  setTimeout(() => {
    if (!state.frames.has(a.id)) col.classList.add('blocked');
  }, 12000);

  return col;
}

const setMeta = (siteId, text) => {
  const m = document.getElementById(`meta-${siteId}`);
  if (m) m.textContent = text;
};

// --------------------------------------------------------------------- 动作
let lastQuestion = '';
let activeSynthesisToken = 0;

async function ask() {
  const text = $('#q').value.replace(/\r\n/g, '\n').trim();
  const files = state.attachments;
  // 只有附件没有文字也允许发（发图问"这是什么"是常见用法）
  if ((!text && !files.length) || state.busy) return;
  const targets = state.order.filter((id) => state.enabled.has(id));
  if (!targets.length) { $('#status').textContent = '先勾选至少一个模型'; return; }

  // 裁判模型排除在第一阶段同问之外
  const judgeId = state.judgeId && state.enabled.has(state.judgeId) ? state.judgeId : null;
  const askTargets = judgeId ? targets.filter((id) => id !== judgeId) : targets;

  if (judgeId && !askTargets.length) {
    $('#status').textContent = '已设置裁判模型，但没有其他作答模型，请勾选其他模型';
    return;
  }

  state.busy = true;
  $('#go').disabled = true;
  lastQuestion = text;

  const judgeName = judgeId && A.byId(judgeId) ? A.byId(judgeId).name : '';
  const judgeSuffix = judgeId ? `（👑 ${judgeName} 候审中）` : '';
  $('#status').textContent = files.length
    ? `发送到 ${askTargets.length} 个模型${judgeSuffix}（含 ${files.length} 个附件，上传可能较慢）…`
    : `发送到 ${askTargets.length} 个模型${judgeSuffix}…`;

  askTargets.forEach((id) => setMeta(id, files.length ? '上传中' : '发送中'));
  if (judgeId) {
    setMeta(judgeId, `👑 裁判就位 (等待 ${askTargets.length} 家模型作答…)`);
  }

  const autoSend = $('#autosend').checked;

  // 附件只发给支持的站点；不支持的照常发文字，避免整条消息卡住
  const payloadFiles = files.map(({ name, type, data }) => ({ name, type, data }));
  const filesFor = (id) => (A.byId(id)?.supportsFiles ? payloadFiles : []);

  /*
   * 上传等待要短。之前给 150 秒，结果站点已经收下图了但缩略图选择器认不出，
   * 就白等满两分半 —— 卡住不发比附件没跟上糟得多。25 秒足够本地文件进预览，
   * 而按钮型站点还有 waitSendable 兜着（上传中发送键是 disabled 的）。
   */
  const uploadMs = files.length ? 25000 : 0;
  const prepareTimeout = files.length ? 45000 : 20000;

  /*
   * 注入后确认站点收下附件的窗口。必须显式给，否则 attachFiles 用它自己的
   * 默认值，两条注入路径合起来能白等好几秒，界面就一直停在"上传中"。
   */
  const verifyMs = files.length ? 2500 : 0;

  /*
   * 两阶段派发，这样各站点是真的"同时"提交：
   *   1. prepare 并发下发 —— 各站点填入文本并等自己的发送按钮就绪。
   *      这一步耗时因站点而异（ChatGPT 的按钮几乎立刻可用，有些站点要等上一两秒）。
   *   2. 全部就绪后再并发 fire —— 提交环节不含任何等待，各家几乎在同一瞬间发出。
   */
  const prepared = await Promise.all(
    askTargets.map((id) =>
      send(id, { type: 'prepare', text, files: filesFor(id), armMs: 2500, uploadMs, verifyMs },
           prepareTimeout)
        .then((r) => {
          const p = { id, ...r };
          if (!p.ok) setMeta(p.id, `失败: ${p.error}`);
          else {
            const base = autoSend ? '待发送' : '已填入';
            setMeta(p.id, p.fileError ? `${base}（附件: ${p.fileError}）`
                                      : p.attached ? `${base}（${p.attached} 附件）` : base);
          }
          return p;
        }))
  );

  const ready = prepared.filter((p) => p.ok).map((p) => p.id);
  if (!autoSend) {
    $('#status').textContent = `${ready.length}/${askTargets.length} 已填入（未自动发送，请在各栏手动发）`;
    state.busy = false;
    $('#go').disabled = false;
    return;
  }

  const fired = await Promise.all(
    ready.map((id) => send(id, { type: 'fire' }, 15000).then((r) => ({ id, ...r })))
  );

  for (const f of fired) setMeta(f.id, f.ok ? '已发送' : `发送失败: ${f.error}`);
  const good = fired.filter((f) => f.ok).length;
  const failed = prepared.filter((p) => !p.ok).length;
  $('#status').textContent =
    `${good}/${askTargets.length} 已发送` + (failed ? `，${failed} 个填入失败` : '') + judgeSuffix;

  // 发送成功后清空输入框和附件，并重新聚焦（fillInput 会让 iframe 获得焦点）
  if (good > 0) {
    const q = $('#q');
    q.value = '';
    clearAttachments();
    q.focus();

    // 如果开启了裁判与自动派发，启动后台监控并在作答完毕后自动派发给裁判
    if (judgeId && state.autoJudge) {
      monitorAndSynthesize(ready, judgeId, text);
    }
  }

  state.busy = false;
  $('#go').disabled = false;
}

// --------------------------------------------------------------------- 裁判派发与监控
async function dispatchToJudge(judgeId, prompt) {
  if (!judgeId || !prompt) return;
  const judgeCol = document.getElementById(`col-${judgeId}`);
  if (judgeCol && state.collapsed.has(judgeId)) {
    toggleCollapse(judgeId);
  }
  const judgeAdapter = A.byId(judgeId);
  const judgeName = judgeAdapter ? judgeAdapter.name : judgeId;

  if (!state.frames.has(judgeId)) {
    setMeta(judgeId, '👑 裁判 frame 未就绪');
    $('#status').textContent = `裁判 [${judgeName}] 尚未就绪，无法派发`;
    return;
  }

  setMeta(judgeId, '👑 注入对比提示词…');
  $('#status').textContent = `正在将对比分析任务派发给裁判 [${judgeName}]…`;

  // 两阶段提交对比提示词到裁判窗口
  const prep = await send(judgeId, {
    type: 'prepare',
    text: prompt,
    files: [],
    armMs: 2500,
    uploadMs: 0,
    verifyMs: 0,
  }, 30000);

  if (!prep.ok) {
    setMeta(judgeId, `👑 派发失败: ${prep.error}`);
    $('#status').textContent = `派发给裁判 [${judgeName}] 失败: ${prep.error}`;
    return;
  }

  setMeta(judgeId, '👑 触发裁判作答…');
  const fired = await send(judgeId, { type: 'fire' }, 15000);
  if (!fired.ok) {
    setMeta(judgeId, `👑 提交失败: ${fired.error}`);
    $('#status').textContent = `裁判 [${judgeName}] 提交失败: ${fired.error}`;
    return;
  }

  setMeta(judgeId, '👑 裁判生成对比中…');
  $('#status').textContent = `👑 裁判 [${judgeName}] 正在分析各家回答并生成对比报告…`;

  // 轮询裁判生成进度
  let lastLen = 0;
  let stableCount = 0;
  const pollStart = Date.now();
  const maxPoll = 180000;

  const judgeTicker = setInterval(async () => {
    if (Date.now() - pollStart > maxPoll) {
      clearInterval(judgeTicker);
      setMeta(judgeId, '👑 裁判对比完成 (已达最大等待)');
      return;
    }
    const r = await send(judgeId, { type: 'peek' }, 4000);
    if (r.ok) {
      const curLen = r.length || 0;
      setMeta(judgeId, `👑 裁判分析中 (${curLen} 字)`);
      if (curLen > 60 && curLen === lastLen) {
        stableCount++;
        if (stableCount >= 2) {
          clearInterval(judgeTicker);
          setMeta(judgeId, `👑 对比完成 (${curLen} 字) ✓`);
          $('#status').textContent = `👑 裁判 [${judgeName}] 对比报告生成完毕！`;
        }
      } else {
        lastLen = curLen;
        stableCount = 0;
      }
    }
  }, 2500);
}

async function monitorAndSynthesize(participants, judgeId, question) {
  const token = ++activeSynthesisToken;
  const judgeAdapter = A.byId(judgeId);
  const judgeName = judgeAdapter ? judgeAdapter.name : judgeId;

  setMeta(judgeId, `👑 裁判就位 (等待 ${participants.length} 家模型作答…)`);

  const pollInterval = 2500;
  const maxWaitMs = 150000;
  const startTime = Date.now();
  const lastLens = new Map();
  const stableRounds = new Map();

  // 延迟 4 秒后再开始检查，给各模型初次响应留出时间
  await new Promise((resolve) => setTimeout(resolve, 4000));
  if (token !== activeSynthesisToken) return;

  const timer = setInterval(async () => {
    if (token !== activeSynthesisToken) {
      clearInterval(timer);
      return;
    }

    if (Date.now() - startTime > maxWaitMs) {
      clearInterval(timer);
      if (token === activeSynthesisToken) {
        triggerAutoSynthesis(participants, judgeId, question, token);
      }
      return;
    }

    let allStable = true;
    let anyAnswered = false;
    let answeredCount = 0;

    for (const id of participants) {
      const r = await send(id, { type: 'peek' }, 3000);
      if (r.ok) {
        const len = r.length || 0;
        if (len > 0) {
          anyAnswered = true;
          answeredCount++;
        }
        const prev = lastLens.get(id) ?? -1;
        if (len > 0 && len === prev) {
          const rounds = (stableRounds.get(id) || 0) + 1;
          stableRounds.set(id, rounds);
          if (rounds < 2) allStable = false;
        } else {
          lastLens.set(id, len);
          stableRounds.set(id, 0);
          allStable = false;
        }
      } else {
        // frame 无响应或异常，不卡死流程
        stableRounds.set(id, 99);
      }
    }

    if (answeredCount > 0) {
      setMeta(judgeId, `👑 裁判就位 (已作答: ${answeredCount}/${participants.length} 家)`);
    }

    // 至少有一家有文字输出，且所有有回答的模型均已稳定 2 轮（至少 5 秒不再增长）
    if (anyAnswered && allStable) {
      clearInterval(timer);
      if (token === activeSynthesisToken) {
        triggerAutoSynthesis(participants, judgeId, question, token);
      }
    }
  }, pollInterval);
}

async function triggerAutoSynthesis(participants, judgeId, question, token) {
  if (token && token !== activeSynthesisToken) return;
  const judgeAdapter = A.byId(judgeId);
  const judgeName = judgeAdapter ? judgeAdapter.name : judgeId;

  setMeta(judgeId, '👑 提取各模型作答…');
  const results = await Promise.all(
    participants.map((id) =>
      send(id, { type: 'collect', maxWait: 8000 }, 12000).then((r) => ({ id, ...r }))
    )
  );

  if (token && token !== activeSynthesisToken) return;

  const entries = results
    .filter((r) => r.ok && r.text)
    .map((r) => ({ name: r.name, text: r.text }));

  if (!entries.length) {
    setMeta(judgeId, '👑 未抓到有效回答');
    return;
  }

  const prompt = A.buildComparePrompt(question, entries);
  state.judgePrompt = prompt;
  updateDlgJudgeButton();

  // 更新对话框内容预备
  $('#dlgText').textContent = prompt;
  $('#dlgMeta').textContent = `${entries.length} 份回答 · ${prompt.length} 字`;

  await dispatchToJudge(judgeId, prompt);
}

// --------------------------------------------------------------------- 收集对比
async function collect() {
  if (state.busy) return;
  const judgeId = state.judgeId && state.enabled.has(state.judgeId) ? state.judgeId : null;
  // 收集时排除裁判模型自身
  const targets = state.order.filter(
    (id) => state.enabled.has(id) && state.frames.has(id) && id !== judgeId
  );
  if (!targets.length) {
    $('#status').textContent = judgeId ? '除裁判外没有就绪的模型' : '没有就绪的模型';
    return;
  }

  // 停止后台自动监控，用户主动触发了收集
  activeSynthesisToken++;

  state.busy = true;
  $('#collect').disabled = true;
  $('#status').textContent = '等待各模型生成完毕…';

  // 轮询各栏字数，让用户看到进度而不是干等。
  const ticker = setInterval(async () => {
    for (const id of targets) {
      const r = await send(id, { type: 'peek' }, 4000);
      if (r.ok) setMeta(id, `${r.length} 字`);
    }
  }, 1500);

  const results = await Promise.all(
    targets.map((id) =>
      send(id, { type: 'collect', maxWait: A.MAX_WAIT_MS }, A.MAX_WAIT_MS + 10000)
        .then((r) => ({ id, ...r })))
  );
  clearInterval(ticker);

  const entries = results
    .filter((r) => r.ok && r.text)
    .map((r) => ({ name: r.name, text: r.text }));
  for (const r of results) setMeta(r.id, r.ok && r.text ? `${r.text.length} 字 ✓` : '未抓到');

  if (!entries.length) {
    $('#status').textContent = '没抓到任何回答';
  } else {
    const prompt = A.buildComparePrompt(lastQuestion, entries);
    state.judgePrompt = prompt;
    $('#dlgText').textContent = prompt;
    $('#dlgMeta').textContent = `${entries.length} 份回答 · ${prompt.length} 字`;
    updateDlgJudgeButton();
    $('#dlg').showModal();
    $('#status').textContent = entries.length === 1
      ? '只抓到 1 份回答，其他模型可能未作答或选择器失效'
      : `已收集 ${entries.length} 份回答`;

    // 如果开启了自动评测，且裁判就绪，立即派发给裁判
    if (judgeId && state.autoJudge && state.frames.has(judgeId)) {
      dispatchToJudge(judgeId, prompt);
    }
  }

  state.busy = false;
  $('#collect').disabled = false;
}

// --------------------------------------------------------------------- 绑定
function insertNewline(ta) {
  // 优先 execCommand：它保留撤销历史，手动改 value 会把 Ctrl+Z 记录冲掉。
  if (!document.execCommand('insertText', false, '\n')) {
    const { selectionStart: s, selectionEnd: e, value } = ta;
    ta.value = value.slice(0, s) + '\n' + value.slice(e);
    ta.selectionStart = ta.selectionEnd = s + 1;
  }
  ta.scrollTop = ta.scrollHeight;
}

$('#go').onclick = ask;
$('#collect').onclick = collect;

// ---- 附件入口：按钮选择、粘贴截图、拖拽 ----
$('#pickFile').onclick = () => $('#fileInput').click();
$('#pickImage').onclick = () => $('#imageInput').click();

for (const id of ['#fileInput', '#imageInput']) {
  $(id).addEventListener('change', async (e) => {
    await addFiles(e.target.files);
    e.target.value = ''; // 清空才能重复选同一个文件
  });
}

// 粘贴截图是最常用的路径（Win+Shift+S 后直接 Ctrl+V）
$('#q').addEventListener('paste', async (e) => {
  const items = [...(e.clipboardData?.items ?? [])];
  const files = items.filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
  if (!files.length) return; // 纯文本粘贴走默认行为
  e.preventDefault();
  await addFiles(files);
});

// 拖拽到底部输入区
const dropZone = $('.input-wrapper');
for (const t of ['dragover', 'dragenter']) {
  dropZone.addEventListener(t, (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dropZone.classList.add('dragging');
  });
}
for (const t of ['dragleave', 'drop']) {
  dropZone.addEventListener(t, () => dropZone.classList.remove('dragging'));
}
dropZone.addEventListener('drop', async (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  await addFiles(e.dataTransfer.files);
});

$('#q').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;

  /*
   * 中文输入法选字时也会发出 Enter。此时 isComposing 为 true（部分环境只给
   * keyCode 229），必须放过，否则打一句中文中途就被发出去了。
   */
  if (e.isComposing || e.keyCode === 229) return;

  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    insertNewline(e.target);
    return;
  }
  if (e.shiftKey || e.altKey) return; // Shift+Enter 保留浏览器默认换行
  e.preventDefault();
  ask();
});
$('#dlgClose').onclick = () => $('#dlg').close();
$('#dlgCopy').onclick = async () => {
  await navigator.clipboard.writeText($('#dlgText').textContent);
  $('#dlgCopy').textContent = '已复制';
  setTimeout(() => ($('#dlgCopy').textContent = '复制到剪贴板'), 1500);
};

(async () => {
  const saved = await chrome.storage.local.get([
    STORE_KEY,
    STORE_ORDER_KEY,
    STORE_LAYOUT_KEY,
    STORE_JUDGE_KEY,
    STORE_AUTO_JUDGE_KEY,
  ]);
  const ids = saved[STORE_KEY];
  state.enabled = new Set(
    Array.isArray(ids) && ids.length ? ids : ['chatgpt', 'deepseek']
  );

  const savedOrder = saved[STORE_ORDER_KEY];
  const allIds = A.ADAPTERS.map((a) => a.id);
  if (Array.isArray(savedOrder) && savedOrder.length) {
    state.order = [
      ...savedOrder.filter((id) => allIds.includes(id)),
      ...allIds.filter((id) => !savedOrder.includes(id)),
    ];
  } else {
    state.order = [...allIds];
  }

  // 恢复裁判模型与自动派发设置
  const savedJudge = saved[STORE_JUDGE_KEY];
  if (savedJudge && state.enabled.has(savedJudge)) {
    state.judgeId = savedJudge;
  } else {
    state.judgeId = null;
  }
  if (saved[STORE_AUTO_JUDGE_KEY] !== undefined) {
    state.autoJudge = Boolean(saved[STORE_AUTO_JUDGE_KEY]);
  } else {
    state.autoJudge = true;
  }

  // 绑定底部裁判选择器与自动派发勾选框
  const judgeSel = $('#judgeSelect');
  if (judgeSel) {
    judgeSel.addEventListener('change', (e) => {
      setJudge(e.target.value || null);
    });
  }

  const autoJudgeChk = $('#autoJudge');
  if (autoJudgeChk) {
    autoJudgeChk.checked = state.autoJudge;
    autoJudgeChk.addEventListener('change', (e) => {
      state.autoJudge = e.target.checked;
      chrome.storage.local.set({ [STORE_AUTO_JUDGE_KEY]: state.autoJudge });
    });
  }

  // 绑定布局切换按钮
  $('#btnModeGrid')?.addEventListener('click', () => setLayoutMode('grid'));
  $('#btnModeScroll')?.addEventListener('click', () => setLayoutMode('scroll'));
  $('#btnModeCol2')?.addEventListener('click', () => setLayoutMode('col-2'));
  $('#btnModeCol3')?.addEventListener('click', () => setLayoutMode('col-3'));

  // 横向画廊滚动导航
  $('#scrollLeft')?.addEventListener('click', () => {
    $('#cols')?.scrollBy({ left: -460, behavior: 'smooth' });
  });
  $('#scrollRight')?.addEventListener('click', () => {
    $('#cols')?.scrollBy({ left: 460, behavior: 'smooth' });
  });

  // 在横向画廊模式下，鼠标滚轮竖向滚动自动映射为横向滚动
  $('#cols')?.addEventListener('wheel', (e) => {
    if (state.layout === 'scroll' && e.deltaY && !e.shiftKey) {
      e.preventDefault();
      $('#cols').scrollLeft += e.deltaY;
    }
  }, { passive: false });

  // 侧边栏批量选择与常用预设
  $('#btnSelectAll')?.addEventListener('click', selectAllModels);
  $('#btnClearAll')?.addEventListener('click', clearAllModels);
  $('#presetDomestic')?.addEventListener('click', () => applyPreset(PRESET_DOMESTIC));
  $('#presetGlobal')?.addEventListener('click', () => applyPreset(PRESET_GLOBAL));

  buildHeader();
  buildCols();
  applyOrder();
  setJudge(state.judgeId);
  populateJudgeSelect();

  const savedLayout = saved[STORE_LAYOUT_KEY] || 'grid';
  setLayoutMode(savedLayout);
  updateCount();

  await chrome.runtime.sendMessage({ type: 'ensure-framing' }).catch(() => {});
})();
