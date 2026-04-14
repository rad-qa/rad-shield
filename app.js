// ════════════════════════════════════════════════════════════
// RAD Shield — app.js
// ════════════════════════════════════════════════════════════

// ── API 設定（填入你的 Apps Script 網址）──
const API_URL = 'https://script.google.com/macros/s/AKfycbybSuM90u1A6eal0CpaLQUTByuFqXqb1NUB6ljmfmKydVnH2mWu1DKDc9zFZ9UFvd7Z/exec';

// ════════════════════════════════════════════════════════════
// 資料與快取
// ════════════════════════════════════════════════════════════
const KEYS = { eq:'rad_eq', rec:'rad_rec', cfg:'rad_cfg', ret:'rad_ret', auth:'rad_auth', synced:'rad_synced' };
const load = k => { try { return JSON.parse(localStorage.getItem(k)||'null'); } catch { return null; } };
const save = (k,v) => localStorage.setItem(k, JSON.stringify(v));

let EQ  = load(KEYS.eq)  || [];
let REC = load(KEYS.rec) || [];
let RET = load(KEYS.ret) || [];
let CFG = load(KEYS.cfg) || {
  hospital:'某某醫院', dept:'輻射防護組',
  depts:['放射科','心導管室','放射腫瘤科','核醫科','手術室'],
  approvers:[], customFields:[]
};
if(!CFG.approvers)   CFG.approvers   = [];
if(!CFG.customFields) CFG.customFields = [];

let _syncTimer = null;
let _lastSync  = load(KEYS.synced) || '';

function persistLocal() {
  save(KEYS.eq,  EQ);
  save(KEYS.rec, REC);
  save(KEYS.ret, RET);
  save(KEYS.cfg, CFG);
  scheduleSync();
}

// ════════════════════════════════════════════════════════════
// 密碼 / 鎖定畫面
// ════════════════════════════════════════════════════════════
function getStoredPwd() { return localStorage.getItem(KEYS.auth) || ''; }
function storePwd(pwd)  { localStorage.setItem(KEYS.auth, pwd); }

async function verifyPassword(pwd) {
  const res = await apiFetchDirect({ action: 'verifyPassword', pwd });
  return res && res.ok;
}

async function apiFetchDirect(body) {
  try {
    const params = new URLSearchParams(body);
    const res = await fetch(API_URL + '?' + params.toString());
    return await res.json();
  } catch(e) {
    console.warn('apiFetchDirect error:', e);
    return null;
  }
}

async function handleLogin() {
  const input = document.getElementById('lock-pwd');
  const err   = document.getElementById('lock-err');
  const hint  = document.getElementById('lock-loading');
  const pwd   = input.value.trim();
  if (!pwd) { err.textContent = '請輸入密碼'; return; }

  err.textContent = '';
  hint.textContent = '驗證中...';
  input.disabled = true;

  const ok = await verifyPassword(pwd);
  input.disabled = false;
  hint.textContent = '';

  if (ok) {
    storePwd(pwd);
    document.getElementById('lock-screen').style.display = 'none';
    initApp();
  } else {
    err.textContent = '密碼錯誤，請再試一次';
    input.value = '';
    input.focus();
  }
}

function checkAuth() {
  const pwd = getStoredPwd();
  if (!pwd) {
    showLockScreen();
    return false;
  }
  // 背景靜默驗證（不擋畫面）
  verifyPassword(pwd).then(ok => {
    if (!ok) { localStorage.removeItem(KEYS.auth); showLockScreen(); }
  });
  return true;
}

function showLockScreen() {
  document.getElementById('lock-screen').style.display = 'flex';
}

// ════════════════════════════════════════════════════════════
// API 呼叫
// ════════════════════════════════════════════════════════════
function getPwd() { return getStoredPwd(); }

async function apiFetch(body) {
  return new Promise((resolve) => {
    try {
      const cb = 'cb' + Date.now();
      const params = { ...body, pwd: getPwd(), callback: cb };
      // 序列化資料欄位
      ['equipment','records','retired','config'].forEach(k => {
        if (params[k] !== undefined && typeof params[k] === 'object') {
          params[k] = JSON.stringify(params[k]);
        }
      });
      const qs = Object.entries(params)
        .map(([k,v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
        .join('&');
      const script = document.createElement('script');
      const timer = setTimeout(() => {
        cleanup();
        console.warn('API timeout');
        resolve(null);
      }, 30000);
      function cleanup() {
        clearTimeout(timer);
        delete window[cb];
        if (script.parentNode) script.parentNode.removeChild(script);
      }
      window[cb] = (data) => {
        cleanup();
        resolve(data);
      };
      script.src = API_URL + '?' + qs;
      script.onerror = () => { cleanup(); resolve(null); };
      document.head.appendChild(script);
    } catch(e) {
      console.warn('API error:', e);
      resolve(null);
    }
  });
}

// ── 從 Sheets 載入全部資料 ──
async function loadFromSheets() {
  showSyncOverlay('從 Google Sheets 載入資料...');
  const res = await jsonpFetch({ action: 'load' });
  hideSyncOverlay();

  if (!res || !res.ok) {
    toast('⚠️ 無法連線 Sheets，使用本機快取');
    return;
  }

  // 合併：Sheets 有更多資料才覆蓋
  if (res.equipment && res.equipment.length >= EQ.length)  EQ  = res.equipment;
  if (res.records   && res.records.length   >= REC.length) REC = res.records;
  if (res.retired   && res.retired.length   >= RET.length) RET = res.retired;
  if (res.config)   Object.assign(CFG, res.config);

  normalizeLegacyPlans();
  save(KEYS.eq,  EQ);
  save(KEYS.rec, REC);
  save(KEYS.ret, RET);
  save(KEYS.cfg, CFG);

  const n = new Date().toLocaleString('zh-TW',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  _lastSync = n;
  save(KEYS.synced, n);
  setSyncSt('con', '已同步 ' + n);

  syncStatuses();
  refreshSelects();
  renderDash();
  const cp  = document.querySelector('.page.on');
  const pid = cp?.id?.replace('page-','');
  if (pid === 'equipment') renderEq();
  else if (pid === 'records')  renderRec();
  else if (pid === 'schedule') renderSchedule();
  else if (pid === 'overview') renderOverview();
  else if (pid === 'retired')  renderRetired();
  else if (pid === 'settings') renderSettings();
}

// ── 儲存全部到 Sheets（防抖 2 秒）──
function scheduleSync() {
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(syncNow, 2000);
}

// 分批 JSONP 傳送（每批最多 20 筆）
async function jsonpFetch(params) {
  return new Promise((resolve) => {
    const cb = 'cb' + Date.now() + Math.floor(Math.random()*10000);
    const qs = Object.entries({ ...params, pwd: getPwd(), callback: cb })
      .map(([k,v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
      .join('&');
    const script = document.createElement('script');
    const timer = setTimeout(() => {
      cleanup(); resolve(null);
    }, 30000);
    function cleanup() {
      clearTimeout(timer);
      delete window[cb];
      if (script.parentNode) script.parentNode.removeChild(script);
    }
    window[cb] = (data) => { cleanup(); resolve(data); };
    script.src = API_URL + '?' + qs;
    script.onerror = () => { cleanup(); resolve(null); };
    document.head.appendChild(script);
  });
}

async function syncSheet(sheetName, data) {
  const BATCH = 8;
  const DELAY = 500; // 每批間隔 500ms
  // 先清除舊資料
  const clearRes = await jsonpFetch({ action: 'clearSheet', sheet: sheetName });
  if (!clearRes || !clearRes.ok) return false;
  // 分批寫入
  for (let i = 0; i < data.length; i += BATCH) {
    const batch = data.slice(i, i + BATCH);
    const res = await jsonpFetch({
      action:   'saveSheet',
      sheet:    sheetName,
      rows:     JSON.stringify(batch),
      startRow: String(i + 2)
    });
    if (!res || !res.ok) {
      console.warn('批次失敗 startRow:', i+2, '結果:', res);
      return false;
    }
    // 批次間延遲，避免觸發速率限制
    if (i + BATCH < data.length) {
      await new Promise(r => setTimeout(r, DELAY));
    }
  }
  return true;
}

async function syncNow() {
  setSyncSt('syn');
  try {
    const eqOk  = await syncSheet('equipment', EQ);
    const recOk = await syncSheet('records',   REC);
    const retOk = await syncSheet('retired',   RET);
    const cfgOk = await jsonpFetch({ action: 'saveConfig', config: JSON.stringify(CFG) });
    if (eqOk && recOk && retOk && cfgOk && cfgOk.ok) {
      const n = new Date().toLocaleString('zh-TW',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
      _lastSync = n;
      save(KEYS.synced, n);
      setSyncSt('con', '已同步 ' + n);
    } else {
      setSyncSt('err', '同步失敗');
    }
  } catch(e) {
    console.warn('syncNow error:', e);
    setSyncSt('err', '同步失敗');
  }
}

// ── Sync 狀態顯示 ──
function setSyncSt(st, msg) {
  const d = document.getElementById('sync-dot');
  const l = document.getElementById('sync-label');
  if (!d || !l) return;
  const cls = { con:'con', syn:'syn', err:'err', dis:'dis' };
  d.className = 'sd ' + (cls[st] || 'dis');
  const lbs = { dis:'未連線', con: msg||'已同步', syn:'同步中...', err: msg||'同步失敗' };
  l.textContent  = lbs[st] || msg || '';
  l.style.color  = { dis:'var(--g400)', con:'var(--grn)', syn:'var(--am)', err:'var(--red)' }[st];
  const sb = document.getElementById('sync-bar');
  if (sb) sb.onclick = st === 'err' ? syncNow : () => nav('settings', document.querySelectorAll('.ni')[9]);
}

// ── Loading overlay ──
function showSyncOverlay(msg) {
  const el = document.getElementById('sync-overlay');
  if (!el) return;
  el.innerHTML = `<span class="spin"></span><span>${msg}</span>`;
  el.classList.add('show');
}
function hideSyncOverlay() {
  document.getElementById('sync-overlay')?.classList.remove('show');
}

// ════════════════════════════════════════════════════════════
// Result / Status 定義
// ════════════════════════════════════════════════════════════
const RES = {
  normal:       { l:'正常，堪用',                       c:'bg',  i:'✅' },
  edge_ok:      { l:'邊緣破損，堪用',                   c:'ba',  i:'⚠️' },
  edge_replace: { l:'邊緣破損，建議更換',               c:'bo2', i:'🔶' },
  core_replace: { l:'重要防護區破損，建議更換',         c:'br',  i:'🔴' },
  both_replace: { l:'邊緣及重要防護區破損，建議更換',   c:'br',  i:'🚨' },
  pending:      { l:'待登錄',                           c:'bgr', i:'⏳' }
};

const RESULT_MAP = {
  '正常，堪用':'normal','邊緣破損，堪用':'edge_ok',
  '邊緣破損，建議更換':'edge_replace','重要防護區破損，建議更換':'core_replace',
  '邊緣及重要防護區破損，建議更換':'both_replace',
  '合格':'normal','不合格':'core_replace'
};

const MO = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
const uid = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);

const SM = { pass:'bg', fail:'bo2', overdue:'br', pending:'ba', semi_pending:'bb' };
const SL = { pass:'合格', fail:'不合格，建議更換', overdue:'逾期', pending:'待檢', semi_pending:'第二次待檢' };

// ════════════════════════════════════════════════════════════
// 狀態計算
// ════════════════════════════════════════════════════════════
function computeEqStatus(eq) {
  const now = new Date();
  const curYear  = now.getFullYear();
  const curMonth = now.getMonth() + 1;

  const eqRecs = REC.filter(r => r.eqId === eq.id && r.result !== 'pending' && r.date)
    .sort((a,b) => b.date.localeCompare(a.date));

  if (eq.schedYM) {
    const [sy,sm] = eq.schedYM.split('-').map(Number);
    const deadline = new Date(sy, sm, 15);
    const notYetDue = now < new Date(sy, sm-1, 1);
    if (notYetDue) return 'pending';
    const hasDone = eqRecs.some(r => {
      const d = new Date(r.date);
      return d.getFullYear() === sy && d.getMonth()+1 >= sm;
    });
    if (now > deadline && !hasDone) return 'overdue';
    const latest = eqRecs.find(r => { const d = new Date(r.date); return d.getFullYear() === sy && d.getMonth()+1 >= sm; });
    if (latest) {
      if (latest.result === 'normal' || latest.result === 'edge_ok') return 'pass';
      if (latest.result === 'edge_replace' || latest.result === 'core_replace' || latest.result === 'both_replace') return 'fail';
    }
    return 'pending';
  }

  function isOverdue(m) {
    let dy = curYear, dm = m + 1;
    if (dm > 12) { dm = 1; dy++; }
    const deadline = new Date(dy, dm-1, 15);
    if (now <= deadline) return false;
    return !eqRecs.some(r => { const d = new Date(r.date); return d.getFullYear() === curYear && d.getMonth()+1 >= m; });
  }

  if (isOverdue(eq.month)) return 'overdue';
  if (eq.semiAnnual && eq.month2 && isOverdue(eq.month2)) return 'overdue';

  const latest = eqRecs[0];
  if (latest) {
    const r = latest.result;
    if (r === 'normal' || r === 'edge_ok') {
      if (eq.semiAnnual && eq.month2) {
        const done2 = eqRecs.some(r2 => { const d = new Date(r2.date); return d.getFullYear() === curYear && d.getMonth()+1 >= eq.month2; });
        if (!done2 && curMonth >= eq.month2) return 'semi_pending';
      }
      return 'pass';
    }
    if (r === 'edge_replace' || r === 'core_replace' || r === 'both_replace') return 'fail';
  }
  return 'pending';
}

function syncStatuses() { EQ.forEach(e => { e.status = computeEqStatus(e); }); }

// ════════════════════════════════════════════════════════════
// 導覽
// ════════════════════════════════════════════════════════════
const TITLES = {
  dashboard:'儀表板', equipment:'器具管理', schedule:'檢測計畫',
  records:'檢測紀錄', batch:'⚡ 快速批次登錄', overview:'年度總覽',
  retired:'汰換清單', reports:'報表匯出', import:'資料輸入', settings:'系統設定'
};

function nav(p, el) {
  document.querySelectorAll('.page').forEach(e => e.classList.remove('on'));
  document.querySelectorAll('.ni').forEach(e => e.classList.remove('on'));
  document.getElementById('page-' + p).classList.add('on');
  if (el) el.classList.add('on');
  document.getElementById('topbar-title').textContent = TITLES[p] || p;
  closeSidebar();
  refreshSelects();
  if (p === 'dashboard') renderDash();
  if (p === 'equipment') { syncStatuses(); renderEq(); }
  if (p === 'schedule')  { syncStatuses(); renderSchedule(); }
  if (p === 'records')   renderRec();
  if (p === 'overview')  renderOverview();
  if (p === 'retired')   renderRetired();
  if (p === 'settings')  renderSettings();
  if (p === 'batch')     initBatch();
  if (p === 'history')   initHistory();
}

// ── 手機 Sidebar 開關 ──
function toggleSidebar() {
  document.querySelector('.sb').classList.toggle('open');
  document.querySelector('.sb-overlay').classList.toggle('show');
}
function closeSidebar() {
  document.querySelector('.sb')?.classList.remove('open');
  document.querySelector('.sb-overlay')?.classList.remove('show');
}

function navToRecByDept(dept) {
  nav('records', document.querySelectorAll('.ni')[3]);
  setTimeout(() => { const s = document.getElementById('rec-fdept'); if(s){ s.value = dept; renderRec(); } }, 80);
}
function navToEqByDept(dept) {
  nav('equipment', document.querySelectorAll('.ni')[1]);
  setTimeout(() => { const s = document.getElementById('eq-fdept'); if(s){ s.value = dept; renderEq(); } }, 80);
}

// ════════════════════════════════════════════════════════════
// Select 更新
// ════════════════════════════════════════════════════════════
function refreshSelects() {
  const allOpt = '<option value="">所有單位</option>' + CFG.depts.map(d => `<option>${d}</option>`).join('');
  const allFull = '<option value="">全部</option>'    + CFG.depts.map(d => `<option>${d}</option>`).join('');
  ['eq-fdept','rec-fdept','ret-fdept'].forEach(id => { const e = document.getElementById(id); if(e) e.innerHTML = allOpt; });
  ['rpt-dept','rpt-dept2'].forEach(id => { const e = document.getElementById(id); if(e) e.innerHTML = allFull; });
  const fd = document.getElementById('f-dept'); if(fd) fd.innerHTML = CFG.depts.map(d => `<option>${d}</option>`).join('');
  const re = document.getElementById('r-eq');   if(re) re.innerHTML = EQ.map(e => `<option value="${e.id}">${e.id} — ${e.type} / ${e.dept}</option>`).join('');
}

// ════════════════════════════════════════════════════════════
// 日期正規化
// ════════════════════════════════════════════════════════════
function normDateStr(s) {
  if (!s) return '';
  s = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const a = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (a) return a[1] + '-' + a[2].padStart(2,'0') + '-' + a[3].padStart(2,'0');
  const b = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (b) return b[1] + '-' + b[2].padStart(2,'0') + '-' + b[3].padStart(2,'0');
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) return s.slice(0,10);
  const c = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (c) return c[1] + '-' + c[2] + '-' + c[3];
  return '';
}

// ════════════════════════════════════════════════════════════
// 舊資料正規化
// ════════════════════════════════════════════════════════════
function normalizeLegacyPlans() {
  const MON_MAP_L = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
  function normP(s) {
    if (!s) return '';
    if (/^\d{4}-\d{2}$/.test(s)) return s;
    const mmy = s.match(/^([A-Za-z]{1,3})-(\d{2,4})$/);
    if (mmy) { const mo = MON_MAP_L[mmy[1].toLowerCase().slice(0,3)]; if(mo){ const yr = mmy[2].length===2?2000+parseInt(mmy[2],10):parseInt(mmy[2],10); return yr+'-'+String(mo).padStart(2,'0'); } }
    const ymm = s.match(/^(\d{2,4})-([A-Za-z]{1,3})$/);
    if (ymm) { const mo = MON_MAP_L[ymm[2].toLowerCase().slice(0,3)]; if(mo){ const yr = ymm[1].length===2?2000+parseInt(ymm[1],10):parseInt(ymm[1],10); return yr+'-'+String(mo).padStart(2,'0'); } }
    const slash = s.match(/^(\d{1,2})\/(\d{4})$/);
    if (slash) { const m = +slash[1]; const y = +slash[2]; if(m>=1&&m<=12) return y+'-'+String(m).padStart(2,'0'); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.slice(0,7);
    return '';
  }
  let changed = false;
  REC.forEach(r => {
    const n = normP(r.plan);
    if (n && n !== r.plan) { r.plan = n; changed = true; }
    const nd = normDateStr(r.date);
    if (nd && nd !== r.date) { r.date = nd; changed = true; }
    if (!r.plan && r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) { r.plan = r.date.slice(0,7); changed = true; }
  });
  if (changed) save(KEYS.rec, REC);
}

// ════════════════════════════════════════════════════════════
// 年份工具
// ════════════════════════════════════════════════════════════
function recYearOf(r) {
  const p = r.plan || '';
  if (/^\d{4}-\d{2}$/.test(p)) return p.slice(0,4);
  if (/^\d{4}-\d{2}-\d{2}$/.test(r.date||'')) return r.date.slice(0,4);
  return null;
}
function buildYears() {
  const yr = new Set(REC.map(recYearOf).filter(Boolean));
  yr.add(String(new Date().getFullYear()));
  return [...yr].sort().reverse();
}

// ════════════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════════════
function renderDash() {
  document.getElementById('dash-hn').textContent = CFG.hospital;
  document.getElementById('dash-hs').textContent = CFG.dept + '　輻射防護器具管理系統';
  document.getElementById('sf-hospital').textContent = CFG.hospital;
  document.getElementById('sf-dept').textContent = CFG.dept;
  syncStatuses();

  const yd = document.getElementById('dash-year');
  const years = buildYears();
  const cur = yd.value || years[0] || String(new Date().getFullYear());
  yd.innerHTML = years.map(y => `<option value="${y}" ${y===cur?'selected':''}>${y} 年度</option>`).join('');
  const selY = yd.value || cur;

  const yearRecs = REC.filter(r => r.result !== 'pending' && r.date && recYearOf(r) === selY);
  const overdue  = EQ.filter(e => e.status === 'overdue');
  const failed   = EQ.filter(e => e.status === 'fail');
  const total    = EQ.length;
  const inspectedItems = new Set(yearRecs.map(r => r.eqId)).size;
  const inspectedTimes = yearRecs.length;
  const semiCount = EQ.filter(e => e.semiAnnual).length;

  document.getElementById('dash-alert').innerHTML = (overdue.length || failed.length)
    ? `<div class="alert al-a"><span style="font-size:15px">⚠️</span><div>${overdue.length ? `<strong>${overdue.length}</strong> 件逾期未檢，` : ''} ${failed.length ? `<strong>${failed.length}</strong> 件不合格建議更換，` : ''}請儘快處理。</div></div>` : '';

  document.getElementById('dash-stats').innerHTML = `
    <div class="sc"><div class="si ic-t">🦺</div><div><div class="sn">${total}</div><div class="sl">器具總數</div></div></div>
    <div class="sc"><div class="si ic-g">✅</div><div><div class="sn">${inspectedItems}</div><div class="sl">${selY} 已檢測件數</div></div></div>
    <div class="sc"><div class="si ic-g">📋</div><div><div class="sn">${inspectedTimes}</div><div class="sl">${selY} 已檢測次數</div></div></div>
    <div class="sc"><div class="si ic-a">🔁</div><div><div class="sn">${semiCount}</div><div class="sl">需半年檢測</div></div></div>
    <div class="sc" onclick="nav('records',document.querySelectorAll('.ni')[3])"><div class="si ic-r">⏰</div><div><div class="sn">${overdue.length}</div><div class="sl">逾期</div></div></div>
    <div class="sc" onclick="nav('records',document.querySelectorAll('.ni')[3])"><div class="si ic-o">🔶</div><div><div class="sn">${failed.length}</div><div class="sl">不合格</div></div></div>`;

  const curM = new Date().getMonth() + 1;
  const curYear2 = new Date().getFullYear();
  const thisMonthInspected = new Set(
    REC.filter(r => r.result !== 'pending' && r.date && new Date(r.date).getFullYear() === curYear2 && new Date(r.date).getMonth()+1 === curM)
      .map(r => r.eqId)
  );
  const allMonthEqs = EQ.filter(e => {
    if (e.schedYM) { const[sy,sm]=e.schedYM.split('-').map(Number); if(sy===curYear2&&(sm===curM||(e.semiAnnual&&+e.month2===curM)))return true; }
    else if (e.month === curM || (e.semiAnnual && e.month2 === curM)) return true;
    if (thisMonthInspected.has(e.id)) return true;
    return false;
  });
  const mpByDept = {};
  allMonthEqs.forEach(e => {
    if (!mpByDept[e.dept]) mpByDept[e.dept] = { done:[], pending:[] };
    const hasRec = REC.some(r => r.eqId === e.id && r.result !== 'pending' && r.date && new Date(r.date).getFullYear() === curYear2);
    if (hasRec) mpByDept[e.dept].done.push(e);
    else mpByDept[e.dept].pending.push(e);
  });

  document.getElementById('dash-mp').innerHTML = Object.keys(mpByDept).length
    ? Object.entries(mpByDept).map(([d,{done,pending}]) => {
        const total = done.length + pending.length;
        const doneHtml = done.length ? `<span style="font-family:var(--M);font-size:10px;color:#10b981">${done.slice(0,3).map(e=>e.id).join('、')}${done.length>3?`…+${done.length-3}`:''}✓</span>` : `<span style="color:var(--g300);font-size:10px">—</span>`;
        const pendHtml = pending.length ? `<span style="font-family:var(--M);font-size:10px;color:var(--red)">${pending.slice(0,3).map(e=>e.id).join('、')}${pending.length>3?`…+${pending.length-3}`:''}</span>` : `<span style="color:var(--g300);font-size:10px">—</span>`;
        return `<tr><td style="cursor:pointer;color:var(--teal);font-weight:500" onclick="navToEqByDept('${d}')">${d}</td><td style="font-weight:700">${total} 件</td><td>${doneHtml}</td><td>${pendHtml}</td></tr>`;
      }).join('')
    : `<tr><td colspan="4" class="te">✅ 本月無排定器具</td></tr>`;

  document.getElementById('dash-fl').innerHTML = failed.length
    ? failed.map(e => {
        const lr = REC.filter(r => r.eqId === e.id && r.result !== 'pending' && r.date).sort((a,b) => b.date.localeCompare(a.date))[0];
        const rv = RES[lr?.result] || RES.pending;
        return `<tr><td><span style="font-family:var(--M);font-size:10px;color:var(--teal)">${e.id}</span></td><td>${e.type}${e.subtype?'／'+e.subtype:''}</td><td>${e.dept}</td><td><span class="badge ${rv.c}" style="font-size:9.5px;white-space:normal">${rv.i} ${rv.l}</span></td></tr>`;
      }).join('')
    : `<tr><td colspan="4" class="te">✅ 本年度無不合格器具</td></tr>`;

  const dm = {};
  EQ.forEach(e => {
    if (!dm[e.dept]) dm[e.dept] = { total:0,done:0,overdue:0,fail:0,semi:0,semiPending:0,pending:0 };
    dm[e.dept].total++;
    if (e.status === 'pass') {
      dm[e.dept].done++;
      if (e.semiAnnual && e.month2) {
        const hasFirst = REC.some(r => r.eqId===e.id && (r.result==='edge_ok'||r.result==='normal') && r.date && new Date(r.date).getFullYear()===+selY);
        if (hasFirst) { dm[e.dept].semi++; dm[e.dept].semiPending++; }
      }
    }
    if (e.status === 'semi_pending') { dm[e.dept].done++; dm[e.dept].semi++; dm[e.dept].semiPending++; }
    if (e.status === 'overdue') dm[e.dept].overdue++;
    if (e.status === 'fail')    dm[e.dept].fail++;
    if (e.status === 'pending') dm[e.dept].pending++;
  });

  document.getElementById('dash-dept').innerHTML = Object.entries(dm).map(([d,v]) => {
    let statusBadge;
    if (v.fail > 0 || v.overdue > 0) statusBadge = `<span class="badge br" style="cursor:pointer" onclick="navToRecByDept('${d}')">注意</span>`;
    else if (v.pending > 0)           statusBadge = `<span class="badge bgr" style="cursor:pointer" onclick="navToRecByDept('${d}')">待檢</span>`;
    else if (v.semiPending > 0)       statusBadge = `<span class="badge" style="cursor:pointer;background:#ffedd5;color:#9a3412" onclick="navToRecByDept('${d}')">需半年檢測</span>`;
    else                               statusBadge = `<span class="badge bg" style="cursor:pointer" onclick="navToRecByDept('${d}')">良好</span>`;
    return `<tr><td style="cursor:pointer;color:var(--teal);font-weight:500" onclick="navToRecByDept('${d}')">${d}</td><td>${v.total}</td><td>${v.done}</td><td>${v.overdue}</td><td>${v.fail}</td><td>${v.semi}</td><td>${statusBadge}</td></tr>`;
  }).join('') || `<tr><td colspan="7" class="te">尚無器具資料</td></tr>`;
}

// ════════════════════════════════════════════════════════════
// EQUIPMENT
// ════════════════════════════════════════════════════════════
function renderEq() {
  const q  = (document.getElementById('eq-q')?.value||'').toLowerCase();
  const fd = document.getElementById('eq-fdept')?.value||'';
  const ft = document.getElementById('eq-ftype')?.value||'';
  const fs = document.getElementById('eq-fst')?.value||'';
  const data = EQ.filter(e =>
    (!q  || e.id.toLowerCase().includes(q) || e.brand.toLowerCase().includes(q) || (e.note||'').includes(q)) &&
    (!fd || e.dept === fd) && (!ft || e.type === ft) && (!fs || e.status === fs)
  );
  document.getElementById('eq-cnt').textContent = `（共 ${data.length} 件）`;
  document.getElementById('eq-tbody').innerHTML = data.length
    ? data.map(e => `<tr>
        <td style="text-align:center"><input type="checkbox" class="eq-cb" data-id="${e.id}" style="accent-color:var(--teal);width:13px;height:13px" onchange="onEqCb()"></td>
        <td>${e.photo?`<img class="eqth" src="${e.photo}">`:`<div class="eqth">🦺</div>`}</td>
        <td><span style="font-family:var(--M);font-size:10px;color:var(--teal);font-weight:600">${e.id}</span></td>
        <td style="font-weight:500">${e.type}</td>
        <td style="color:var(--g600)">${e.subtype||'—'}</td>
        <td style="color:var(--g600)">${e.brand}</td>
        <td style="font-family:var(--M);font-size:10.5px">${e.lead} mmPb</td>
        <td>${e.dept}</td>
        <td style="text-align:center;font-family:var(--M);font-size:10.5px">${e.schedYM||MO[(e.month||1)-1]}</td>
        <td style="text-align:center">${e.semiAnnual&&e.month2?`<span class="badge bb">${MO[e.month2-1]}</span>`:'—'}</td>
        <td><span class="badge ${SM[e.status]||'bgr'}">${SL[e.status]||e.status}</span></td>
        <td style="display:flex;gap:3px">
          <button class="btn bo bxs" onclick="viewEq('${e.id}')">查看</button>
          <button class="btn bo bxs" onclick="editEq('${e.id}')">編輯</button>
          <button class="btn bd bxs" onclick="delEq('${e.id}')">刪除</button>
        </td>
      </tr>`).join('')
    : `<tr><td colspan="12" class="te">查無符合條件的器具</td></tr>`;
}

function onEqCb() {
  const ch = document.querySelectorAll('.eq-cb:checked');
  const bb = document.getElementById('eq-bbar');
  const sa = document.getElementById('eq-sa');
  const all = document.querySelectorAll('.eq-cb');
  bb.style.display = ch.length ? 'flex' : 'none';
  document.getElementById('eq-bcnt').textContent = `已選取 ${ch.length} 件`;
  if (sa) sa.checked = all.length > 0 && ch.length === all.length;
}
function toggleSelAll(cb) { document.querySelectorAll('.eq-cb').forEach(c => c.checked = cb.checked); onEqCb(); }
function clearEqSel() { document.querySelectorAll('.eq-cb').forEach(c => c.checked = false); const sa = document.getElementById('eq-sa'); if(sa) sa.checked = false; onEqCb(); }

function openEqModal(id) {
  document.getElementById('eq-eid').value = id || '';
  document.getElementById('eq-mtitle').textContent = id ? '編輯器具' : '新增器具';
  refreshSelects();
  if (id) {
    const e = EQ.find(x => x.id === id); if (!e) return;
    document.getElementById('f-id').value    = e.id;
    document.getElementById('f-type').value  = e.type;
    document.getElementById('f-sub').value   = e.subtype || '';
    document.getElementById('f-brand').value = e.brand;
    document.getElementById('f-model').value = e.model || '';
    document.getElementById('f-lead').value  = e.lead || '';
    document.getElementById('f-dept').value  = e.dept;
    document.getElementById('f-month').value = e.schedYM || e.month || '';
    document.getElementById('f-semi').value  = e.semiAnnual ? '1' : '0';
    document.getElementById('f-month2').value = e.month2 || 1;
    document.getElementById('f-m2-wrap').style.display = e.semiAnnual ? 'flex' : 'none';
    document.getElementById('f-start').value = e.start || '';
    document.getElementById('f-owner').value = e.owner || '';
    document.getElementById('f-note').value  = e.note || '';
    document.getElementById('photo-area').innerHTML = e.photo
      ? `<div class="ph-pw"><img class="ph-p" src="${e.photo}"><button class="ph-d" onclick="clearPhoto()">✕</button></div>`
      : `<div class="phu" onclick="document.getElementById('ph-inp').click()"><div style="font-size:22px;margin-bottom:5px">📷</div><div style="font-size:11.5px;font-weight:600;color:var(--navy)">點擊上傳照片</div></div>`;
    renderEqCustomFields(e.customFields || {});
  } else {
    ['f-id','f-brand','f-model','f-lead','f-start','f-owner','f-note'].forEach(i => document.getElementById(i).value = '');
    document.getElementById('f-type').value  = '鉛衣';
    document.getElementById('f-sub').value   = '';
    document.getElementById('f-month').value = '1';
    document.getElementById('f-semi').value  = '0';
    document.getElementById('f-month2').value = '1';
    document.getElementById('f-m2-wrap').style.display = 'none';
    document.getElementById('photo-area').innerHTML = `<div class="phu" onclick="document.getElementById('ph-inp').click()"><div style="font-size:22px;margin-bottom:5px">📷</div><div style="font-size:11.5px;font-weight:600;color:var(--navy)">點擊上傳照片</div></div>`;
    renderEqCustomFields({});
  }
  _curPhoto = '';
  openModal('modal-eq');
}
function editEq(id) { openEqModal(id); }
let _curPhoto = '';
function clearPhoto() { document.getElementById('photo-area').innerHTML = `<div class="phu" onclick="document.getElementById('ph-inp').click()"><div style="font-size:22px;margin-bottom:5px">📷</div><div style="font-size:11.5px;font-weight:600;color:var(--navy)">點擊上傳照片</div></div>`; _curPhoto = ''; }
function handlePhoto(inp) { const f = inp.files[0]; if(!f) return; const r = new FileReader(); r.onload = e => { _curPhoto = e.target.result; document.getElementById('photo-area').innerHTML = `<div class="ph-pw"><img class="ph-p" src="${_curPhoto}"><button class="ph-d" onclick="clearPhoto()">✕</button></div>`; }; r.readAsDataURL(f); }
function toggleM2() { document.getElementById('f-m2-wrap').style.display = document.getElementById('f-semi').value === '1' ? 'flex' : 'none'; }

function saveEq() {
  const id  = document.getElementById('f-id').value.trim();
  const eid = document.getElementById('eq-eid').value;
  if (!id) { toast('❗ 請輸入編號'); return; }
  if (!eid && EQ.find(e => e.id === id)) { toast('❗ 此編號已存在'); return; }
  const semi  = document.getElementById('f-semi').value === '1';
  const photo = _curPhoto || (eid ? EQ.find(e => e.id === eid)?.photo || '' : '');
  const customVals = {};
  (CFG.customFields||[]).filter(f => f.scope==='eq'||f.scope==='both').forEach(f => { const el = document.getElementById('ecf-'+f.id); if(el) customVals[f.id] = el.value.trim(); });
  const obj = {
    id, type: document.getElementById('f-type').value, subtype: document.getElementById('f-sub').value||'',
    brand: document.getElementById('f-brand').value.trim(), model: document.getElementById('f-model').value.trim(),
    lead: document.getElementById('f-lead').value.trim(), dept: document.getElementById('f-dept').value,
    month: (()=>{ const v = document.getElementById('f-month').value.trim(); return /^\d{4}-\d{2}$/.test(v)?+v.split('-')[1]:+v||1; })(),
    schedYM: (()=>{ const v = document.getElementById('f-month').value.trim(); return /^\d{4}-\d{2}$/.test(v)?v:null; })(),
    semiAnnual: semi, month2: semi ? +document.getElementById('f-month2').value : null,
    start: document.getElementById('f-start').value, owner: document.getElementById('f-owner').value.trim(),
    note: document.getElementById('f-note').value.trim(), photo, status:'pending', customFields: customVals
  };
  obj.status = computeEqStatus(obj);
  if (eid) { const i = EQ.findIndex(e => e.id === eid); if(i>=0) EQ[i] = obj; } else EQ.push(obj);
  persistLocal(); _curPhoto = ''; closeModal('modal-eq'); renderEq(); renderDash();
  toast(`✅ 器具 ${id} 已${eid?'更新':'新增'}`);
}

function delEq(id) {
  if (!confirm(`確定要刪除器具 ${id}？\n相關檢測紀錄也會一併刪除。`)) return;
  EQ  = EQ.filter(e => e.id !== id);
  REC = REC.filter(r => r.eqId !== id);
  persistLocal(); renderEq(); renderDash(); toast(`🗑 器具 ${id} 已刪除`);
}
function bulkDelEq() {
  const ids = [...document.querySelectorAll('.eq-cb:checked')].map(c => c.dataset.id);
  if (!ids.length) return;
  if (!confirm(`確定要刪除選取的 ${ids.length} 件器具？`)) return;
  EQ  = EQ.filter(e => !ids.includes(e.id));
  REC = REC.filter(r => !ids.includes(r.eqId));
  persistLocal(); clearEqSel(); renderEq(); renderDash(); toast(`🗑 已刪除 ${ids.length} 件器具`);
}

function viewEq(id) {
  const e = EQ.find(x => x.id === id); if (!e) return;
  const recs = REC.filter(r => r.eqId === id).sort((a,b) => (b.date||b.plan||'').localeCompare(a.date||a.plan||''));
  document.getElementById('mmd-title').textContent = `器具詳細資料 — ${id}`;
  document.getElementById('mmd-body').innerHTML = `
    <div style="display:flex;gap:16px;align-items:flex-start;margin-bottom:15px">
      ${e.photo?`<img src="${e.photo}" style="width:100px;height:75px;object-fit:cover;border-radius:7px;border:1px solid var(--g200);flex-shrink:0">`:`<div style="width:100px;height:75px;background:var(--g100);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:30px;flex-shrink:0">🦺</div>`}
      <div style="flex:1">
        <div style="font-size:18px;font-weight:700;color:var(--navy)">${e.id}</div>
        <div style="font-size:12px;color:var(--g600);margin-top:2px">${e.type}${e.subtype?'／'+e.subtype:''}｜${e.brand} ${e.model||''}</div>
        <div style="margin-top:7px;display:flex;gap:6px;flex-wrap:wrap">
          <span class="badge ${SM[e.status]||'bgr'}">${SL[e.status]||e.status}</span>
          <span class="badge bgr">${e.dept}</span>
          <span class="badge bb">每年${MO[e.month-1]}檢測</span>
          ${e.semiAnnual&&e.month2?`<span class="badge bp2">半年追蹤：${MO[e.month2-1]}</span>`:''}
        </div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;background:var(--g50);padding:10px;border-radius:7px;margin-bottom:12px">
      <div><div style="font-size:9.5px;color:var(--g400);font-weight:700;text-transform:uppercase">鉛當量</div><div style="font-size:13px;font-weight:600;font-family:var(--M)">${e.lead} mmPb</div></div>
      <div><div style="font-size:9.5px;color:var(--g400);font-weight:700;text-transform:uppercase">啟用日期</div><div style="font-size:12px;font-weight:500">${e.start||'—'}</div></div>
      <div><div style="font-size:9.5px;color:var(--g400);font-weight:700;text-transform:uppercase">保管人</div><div style="font-size:12px;font-weight:500">${e.owner||'—'}</div></div>
    </div>
    ${e.note?`<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:9px;font-size:11.5px;color:#78350f;margin-bottom:12px">📝 ${e.note}</div>`:''}
    <div style="font-size:11.5px;font-weight:700;color:var(--navy);margin:12px 0 7px;display:flex;align-items:center;gap:7px">歷史檢測紀錄<span style="flex:1;height:1px;background:var(--g200);display:block"></span></div>
    ${recs.length?`<table class="tbl"><thead><tr><th>排定</th><th>檢測日期</th><th>人員</th><th>結果</th><th>下次</th><th>備註</th></tr></thead><tbody>${recs.map(r=>{const rv=RES[r.result]||RES.pending;return`<tr><td>${r.plan}</td><td>${r.date||'—'}</td><td>${r.insp||'—'}</td><td><span class="badge ${rv.c}" style="font-size:9.5px">${rv.i} ${rv.l}</span></td><td>${r.next||'—'}</td><td style="font-size:10.5px;color:var(--g600)">${r.note||'—'}</td></tr>`;}).join('')}</tbody></table>`:`<div class="te">尚無檢測紀錄</div>`}
    <div style="display:flex;gap:7px;margin-top:12px"><button class="btn bp bsm" onclick="closeModal('modal-month');editEq('${id}')">✏️ 編輯器具</button></div>`;
  openModal('modal-month');
}

// ════════════════════════════════════════════════════════════
// RETIRE
// ════════════════════════════════════════════════════════════
let _retireIds = [];
function bulkRetireEq() {
  const ids = [...document.querySelectorAll('.eq-cb:checked')].map(c => c.dataset.id);
  if (!ids.length) { toast('❗ 請先勾選要汰換的器具'); return; }
  _retireIds = ids;
  document.getElementById('retire-ids').innerHTML = `即將移入汰換：<span style="font-family:var(--M);font-size:11px;color:var(--teal)">${ids.join('、')}</span>`;
  document.getElementById('retire-year').value = new Date().getFullYear();
  document.getElementById('retire-date').value = new Date().toISOString().slice(0,10);
  document.getElementById('retire-note').value = '';
  openModal('modal-retire');
}
function confirmRetire() {
  const yr = +document.getElementById('retire-year').value;
  if (!yr || yr < 2000) { toast('❗ 請輸入正確年份'); return; }
  const dt   = document.getElementById('retire-date').value;
  const note = document.getElementById('retire-note').value.trim();
  const retiredSet = new Set();
  _retireIds.forEach(id => {
    const e = EQ.find(x => x.id === id); if (!e) return;
    RET.push({ id:e.id, type:e.type, subtype:e.subtype||'', brand:e.brand, model:e.model||'', lead:e.lead, dept:e.dept, retireYear:yr, retireDate:dt, note, retiredAt:new Date().toISOString() });
    retiredSet.add(id);
  });
  EQ  = EQ.filter(e => !retiredSet.has(e.id));
  REC = REC.filter(r => !retiredSet.has(r.eqId));
  persistLocal(); closeModal('modal-retire'); clearEqSel(); renderEq(); renderDash();
  toast(`📦 已將 ${retiredSet.size} 件器具移入汰換清單`);
}

function renderRetired() {
  const q  = (document.getElementById('ret-q')?.value||'').toLowerCase();
  const fy = document.getElementById('ret-fyear')?.value||'';
  const fd = document.getElementById('ret-fdept')?.value||'';
  const yrs = [...new Set(RET.map(r => String(r.retireYear)))].sort().reverse();
  const ryEl = document.getElementById('ret-fyear');
  if (ryEl) { const cv = ryEl.value; ryEl.innerHTML = '<option value="">所有年份</option>' + yrs.map(y=>`<option value="${y}" ${y===cv?'selected':''}>${y} 年度</option>`).join(''); }
  const rdEl = document.getElementById('ret-fdept');
  if (rdEl) { const cv = rdEl.value; rdEl.innerHTML = '<option value="">所有單位</option>' + CFG.depts.map(d=>`<option ${d===cv?'selected':''}>${d}</option>`).join(''); }
  const data = [...RET].filter(r => (!q||r.id.toLowerCase().includes(q)||(r.brand||'').toLowerCase().includes(q)) && (!fy||String(r.retireYear)===fy) && (!fd||r.dept===fd))
    .sort((a,b) => b.retireYear - a.retireYear || (b.retireDate||'').localeCompare(a.retireDate||''));
  document.getElementById('ret-cnt').textContent = `（共 ${data.length} 件）`;
  document.getElementById('ret-tbody').innerHTML = data.length
    ? data.map(r => `<tr>
        <td style="font-family:var(--M);font-weight:700">${r.retireYear}</td>
        <td style="color:var(--g600)">${r.retireDate||'—'}</td>
        <td><span style="font-family:var(--M);font-size:10px;color:var(--teal)">${r.id}</span></td>
        <td>${r.type}</td><td style="color:var(--g600)">${r.subtype||'—'}</td><td style="color:var(--g600)">${r.brand}</td>
        <td style="font-family:var(--M);font-size:10.5px">${r.lead}</td><td>${r.dept}</td>
        <td style="font-size:10.5px;color:var(--g600)">${r.note||'—'}</td>
        <td><button class="btn bo bxs" onclick="restoreRetired('${r.id}','${r.retiredAt||''}')">↩ 還原</button></td>
      </tr>`).join('')
    : `<tr><td colspan="10" class="te">尚無汰換紀錄</td></tr>`;
}

function restoreRetired(id, at) {
  const idx = RET.findIndex(r => r.id===id && (r.retiredAt||'')===at);
  if (idx < 0 || !confirm(`確定要將 ${id} 還原至器具管理？`)) return;
  const item = RET[idx];
  EQ.push({ id:item.id, type:item.type, subtype:item.subtype||'', brand:item.brand, model:item.model||'', lead:item.lead, dept:item.dept, month:1, semiAnnual:false, month2:null, start:'', owner:'', note:'（從汰換清單還原）', photo:'', status:'pending' });
  RET.splice(idx, 1);
  persistLocal(); renderRetired(); renderDash(); toast(`↩ ${id} 已還原至器具管理`);
}

function exportRetiredCSV() {
  const bom = '\uFEFF';
  const csv = bom + '汰換年份,汰換日期,編號,器具類型,次分類,廠牌,鉛當量,單位,備註\n' + RET.map(r=>`${r.retireYear},${r.retireDate||''},${r.id},${r.type},${r.subtype||''},${r.brand},${r.lead},${r.dept},"${r.note||''}"`).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'})); a.download = '汰換清單.csv'; a.click(); toast('📊 汰換清單已匯出');
}

// ════════════════════════════════════════════════════════════
// SCHEDULE
// ════════════════════════════════════════════════════════════
function renderSchedule() {
  const now = new Date();
  const curYear = now.getFullYear();
  const ymYears = new Set(EQ.filter(e=>e.schedYM).map(e=>+e.schedYM.split('-')[0]));
  ymYears.add(curYear); ymYears.add(curYear+1);
  const yearList = [...ymYears].sort();
  const yd = document.getElementById('sch-year');
  if (yd) {
    const cur = +(yd.value)||curYear;
    yd.innerHTML = yearList.map(y=>'<option value="'+y+'"'+(y===cur?' selected':'')+'>'+y+' 年度</option>').join('');
    if (!yd.value) yd.value = curYear;
  }
  const selYear = +(yd&&yd.value?yd.value:curYear);
  function isSchedThisYear(eq) { if(eq.schedYM) return +eq.schedYM.split('-')[0]===selYear; return true; }
  const scheduledEq = EQ.filter(isSchedThisYear);
  function hasInspectedInYear(eq,fromMonth) { return REC.some(r=>{ if(r.eqId!==eq.id||r.result==='pending'||!r.date)return false; const d=new Date(r.date); return d.getFullYear()===selYear&&d.getMonth()+1>=fromMonth; }); }
  let total=0, done=0;
  scheduledEq.forEach(e=>{
    if(e.schedYM){ const p=e.schedYM.split('-'); const sy=+p[0],sm=+p[1]; total++; const hasDone=REC.some(r=>r.eqId===e.id&&r.result!=='pending'&&r.date&&new Date(r.date).getFullYear()===sy&&new Date(r.date).getMonth()+1>=sm); if(hasDone)done++; if(e.semiAnnual&&e.month2){ total++; const hasDone2=REC.some(r=>r.eqId===e.id&&r.result!=='pending'&&r.date&&new Date(r.date).getFullYear()===sy&&new Date(r.date).getMonth()+1>=+e.month2); if(hasDone2)done++; } }
    else{ total++; if(hasInspectedInYear(e,e.month))done++; if(e.semiAnnual&&e.month2){ total++; if(hasInspectedInYear(e,e.month2))done++; } }
  });
  document.getElementById('sch-rate').textContent = total ? Math.round(done/total*100)+'%' : '—';
  document.getElementById('sch-sub').textContent  = done+' / '+total+' 次已完成（'+selYear+' 年度）';
  const nextM = (now.getMonth()+1)%12+1;
  const nxt = EQ.filter(e=>{ if(e.schedYM){const p=e.schedYM.split('-');return(+p[0]===selYear&&+p[1]===nextM)||(+p[0]===selYear&&e.semiAnnual&&+e.month2===nextM);} return e.month===nextM||(e.semiAnnual&&+e.month2===nextM); }).length;
  document.getElementById('sch-next').textContent = nxt;
  document.getElementById('sch-ns').textContent   = MO[nextM-1]+' 排定器具';
  const curM = now.getMonth()+1;
  const cells = [];
  for (let i=0;i<12;i++) {
    const m = i+1;
    const annualItems = EQ.filter(e=>{ if(e.schedYM){const p=e.schedYM.split('-');return +p[0]===selYear&&+p[1]===m;} return e.month===m; });
    const annualIds = new Set(annualItems.map(e=>e.id));
    const semiItems = EQ.filter(e=>{ if(e.schedYM){if(+e.schedYM.split('-')[0]!==selYear)return false;} if(!e.semiAnnual||e.semiAnnual==='false'||e.semiAnnual==='0')return false; if(!e.month2||+e.month2<1||+e.month2>12)return false; if(+e.month2!==m)return false; if(annualIds.has(e.id))return false; return true; });
    const allIds = new Set([...annualItems,...semiItems].map(e=>e.id));
    const items  = [...allIds].map(id=>EQ.find(e=>e.id===id));
    const dn = items.filter(e=>e.status==='pass'||e.status==='semi_pending');
    const la = items.filter(e=>e.status==='overdue');
    const pe = items.filter(e=>e.status==='pending');
    let cls = '';
    if(la.length) cls='late'; else if(items.length&&dn.length===items.length) cls='done'; else if(items.length) cls='pend';
    if(m===curM&&selYear===curYear) cls+=' cur';
    const annualDeptMap={};
    annualItems.forEach(e=>{ if(!annualDeptMap[e.dept])annualDeptMap[e.dept]=[]; annualDeptMap[e.dept].push(e); });
    const semiDeptMap={};
    semiItems.forEach(e=>{ if(!semiDeptMap[e.dept])semiDeptMap[e.dept]=[]; semiDeptMap[e.dept].push(e); });
    let chips='';
    Object.entries(annualDeptMap).forEach(([dept,eqs])=>{ const hl=eqs.some(e=>e.status==='overdue'); const ad=eqs.every(e=>e.status==='pass'); const cc=hl?'mi-l':ad?'mi-d':'mi-p'; chips+=`<div class="mi ${cc}" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:3px" data-dept="${encodeURIComponent(dept)}" onclick="event.stopPropagation();navToEqByDept(decodeURIComponent(this.dataset.dept))"><span>${dept}</span><span style="font-weight:700">${eqs.length}</span></div>`; });
    Object.entries(semiDeptMap).forEach(([dept,eqs])=>{ const hl=eqs.some(e=>e.status==='overdue'); const cc=hl?'mi-l':''; const semiStyle=hl?'':'background:rgba(249,115,22,.12);color:#c2410c;'; chips+=`<div class="mi ${cc}" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:3px;${semiStyle}" data-dept="${encodeURIComponent(dept)}" onclick="event.stopPropagation();navToEqByDept(decodeURIComponent(this.dataset.dept))"><span>${dept} <span style="font-size:8.5px;opacity:.8">半年</span></span><span style="font-weight:700">${eqs.length}</span></div>`; });
    if(!chips) chips='<span style="font-size:10px;color:var(--g300)">—</span>';
    let stat='';
    if(dn.length) stat+=`<span class="ms-d">${dn.length}✓</span>`;
    if(la.length) stat+=`<span class="ms-l">${la.length}⚠</span>`;
    if(pe.length) stat+=`<span class="ms-p">${pe.length}◷</span>`;
    if(semiItems.length) stat+=`<span style="background:#f97316;color:#fff;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700">${semiItems.length}半</span>`;
    if(!items.length) stat+='<span style="color:var(--g300);font-size:10px">無排定</span>';
    const curBadge=(m===curM&&selYear===curYear)?'<span style="font-size:9px;background:var(--am);color:#fff;padding:1px 5px;border-radius:3px">本月</span>':'';
    cells.push(`<div class="mc2 ${cls}" onclick="showMonthDetail(${m},${selYear})"><div style="display:flex;justify-content:space-between;align-items:flex-start"><div class="mn">${MO[i]}</div>${curBadge}</div><div class="ms">${stat}</div><div class="mitems">${chips}</div></div>`);
  }
  document.getElementById('month-grid').innerHTML = cells.join('');
}

function showMonthDetail(m, selYear) {
  const yr = selYear || new Date().getFullYear();
  const items = EQ.filter(e=>{ const hasSemi=e.semiAnnual&&e.semiAnnual!=='false'&&e.semiAnnual!=='0'&&e.month2&&+e.month2>=1&&+e.month2<=12; if(e.schedYM){const[sy,sm]=e.schedYM.split('-').map(Number);return sy===yr&&(sm===m||(hasSemi&&+e.month2===m));} return e.month===m||(hasSemi&&+e.month2===m); });
  document.getElementById('mmd-title').textContent = `${MO[m-1]} 排程明細（${items.length} 件）`;
  const deptMap = {};
  items.forEach(e=>{ if(!deptMap[e.dept])deptMap[e.dept]=[]; deptMap[e.dept].push(e); });
  let html = '';
  Object.entries(deptMap).forEach(([d,eqs])=>{
    const semiItems = eqs.filter(e=>e.semiAnnual&&e.month2===m);
    const semiNote  = semiItems.length?` <span style="font-size:9px;background:rgba(249,115,22,.15);color:#c2410c;border-radius:3px;padding:1px 5px;font-weight:600">含半年檢測 ${semiItems.length} 件</span>`:'';
    html += `<div style="margin-bottom:12px"><div style="font-size:10.5px;font-weight:700;color:var(--g600);text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px;display:flex;align-items:center;gap:6px">${d} <span style="font-weight:400;color:var(--g400)">${eqs.length} 件</span>${semiNote}<span style="flex:1;height:1px;background:var(--g200);display:block"></span><button class="btn bo bxs" onclick="navToEqByDept('${d}');closeModal('modal-month')">查看全部</button></div>
    <table class="tbl"><thead><tr><th>編號</th><th>類型</th><th>廠牌</th><th>鉛當量</th><th>檢測類別</th><th>狀態</th><th>操作</th></tr></thead><tbody>${eqs.map(e=>{ const isSemi=e.semiAnnual&&e.month2===m; const typeTag=isSemi?'<span style="font-size:9.5px;background:rgba(249,115,22,.15);color:#c2410c;border-radius:3px;padding:1px 5px;font-weight:600">半年檢測</span>':'<span style="font-size:9.5px;background:var(--tp);color:var(--teal);border-radius:3px;padding:1px 5px;font-weight:600">年度檢測</span>'; return '<tr><td><span style="font-family:var(--M);font-size:10px;color:var(--teal)">'+e.id+'</span></td><td>'+e.type+(e.subtype?'／'+e.subtype:'')+'</td><td>'+e.brand+'</td><td style="font-family:var(--M);font-size:10px">'+e.lead+'</td><td>'+typeTag+'</td><td><span class="badge '+(SM[e.status]||'bgr')+'">'+(SL[e.status]||e.status)+'</span></td><td><button class="btn bo bxs" onclick="closeModal(\'modal-month\');viewEq(\''+e.id+'\')">查看</button></td></tr>'; }).join('')}</tbody></table></div>`;
  });
  document.getElementById('mmd-body').innerHTML = html || `<div class="te">此月份無排定器具</div>`;
  openModal('modal-month');
}

// ════════════════════════════════════════════════════════════
// RECORDS
// ════════════════════════════════════════════════════════════
let _recFilter = 'all';
function recTab(el) { document.querySelectorAll('#page-records .tab').forEach(t=>t.classList.remove('on')); el.classList.add('on'); _recFilter=el.dataset.f; renderRec(); }

function renderRec() {
  const q  = (document.getElementById('rec-q')?.value||'').toLowerCase();
  const fd = document.getElementById('rec-fdept')?.value||'';
  const fy = document.getElementById('rec-fyear')?.value||'';
  const years = [...new Set(REC.map(recYearOf).filter(Boolean))].sort().reverse();
  const ryEl = document.getElementById('rec-fyear');
  if (ryEl) { const cv=ryEl.value; ryEl.innerHTML='<option value="">所有年份</option>'+years.map(y=>`<option value="${y}" ${y===cv?'selected':''}>${y} 年度</option>`).join(''); }
  let data = [...REC];
  if (_recFilter !== 'all') data = data.filter(r => r.result === _recFilter);
  data = data.filter(r => (!q||r.eqId.toLowerCase().includes(q)||(r.eqType||'').includes(q)||(r.insp||'').includes(q)) && (!fd||r.dept===fd) && (!fy||recYearOf(r)===fy))
    .sort((a,b) => (b.plan||b.date||'').localeCompare(a.plan||a.date||''));
  document.getElementById('rec-tbody').innerHTML = data.length
    ? data.map(r => {
        const rv = RES[r.result] || RES.pending;
        const approverBadge = r.approver ? `<span style="display:inline-flex;align-items:center;gap:3px;font-size:10px;color:#166534;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:4px;padding:1px 6px">🖊 ${r.approver}</span>` : '<span style="color:var(--g300);font-size:10px">—</span>';
        return `<tr>
          <td style="text-align:center"><input type="checkbox" class="rec-cb" data-id="${r.id}" style="accent-color:var(--teal);width:13px;height:13px" onchange="onRecCb()"></td>
          <td><span style="font-family:var(--M);font-size:10px;color:var(--teal);font-weight:600">${r.eqId}</span></td>
          <td>${r.eqType||'—'}</td><td style="color:var(--g600)">${r.eqSub||'—'}</td><td style="color:var(--g600)">${r.eqBrand||'—'}</td><td>${r.dept}</td>
          <td>${r.plan||(r.date?r.date.slice(0,7):'—')}</td><td style="color:var(--g600)">${r.date||'—'}</td><td>${r.insp||'—'}</td>
          <td>${approverBadge}</td>
          <td><span class="badge ${rv.c}" style="font-size:9.5px;white-space:normal">${rv.i} ${rv.l}</span></td>
          <td style="color:var(--g600)">${r.next||'—'}</td>
          <td style="font-size:10.5px;color:var(--g600);max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.note||'—'}</td>
          <td style="display:flex;gap:3px">${r.result==='pending'?`<button class="btn bp bxs" onclick="fillPending('${r.id}')">登錄</button>`:`<button class="btn bo bxs" onclick="editRec('${r.id}')">編輯</button>`}<button class="btn bd bxs" onclick="delRec('${r.id}')">刪除</button></td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="14" class="te">查無符合條件的紀錄</td></tr>`;
  const allChk = document.getElementById('rec-chk-all'); if(allChk) allChk.checked=false;
  document.getElementById('rec-bbar').style.display = 'none';
}

function onEqSelect(eqId) {
  const eq = EQ.find(e => e.id === eqId) || {};
  const typeEl = document.getElementById('r-eqtype'); const subEl = document.getElementById('r-eqsub');
  if(typeEl) typeEl.value = eq.type||''; if(subEl) subEl.value = eq.subtype||'—';
  const planEl = document.getElementById('r-plan');
  if(planEl && !planEl.value) {
    if(eq.schedYM&&/^\d{4}-\d{2}$/.test(eq.schedYM)) planEl.value=eq.schedYM;
    else if(eq.month) { const yr=new Date().getFullYear(); planEl.value=yr+'-'+String(eq.month).padStart(2,'0'); }
  }
}

function openRecModal() {
  document.getElementById('rec-eid').value='';
  document.getElementById('rec-mtitle').textContent='登錄檢測結果';
  refreshSelects();
  ['r-plan','r-date','r-next','r-insp','r-note','r-approver','r-approve-date','r-approve-note'].forEach(i=>document.getElementById(i).value='');
  document.getElementById('r-result').value='normal';
  ['cb1','cb2','cb3','cb4'].forEach(i=>document.getElementById(i).checked=false);
  document.getElementById('r-semi-wrap').style.display='none';
  document.getElementById('r-need2').checked=false;
  document.getElementById('r-m2-wrap').style.display='none';
  renderApproverSel('r-approver-sel');
  document.getElementById('r-insp-sign-label').textContent='—';
  document.getElementById('r-approver-sign-label').textContent='—';
  renderRecCustomFields({});
  const firstEq = document.getElementById('r-eq')?.value; if(firstEq) onEqSelect(firstEq);
  openModal('modal-rec');
}

function fillPending(id) {
  const r = REC.find(x=>x.id===id); if(!r) return;
  document.getElementById('rec-eid').value=id;
  document.getElementById('rec-mtitle').textContent='登錄檢測結果';
  refreshSelects();
  document.getElementById('r-eq').value=r.eqId; onEqSelect(r.eqId);
  document.getElementById('r-plan').value=r.plan;
  document.getElementById('r-date').value=new Date().toISOString().slice(0,10);
  document.getElementById('r-insp').value=''; document.getElementById('r-result').value='normal';
  document.getElementById('r-note').value=''; document.getElementById('r-next').value='';
  ['r-approver','r-approve-date','r-approve-note'].forEach(i=>document.getElementById(i).value='');
  renderApproverSel('r-approver-sel');
  document.getElementById('r-insp-sign-label').textContent='—'; document.getElementById('r-approver-sign-label').textContent='—';
  renderRecCustomFields({});
  ['cb1','cb2','cb3','cb4'].forEach(i=>document.getElementById(i).checked=false);
  document.getElementById('r-semi-wrap').style.display='none'; document.getElementById('r-need2').checked=false; document.getElementById('r-m2-wrap').style.display='none';
  openModal('modal-rec');
}

function onResultChange() {
  const v=document.getElementById('r-result')?.value; const sw=document.getElementById('r-semi-wrap'); if(!sw) return;
  if(v==='edge_ok'){ sw.style.display='block'; const now=new Date(); document.getElementById('r-second-month').value=((now.getMonth()+6)%12)+1; }
  else{ sw.style.display='none'; document.getElementById('r-need2').checked=false; document.getElementById('r-m2-wrap').style.display='none'; }
}
function toggleR2() { document.getElementById('r-m2-wrap').style.display=document.getElementById('r-need2').checked?'flex':'none'; }

function saveRec() {
  const eqId=document.getElementById('r-eq').value; const date=document.getElementById('r-date').value; const insp=document.getElementById('r-insp').value.trim(); const result=document.getElementById('r-result').value;
  if(!eqId){toast('❗ 請選擇器具');return;} if(!date){toast('❗ 請輸入檢測日期');return;} if(!insp){toast('❗ 請輸入檢測人員');return;}
  const eq=EQ.find(e=>e.id===eqId); const eid=document.getElementById('rec-eid').value;
  const customVals={};
  (CFG.customFields||[]).filter(f=>f.scope==='rec'||f.scope==='both').forEach(f=>{ const el=document.getElementById('rcf-'+f.id); if(el) customVals[f.id]=el.value.trim(); });
  const obj={ id:eid||uid(),eqId,eqType:eq?.type||'',eqSub:eq?.subtype||'',eqBrand:eq?.brand||'',dept:eq?.dept||'', plan:document.getElementById('r-plan').value,date,insp,result, next:document.getElementById('r-next').value,note:document.getElementById('r-note').value.trim(), approver:document.getElementById('r-approver').value.trim(), approveDate:document.getElementById('r-approve-date').value, approveNote:document.getElementById('r-approve-note').value.trim(), customFields:customVals };
  if(eid){const i=REC.findIndex(r=>r.id===eid);if(i>=0)REC[i]=obj;}else REC.push(obj);
  if(eq){ const next=document.getElementById('r-next').value; if(next){const nm=+next.split('-')[1];if(nm>=1&&nm<=12)eq.month=nm;} if(document.getElementById('r-need2').checked){const m2=+document.getElementById('r-second-month').value;if(m2>=1&&m2<=12){eq.semiAnnual=true;eq.month2=m2;}} eq.status=computeEqStatus(eq); }
  persistLocal(); closeModal('modal-rec'); renderRec(); renderDash(); toast(`✅ 檢測紀錄已儲存（${RES[result]?.l||result}）`);
}

function delRec(id) { if(!confirm('確定要刪除此筆檢測紀錄？'))return; REC=REC.filter(r=>r.id!==id); persistLocal(); renderRec(); renderDash(); toast('🗑 紀錄已刪除'); }

function editRec(id) {
  const r=REC.find(x=>x.id===id); if(!r) return;
  document.getElementById('rec-eid').value=id; document.getElementById('rec-mtitle').textContent='編輯檢測紀錄';
  refreshSelects();
  document.getElementById('r-eq').value=r.eqId; onEqSelect(r.eqId);
  const planVal=(r.plan&&/^\d{4}-\d{2}$/.test(r.plan))?r.plan:(r.date?r.date.slice(0,7):'');
  document.getElementById('r-plan').value=planVal; document.getElementById('r-date').value=normDateStr(r.date)||new Date().toISOString().slice(0,10);
  document.getElementById('r-insp').value=r.insp||''; document.getElementById('r-result').value=r.result||'normal';
  document.getElementById('r-next').value=r.next||''; document.getElementById('r-note').value=r.note||'';
  document.getElementById('r-approver').value=r.approver||''; document.getElementById('r-approve-date').value=r.approveDate||''; document.getElementById('r-approve-note').value=r.approveNote||'';
  renderApproverSel('r-approver-sel');
  document.getElementById('r-insp-sign-label').textContent=r.insp||'—'; document.getElementById('r-approver-sign-label').textContent=r.approver||'—';
  renderRecCustomFields(r.customFields||{});
  ['cb1','cb2','cb3','cb4'].forEach(i=>document.getElementById(i).checked=false);
  const showSemi=(r.result==='edge_ok'); const sw=document.getElementById('r-semi-wrap'); if(sw) sw.style.display=showSemi?'block':'none';
  const eq=EQ.find(e=>e.id===r.eqId); const need2Chk=document.getElementById('r-need2'); const m2Wrap=document.getElementById('r-m2-wrap');
  if(showSemi&&eq&&eq.semiAnnual&&eq.month2){if(need2Chk)need2Chk.checked=true;if(m2Wrap)m2Wrap.style.display='flex';document.getElementById('r-second-month').value=eq.month2;}
  else{if(need2Chk)need2Chk.checked=false;if(m2Wrap)m2Wrap.style.display='none';}
  openModal('modal-rec');
}

function onRecCb() {
  const all=document.querySelectorAll('.rec-cb'); const chk=document.querySelectorAll('.rec-cb:checked'); const n=chk.length;
  const bbar=document.getElementById('rec-bbar'); const allChk=document.getElementById('rec-chk-all');
  if(bbar) bbar.style.display=n?'flex':'none'; if(allChk) allChk.checked=all.length>0&&n===all.length;
  const cnt=document.getElementById('rec-sel-cnt'); if(cnt) cnt.textContent=n;
}
function toggleAllRec(cb) { document.querySelectorAll('.rec-cb').forEach(c=>c.checked=cb.checked); onRecCb(); }
function clearRecSel() { document.querySelectorAll('.rec-cb').forEach(c=>c.checked=false); const allChk=document.getElementById('rec-chk-all');if(allChk)allChk.checked=false; const bbar=document.getElementById('rec-bbar');if(bbar)bbar.style.display='none'; }
function bulkDelRec() {
  const ids=[...document.querySelectorAll('.rec-cb:checked')].map(c=>c.dataset.id); if(!ids.length)return;
  if(!confirm(`確定要刪除選取的 ${ids.length} 筆檢測紀錄？`))return;
  REC=REC.filter(r=>!ids.includes(r.id)); persistLocal(); clearRecSel(); renderRec(); renderDash(); toast(`🗑 已刪除 ${ids.length} 筆檢測紀錄`);
}

// ════════════════════════════════════════════════════════════
// OVERVIEW (Charts)
// ════════════════════════════════════════════════════════════
let _barChart=null, _pieChart=null;
function renderOverview() {
  const years=[...new Set(REC.map(recYearOf).filter(Boolean))].sort().reverse();
  const yd=document.getElementById('ov-year');
  if(yd){ const cur=yd.value||years[0]||String(new Date().getFullYear()); yd.innerHTML=years.map(y=>`<option value="${y}" ${y===cur?'selected':''}>${y} 年度</option>`).join(''); if(!yd.value&&years[0])yd.value=years[0]; }
  const selY=(yd&&yd.value)||years[0]||String(new Date().getFullYear());
  const yearRecs=REC.filter(r=>r.result!=='pending'&&r.date&&recYearOf(r)===selY);
  const latestByEq={};
  yearRecs.forEach(r=>{ if(!latestByEq[r.eqId]||r.date>latestByEq[r.eqId].date) latestByEq[r.eqId]=r; });
  const dedupedRecs=Object.values(latestByEq);
  const rKeys=['normal','edge_ok','edge_replace','core_replace','both_replace'];
  const rLabels={normal:'正常堪用',edge_ok:'邊緣堪用',edge_replace:'邊緣建議換',core_replace:'重要區破損',both_replace:'邊緣及重要'};
  const rColors={normal:'#10b981',edge_ok:'#f59e0b',edge_replace:'#f97316',core_replace:'#ef4444',both_replace:'#991b1b'};
  const depts=[...new Set(EQ.map(e=>e.dept))].sort();
  const deptEqIds={}; depts.forEach(d=>deptEqIds[d]=new Set(EQ.filter(e=>e.dept===d).map(e=>e.id)));
  const mx={}; depts.forEach(d=>{ mx[d]={}; rKeys.forEach(k=>{ mx[d][k]=0; }); mx[d].notYet=0; });
  dedupedRecs.forEach(r=>{ const dept=r.dept||EQ.find(e=>e.id===r.eqId)?.dept||'其他'; if(!mx[dept]){mx[dept]={...Object.fromEntries(rKeys.map(k=>[k,0])),notYet:0};} if(mx[dept][r.result]!==undefined) mx[dept][r.result]++; });
  const inspectedIds=new Set(dedupedRecs.map(r=>r.eqId));
  depts.forEach(d=>{ mx[d].notYet=(deptEqIds[d]?[...deptEqIds[d]].filter(id=>!inspectedIds.has(id)).length:0); });
  document.getElementById('ov-tbody').innerHTML=depts.map(d=>{ const v=mx[d]||{}; const inspected=rKeys.reduce((s,k)=>s+(v[k]||0),0); const total=inspected+(v.notYet||0); return `<tr><td style="font-weight:600">${d}</td><td><span style="color:#10b981;font-weight:700">${v.normal||0}</span></td><td><span style="color:#f59e0b;font-weight:700">${v.edge_ok||0}</span></td><td><span style="color:#f97316;font-weight:700">${v.edge_replace||0}</span></td><td><span style="color:#ef4444;font-weight:700">${v.core_replace||0}</span></td><td><span style="color:#991b1b;font-weight:700">${v.both_replace||0}</span></td><td style="color:var(--g400)">${v.notYet||0}</td><td style="font-weight:700">${total}</td></tr>`; }).join('')||`<tr><td colspan="8" class="te">無資料</td></tr>`;
  if(_barChart){_barChart.destroy();_barChart=null;} const bc=document.getElementById('chart-bar');
  if(bc&&depts.length){ _barChart=new Chart(bc,{type:'bar',data:{labels:depts,datasets:rKeys.map(k=>({label:rLabels[k],data:depts.map(d=>(mx[d]||{})[k]||0),backgroundColor:rColors[k]+'cc',borderColor:rColors[k],borderWidth:1}))},options:{responsive:true,plugins:{legend:{position:'bottom',labels:{font:{size:10},boxWidth:11}}},scales:{x:{stacked:true,ticks:{font:{size:10}}},y:{stacked:true,beginAtZero:true,ticks:{stepSize:1}}}}}); }
  if(_pieChart){_pieChart.destroy();_pieChart=null;} const pc=document.getElementById('chart-pie');
  if(pc){ const tots=rKeys.map(k=>depts.reduce((s,d)=>s+((mx[d]||{})[k]||0),0)); const nonZ=rKeys.map((k,i)=>({k,v:tots[i]})).filter(x=>x.v>0); if(nonZ.length){ _pieChart=new Chart(pc,{type:'doughnut',data:{labels:nonZ.map(x=>rLabels[x.k]),datasets:[{data:nonZ.map(x=>x.v),backgroundColor:nonZ.map(x=>rColors[x.k]),borderWidth:2}]},options:{responsive:true,plugins:{legend:{position:'bottom',labels:{font:{size:10},boxWidth:11}},tooltip:{callbacks:{label:ctx=>{ const t=ctx.dataset.data.reduce((a,b)=>a+b,0); return ` ${ctx.label}: ${ctx.raw} (${Math.round(ctx.raw/t*100)}%)`; }}}}}}); } }
}

// ════════════════════════════════════════════════════════════
// REPORTS
// ════════════════════════════════════════════════════════════
function exportReport(type) {
  const bom='\uFEFF'; let csv='',fn='';
  const eqCF=(CFG.customFields||[]).filter(f=>f.scope==='eq'||f.scope==='both');
  const recCF=(CFG.customFields||[]).filter(f=>f.scope==='rec'||f.scope==='both');
  const cfVal=(obj,f)=>'"'+(((obj.customFields||{})[f.id])||'').replace(/"/g,'""')+'"';
  if(type==='annual'){ fn='年度檢測總報表.csv'; const recCFH=recCF.map(f=>f.name).join(','); csv=bom+'編號,器具類型,次分類,廠牌,單位,鉛當量,排定月份,半年月份,狀態,最新檢測日,最新結果,檢測人員,主管核簽,核簽日期'+(recCFH?','+recCFH:'')+'\n'; csv+=EQ.map(e=>{ const lr=REC.filter(r=>r.eqId===e.id&&r.result!=='pending'&&r.date).sort((a,b)=>b.date.localeCompare(a.date))[0]; const cfCols=recCF.map(f=>cfVal(lr||{},f)).join(','); return `${e.id},${e.type},${e.subtype||''},${e.brand},${e.dept},${e.lead},${e.schedYM||MO[(e.month||1)-1]},${e.semiAnnual&&e.month2?MO[e.month2-1]:''},${SL[e.status]||e.status},${lr?.date||''},${RES[lr?.result]?.l||''},${lr?.insp||''},${lr?.approver||''},${lr?.approveDate||''}${cfCols?','+cfCols:''}`; }).join('\n'); }
  else if(type==='inventory'){ fn='器具清冊.csv'; const eqCFH=eqCF.map(f=>f.name).join(','); csv=bom+'編號,器具類型,次分類,廠牌,型號,鉛當量,單位,排定月份,啟用日期,保管人,備註'+(eqCFH?','+eqCFH:'')+'\n'; csv+=EQ.map(e=>{ const cfCols=eqCF.map(f=>cfVal(e,f)).join(','); return `${e.id},${e.type},${e.subtype||''},${e.brand},${e.model||''},${e.lead},${e.dept},${e.schedYM||MO[(e.month||1)-1]},${e.start||''},${e.owner||''},"${(e.note||'').replace(/"/g,'""')}"${cfCols?','+cfCols:''}`; }).join('\n'); }
  else if(type==='anomaly'){ fn='逾期不合格報表.csv'; csv=bom+'類別,編號,器具類型,廠牌,單位,排定月份,狀態,最新檢測日,最新結果,檢測人員,主管核簽\n'; const ov=EQ.filter(e=>e.status==='overdue').map(e=>`逾期未檢,${e.id},${e.type},${e.brand},${e.dept},${e.schedYM||MO[(e.month||1)-1]},逾期,,,`); const failRows=EQ.filter(e=>e.status==='fail').map(e=>{ const lr=REC.filter(r=>r.eqId===e.id&&r.result!=='pending'&&r.date).sort((a,b)=>b.date.localeCompare(a.date))[0]; return `不合格，建議更換,${e.id},${e.type},${e.brand},${e.dept},${e.schedYM||MO[(e.month||1)-1]},不合格,${lr?.date||''},${RES[lr?.result]?.l||''},${lr?.insp||''},${lr?.approver||''}`; }); csv+=([...ov,...failRows]).join('\n'); }
  else if(type==='monthly'){ const mv=document.getElementById('rpt-month').value; fn=`${mv}工作單.csv`; const mn=+mv.split('-')[1]; const recCFH=recCF.map(f=>f.name).join(','); csv=bom+'編號,器具類型,次分類,廠牌,單位,鉛當量,排定月份,狀態,檢測日期,檢測人員,主管核簽,核簽日期,備註'+(recCFH?','+recCFH:'')+'\n'; csv+=EQ.filter(e=>e.month===mn||(e.semiAnnual&&e.month2===mn)).map(e=>{ const lr=REC.filter(r=>r.eqId===e.id&&r.result!=='pending'&&r.date).sort((a,b)=>b.date.localeCompare(a.date))[0]; const cfCols=recCF.map(f=>cfVal(lr||{},f)).join(','); return `${e.id},${e.type},${e.subtype||''},${e.brand},${e.dept},${e.lead},${e.schedYM||MO[(e.month||1)-1]},${SL[e.status]||e.status},${lr?.date||''},${lr?.insp||''},${lr?.approver||''},${lr?.approveDate||''},"${(lr?.note||'').replace(/"/g,'""')}"${cfCols?','+cfCols:''}`; }).join('\n'); }
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'})); a.download=fn; a.click(); toast('📊 '+fn+' 已下載');
}

// ════════════════════════════════════════════════════════════
// IMPORT
// ════════════════════════════════════════════════════════════
let _pEq=null, _pRec=null;
function importTab(el,t) { document.querySelectorAll('#page-import .tab').forEach(x=>x.classList.remove('on')); el.classList.add('on'); ['imp-eq','imp-rec'].forEach(id=>document.getElementById(id).style.display='none'); document.getElementById(t).style.display='block'; }
function dov(e,id){e.preventDefault();document.getElementById(id)?.classList.add('drag');}
function dol(id){document.getElementById(id)?.classList.remove('drag');}
function dod(e,type){e.preventDefault();dol('dz-'+type);const f=e.dataTransfer.files[0];if(f)readFile(f,type);}
function handleFile(inp,type){if(inp.files.length){readFile(inp.files[0],type);inp.value='';}}
function readFile(f,type){const r=new FileReader();r.onload=e=>{let t=e.target.result;if(t.charCodeAt(0)===0xFEFF)t=t.slice(1);parseCSV(t,type);};r.readAsText(f,'UTF-8');}
function parseCSVLines(text){const lines=text.split(/\r?\n/).filter(l=>l.trim());if(!lines.length)return{headers:[],rows:[]};const split=l=>{const res=[];let cur='',q=false;for(const c of l){if(c==='"')q=!q;else if(c===','&&!q){res.push(cur.trim());cur='';}else cur+=c;}res.push(cur.trim());return res;};return{headers:split(lines[0]),rows:lines.slice(1).map(l=>split(l))};}
function getCol(headers,names){for(const n of names){const i=headers.findIndex(h=>h.replace(/\s/g,'').toLowerCase()===n.replace(/\s/g,'').toLowerCase());if(i>=0)return i;}return -1;}
function parseCSV(text,type){const{headers,rows}=parseCSVLines(text);if(!headers.length||!rows.length){toast('⚠️ 無法解析檔案，請確認格式');return;}if(type==='eq')parseEqCSV(headers,rows);else parseRecCSV(headers,rows);}

function parseEqCSV(headers,rows){
  const iId=getCol(headers,['編號','id']);const iType=getCol(headers,['器具類型','類型','type']);const iBrand=getCol(headers,['廠牌','brand']);const iModel=getCol(headers,['型號','model']);const iSub=getCol(headers,['器具次分類','次分類','subtype']);const iLead=getCol(headers,['鉛當量(mmPb)','鉛當量','lead']);const iDept=getCol(headers,['所屬單位','單位','dept']);const iMonth=getCol(headers,['排定年/月','排定月份','月份','month']);const iSemi=getCol(headers,['是否需半年檢測','半年檢測','semi']);const iM2=getCol(headers,['半年檢測月份','month2']);const iStart=getCol(headers,['啟用日期','start']);const iOwner=getCol(headers,['保管人','owner']);const iNote=getCol(headers,['備註','note']);
  if(iId<0||iDept<0||iMonth<0){toast('⚠️ 找不到必填欄位（編號、所屬單位、排定月份）\n偵測到欄位：'+headers.join('、'));return;}
  const MON_MAP={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  function parseSched(raw){const s=raw.trim();if(!s)return{month:1,schedYM:null};if(/^\d{4}-\d{2}$/.test(s)){const m=+s.split('-')[1];return{month:m||1,schedYM:s};}const mmy=s.match(/^([A-Za-z]{3})-(\d{2,4})$/);if(mmy){const mo=MON_MAP[mmy[1].toLowerCase()];if(mo){const yr=mmy[2].length===2?2000+parseInt(mmy[2],10):parseInt(mmy[2],10);return{month:mo,schedYM:yr+'-'+String(mo).padStart(2,'0')};}}const slash=s.match(/^(\d{1,2})\/(\d{4})$/);if(slash){const m=+slash[1];const y=+slash[2];if(m>=1&&m<=12)return{month:m,schedYM:y+'-'+String(m).padStart(2,'0')};}const n=+s;if(n>=1&&n<=12)return{month:n,schedYM:null};return{month:1,schedYM:null};}
  function parseMonthOnly(raw){if(!raw||!raw.trim())return 0;const r=parseSched(raw.trim());return r.month;}
  const parsed=rows.map(r=>{const sr=(iSemi>=0?r[iSemi]||'':'').trim();const sa=sr==='是'||sr==='1'||sr.toLowerCase()==='yes';const rawM2=(iM2>=0?r[iM2]||'':'').trim();const m2=parseMonthOnly(rawM2);const rawSched=(r[iMonth]||'').trim();const{month:schedMonth,schedYM}=parseSched(rawSched);return{id:(r[iId]||'').trim(),type:(iType>=0?r[iType]||'鉛衣':'鉛衣').trim(),subtype:(iSub>=0?r[iSub]||'':'').trim(),brand:(iBrand>=0?r[iBrand]||'':'').trim(),model:(iModel>=0?r[iModel]||'':'').trim(),lead:(iLead>=0?r[iLead]||'':'').trim(),dept:(r[iDept]||'').trim(),month:schedMonth,schedYM:schedYM||null,semiAnnual:sa,month2:sa&&m2>=1&&m2<=12?m2:null,start:(iStart>=0?r[iStart]||'':'').trim(),owner:(iOwner>=0?r[iOwner]||'':'').trim(),note:(iNote>=0?r[iNote]||'':'').trim(),photo:'',status:'pending'};}).filter(r=>r.id&&r.dept);
  if(!parsed.length){toast('⚠️ 解析後無有效資料');return;} _pEq=parsed;
  const newI=parsed.filter(r=>!EQ.find(e=>e.id===r.id)); const dupI=parsed.filter(r=>!!EQ.find(e=>e.id===r.id));
  document.getElementById('prev-eq').innerHTML=`<div class="card" style="margin-top:10px"><div class="ch"><div class="ct" style="color:var(--grn)">✅ 預覽：共 ${parsed.length} 筆${newI.length?`<span class="badge bg" style="margin-left:6px">${newI.length} 新增</span>`:''}${dupI.length?`<span class="badge ba" style="margin-left:4px">${dupI.length} 已存在</span>`:''}</div><div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap"><label style="display:flex;align-items:center;gap:5px;font-size:11px;cursor:pointer"><input type="checkbox" id="imp-sa" style="accent-color:var(--teal);width:13px;height:13px" onchange="toggleImpAll(this)">全選/取消全選</label><button class="btn bp bsm" onclick="confirmImpEq()">確認匯入勾選項目</button><button class="btn bo bsm" onclick="_pEq=null;document.getElementById('prev-eq').innerHTML=''">取消</button></div></div><div style="padding:8px 13px;font-size:11px;color:var(--g600);background:var(--g50);border-bottom:1px solid var(--g100)"><span style="color:var(--g400)">「已存在」項目預設不勾選；勾選後匯入將覆蓋更新</span></div><div style="overflow-x:auto"><table class="tbl"><thead><tr><th></th><th>編號</th><th>類型</th><th>次分類</th><th>廠牌</th><th>單位</th><th>月份</th><th>半年</th><th>狀態</th></tr></thead><tbody>${parsed.map((r,i)=>{const dup=!!EQ.find(e=>e.id===r.id);return`<tr><td style="text-align:center"><input type="checkbox" class="imp-eq-cb" data-i="${i}" style="accent-color:var(--teal);width:13px;height:13px" ${dup?'':'checked'} onchange="updImpCnt()"></td><td><span style="font-family:var(--M);font-size:10px;color:var(--teal)">${r.id}</span></td><td>${r.type}</td><td>${r.subtype||'—'}</td><td>${r.brand||'—'}</td><td>${r.dept}</td><td>${r.schedYM||MO[(r.month||1)-1]}</td><td>${r.semiAnnual&&r.month2?`<span class="badge bb">${MO[r.month2-1]}</span>`:'—'}</td><td>${dup?'<span class="badge ba">已存在</span>':'<span class="badge bg">新增</span>'}</td></tr>`;}).join('')}</tbody></table></div><div style="padding:9px 13px;font-size:11px;color:var(--g600);border-top:1px solid var(--g100)">已勾選 <strong id="imp-cnt">${newI.length}</strong> 筆</div></div>`;
}
function toggleImpAll(cb){document.querySelectorAll('.imp-eq-cb').forEach(c=>c.checked=cb.checked);updImpCnt();}
function updImpCnt(){const n=document.querySelectorAll('.imp-eq-cb:checked').length;const el=document.getElementById('imp-cnt');if(el)el.textContent=n;const sa=document.getElementById('imp-sa');const all=document.querySelectorAll('.imp-eq-cb');if(sa)sa.checked=all.length>0&&n===all.length;}
function confirmImpEq(){
  if(!_pEq){toast('❗ 無資料可匯入');return;}
  const chk=new Set([...document.querySelectorAll('.imp-eq-cb:checked')].map(c=>+c.dataset.i));
  if(!chk.size){toast('⚠️ 請至少勾選一筆資料');return;}
  let added=0,updated=0;
  _pEq.forEach((r,i)=>{if(!chk.has(i))return;r.status=computeEqStatus(r);const ex=EQ.find(e=>e.id===r.id);if(ex){Object.assign(ex,{...r,photo:ex.photo||r.photo,status:ex.status,month:r.month,schedYM:r.schedYM||null});updated++;}else{r.month=r.month||1;r.schedYM=r.schedYM||null;EQ.push(r);added++;}});
  persistLocal();_pEq=null;document.getElementById('prev-eq').innerHTML='';renderEq();renderDash();
  const msg=[];if(added)msg.push(`新增 ${added} 筆`);if(updated)msg.push(`更新 ${updated} 筆`);
  if(msg.length)toast(`✅ 匯入完成：${msg.join('，')}`);else toast('⚠️ 沒有資料被匯入');
}

function parseRecCSV(headers,rows){
  const iId=getCol(headers,['編號','id']);const iPlan=getCol(headers,['排定月份','plan']);const iDate=getCol(headers,['檢測日期','實際日期','日期','date']);const iInsp=getCol(headers,['檢測人員','人員','inspector']);const iResult=getCol(headers,['結果','result']);const iNext=getCol(headers,['下次檢測月份','下次','next']);const iNote=getCol(headers,['備註','note']);
  if(iId<0||iDate<0||iInsp<0){toast('⚠️ 找不到必填欄位（編號、檢測日期、檢測人員）');return;}
  const MON_MAP2={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  function normPlan(raw){const s=(raw||'').trim();if(!s)return'';if(/^\d{4}-\d{2}$/.test(s))return s;const mmy=s.match(/^([A-Za-z]{1,3})-(\d{2,4})$/);if(mmy){const key=mmy[1].toLowerCase().slice(0,3);const mo=MON_MAP2[key];if(mo){const yr=mmy[2].length===2?2000+parseInt(mmy[2],10):parseInt(mmy[2],10);return yr+'-'+String(mo).padStart(2,'0');}}const slash=s.match(/^(\d{1,2})\/(\d{4})$/);if(slash){const m=+slash[1];const y=+slash[2];if(m>=1&&m<=12)return y+'-'+String(m).padStart(2,'0');}if(/^\d{4}-\d{2}-\d{2}$/.test(s))return s.slice(0,7);return'';}
  const parsed=rows.map(r=>{const eqId=(r[iId]||'').trim();const eq=EQ.find(e=>e.id===eqId)||{};const rt=(iResult>=0?r[iResult]||'':'').trim();const rawPlan=iPlan>=0?r[iPlan]||'':'';const plan=normPlan(rawPlan);return{id:uid(),eqId,eqType:eq.type||'',eqSub:eq.subtype||'',eqBrand:eq.brand||'',dept:eq.dept||'',plan,date:(()=>{const raw=(r[iDate]||'').trim();return normDateStr(raw)||raw;})(),insp:(r[iInsp]||'').trim(),result:RESULT_MAP[rt]||'normal',next:normPlan(iNext>=0?r[iNext]||'':''),note:(iNote>=0?r[iNote]||'':'').trim()||''};}).filter(r=>r.eqId&&r.date&&r.insp);
  if(!parsed.length){toast('⚠️ 解析後無有效資料');return;} _pRec=parsed;
  document.getElementById('prev-rec').innerHTML=`<div class="card" style="margin-top:10px"><div class="ch"><div class="ct" style="color:var(--grn)">✅ 預覽：共 ${parsed.length} 筆檢測紀錄</div><div style="display:flex;gap:7px"><button class="btn bp bsm" onclick="confirmImpRec()">確認匯入</button><button class="btn bo bsm" onclick="_pRec=null;document.getElementById('prev-rec').innerHTML=''">取消</button></div></div><div style="overflow-x:auto"><table class="tbl"><thead><tr><th>編號</th><th>排定</th><th>檢測日期</th><th>人員</th><th>結果</th></tr></thead><tbody>${parsed.slice(0,50).map(r=>{const rv=RES[r.result]||RES.normal;return`<tr><td><span style="font-family:var(--M);font-size:10px;color:var(--teal)">${r.eqId}</span></td><td>${r.plan}</td><td>${r.date}</td><td>${r.insp}</td><td><span class="badge ${rv.c}" style="font-size:9.5px">${rv.i} ${rv.l}</span></td></tr>`;}).join('')}${parsed.length>50?`<tr><td colspan="5" style="text-align:center;color:var(--g400);font-size:11px">...另有 ${parsed.length-50} 筆（全部將一併匯入）</td></tr>`:''}</tbody></table></div></div>`;
}
function confirmImpRec(){
  if(!_pRec){toast('❗ 無資料可匯入');return;}
  const count=_pRec.length;
  _pRec.forEach(r=>{REC.push(r);const eq=EQ.find(e=>e.id===r.eqId);if(eq){if(r.result==='edge_ok'&&r.next){const nm=+r.next.split('-')[1];if(nm>=1&&nm<=12){eq.semiAnnual=true;if(!eq.month2)eq.month2=nm;}}eq.status=computeEqStatus(eq);}});
  normalizeLegacyPlans();persistLocal();_pRec=null;document.getElementById('prev-rec').innerHTML='';syncStatuses();renderRec();renderDash();toast(`✅ 檢測紀錄匯入完成（共 ${count} 筆）`);
}
function dlTpl(type){
  const bom='\uFEFF';let csv='',fn='';
  if(type==='eq'){fn='器具清單範本.csv';csv=bom+'編號,器具類型,器具次分類,廠牌,型號,鉛當量(mmPb),所屬單位,排定年/月,是否需半年檢測,半年檢測月份,啟用日期,保管人,備註\nLA-101,鉛衣,衣,MAVIG,BR35,0.35,放射科,6,否,,2023-01-01,王小明,（每年6月）\n';}
  else{fn='檢測紀錄範本.csv';csv=bom+'編號,排定月份,檢測日期,檢測人員,結果,下次檢測月份,備註\nLA-101,2026-06,2026-06-18,林淑芬,正常，堪用,2027-06,\n';}
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));a.download=fn;a.click();toast('📥 範本已下載：'+fn);
}

// ════════════════════════════════════════════════════════════
// SETTINGS
// ════════════════════════════════════════════════════════════
function renderSettings() {
  document.getElementById('set-hosp').value = CFG.hospital || '';
  document.getElementById('set-dept').value = CFG.dept || '';
  renderDeptList(); renderApproverList(); renderCustomFieldList();
  const el = document.getElementById('drive-panel');
  if (el) el.innerHTML = `<div style="padding:11px;background:var(--g50);border-radius:8px;font-size:11.5px;color:var(--g600);line-height:1.7">
    ☁️ 資料自動同步至 Google Sheets<br>
    上次同步：<strong>${_lastSync||'尚未同步'}</strong><br>
    <button class="btn bp bsm" style="margin-top:8px" onclick="syncNow()">🔄 立即同步</button>
  </div>`;
}

function renderDeptList(){
  document.getElementById('dept-list').innerHTML = CFG.depts.map(d=>`<div style="display:flex;align-items:center;gap:3px;background:var(--g100);border-radius:5px;padding:3px 7px;font-size:11.5px">${d}<button onclick="removeDept('${d}')" style="background:none;border:none;cursor:pointer;color:var(--g400);padding:0;line-height:1;font-size:12px">✕</button></div>`).join('');
}
function addDept(){const v=document.getElementById('new-dept').value.trim();if(!v){toast('❗ 請輸入單位名稱');return;}if(CFG.depts.includes(v)){toast('❗ 此單位已存在');return;}CFG.depts.push(v);renderDeptList();document.getElementById('new-dept').value='';}
function removeDept(d){if(!confirm(`確定要移除「${d}」？`))return;CFG.depts=CFG.depts.filter(x=>x!==d);renderDeptList();}

function renderApproverList(){
  const el=document.getElementById('approver-list');if(!el)return;
  el.innerHTML=(CFG.approvers||[]).map(a=>`<div style="display:flex;align-items:center;gap:3px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:5px;padding:3px 9px;font-size:11.5px;color:#166534">🖊 ${a}<button onclick="removeApprover('${a}')" style="background:none;border:none;cursor:pointer;color:#4ade80;padding:0 0 0 4px;line-height:1;font-size:12px">✕</button></div>`).join('')||'<span style="font-size:11px;color:var(--g400)">尚未設定核簽人員</span>';
}
function addApprover(){const v=document.getElementById('new-approver').value.trim();if(!v){toast('❗ 請輸入姓名');return;}if(!CFG.approvers)CFG.approvers=[];if(CFG.approvers.includes(v)){toast('❗ 此人員已存在');return;}CFG.approvers.push(v);renderApproverList();document.getElementById('new-approver').value='';}
function removeApprover(a){CFG.approvers=(CFG.approvers||[]).filter(x=>x!==a);renderApproverList();}
function renderApproverSel(selId){const sel=document.getElementById(selId);if(!sel)return;sel.innerHTML='<option value="">快選</option>'+(CFG.approvers||[]).map(a=>`<option value="${a}">${a}</option>`).join('');}

function renderCustomFieldList(){
  const el=document.getElementById('custom-fields-list');if(!el)return;
  const fields=CFG.customFields||[];
  if(!fields.length){el.innerHTML='<div style="font-size:11px;color:var(--g400);padding:6px 0">尚未新增自訂欄位</div>';return;}
  const scopeLabel={eq:'器具',rec:'紀錄',both:'器具＋紀錄'};
  el.innerHTML=fields.map((f,i)=>`<div style="display:flex;align-items:center;gap:8px;background:#fff;border:1px solid var(--g200);border-radius:7px;padding:8px 11px"><div style="flex:1"><span style="font-size:12px;font-weight:600;color:var(--navy)">${f.name}</span><span style="font-size:10px;color:var(--g400);margin-left:7px">適用：${scopeLabel[f.scope]||f.scope}</span>${f.placeholder?`<span style="font-size:10px;color:var(--g400);margin-left:5px">提示：「${f.placeholder}」</span>`:''}</div><div style="display:flex;gap:4px">${i>0?`<button class="btn bo bxs" onclick="moveCF(${i},-1)">↑</button>`:''} ${i<fields.length-1?`<button class="btn bo bxs" onclick="moveCF(${i},1)">↓</button>`:''}<button class="btn bd bxs" onclick="removeCF('${f.id}')">刪除</button></div></div>`).join('');
}
function addCustomField(){const name=document.getElementById('cf-name').value.trim();const scope=document.getElementById('cf-scope').value;const placeholder=document.getElementById('cf-placeholder').value.trim();if(!name){toast('❗ 請輸入欄位名稱');return;}if(!CFG.customFields)CFG.customFields=[];if(CFG.customFields.find(f=>f.name===name)){toast('❗ 此欄位名稱已存在');return;}const id='cf_'+Date.now().toString(36);CFG.customFields.push({id,name,scope,placeholder});renderCustomFieldList();document.getElementById('cf-name').value='';document.getElementById('cf-placeholder').value='';toast(`✅ 自訂欄位「${name}」已新增`);}
function removeCF(id){if(!confirm('確定要刪除此自訂欄位？\n已儲存的資料不會受影響，但欄位將不再顯示。'))return;CFG.customFields=(CFG.customFields||[]).filter(f=>f.id!==id);renderCustomFieldList();toast('🗑 欄位已刪除');}
function moveCF(i,dir){const arr=CFG.customFields||[];const j=i+dir;if(j<0||j>=arr.length)return;[arr[i],arr[j]]=[arr[j],arr[i]];renderCustomFieldList();}

function renderEqCustomFields(vals){const fields=(CFG.customFields||[]).filter(f=>f.scope==='eq'||f.scope==='both');const wrap=document.getElementById('f-custom-fields-wrap');const body=document.getElementById('f-custom-fields-body');if(!wrap||!body)return;if(!fields.length){wrap.style.display='none';return;}wrap.style.display='block';body.innerHTML=fields.map(f=>`<div class="fg"><label class="fl">${f.name}</label><input class="fi2" id="ecf-${f.id}" placeholder="${f.placeholder||''}" value="${((vals||{})[f.id]||'').replace(/"/g,'&quot;')}"></div>`).join('');}
function renderRecCustomFields(vals){const fields=(CFG.customFields||[]).filter(f=>f.scope==='rec'||f.scope==='both');const wrap=document.getElementById('r-custom-fields-wrap');const body=document.getElementById('r-custom-fields-body');if(!wrap||!body)return;if(!fields.length){wrap.style.display='none';return;}wrap.style.display='block';body.innerHTML=fields.map(f=>`<div class="fg"><label class="fl">${f.name}</label><input class="fi2" id="rcf-${f.id}" placeholder="${f.placeholder||''}" value="${((vals||{})[f.id]||'').replace(/"/g,'&quot;')}"></div>`).join('');}

function saveSettings(){
  CFG.hospital=document.getElementById('set-hosp').value.trim()||'某某醫院';
  CFG.dept=document.getElementById('set-dept').value.trim()||'輻射防護組';
  persistLocal();
  document.getElementById('sf-hospital').textContent=CFG.hospital;
  document.getElementById('sf-dept').textContent=CFG.dept;
  renderDash();toast('✅ 設定已儲存');
}
function clearAll(){[KEYS.eq,KEYS.rec,KEYS.cfg,KEYS.ret,KEYS.auth,KEYS.synced].forEach(k=>localStorage.removeItem(k));location.reload();}

// ════════════════════════════════════════════════════════════
// BATCH ENTRY
// ════════════════════════════════════════════════════════════
let _bRows = [];
function initBatch(){
  const bd=document.getElementById('b-dept');
  if(bd) bd.innerHTML='<option value="">全部單位</option>'+CFG.depts.map(d=>`<option>${d}</option>`).join('');
  const bm=document.getElementById('b-month');
  if(bm&&!bm.value){const now=new Date();bm.value=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');}
  _bRows=[];batchShowStep(1);
}
function batchShowStep(n){[1,2,3].forEach(i=>{document.getElementById('batch-s'+i).style.display=i===n?'block':'none';const stepEl=document.getElementById('bstep-'+i);const dot=i>=2?document.getElementById('bstep'+i+'-dot'):null;if(stepEl){if(i<=n){stepEl.style.background='var(--tp)';stepEl.style.color='var(--teal)';if(dot)dot.style.background='var(--teal)';}else{stepEl.style.background='';stepEl.style.color='var(--g400)';if(dot)dot.style.background='var(--g300)';}}}); }
function batchLoadList(){
  const selMonth=document.getElementById('b-month').value;const selDept=document.getElementById('b-dept').value;const insp=document.getElementById('b-insp').value.trim();const defResult=document.getElementById('b-default-result').value;const incOverdue=document.getElementById('b-inc-overdue').checked;const incPending=document.getElementById('b-inc-pending').checked;const incSemi=document.getElementById('b-inc-semi').checked;
  if(!selMonth){toast('❗ 請選擇檢測月份');return;}if(!insp){toast('❗ 請填寫檢測人員');return;}
  const[selY,selM]=selMonth.split('-').map(Number);syncStatuses();
  const rows=[];
  EQ.forEach(eq=>{if(selDept&&eq.dept!==selDept)return;let reason=null;if(eq.schedYM){const[sy,sm]=eq.schedYM.split('-').map(Number);if(sy===selY&&sm===selM)reason='年度';}else if(eq.month===selM)reason='年度';if(!reason&&eq.semiAnnual&&eq.month2===selM)reason='半年';if(!reason&&eq.status==='overdue')reason='逾期';if(!reason)return;if(reason==='逾期'&&!incOverdue)return;if(reason==='年度'&&!incPending)return;if(reason==='半年'&&!incSemi)return;const alreadyDone=REC.some(r=>r.eqId===eq.id&&r.result!=='pending'&&r.date&&new Date(r.date).getFullYear()===selY&&new Date(r.date).getMonth()+1===selM);rows.push({eq,reason,alreadyDone,date:new Date().toISOString().slice(0,10),result:alreadyDone?'skip':defResult,note:'',insp});});
  if(!rows.length){document.getElementById('b-load-hint').textContent='⚠️ 本月無符合條件的器具，請調整篩選條件';return;}
  document.getElementById('b-load-hint').textContent='';_bRows=rows;batchRenderTable();batchShowStep(2);batchUpdateProgress();
}
const B_RESULTS=[{v:'normal',l:'✅ 正常，堪用'},{v:'edge_ok',l:'⚠️ 邊緣破損，堪用'},{v:'edge_replace',l:'🔶 邊緣破損，建議更換'},{v:'core_replace',l:'🔴 重要防護區破損，建議更換'},{v:'both_replace',l:'🚨 邊緣及重要破損'},{v:'skip',l:'— 跳過（本月已有紀錄）'}];
function batchRenderTable(){
  const tbody=document.getElementById('batch-tbody');
  tbody.innerHTML=_bRows.map((row,i)=>{const reasonBadge=row.reason==='逾期'?`<span class="badge br" style="font-size:9px">逾期</span>`:row.reason==='半年'?`<span class="badge bb" style="font-size:9px">半年</span>`:` <span style="font-size:9px;color:var(--g400)">年度</span>`;const resultOpts=B_RESULTS.map(r=>`<option value="${r.v}"${row.result===r.v?' selected':''}>${r.l}</option>`).join('');const rowBg=row.alreadyDone?'background:#f0fdf4;':'';const statusIcon=row.result==='skip'?'<span>—</span>':row.result==='normal'||row.result==='edge_ok'?'<span style="color:var(--grn)">✓</span>':'<span style="color:var(--red)">⚠</span>';return `<tr id="brow-${i}" style="${rowBg}"><td style="text-align:center;font-family:var(--M);font-size:10px;color:var(--g400)">${i+1}</td><td><div style="display:flex;align-items:center;gap:5px"><span style="font-family:var(--M);font-size:10px;color:var(--teal);font-weight:700">${row.eq.id}</span>${reasonBadge}</div><div style="font-size:10px;color:var(--g400);margin-top:1px">${row.eq.brand||''}</div></td><td style="font-size:11px">${row.eq.type}${row.eq.subtype?'／'+row.eq.subtype:''}</td><td style="font-size:11px">${row.eq.dept}</td><td style="font-family:var(--M);font-size:10px;color:var(--g600)">${row.eq.schedYM||MO[(row.eq.month||1)-1]}</td><td><input type="date" class="fi2" style="font-size:11px;padding:4px 6px" value="${row.date}" ${row.result==='skip'?'disabled style="opacity:.4"':''} onchange="batchSetDate(${i},this.value)"></td><td><select class="fs" style="font-size:11px;padding:4px 6px" onchange="batchSetResult(${i},this.value)">${resultOpts}</select></td><td><input type="text" class="fi2" style="font-size:11px;padding:4px 6px" placeholder="備註..." value="${row.note||''}" ${row.result==='skip'?'disabled style="opacity:.4"':''} oninput="batchSetNote(${i},this.value)"></td><td style="text-align:center;font-size:14px">${statusIcon}</td></tr>`;}).join('');
}
function batchSetDate(i,v){_bRows[i].date=v;batchRefreshRow(i);}
function batchSetResult(i,v){_bRows[i].result=v;batchRefreshRow(i);batchUpdateProgress();}
function batchSetNote(i,v){_bRows[i].note=v;}
function batchRefreshRow(i){const row=_bRows[i];const tr=document.getElementById('brow-'+i);if(!tr)return;const isSkip=row.result==='skip';tr.style.background=isSkip?'#f0fdf4':'';const statusCell=tr.cells[8];if(statusCell)statusCell.innerHTML=isSkip?'<span>—</span>':row.result==='normal'||row.result==='edge_ok'?'<span style="color:var(--grn)">✓</span>':'<span style="color:var(--red)">⚠</span>';const dateInp=tr.querySelector('input[type="date"]');const noteInp=tr.querySelectorAll('input[type="text"]')[0];if(dateInp){dateInp.disabled=isSkip;dateInp.style.opacity=isSkip?'.4':'1';}if(noteInp){noteInp.disabled=isSkip;noteInp.style.opacity=isSkip?'.4':'1';}}
function batchUpdateProgress(){const total=_bRows.length;const filled=_bRows.filter(r=>r.result!=='skip').length;const pct=total?Math.round(filled/total*100):0;const bar=document.getElementById('b-progress-bar');const txt=document.getElementById('b-progress-txt');if(bar)bar.style.width=pct+'%';if(txt)txt.textContent=`（${filled} / ${total} 筆已設定）`;}
function batchApplyAll(){const v=document.getElementById('b-bulk-result').value;if(!v){toast('❗ 請先選擇要套用的結果');return;}_bRows.forEach((r,i)=>{if(!r.alreadyDone){r.result=v;batchRefreshRow(i);}});document.querySelectorAll('#batch-tbody select').forEach((sel,i)=>{if(!_bRows[i].alreadyDone)sel.value=_bRows[i].result;});batchUpdateProgress();toast('✅ 已套用至全部待填器具');}
function batchBack(){batchShowStep(1);}
function batchGoStep2(){batchShowStep(2);batchRenderTable();batchUpdateProgress();}
function batchGoConfirm(){
  const toSave=_bRows.filter(r=>r.result&&r.result!=='skip');if(!toSave.length){toast('❗ 沒有任何可儲存的紀錄（全部已設為跳過）');return;}
  const missing=toSave.filter(r=>!r.date);if(missing.length){toast(`❗ 有 ${missing.length} 筆缺少檢測日期`);return;}
  document.getElementById('b-confirm-title').textContent=`即將儲存 ${toSave.length} 筆紀錄（跳過 ${_bRows.length-toSave.length} 筆）`;
  const warns=toSave.filter(r=>r.result==='edge_replace'||r.result==='core_replace'||r.result==='both_replace');
  document.getElementById('b-confirm-summary').innerHTML=`<div style="display:flex;gap:8px;flex-wrap:wrap"><div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px 14px;flex:1;min-width:110px"><div style="font-size:20px;font-weight:700;color:var(--grn)">${toSave.filter(r=>r.result==='normal').length}</div><div style="font-size:10px;color:#166534;margin-top:2px">正常，堪用</div></div><div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 14px;flex:1;min-width:110px"><div style="font-size:20px;font-weight:700;color:var(--am)">${toSave.filter(r=>r.result==='edge_ok').length}</div><div style="font-size:10px;color:#92400e;margin-top:2px">邊緣破損，堪用</div></div><div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 14px;flex:1;min-width:110px"><div style="font-size:20px;font-weight:700;color:var(--red)">${warns.length}</div><div style="font-size:10px;color:#991b1b;margin-top:2px">建議更換</div></div><div style="background:var(--g100);border:1px solid var(--g200);border-radius:8px;padding:10px 14px;flex:1;min-width:110px"><div style="font-size:20px;font-weight:700;color:var(--g600)">${_bRows.length-toSave.length}</div><div style="font-size:10px;color:var(--g600);margin-top:2px">跳過</div></div></div>`;
  document.getElementById('b-confirm-tbody').innerHTML=toSave.map((r,i)=>{const rv=RES[r.result]||RES.normal;return `<tr><td style="font-family:var(--M);font-size:10px;color:var(--g400)">${i+1}</td><td><span style="font-family:var(--M);font-size:10px;color:var(--teal);font-weight:700">${r.eq.id}</span></td><td style="font-size:11px">${r.eq.type}${r.eq.subtype?'／'+r.eq.subtype:''}</td><td style="font-size:11px">${r.eq.dept}</td><td style="font-family:var(--M);font-size:10.5px">${r.date}</td><td><span class="badge ${rv.c}" style="font-size:9.5px;white-space:normal">${rv.i} ${rv.l}</span></td><td style="font-size:10.5px;color:var(--g600)">${r.note||'—'}</td></tr>`;}).join('');
  batchShowStep(3);
}
function batchSaveAll(){
  const selMonth=document.getElementById('b-month').value;const toSave=_bRows.filter(r=>r.result&&r.result!=='skip');if(!toSave.length)return;
  toSave.forEach(row=>{const eq=row.eq;REC.push({id:uid(),eqId:eq.id,eqType:eq.type||'',eqSub:eq.subtype||'',eqBrand:eq.brand||'',dept:eq.dept||'',plan:selMonth,date:row.date,insp:row.insp,result:row.result,note:row.note||'',next:''});eq.status=computeEqStatus(eq);});
  persistLocal();syncStatuses();const btn=document.getElementById('b-save-btn');if(btn){btn.disabled=true;btn.textContent='✅ 已儲存';}
  toast(`✅ 已儲存 ${toSave.length} 筆批次檢測紀錄`);
  setTimeout(()=>{_bRows=[];initBatch();document.getElementById('b-load-hint').textContent=`🎉 上次批次登錄成功儲存 ${toSave.length} 筆`;},1200);
}

// ════════════════════════════════════════════════════════════
// MODAL & TOAST
// ════════════════════════════════════════════════════════════
function openModal(id){document.getElementById(id).classList.add('open');document.body.style.overflow='hidden';}
function closeModal(id){document.getElementById(id).classList.remove('open');document.body.style.overflow='';}
document.querySelectorAll('.ov').forEach(o=>o.addEventListener('click',e=>{if(e.target===o)closeModal(o.id);}));
document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelectorAll('.ov.open').forEach(o=>closeModal(o.id));});
let _tt;
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');clearTimeout(_tt);_tt=setTimeout(()=>t.classList.remove('show'),3200);}

// ════════════════════════════════════════════════════════════
// 初始化
// ════════════════════════════════════════════════════════════
function initApp() {
  document.getElementById('sf-hospital').textContent = CFG.hospital;
  document.getElementById('sf-dept').textContent     = CFG.dept;
  syncStatuses();
  save(KEYS.eq,  EQ);
  save(KEYS.rec, REC);
  refreshSelects();
  renderDash();
  setSyncSt('con', _lastSync ? '已同步 ' + _lastSync : '已連線');
  // 背景從 Sheets 載入最新資料
  loadFromSheets();
}

// 頁面載入時先檢查是否已驗證
window.addEventListener('DOMContentLoaded', () => {
  // 手機 sidebar overlay 點擊關閉
  document.querySelector('.sb-overlay')?.addEventListener('click', closeSidebar);

  const pwd = getStoredPwd();
  if (pwd) {
    // 有快取密碼：先用本機快取顯示畫面，背景驗證
    document.getElementById('lock-screen').style.display = 'none';
    initApp();
  } else {
    // 無密碼：顯示鎖定畫面
    document.getElementById('lock-screen').style.display = 'flex';
    // Enter 鍵觸發登入
    document.getElementById('lock-pwd')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') handleLogin();
    });
  }
});
// ════════════════════════════════════════════════════════════
// 器具履歷
// ════════════════════════════════════════════════════════════
function initHistory() {
  // 器具編號下拉
  const eqSel = document.getElementById('hist-eq');
  if (eqSel) {
    eqSel.innerHTML = EQ.map(e =>
      `<option value="${e.id}">${e.id} — ${e.type}${e.subtype?'／'+e.subtype:''}（${e.dept}）</option>`
    ).join('');
  }
  // 年度下拉
  const years = buildYears();
  const curY  = String(new Date().getFullYear());
  ['hist-yr1','hist-yr2'].forEach((id, i) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = years.map(y =>
      `<option value="${y}" ${(i===0 ? y===curY : y===curY) ? 'selected':''}>${y}</option>`
    ).join('');
  });
}

function historySearch() {
  const eqId = document.getElementById('hist-eq')?.value;
  const yr1  = +document.getElementById('hist-yr1')?.value;
  const yr2  = +document.getElementById('hist-yr2')?.value;
  if (!eqId) { toast('❗ 請選擇器具編號'); return; }
  if (yr1 > yr2) { toast('❗ 起始年度不能大於結束年度'); return; }

  const eq = EQ.find(e => e.id === eqId);
  const recs = REC
    .filter(r => {
      if (r.eqId !== eqId || r.result === 'pending' || !r.date) return false;
      const y = +r.date.slice(0, 4);
      return y >= yr1 && y <= yr2;
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const result = document.getElementById('hist-result');
  if (!result) return;

  if (!recs.length) {
    result.innerHTML = `<div class="card cb te">此器具在 ${yr1}～${yr2} 年度內無檢測紀錄</div>`;
    return;
  }

  // 器具基本資料
  const eqInfo = eq ? `
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
      <div style="font-size:16px;font-weight:700;color:var(--navy);font-family:var(--M)">${eq.id}</div>
      <span class="badge bgr">${eq.type}${eq.subtype?'／'+eq.subtype:''}</span>
      <span class="badge bgr">${eq.dept}</span>
      <span class="badge bb">${eq.lead} mmPb</span>
      <span class="badge ${SM[eq.status]||'bgr'}">${SL[eq.status]||eq.status}</span>
    </div>` : '';

  // 時間軸
  const timeline = recs.map((r, i) => {
    const rv = RES[r.result] || RES.pending;
    const isLast = i === recs.length - 1;
    const dotColor = {
      normal: 'var(--grn)', edge_ok: 'var(--am)',
      edge_replace: '#f97316', core_replace: 'var(--red)', both_replace: '#991b1b'
    }[r.result] || 'var(--g300)';
    return `
      <div style="display:flex;gap:12px;align-items:flex-start">
        <div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0">
          <div style="width:14px;height:14px;border-radius:50%;background:${dotColor};border:2px solid #fff;box-shadow:0 0 0 2px ${dotColor};margin-top:3px"></div>
          ${!isLast?`<div style="width:2px;flex:1;background:var(--g200);min-height:30px;margin:4px 0"></div>`:''}
        </div>
        <div style="flex:1;padding-bottom:${isLast?'0':'16px'}">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
            <span style="font-size:12px;font-weight:700;color:var(--navy);font-family:var(--M)">${r.date}</span>
            <span class="badge ${rv.c}">${rv.i} ${rv.l}</span>
            ${r.plan?`<span style="font-size:10px;color:var(--g400)">排定：${r.plan}</span>`:''}
          </div>
          <div style="font-size:11px;color:var(--g600);display:flex;gap:12px;flex-wrap:wrap">
            ${r.insp?`<span>👤 ${r.insp}</span>`:''}
            ${r.approver?`<span>🖊 ${r.approver}</span>`:''}
            ${r.next?`<span>📅 下次：${r.next}</span>`:''}
          </div>
          ${r.note?`<div style="font-size:11px;color:#78350f;background:#fffbeb;border:1px solid #fde68a;border-radius:5px;padding:5px 8px;margin-top:5px">📝 ${r.note}</div>`:''}
        </div>
      </div>`;
  }).join('');

  // 統計摘要
  const total   = recs.length;
  const passN   = recs.filter(r => r.result === 'normal').length;
  const warnN   = recs.filter(r => r.result === 'edge_ok').length;
  const failN   = recs.filter(r => ['edge_replace','core_replace','both_replace'].includes(r.result)).length;

  result.innerHTML = `
    <div class="card cb">
      ${eqInfo}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
        <div style="background:var(--g50);border:1px solid var(--g200);border-radius:8px;padding:9px 14px;flex:1;min-width:80px;text-align:center">
          <div style="font-size:20px;font-weight:700;color:var(--navy)">${total}</div>
          <div style="font-size:10px;color:var(--g400);margin-top:2px">總檢測次數</div>
        </div>
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:9px 14px;flex:1;min-width:80px;text-align:center">
          <div style="font-size:20px;font-weight:700;color:var(--grn)">${passN}</div>
          <div style="font-size:10px;color:#166534;margin-top:2px">正常堪用</div>
        </div>
        <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:9px 14px;flex:1;min-width:80px;text-align:center">
          <div style="font-size:20px;font-weight:700;color:var(--am)">${warnN}</div>
          <div style="font-size:10px;color:#92400e;margin-top:2px">邊緣堪用</div>
        </div>
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:9px 14px;flex:1;min-width:80px;text-align:center">
          <div style="font-size:20px;font-weight:700;color:var(--red)">${failN}</div>
          <div style="font-size:10px;color:#991b1b;margin-top:2px">建議更換</div>
        </div>
      </div>
      <div style="font-size:11px;font-weight:700;color:var(--navy);margin-bottom:10px;display:flex;align-items:center;gap:7px">
        檢測時間軸
        <span style="flex:1;height:1px;background:var(--g200);display:block"></span>
        <span style="font-weight:400;color:var(--g400)">${yr1} ～ ${yr2} 年度</span>
      </div>
      <div style="padding-left:4px">${timeline}</div>
    </div>`;
}
