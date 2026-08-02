/* ========================================================================
 * 博智托管 - 管理工作台  (电脑 + H5 双端, 数据互通)
 * 数据存储: localStorage  (两端访问同一域名即可互通)
 * ====================================================================== */

const DB = (() => {
  const KEY = 'bozhi_trustee_data_v1';
  const CONFIG_KEY = 'bozhi_trustee_cloud_config';
  const defaults = {
    students: [],
    teachers: [],
    hourLogs: [],        // 小课课时消耗记录
    payments: [],        // 缴费记录
    teacherShares: [],   // 教师消课分享链接 [{id, teacherId, code, createdAt, revokedAt}]
    settings: {
      orgName: '博智托管',
      // 默认分成比例: 教师拿 60%, 托管 40%
      defaultShareRate: 60,
    },
  };
  let cache = null;

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) { cache = JSON.parse(JSON.stringify(defaults)); save(); }
      else cache = JSON.parse(raw);
      // 容错
      ['students','teachers','hourLogs','payments','teacherShares'].forEach(k => {
        if (!Array.isArray(cache[k])) cache[k] = [];
      });
      if (!cache.settings) cache.settings = JSON.parse(JSON.stringify(defaults.settings));
    } catch (e) {
      cache = JSON.parse(JSON.stringify(defaults));
      save();
    }
    return cache;
  }
  function save() {
    if (!cache) cache = JSON.parse(JSON.stringify(defaults));
    localStorage.setItem(KEY, JSON.stringify(cache));
  }
  function get() { if (!cache) load(); return cache; }
  function persist() { save(); }
  function reset() { cache = JSON.parse(JSON.stringify(defaults)); save(); }

  /* ---- 云端配置 ---- */
  function getCloudConfig() {
    try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}'); }
    catch { return {}; }
  }
  function setCloudConfig(cfg) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  }
  function clearCloudConfig() {
    localStorage.removeItem(CONFIG_KEY);
  }

  /* ---- 云端同步 (Supabase) ----
   * 数据表结构 (在 Supabase SQL Editor 执行):
   *   create table bozhi_data (
   *     id text primary key,         -- 固定值 'main'
   *     payload jsonb not null,      -- 完整数据
   *     updated_at timestamptz default now()
   *   );
   *   alter table bozhi_data enable row level security;
   *   create policy "public all" on bozhi_data for all using (true) with check (true);
   *
   * 启用后: 每次 persist() 自动推送, 启动时自动拉取
   */
  async function cloudPush() {
    const cfg = getCloudConfig();
    if (!cfg.url || !cfg.key || !cfg.enabled) return { ok: false, reason: 'disabled' };
    try {
      const resp = await fetch(`${cfg.url}/rest/v1/bozhi_data?id=eq.main`, {
        method: 'PATCH',
        headers: {
          'apikey': cfg.key,
          'Authorization': `Bearer ${cfg.key}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          payload: cache,
          updated_at: new Date().toISOString(),
        }),
      });
      if (!resp.ok) {
        // 可能记录不存在, 尝试 UPSERT
        const resp2 = await fetch(`${cfg.url}/rest/v1/bozhi_data`, {
          method: 'POST',
          headers: {
            'apikey': cfg.key,
            'Authorization': `Bearer ${cfg.key}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({
            id: 'main',
            payload: cache,
            updated_at: new Date().toISOString(),
          }),
        });
        return { ok: resp2.ok, status: resp2.status };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function cloudPull() {
    const cfg = getCloudConfig();
    if (!cfg.url || !cfg.key || !cfg.enabled) return { ok: false, reason: 'disabled' };
    try {
      const resp = await fetch(`${cfg.url}/rest/v1/bozhi_data?id=eq.main&select=payload,updated_at`, {
        headers: {
          'apikey': cfg.key,
          'Authorization': `Bearer ${cfg.key}`,
        },
      });
      if (!resp.ok) return { ok: false, status: resp.status };
      const arr = await resp.json();
      if (!arr.length) return { ok: false, reason: 'empty' };
      const row = arr[0];
      const remote = row.payload;
      if (!remote || !Array.isArray(remote.students)) return { ok: false, reason: 'bad_format' };
      // 比较时间戳: 仅当远端更新时覆盖本地
      const localTs = localStorage.getItem('bozhi_trustee_last_sync') || '0';
      const remoteTs = row.updated_at || '';
      cache = remote;
      save();
      localStorage.setItem('bozhi_trustee_last_sync', remoteTs || new Date().toISOString());
      return { ok: true, updated_at: remoteTs };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // 包装 persist: 同时推送云端 (防抖)
  let pushTimer = null;
  function persistWithSync() {
    save();
    const cfg = getCloudConfig();
    if (!cfg.enabled) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { cloudPush(); }, 800);
  }

  return {
    load, get, save,
    persist: persistWithSync,
    reset,
    cloudPush, cloudPull,
    getCloudConfig, setCloudConfig, clearCloudConfig,
  };
})();

/* ---------- 工具 ---------- */
const $ = (s, p=document) => p.querySelector(s);
const $$ = (s, p=document) => Array.from(p.querySelectorAll(s));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,6);
const fmtMoney = (n) => '¥' + (Number(n)||0).toFixed(2).replace(/\.00$/,'');
const fmtDate = (ts) => ts ? new Date(ts).toLocaleDateString('zh-CN') : '-';
const today = () => new Date().toISOString().slice(0,10);
const thisMonth = () => new Date().toISOString().slice(0,7);
const monthNav = (m, d) => {
  const [y, mm] = m.split('-').map(Number);
  const dt = new Date(y, mm-1+d, 1);
  return dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0');
};

/* Toast */
function toast(msg, type='success') {
  const box = $('#toastBox') || (() => {
    const d = document.createElement('div');
    d.id = 'toastBox';
    d.className = 'toast-container';
    document.body.appendChild(d);
    return d;
  })();
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  const icons = {success:'✅',error:'❌',warning:'⚠️',info:'ℹ️'};
  t.innerHTML = `<span class="toast-icon">${icons[type]||'✅'}</span><span>${msg}</span>`;
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform='translateX(20px)'; setTimeout(()=>t.remove(),300); }, 2500);
}

/* ---------- 常量 ---------- */
const ENROLL_TYPES = [
  { key: 'summer',    label: '暑期班', cls: 'tag-orange' },
  { key: 'evening',   label: '晚辅导', cls: 'tag-cyan' },
  { key: 'weekend',   label: '周末托', cls: 'tag-green' },
  { key: 'private',   label: '小课',   cls: 'tag-purple' },
];

const PAY_MODES = [
  { key: 'monthly',   label: '按月缴纳' },
  { key: 'one_time',  label: '一次性缴纳' },
];

const GRADES = ['一年级','二年级','三年级','四年级','五年级','六年级','初一','初二','初三'];

const DEPTS = ['小学部','初中部'];

/* 教师职级示例 */
const TEACHER_LEVELS = ['初级教师','中级教师','高级教师','骨干教师','学科带头人'];

/* ======================================================================
 *  主应用
 * ==================================================================== */
const App = {
  view: 'dashboard',
  device: 'desktop',
  shareMode: false,        // 是否为教师消课分享模式
  shareTeacherId: null,    // 分享模式对应的教师ID
  state: {
    currentMonth: thisMonth(),
    editingStudentId: null,
    editingTeacherId: null,
    detailTab: 'info',
    search: '',
    filterType: '',
    filterDept: '',
    attendanceTab: 'teacher',
    shareTab: 'consume',   // 教师分享端: 'consume' | 'attendance'
  },

  init() {
    DB.load();
    this.detectDevice();
    this.bind();
    // 异步初始化: 先拉云端, 再判定分享模式, 最后渲染
    this.asyncInit();
    // 兜底: 先用本地数据渲染一次 (避免白屏)
    this.checkShareMode();
    this.render();
    // 监听窗口尺寸切换
    window.addEventListener('resize', () => {
      const nd = window.innerWidth < 768 ? 'mobile' : 'desktop';
      if (nd !== this.device) { this.device = nd; this.render(); }
    });
    // 监听 hash 变化
    window.addEventListener('hashchange', () => {
      const wasShare = this.shareMode;
      this.checkShareMode();
      if (wasShare !== this.shareMode) this.render();
    });
    // 监听其他标签页的 localStorage 变化
    window.addEventListener('storage', (e) => {
      if (e.key === 'bozhi_trustee_data_v1') {
        DB.load();
        this.checkShareMode();
        this.render();
      }
    });
  },

  async asyncInit() {
    const cfg = DB.getCloudConfig();
    if (!cfg.enabled) {
      // 未启用云端, 如果是分享链接且本地无数据, 提示
      if (location.hash.includes('share=')) {
        this.showShareError('云端同步未启用', '请联系管理员开启云端同步，否则无法跨设备使用分享链接。');
      }
      return;
    }
    // 已启用云端: 先拉取最新数据
    const result = await DB.cloudPull();
    if (result.ok) {
      // 拉取成功, 如果有待验证的分享码, 现在重新查找
      if (this._shareCodePending) {
        const share = DB.get().teacherShares.find(s => s.code === this._shareCodePending && !s.revokedAt);
        if (share) {
          this.shareTeacherId = share.teacherId;
          this._shareCodePending = null;
        } else {
          // 分享码无效
          this.shareMode = false;
          this.shareTeacherId = null;
          this._shareCodePending = null;
          this.showShareError('链接无效', '此分享链接不存在或已被作废，请联系管理员重新生成。');
          return;
        }
      }
      this.render();
      if (location.hash.includes('share=')) {
        toast('数据加载完成', 'success');
      } else {
        toast('已从云端同步最新数据', 'info');
      }
    } else if (result.reason === 'empty') {
      // 云端没数据, 推送本地上去 (管理员首次使用)
      const pushResult = await DB.cloudPush();
      if (pushResult.ok) toast('本地数据已上传云端', 'success');
      this.checkShareMode();
      this.render();
    } else {
      // 拉取失败
      console.warn('云端同步失败:', result);
      if (location.hash.includes('share=')) {
        this.showShareError('云端连接失败', '错误: ' + (result.error || result.reason || '未知') + '。请检查网络或联系管理员。');
      } else {
        toast('云端同步失败: ' + (result.error || result.reason || ''), 'error');
      }
    }
  },

  showShareError(title, msg) {
    const root = $('#app');
    if (root) {
      root.innerHTML = `
        <div class="topbar" style="background:linear-gradient(135deg,#ea4335 0%,#c5221e 100%)">
          <div class="topbar-logo">
            <span class="logo-icon" style="background:#fff;color:#ea4335">博</span>
            <span>${DB.get().settings.orgName} · 消课端</span>
          </div>
        </div>
        <div class="main" style="margin-left:0">
          <div class="card">
            <div class="empty-state">
              <div class="empty-state-icon" style="font-size:56px">🔒</div>
              <div style="font-size:18px;font-weight:600;margin:12px 0 6px">${title}</div>
              <div style="color:var(--text-light);max-width:400px;margin:0 auto 16px">${msg}</div>
              <button class="btn btn-primary" onclick="location.hash=''">返回工作台</button>
            </div>
          </div>
        </div>
      `;
    }
  },

  checkShareMode() {
    // 管理员共享链接: #admin=1&c=xxxx
    const am = location.hash.match(/admin=1/);
    if (am) {
      // 解析云端配置
      const cm = location.hash.match(/c=([^&]+)/);
      if (cm) {
        try {
          const decoded = JSON.parse(decodeURIComponent(escape(atob(cm[1]))));
          if (decoded.u && decoded.k) {
            const existing = DB.getCloudConfig();
            if (!existing.url || !existing.key || !existing.enabled) {
              DB.setCloudConfig({ url: decoded.u, key: decoded.k, enabled: true });
            }
          }
        } catch (e) { console.warn('解析管理员云端配置失败', e); }
      }
      // 管理员链接清理 hash, 进入正常工作台模式 (会自动触发 asyncInit 拉取数据)
      this.shareMode = false;
      this.shareTeacherId = null;
      // 不清理 hash, 否则刷新后又变成普通链接 (首次加载后由 asyncInit 处理)
      return;
    }

    // 教师消课分享链接: #share=xxxx&c=xxxx
    const m = location.hash.match(/share=([a-z0-9]+)/i);
    if (!m) { this.shareMode = false; this.shareTeacherId = null; return; }
    const code = m[1];

    // 从 URL 解析云端配置 (老师设备首次打开时, 本地没有配置)
    const cm = location.hash.match(/c=([^&]+)/);
    if (cm) {
      try {
        const decoded = JSON.parse(decodeURIComponent(escape(atob(cm[1]))));
        if (decoded.u && decoded.k) {
          const existing = DB.getCloudConfig();
          if (!existing.url || !existing.key) {
            DB.setCloudConfig({ url: decoded.u, key: decoded.k, enabled: true });
          }
        }
      } catch (e) { console.warn('解析云端配置失败', e); }
    }

    const share = DB.get().teacherShares.find(s => s.code === code && !s.revokedAt);
    if (share) {
      this.shareMode = true;
      this.shareTeacherId = share.teacherId;
      this.view = 'shareConsume';
    } else {
      // 分享码本地找不到 — 可能是新设备, 数据还没从云端拉下来
      this.shareMode = true;
      this.shareTeacherId = null;
      this.view = 'shareConsume';
      this._shareCodePending = code;
    }
  },

  detectDevice() {
    const ua = navigator.userAgent;
    const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || window.innerWidth < 768;
    this.device = isMobile ? 'mobile' : 'desktop';
  },

  bind() {
    document.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-nav]');
      if (nav) {
        this.view = nav.dataset.nav;
        this.closeSidebar();
        this.render();
      }
      const close = e.target.closest('[data-close-modal]');
      if (close) this.closeModal();
    });
  },

  /* ---------- 主渲染 ---------- */
  render() {
    const root = $('#app');
    root.innerHTML = this.renderShell();
    this.afterRender();
  },

  renderShell() {
    if (this.shareMode) {
      return `
        ${this.renderShareTopbar()}
        ${this.renderMain()}
        <div id="modalRoot"></div>
      `;
    }
    return `
      ${this.renderTopbar()}
      ${this.renderSidebar()}
      <div class="sidebar-overlay" id="sidebarOverlay" onclick="App.closeSidebar()"></div>
      ${this.renderMain()}
      <div id="modalRoot"></div>
    `;
  },

  renderShareTopbar() {
    const t = DB.get().teachers.find(x=>x.id===this.shareTeacherId);
    const tab = this.state.shareTab || 'consume';
    return `
      <div class="topbar" style="background:linear-gradient(135deg,#34a853 0%,#2d8a47 100%)">
        <div class="topbar-logo">
          <span class="logo-icon" style="background:#fff;color:#34a853">博</span>
          <span>${DB.get().settings.orgName} · 教师端</span>
        </div>
        <div class="topbar-nav" style="display:flex;gap:4px">
          <button class="btn btn-sm share-tab-btn" style="background:${tab==='consume'?'rgba(255,255,255,.25)':'rgba(255,255,255,.1)'};color:#fff;border:none" onclick="App.state.shareTab='consume'; App.render()">⏱️ 消课</button>
          <button class="btn btn-sm share-tab-btn" style="background:${tab==='attendance'?'rgba(255,255,255,.25)':'rgba(255,255,255,.1)'};color:#fff;border:none" onclick="App.state.shareTab='attendance'; App.render()">📅 考勤</button>
        </div>
        <div class="topbar-actions">
          <span class="date-now">${t ? '欢迎, ' + t.name : '教师'}</span>
        </div>
      </div>
    `;
  },

  renderTopbar() {
    const now = new Date();
    const dateStr = `${now.getFullYear()}年${now.getMonth()+1}月${now.getDate()}日`;
    return `
      <div class="topbar">
        <button class="menu-toggle" onclick="App.openSidebar()">☰</button>
        <div class="topbar-logo">
          <span class="logo-icon">博</span>
          <span>${DB.get().settings.orgName}</span>
        </div>
        <div class="topbar-actions">
          <span class="date-now">${dateStr}</span>
          <button class="btn btn-sm" style="background:rgba(255,255,255,.15);color:#fff" onclick="App.toggleDevice()">
            ${this.device==='desktop' ? '🖥️ 电脑' : '📱 移动'}
          </button>
        </div>
      </div>
    `;
  },

  renderSidebar() {
    const navs = [
      { key: 'dashboard', label: '工作台',   icon: '🏠', group: '主要' },
      { key: 'students',  label: '学生管理', icon: '👥', group: '主要' },
      { key: 'teachers',  label: '教师管理', icon: '🧑‍🏫', group: '主要' },
      { key: 'attendance',label: '考勤管理', icon: '📅', group: '业务' },
      { key: 'hours',     label: '课时消耗', icon: '⏱️', group: '业务' },
      { key: 'salary',    label: '工资结算', icon: '💸', group: '业务' },
      { key: 'finance',   label: '收支总览', icon: '📊', group: '业务' },
      { key: 'settings',  label: '系统设置', icon: '⚙️', group: '系统' },
    ];
    const groups = ['主要', '业务', '系统'];
    const cloudOn = DB.getCloudConfig().enabled;
    return `
      <div class="sidebar" id="sidebar">
        ${groups.map(g => `
          <div class="sidebar-section">
            <div class="sidebar-section-title">${g}</div>
            ${navs.filter(n=>n.group===g).map(n => `
              <div class="sidebar-item ${this.view===n.key?'active':''}" data-nav="${n.key}">
                <span class="nav-icon">${n.icon}</span>
                <span>${n.label}</span>
              </div>
            `).join('')}
          </div>
        `).join('')}
        <div class="sidebar-footer">
          ${cloudOn ? '☁️ 云端同步已启用' : '💾 本地存储模式'}<br>
          v2.0 · 博智托管
        </div>
      </div>
    `;
  },

  openSidebar() {
    $('#sidebar')?.classList.add('open');
    $('#sidebarOverlay')?.classList.add('show');
  },

  closeSidebar() {
    $('#sidebar')?.classList.remove('open');
    $('#sidebarOverlay')?.classList.remove('show');
  },

  toggleDevice() {
    this.device = this.device === 'desktop' ? 'mobile' : 'desktop';
    this.render();
  },

  renderMain() {
    const mainClass = this.device === 'mobile' ? 'main mobile-main' : 'main';
    let content = '';
    if (this.shareMode) {
      const tab = this.state.shareTab || 'consume';
      content = tab === 'attendance' ? this.viewShareAttendance() : this.viewShareConsume();
      return `<div class="${mainClass}">${content}</div>`;
    }
    switch (this.view) {
      case 'dashboard': content = this.viewDashboard(); break;
      case 'students':  content = this.viewStudents(); break;
      case 'teachers':  content = this.viewTeachers(); break;
      case 'attendance':content = this.viewAttendance(); break;
      case 'salary':    content = this.viewSalary(); break;
      case 'hours':     content = this.viewHours(); break;
      case 'finance':   content = this.viewFinance(); break;
      case 'settings':  content = this.viewSettings(); break;
      default: content = this.viewDashboard();
    }
    return `<div class="${mainClass}">${content}</div>`;
  },

  afterRender() {
    // nothing
  },

  /* ====================================================================
   *  视图: 工作台
   * ================================================================== */
  viewDashboard() {
    const d = DB.get();
    const students = d.students;
    const teachers = d.teachers;
    const totalIncome = d.payments.reduce((s,p)=>s+(Number(p.amount)||0),0);

    // 学生报名分布
    const typeCount = {};
    ENROLL_TYPES.forEach(t => typeCount[t.key] = 0);
    students.forEach(s => (s.enrollTypes||[]).forEach(t => typeCount[t] = (typeCount[t]||0)+1));

    // 本月工资合计 (估算)
    const monthSalary = teachers.reduce((sum,t) => sum + this.calcTeacherSalary(t, this.state.currentMonth).total, 0);

    return `
      <div class="stats-grid">
        ${this.statCard('green','👥', students.length, '在册学生', `本月新增 ${students.filter(s=>s.createdAt&&s.createdAt.startsWith(this.state.currentMonth)).length} 人`)}
        ${this.statCard('blue','🧑‍🏫', teachers.length, '在职教师', `初中部 ${teachers.filter(t=>t.dept==='初中部').length} 人`)}
        ${this.statCard('orange','💰', fmtMoney(totalIncome), '累计收费', `${d.payments.length} 笔缴费记录`)}
        ${this.statCard('red','💸', fmtMoney(monthSalary), '本月工资支出', this.state.currentMonth)}
        ${this.statCard('purple','📚', d.hourLogs.length, '课时消耗记录', '小课专属')}
        ${this.statCard('cyan','🗓️', this.remainingThisMonth(), '本月剩余', '距月底天数')}
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="title-icon"></span>报名类型分布</div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:16px">
          ${ENROLL_TYPES.map(t => `
            <div style="flex:1;min-width:160px;background:#f9fafb;border-radius:8px;padding:16px;text-align:center">
              <div style="font-size:24px;font-weight:700;color:var(--primary)">${typeCount[t.key]||0}</div>
              <div style="font-size:12px;color:var(--text-light);margin-top:4px">${t.label}</div>
              <div style="margin-top:8px;height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden">
                <div style="width:${students.length?(typeCount[t.key]||0)/students.length*100:0}%;height:100%;background:var(--primary);border-radius:3px"></div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="title-icon"></span>近期缴费记录</div>
          <button class="btn btn-secondary btn-sm" data-nav="students">查看全部 →</button>
        </div>
        ${this.renderPaymentMiniTable(d.payments.slice(-5).reverse())}
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="title-icon"></span>快捷操作</div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px">
          <button class="btn btn-primary" onclick="App.openStudentForm()">➕ 新增学生</button>
          <button class="btn btn-success" onclick="App.openTeacherForm()">➕ 新增教师</button>
          <button class="btn btn-secondary" onclick="App.openConsumePanel()">⚡ 快速消课</button>
          <button class="btn btn-secondary" data-nav="salary">💰 工资结算</button>
          <button class="btn btn-secondary" onclick="App.exportExcel('all')">📊 导出Excel</button>
        </div>
      </div>
    `;
  },

  statCard(color, icon, value, label, sub='') {
    return `
      <div class="stat-card">
        <div class="stat-icon ${color}">${icon}</div>
        <div class="stat-info">
          <div class="stat-label">${label}</div>
          <div class="stat-value">${value}</div>
          ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
        </div>
      </div>
    `;
  },

  remainingThisMonth() {
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth()+1, 0);
    return Math.max(0, end.getDate() - now.getDate());
  },

  renderPaymentMiniTable(payments) {
    if (!payments.length) return `<div class="empty-state"><div class="empty-state-icon">📭</div><div class="empty-state-text">暂无缴费记录</div></div>`;
    return `
      <div class="table-wrap">
        <table>
          <thead><tr><th>学生</th><th>项目</th><th>金额</th><th>方式</th><th>日期</th></tr></thead>
          <tbody>
            ${payments.map(p => {
              const s = DB.get().students.find(x=>x.id===p.studentId);
              const etype = ENROLL_TYPES.find(x=>x.key===p.enrollType);
              return `<tr>
                <td>${s?s.name:'已删除'}</td>
                <td>${etype ? `<span class="tag ${etype.cls}">${etype.label}</span>` : '-'}</td>
                <td><strong>${fmtMoney(p.amount)}</strong></td>
                <td><span class="tag ${p.mode==='monthly'?'tag-blue':'tag-green'}">${p.mode==='monthly'?'按月':'一次性'}</span></td>
                <td>${fmtDate(p.date)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  },

  /* ====================================================================
   *  视图: 学生管理
   * ================================================================== */
  viewStudents() {
    const d = DB.get();
    let list = d.students;
    if (this.state.search) {
      const kw = this.state.search.toLowerCase();
      list = list.filter(s =>
        s.name.toLowerCase().includes(kw) ||
        (s.phone||'').includes(kw) ||
        (s.school||'').includes(kw)
      );
    }
    if (this.state.filterType) {
      list = list.filter(s => (s.enrollTypes||[]).includes(this.state.filterType));
    }

    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="title-icon"></span>学生列表</div>
          <button class="btn btn-primary" onclick="App.openStudentForm()">➕ 新增学生</button>
        </div>
        <div class="toolbar">
          <div class="search-box">
            <input type="text" placeholder="搜索姓名 / 电话 / 学校" value="${this.state.search}"
              oninput="App.state.search=this.value; App.renderStudentsList()">
          </div>
          <select class="filter-select" onchange="App.state.filterType=this.value; App.render()">
            <option value="">全部类型</option>
            ${ENROLL_TYPES.map(t => `<option value="${t.key}" ${this.state.filterType===t.key?'selected':''}>${t.label}</option>`).join('')}
          </select>
          <div style="margin-left:auto;font-size:12px;color:var(--text-light)">共 ${list.length} 名</div>
        </div>
        <div id="studentList">${this.renderStudentTable(list)}</div>
      </div>
    `;
  },

  renderStudentsList() {
    const el = $('#studentList');
    if (el) el.innerHTML = this.renderStudentTable(this.getFilteredStudents());
  },

  getFilteredStudents() {
    let list = DB.get().students;
    if (this.state.search) {
      const kw = this.state.search.toLowerCase();
      list = list.filter(s =>
        s.name.toLowerCase().includes(kw) ||
        (s.phone||'').includes(kw) ||
        (s.school||'').includes(kw)
      );
    }
    if (this.state.filterType) list = list.filter(s => (s.enrollTypes||[]).includes(this.state.filterType));
    return list;
  },

  renderStudentTable(list) {
    if (!list.length) return `<div class="empty-state"><div class="empty-state-icon">👥</div><div class="empty-state-text">暂无学生，点击"新增学生"添加</div></div>`;
    return `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>姓名</th>
              <th>年级</th>
              <th>报名类型</th>
              <th>任课教师</th>
              <th>剩余课时</th>
              <th>电话</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${list.map(s => {
              const bindings = s.teacherBindings || [];
              const d = DB.get();
              const teacherNames = bindings.map(b => {
                const t = d.teachers.find(x=>x.id===b.teacherId);
                return t ? t.name : '';
              }).filter(Boolean);
              return `<tr>
                <td><strong>${s.name}</strong></td>
                <td>${s.grade||'-'}</td>
                <td>${(s.enrollTypes||[]).map(t => {
                  const f = ENROLL_TYPES.find(x=>x.key===t);
                  return f ? `<span class="tag ${f.cls}">${f.label}</span>` : '';
                }).join('')}</td>
                <td>${teacherNames.length ? teacherNames.map(n=>`<span class="tag tag-blue">${n}</span>`).join(' ') : '-'}</td>
                <td>${(s.enrollTypes||[]).includes('private') ? (() => {
                  const ths = s.teacherHours || [];
                  if (ths.length) {
                    return ths.map(th => {
                      const t = DB.get().teachers.find(x=>x.id===th.teacherId);
                      return `<span class="hour-badge">${t?t.name:'?'}: ${th.hours||0}</span>`;
                    }).join(' ');
                  }
                  return `<span class="hour-badge">${s.remainHours||0} 课时</span>`;
                })() : '—'}</td>
                <td>${s.phone||'-'}</td>
                <td class="action-cell">
                  <button class="btn btn-ghost btn-sm" onclick="App.openStudentDetail('${s.id}')">详情</button>
                  <button class="btn btn-ghost btn-sm" onclick="App.openStudentForm('${s.id}')">编辑</button>
                  <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="App.delStudent('${s.id}')">删除</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  },

  openStudentForm(id=null) {
    this.state.editingStudentId = id;
    const s = id ? DB.get().students.find(x=>x.id===id) : null;
    const data = s || {
      name:'', grade:'', phone:'', school:'', enrollTypes:[],
      projectFees: {}, remainHours:0, notes:'', guardian:'', addr:'',
      teacherBindings: [],   // [{teacherId, subject, enrollType}]
      gradeTeachers: [],     // [{teacherId}] 晚辅导/暑期班按年级绑定的固定老师
    };
    const projectFees = data.projectFees || {};
    const bindings = data.teacherBindings || [];
    const teacherHours = data.teacherHours || [];
    const gradeTeachers = data.gradeTeachers || [];

    // 构建教师选项
    const d = DB.get();
    const teacherOpts = d.teachers.map(t => `<option value="${t.id}">${t.name} · ${t.subject||'未设科目'} (${t.dept||''})</option>`).join('');

    // 生成每个报名类型对应的费用输入区
    const feeInputs = ENROLL_TYPES.map(t => {
      const pf = projectFees[t.key] || {};
      return `
        <div class="form-group" style="padding:8px 12px;background:#f9fafb;border-radius:6px;margin-bottom:10px" data-fee-type="${t.key}">
          <div style="font-weight:600;font-size:13px;margin-bottom:6px">${t.label}</div>
          <div style="display:flex;gap:8px">
            <div style="flex:1">
              <label style="font-size:11px;color:var(--text-light)">月费</label>
              <input class="form-input" type="number" id="sf_fee_${t.key}_monthly" value="${pf.monthly||0}" placeholder="0">
            </div>
            <div style="flex:1">
              <label style="font-size:11px;color:var(--text-light)">一次性</label>
              <input class="form-input" type="number" id="sf_fee_${t.key}_onetime" value="${pf.oneTime||0}" placeholder="0">
            </div>
            <div style="flex:1">
              <label style="font-size:11px;color:var(--text-light)">单课时价</label>
              <input class="form-input" type="number" id="sf_fee_${t.key}_unitPrice" value="${pf.unitPrice||''}" placeholder="小课用">
            </div>
          </div>
        </div>
      `;
    }).join('');

    // 生成已绑定的教师行
    const bindingRows = bindings.length ? bindings.map((b, i) => {
      const bt = d.teachers.find(x=>x.id===b.teacherId);
      const btName = bt ? bt.name : '已删除';
      const btSubj = b.subject || (bt?bt.subject:'');
      const enrollLabel = ENROLL_TYPES.find(x=>x.key===b.enrollType)?.label || b.enrollType || '全部';
      return `
        <div class="binding-row" style="display:flex;align-items:center;gap:8px;padding:8px;background:white;border-radius:6px;margin-bottom:6px;border:1px solid var(--border)">
          <span style="flex:1;font-size:12px"><strong>${btName}</strong> · ${btSubj}</span>
          <span class="tag tag-${ENROLL_TYPES.find(x=>x.key===b.enrollType)?.cls?.split('-')[1]||'gray'}">${enrollLabel}</span>
          <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="this.closest('.binding-row').remove()">✕</button>
          <input type="hidden" class="binding-data" value="${b.teacherId}|||${btSubj}|||${b.enrollType||''}">
        </div>
      `;
    }).join('') : '<div style="font-size:12px;color:var(--text-light);padding:8px 0">暂未绑定教师</div>';

    // 小课课时按老师分配
    const teacherHourRows = teacherHours.length ? teacherHours.map((th, i) => {
      const t = d.teachers.find(x=>x.id===th.teacherId);
      const tName = t ? t.name : '已删除';
      return `
        <div class="th-row" style="display:flex;align-items:center;gap:8px;padding:8px;background:white;border-radius:6px;margin-bottom:6px;border:1px solid var(--border)">
          <span style="flex:1;font-size:12px"><strong>${tName}</strong></span>
          <input class="form-input th-hours-input" type="number" value="${th.hours||0}" min="0" style="width:80px;text-align:center" data-th-teacher="${th.teacherId}">
          <span style="font-size:11px;color:var(--text-light)">课时</span>
          <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="this.closest('.th-row').remove()">✕</button>
        </div>
      `;
    }).join('') : '<div style="font-size:12px;color:var(--text-light);padding:8px 0" id="thEmpty">暂未分配课时，请在下方选择老师并分配</div>';

    this.openModal(`
      <div class="modal-header">
        <div class="modal-title">${s?'编辑学生':'新增学生'}</div>
        <button class="modal-close" data-close-modal>×</button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">姓名<span class="required">*</span></label>
            <input class="form-input" id="sf_name" value="${data.name}" placeholder="学生姓名">
          </div>
          <div class="form-group">
            <label class="form-label">年级</label>
            <select class="form-select" id="sf_grade">
              <option value="">请选择</option>
              ${GRADES.map(g=>`<option value="${g}" ${data.grade===g?'selected':''}>${g}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">监护人</label>
            <input class="form-input" id="sf_guardian" value="${data.guardian||''}" placeholder="家长姓名">
          </div>
          <div class="form-group">
            <label class="form-label">联系电话</label>
            <input class="form-input" id="sf_phone" value="${data.phone||''}" placeholder="手机号">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">学校</label>
            <input class="form-input" id="sf_school" value="${data.school||''}" placeholder="就读学校">
          </div>
          <div class="form-group">
            <label class="form-label">地址</label>
            <input class="form-input" id="sf_addr" value="${data.addr||''}" placeholder="家庭地址">
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">报名类型<span class="required">*</span><span class="hint">可多选</span></label>
          <div class="multi-check" id="sf_types">
            ${ENROLL_TYPES.map(t => `
              <div class="multi-check-item ${(data.enrollTypes||[]).includes(t.key)?'checked':''}" data-key="${t.key}" onclick="App.toggleFeeSection(this)">${t.label}</div>
            `).join('')}
          </div>
        </div>

        <hr class="divider">
        <div style="font-weight:600;font-size:13px;margin-bottom:10px">📋 各项目费用设置</div>
        <div id="feeSections">${feeInputs}</div>

        ${(data.enrollTypes||[]).includes('private') ? `
          <hr class="divider">
          <div style="font-weight:600;font-size:13px;margin-bottom:10px">📚 小课课时按老师分配 <span class="hint">一个学生的课时可拆分给不同老师</span></div>
          ${d.teachers.length ? `
            <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
              <select class="form-select" id="sf_th_teacher" style="flex:1;min-width:140px">
                <option value="">选择教师</option>
                ${teacherOpts}
              </select>
              <input class="form-input" type="number" id="sf_th_hours" value="0" min="0" placeholder="课时数" style="width:100px">
              <button class="btn btn-primary btn-sm" onclick="App.addTeacherHours()">+ 分配</button>
            </div>
          ` : '<div style="color:var(--text-light);font-size:12px;margin-bottom:10px">暂无教师，请先添加教师</div>'}
          <div id="thList">${teacherHourRows}</div>
          <div id="thTotalInfo" style="margin-top:8px;padding:8px;background:var(--primary-light);border-radius:6px;font-size:12px"></div>
        ` : ''}

        <hr class="divider">
        <div style="font-weight:600;font-size:13px;margin-bottom:10px">🧑‍🏫 绑定任课教师 <span class="hint">一个学生可绑定多位教师（小课消课用）</span></div>
        ${d.teachers.length ? `
          <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
            <select class="form-select" id="sf_bind_teacher" style="flex:1;min-width:140px">
              <option value="">选择教师</option>
              ${teacherOpts}
            </select>
            <select class="form-select" id="sf_bind_type" style="width:120px">
              <option value="">所属项目</option>
              ${ENROLL_TYPES.map(t=>`<option value="${t.key}">${t.label}</option>`).join('')}
            </select>
            <button class="btn btn-primary btn-sm" onclick="App.addBinding()">+ 绑定</button>
          </div>
        ` : '<div style="color:var(--text-light);font-size:12px;margin-bottom:10px">暂无教师，请先添加教师后再绑定</div>'}
        <div id="bindingList">${bindingRows}</div>

        <hr class="divider">
        <div style="font-weight:600;font-size:13px;margin-bottom:10px">📅 年级固定老师 <span class="hint">晚辅导/暑期班按年级绑定的老师（可多个），负责标记缺勤</span></div>
        ${d.teachers.length ? `
          <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
            <select class="form-select" id="sf_gt_teacher" style="flex:1;min-width:140px">
              <option value="">选择教师</option>
              ${teacherOpts}
            </select>
            <button class="btn btn-primary btn-sm" onclick="App.addGradeTeacher()">+ 绑定</button>
          </div>
        ` : '<div style="color:var(--text-light);font-size:12px;margin-bottom:10px">暂无教师</div>'}
        <div id="gtList">${gradeTeachers.length ? gradeTeachers.map(gt => {
          const t = d.teachers.find(x=>x.id===gt.teacherId);
          const tName = t ? t.name : '已删除';
          return `
            <div class="gt-row" style="display:flex;align-items:center;gap:8px;padding:8px;background:white;border-radius:6px;margin-bottom:6px;border:1px solid var(--border)">
              <span style="flex:1;font-size:12px"><strong>${tName}</strong>${t ? ' · '+(t.subject||'') : ''}</span>
              <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="this.closest('.gt-row').remove()">✕</button>
              <input type="hidden" class="gt-data" value="${gt.teacherId}">
            </div>
          `;
        }).join('') : '<div style="font-size:12px;color:var(--text-light);padding:8px 0" id="gtEmpty">暂未绑定年级老师</div>'}</div>

        <div class="form-group">
          <label class="form-label">备注</label>
          <textarea class="form-textarea" id="sf_notes">${data.notes||''}</textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-close-modal>取消</button>
        <button class="btn btn-primary" onclick="App.saveStudent()">保存</button>
      </div>
    `);

    // 多选交互
    $$('#sf_types .multi-check-item').forEach(el => {
      el.onclick = () => {
        el.classList.toggle('checked');
        this.toggleFeeSection(el);
      };
    });

    // 初始化费用区域显示
    $$('#feeSections [data-fee-type]').forEach(el => {
      const key = el.dataset.feeType;
      const checked = $('#sf_types .multi-check-item[data-key="'+key+'"]')?.classList.contains('checked');
      el.style.display = checked ? '' : 'none';
    });

    // 初始化课时分配总计
    this.updateThTotal();
  },

  toggleFeeSection(el) {
    setTimeout(() => {
      const key = el.dataset.key;
      const feeSec = $(`#feeSections [data-fee-type="${key}"]`);
      if (feeSec) feeSec.style.display = el.classList.contains('checked') ? '' : 'none';
    }, 50);
  },

  addBinding() {
    const tid = $('#sf_bind_teacher')?.value;
    const etype = $('#sf_bind_type')?.value;
    if (!tid) { toast('请选择教师', 'warning'); return; }
    if (!etype) { toast('请选择所属项目', 'warning'); return; }
    const d = DB.get();
    const t = d.teachers.find(x=>x.id===tid);
    if (!t) return;
    const enrollLabel = ENROLL_TYPES.find(x=>x.key===etype)?.label || etype;
    const cls = ENROLL_TYPES.find(x=>x.key===etype)?.cls?.split('-')[1] || 'gray';
    const row = document.createElement('div');
    row.className = 'binding-row';
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px;background:white;border-radius:6px;margin-bottom:6px;border:1px solid var(--border)';
    row.innerHTML = `
      <span style="flex:1;font-size:12px"><strong>${t.name}</strong> · ${t.subject||'未设科目'}</span>
      <span class="tag tag-${cls}">${enrollLabel}</span>
      <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="this.closest('.binding-row').remove()">✕</button>
      <input type="hidden" class="binding-data" value="${tid}|||${t.subject||''}|||${etype}">
    `;
    const list = $('#bindingList');
    if (list) list.appendChild(row);
    toast('已绑定');
  },

  addTeacherHours() {
    const tid = $('#sf_th_teacher')?.value;
    const hours = Number($('#sf_th_hours')?.value)||0;
    if (!tid) { toast('请选择教师', 'warning'); return; }
    if (hours <= 0) { toast('请填写正确的课时数', 'warning'); return; }
    // 检查是否已存在
    const existing = $(`#thList .th-hours-input[data-th-teacher="${tid}"]`);
    if (existing) {
      existing.value = Number(existing.value) + hours;
      toast('已累加到该教师');
      this.updateThTotal();
      return;
    }
    const d = DB.get();
    const t = d.teachers.find(x=>x.id===tid);
    if (!t) return;
    const row = document.createElement('div');
    row.className = 'th-row';
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px;background:white;border-radius:6px;margin-bottom:6px;border:1px solid var(--border)';
    row.innerHTML = `
      <span style="flex:1;font-size:12px"><strong>${t.name}</strong></span>
      <input class="form-input th-hours-input" type="number" value="${hours}" min="0" style="width:80px;text-align:center" data-th-teacher="${tid}" oninput="App.updateThTotal()">
      <span style="font-size:11px;color:var(--text-light)">课时</span>
      <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="this.closest('.th-row').remove(); App.updateThTotal()">✕</button>
    `;
    const list = $('#thList');
    if (list) {
      const empty = $('#thEmpty');
      if (empty) empty.remove();
      list.appendChild(row);
    }
    $('#sf_th_hours').value = '0';
    this.updateThTotal();
    toast('已分配');
  },

  updateThTotal() {
    let total = 0;
    $$('#thList .th-hours-input').forEach(el => {
      total += Number(el.value)||0;
    });
    const el = $('#thTotalInfo');
    if (el) el.innerHTML = `📊 合计分配课时: <strong style="color:var(--primary)">${total}</strong> 课时`;
  },

  addGradeTeacher() {
    const tid = $('#sf_gt_teacher')?.value;
    if (!tid) { toast('请选择教师', 'warning'); return; }
    // 检查是否已存在
    const existing = $$('#gtList .gt-data').find(el => el.value === tid);
    if (existing) { toast('该教师已绑定', 'warning'); return; }
    const d = DB.get();
    const t = d.teachers.find(x=>x.id===tid);
    if (!t) return;
    const row = document.createElement('div');
    row.className = 'gt-row';
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px;background:white;border-radius:6px;margin-bottom:6px;border:1px solid var(--border)';
    row.innerHTML = `
      <span style="flex:1;font-size:12px"><strong>${t.name}</strong> · ${t.subject||'未设科目'}</span>
      <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="this.closest('.gt-row').remove()">✕</button>
      <input type="hidden" class="gt-data" value="${tid}">
    `;
    const list = $('#gtList');
    if (list) {
      const empty = $('#gtEmpty');
      if (empty) empty.remove();
      list.appendChild(row);
    }
    $('#sf_gt_teacher').value = '';
    toast('已绑定年级老师');
  },

  // 获取学生某老师的剩余课时 (从 teacherHours 中查找)
  getTeacherHours(student, teacherId) {
    if (!student || !teacherId) return 0;
    const ths = student.teacherHours || [];
    const found = ths.find(th => th.teacherId === teacherId);
    if (found) return found.hours || 0;
    // 兼容旧数据: 没有 teacherHours 时用 remainHours
    return student.remainHours || 0;
  },

  saveStudent() {
    const name = $('#sf_name').value.trim();
    if (!name) { toast('请填写姓名', 'error'); return; }
    const enrollTypes = $$('#sf_types .multi-check-item.checked').map(x=>x.dataset.key);
    if (!enrollTypes.length) { toast('请至少选择一种报名类型', 'error'); return; }

    // 收集各项目费用
    const projectFees = {};
    ENROLL_TYPES.forEach(t => {
      const m = Number($('#sf_fee_'+t.key+'_monthly')?.value)||0;
      const o = Number($('#sf_fee_'+t.key+'_onetime')?.value)||0;
      const u = Number($('#sf_fee_'+t.key+'_unitPrice')?.value)||0;
      if (m || o || u) projectFees[t.key] = { monthly: m, oneTime: o, unitPrice: u };
    });

    // 收集教师绑定
    const bindings = [];
    $$('#bindingList .binding-data').forEach(el => {
      const parts = el.value.split('|||');
      if (parts[0]) bindings.push({ teacherId: parts[0], subject: parts[1], enrollType: parts[2] });
    });

    // 收集小课课时按老师分配
    const teacherHours = [];
    let totalHours = 0;
    $$('#thList .th-hours-input').forEach(el => {
      const tid = el.dataset.thTeacher;
      const hrs = Number(el.value)||0;
      if (tid && hrs > 0) {
        teacherHours.push({ teacherId: tid, hours: hrs });
        totalHours += hrs;
      }
    });

    // 收集年级固定老师
    const gradeTeachers = [];
    $$('#gtList .gt-data').forEach(el => {
      if (el.value) gradeTeachers.push({ teacherId: el.value });
    });

    const obj = {
      name,
      grade: $('#sf_grade').value,
      guardian: $('#sf_guardian').value.trim(),
      phone: $('#sf_phone').value.trim(),
      school: $('#sf_school').value.trim(),
      addr: $('#sf_addr').value.trim(),
      enrollTypes,
      projectFees,
      teacherBindings: bindings,
      teacherHours,
      gradeTeachers,
      remainHours: totalHours,
      notes: $('#sf_notes').value.trim(),
    };

    const d = DB.get();
    const id = this.state.editingStudentId;
    if (id) {
      const idx = d.students.findIndex(x=>x.id===id);
      if (idx>-1) {
        // 编辑时: 如果没有 teacherHours, 保留旧的 remainHours
        if (!teacherHours.length && d.students[idx].remainHours) {
          obj.remainHours = d.students[idx].remainHours;
        }
        d.students[idx] = {...d.students[idx], ...obj};
      }
    } else {
      obj.id = uid();
      obj.createdAt = new Date().toISOString();
      obj.totalHours = obj.remainHours;
      d.students.push(obj);
    }
    DB.persist();
    this.closeModal();
    toast('保存成功');
    this.render();
  },

  delStudent(id) {
    if (!confirm('确认删除该学生？相关缴费记录会保留但不再显示学生名。')) return;
    const d = DB.get();
    d.students = d.students.filter(x=>x.id!==id);
    DB.persist();
    toast('已删除');
    this.render();
  },

  openStudentDetail(id) {
    const s = DB.get().students.find(x=>x.id===id);
    if (!s) return;
    const d = DB.get();
    const pays = d.payments.filter(p=>p.studentId===id);
    const logs = d.hourLogs.filter(l=>l.studentId===id);
    const bindings = s.teacherBindings || [];
    const pf = s.projectFees || {};

    this.openModal(`
      <div class="modal-header">
        <div class="modal-title">学生档案 · ${s.name}</div>
        <button class="modal-close" data-close-modal>×</button>
      </div>
      <div class="modal-body">
        <div class="info-list">
          <div class="info-item"><span class="info-label">姓名</span><span class="info-value">${s.name}</span></div>
          <div class="info-item"><span class="info-label">年级</span><span class="info-value">${s.grade||'-'}</span></div>
          <div class="info-item"><span class="info-label">监护人</span><span class="info-value">${s.guardian||'-'}</span></div>
          <div class="info-item"><span class="info-label">电话</span><span class="info-value">${s.phone||'-'}</span></div>
          <div class="info-item"><span class="info-label">学校</span><span class="info-value">${s.school||'-'}</span></div>
          <div class="info-item"><span class="info-label">地址</span><span class="info-value">${s.addr||'-'}</span></div>
          <div class="info-item"><span class="info-label">报名类型</span><span class="info-value">${(s.enrollTypes||[]).map(t=>`<span class="tag ${ENROLL_TYPES.find(x=>x.key===t)?.cls}">${ENROLL_TYPES.find(x=>x.key===t)?.label}</span>`).join('')}</span></div>
          ${ (s.enrollTypes||[]).includes('private') ? `
            <div class="info-item"><span class="info-label">总课时</span><span class="info-value">${s.totalHours||0}</span></div>
            <div class="info-item"><span class="info-label">剩余课时</span><span class="info-value"><span class="hour-badge">${s.remainHours||0}</span></span></div>
            ${(s.teacherHours||[]).length ? `
              <div class="info-item" style="flex-direction:column;align-items:flex-start">
                <span class="info-label">按老师分配</span>
                <span class="info-value" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">
                  ${s.teacherHours.map(th => {
                    const t = d.teachers.find(x=>x.id===th.teacherId);
                    return `<span class="tag tag-purple">${t?t.name:'已删除'}: ${th.hours||0}</span>`;
                  }).join('')}
                </span>
              </div>
            ` : ''}
          ` : ''}
          ${(s.gradeTeachers||[]).length ? `
            <div class="info-item" style="flex-direction:column;align-items:flex-start">
              <span class="info-label">年级固定老师</span>
              <span class="info-value" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">
                ${s.gradeTeachers.map(gt => {
                  const t = d.teachers.find(x=>x.id===gt.teacherId);
                  return `<span class="tag tag-cyan">${t?t.name:'已删除'}</span>`;
                }).join('')}
              </span>
            </div>
          ` : ''}
        </div>

        <hr class="divider">
        <div style="font-weight:600;margin-bottom:10px">💰 各项目费用</div>
        <div class="table-wrap"><table>
          <thead><tr><th>项目</th><th>月费</th><th>一次性</th><th>课时单价</th></tr></thead>
          <tbody>
            ${ENROLL_TYPES.map(t => {
              const f = pf[t.key] || {};
              return `<tr>
                <td><span class="tag ${t.cls}">${t.label}</span></td>
                <td>${f.monthly ? fmtMoney(f.monthly) : '-'}</td>
                <td>${f.oneTime ? fmtMoney(f.oneTime) : '-'}</td>
                <td>${f.unitPrice ? fmtMoney(f.unitPrice) : '-'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table></div>

        <hr class="divider">
        <div style="font-weight:600;margin-bottom:10px">🧑‍🏫 任课教师 (${bindings.length})</div>
        ${bindings.length ? `
          <div class="table-wrap"><table>
            <thead><tr><th>教师</th><th>科目</th><th>部门</th><th>负责项目</th></tr></thead>
            <tbody>
              ${bindings.map(b => {
                const t = d.teachers.find(x=>x.id===b.teacherId);
                const label = ENROLL_TYPES.find(x=>x.key===b.enrollType)?.label || b.enrollType || '-';
                const cls = ENROLL_TYPES.find(x=>x.key===b.enrollType)?.cls || 'tag-gray';
                return `<tr>
                  <td>${t?t.name:'已删除'}</td>
                  <td>${b.subject||(t?t.subject:'-')}</td>
                  <td>${t?t.dept:'-'}</td>
                  <td><span class="tag ${cls}">${label}</span></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table></div>
        ` : '<div style="color:var(--text-light);font-size:12px">未绑定教师</div>'}

        ${pays.length ? `
          <hr class="divider">
          <div style="font-weight:600;margin-bottom:10px">缴费记录 (${pays.length})</div>
          <div class="table-wrap"><table>
            <thead><tr><th>日期</th><th>项目</th><th>金额</th><th>方式</th><th>备注</th></tr></thead>
            <tbody>
              ${pays.map(p=>{
                const etype = ENROLL_TYPES.find(x=>x.key===p.enrollType);
                return `<tr>
                  <td>${fmtDate(p.date)}</td>
                  <td>${etype ? `<span class="tag ${etype.cls}">${etype.label}</span>` : '-'}</td>
                  <td><strong>${fmtMoney(p.amount)}</strong></td>
                  <td><span class="tag ${p.mode==='monthly'?'tag-blue':'tag-green'}">${PAY_MODES.find(m=>m.key===p.mode)?.label||'-'}</span></td>
                  <td>${p.note||'-'}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table></div>
        ` : ''}

        ${logs.length ? `
          <hr class="divider">
          <div style="font-weight:600;margin-bottom:10px">课时消耗 (${logs.length})</div>
          <div class="table-wrap"><table>
            <thead><tr><th>日期</th><th>消耗</th><th>教师</th><th>剩余</th></tr></thead>
            <tbody>
              ${logs.map(l=>{
                const t = d.teachers.find(x=>x.id===l.teacherId);
                return `<tr>
                  <td>${fmtDate(l.date)}</td>
                  <td><strong style="color:var(--danger)">-${l.hours}</strong></td>
                  <td>${t?t.name:'-'}</td>
                  <td>${l.remainAfter}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table></div>
        ` : ''}
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-close-modal>关闭</button>
        <button class="btn btn-primary" onclick="App.closeModal(); App.openStudentForm('${id}')">编辑</button>
      </div>
    `);
  },

  /* ====================================================================
   *  视图: 教师管理
   * ================================================================== */
  viewTeachers() {
    const d = DB.get();
    let list = d.teachers;
    if (this.state.filterDept) list = list.filter(t=>t.dept===this.state.filterDept);

    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="title-icon"></span>教师列表</div>
          <button class="btn btn-primary" onclick="App.openTeacherForm()">➕ 新增教师</button>
        </div>
        <div class="toolbar">
          <div class="search-box">
            <input type="text" placeholder="搜索姓名 / 科目" value="${this.state.search||''}"
              oninput="App.state.search=this.value">
          </div>
          <select class="filter-select" onchange="App.state.filterDept=this.value; App.render()">
            <option value="">全部部门</option>
            ${DEPTS.map(d=>`<option value="${d}" ${this.state.filterDept===d?'selected':''}>${d}</option>`).join('')}
          </select>
          <div style="margin-left:auto;font-size:12px;color:var(--text-light)">共 ${list.length} 名</div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>姓名</th><th>部门</th><th>类型</th><th>职级</th><th>科目</th><th>分成比例</th><th>本月工资</th><th>操作</th></tr></thead>
            <tbody>
              ${list.length ? list.filter(t => !this.state.search || t.name.includes(this.state.search) || (t.subject||'').includes(this.state.search)).map(t => {
                const sal = this.calcTeacherSalary(t, this.state.currentMonth);
                return `<tr>
                  <td><strong>${t.name}</strong>${t.isAdmin?'<span class="tag tag-orange">管理岗</span>':''}</td>
                  <td>${t.dept||'-'}</td>
                  <td>${(t.jobType||'full')==='full'?'<span class="tag tag-green">全职</span>':(t.jobType==='hourly'?'<span class="tag tag-cyan">时薪</span>':'<span class="tag tag-gray">兼职</span>')}</td>
                  <td>${t.level||'-'}</td>
                  <td>${t.subject||'-'}</td>
                  <td>${t.shareRate||DB.get().settings.defaultShareRate}%</td>
                  <td><strong style="color:var(--primary)">${fmtMoney(sal.total)}</strong></td>
                  <td class="action-cell">
                    <button class="btn btn-ghost btn-sm" onclick="App.openTeacherDetail('${t.id}')">详情</button>
                    <button class="btn btn-ghost btn-sm" onclick="App.openTeacherForm('${t.id}')">编辑</button>
                    <button class="btn btn-ghost btn-sm" style="color:#34a853" onclick="App.openShareManager('${t.id}')" title="消课分享链接">🔗 分享</button>
                    <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="App.delTeacher('${t.id}')">删除</button>
                  </td>
                </tr>`;
              }).join('') : `<tr><td colspan="8" class="table-empty">暂无教师</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  openTeacherForm(id=null) {
    this.state.editingTeacherId = id;
    const t = id ? DB.get().teachers.find(x=>x.id===id) : null;
    const data = t || {
      name:'', dept:'小学部', level:'初级教师', subject:'', phone:'',
      baseSalary: 0, perfBase: 0, shareRate: DB.get().settings.defaultShareRate,
      socialInsurance: 0, socialType: 'none', isAdmin: false, jobType: 'full', notes:'',
    };

    this.openModal(`
      <div class="modal-header">
        <div class="modal-title">${t?'编辑教师':'新增教师'}</div>
        <button class="modal-close" data-close-modal>×</button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">姓名<span class="required">*</span></label>
            <input class="form-input" id="tf_name" value="${data.name}">
          </div>
          <div class="form-group">
            <label class="form-label">部门</label>
            <select class="form-select" id="tf_dept">
              ${DEPTS.map(d=>`<option value="${d}" ${data.dept===d?'selected':''}>${d}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">职级</label>
            <select class="form-select" id="tf_level">
              ${TEACHER_LEVELS.map(l=>`<option value="${l}" ${data.level===l?'selected':''}>${l}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">科目</label>
            <input class="form-input" id="tf_subject" value="${data.subject||''}" placeholder="如: 数学">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">教师类型</label>
            <div class="radio-group" id="tf_jobtype">
              <div class="radio-item ${(data.jobType||'full')==='full'?'checked':''}" data-key="full">全职（享全勤奖）</div>
              <div class="radio-item ${data.jobType==='part'?'checked':''}" data-key="part">兼职（无全勤奖）</div>
              <div class="radio-item ${data.jobType==='hourly'?'checked':''}" data-key="hourly">时薪制（按工时算）</div>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">联系电话</label>
            <input class="form-input" id="tf_phone" value="${data.phone||''}">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" id="tf_base_label">基本工资 (元)<span class="hint">自定义</span></label>
            <input class="form-input" type="number" id="tf_base" value="${data.baseSalary||0}">
          </div>
          <div class="form-group">
            <label class="form-label" id="tf_perfbase_label">绩效基数 (元)<span class="hint">自定义</span></label>
            <input class="form-input" type="number" id="tf_perfbase" value="${data.perfBase||0}">
          </div>
        </div>
        <div class="form-row" id="tf_hourly_row" style="display:${data.jobType==='hourly'?'':'none'}">
          <div class="form-group">
            <label class="form-label">时薪 (元/小时)<span class="hint">时薪制专用</span></label>
            <input class="form-input" type="number" id="tf_hourly_rate" value="${data.hourlyRate||0}" placeholder="如 50">
          </div>
          <div class="form-group">
            <label class="form-label">每日标准工时<span class="hint">小时</span></label>
            <input class="form-input" type="number" id="tf_daily_hours" value="${data.dailyHours||8}" placeholder="如 8">
          </div>
        </div>
          <div class="form-group">
            <label class="form-label">小课分成比例 (%)<span class="hint">教师拿的比例</span></label>
            <input class="form-input" type="number" id="tf_share" value="${data.shareRate||DB.get().settings.defaultShareRate}" min="0" max="100">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">社保</label>
          <select class="form-select" id="tf_social_type" onchange="App.toggleTeacherSocialType()">
            <option value="none" ${(!t || !t.socialType || t.socialType==='none')?'selected':''}>不缴纳（发社保补贴）</option>
            <option value="pay" ${t && t.socialType==='pay'?'selected':''}>缴纳（扣个人部分）</option>
          </select>
          <div style="margin-top:8px">
            <label class="form-label" id="tf_social_label">${t && t.socialType==='pay'?'社保扣除金额 (元)':'社保补贴金额 (元)'}</label>
            <input class="form-input" type="number" id="tf_social" value="${data.socialInsurance||0}">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">岗位</label>
          <div class="radio-group" id="tf_isadmin">
            <div class="radio-item ${data.isAdmin?'checked':''}" data-key="1">管理岗 (带班补助+200)</div>
            <div class="radio-item ${!data.isAdmin?'checked':''}" data-key="0">普通教师</div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">备注</label>
          <textarea class="form-textarea" id="tf_notes">${data.notes||''}</textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-close-modal>取消</button>
        <button class="btn btn-primary" onclick="App.saveTeacher()">保存</button>
      </div>
    `);

    $$('#tf_isadmin .radio-item').forEach(el => {
      el.onclick = () => {
        $$('#tf_isadmin .radio-item').forEach(x=>x.classList.remove('checked'));
        el.classList.add('checked');
      };
    });
    $$('#tf_jobtype .radio-item').forEach(el => {
      el.onclick = () => {
        $$('#tf_jobtype .radio-item').forEach(x=>x.classList.remove('checked'));
        el.classList.add('checked');
        App.onJobTypeChange();
      };
    });
  },

  onJobTypeChange() {
    const jobType = $$('#tf_jobtype .radio-item.checked')[0]?.dataset.key || 'full';
    const hourlyRow = $('#tf_hourly_row');
    const baseLabel = $('#tf_base_label');
    const perfBaseLabel = $('#tf_perfbase_label');
    if (hourlyRow) hourlyRow.style.display = jobType === 'hourly' ? '' : 'none';
    if (jobType === 'hourly') {
      if (baseLabel) baseLabel.innerHTML = '基本工资<span class="hint">时薪制此项无效</span>';
      if (perfBaseLabel) perfBaseLabel.innerHTML = '绩效基数<span class="hint">时薪制此项无效</span>';
    } else {
      if (baseLabel) baseLabel.innerHTML = '基本工资 (元)<span class="hint">自定义</span>';
      if (perfBaseLabel) perfBaseLabel.innerHTML = '绩效基数 (元)<span class="hint">自定义</span>';
    }
  },

  saveTeacher() {
    const name = $('#tf_name').value.trim();
    if (!name) { toast('请填写姓名', 'error'); return; }
    const obj = {
      name,
      dept: $('#tf_dept').value,
      level: $('#tf_level').value,
      subject: $('#tf_subject').value.trim(),
      phone: $('#tf_phone').value.trim(),
      jobType: $$('#tf_jobtype .radio-item.checked')[0]?.dataset.key || 'full',
      baseSalary: Number($('#tf_base').value)||0,
      perfBase: Number($('#tf_perfbase').value)||0,
      hourlyRate: Number($('#tf_hourly_rate')?.value)||0,
      dailyHours: Number($('#tf_daily_hours')?.value)||8,
      shareRate: Number($('#tf_share').value)||0,
      socialType: $('#tf_social_type').value,
      socialInsurance: Number($('#tf_social').value)||0,
      isAdmin: $$('#tf_isadmin .radio-item.checked')[0]?.dataset.key === '1',
      notes: $('#tf_notes').value.trim(),
    };
    const d = DB.get();
    const id = this.state.editingTeacherId;
    if (id) {
      const idx = d.teachers.findIndex(x=>x.id===id);
      if (idx>-1) d.teachers[idx] = {...d.teachers[idx], ...obj};
    } else {
      obj.id = uid();
      obj.createdAt = new Date().toISOString();
      d.teachers.push(obj);
    }
    DB.persist();
    this.closeModal();
    toast('保存成功');
    this.render();
  },

  delTeacher(id) {
    if (!confirm('确认删除该教师？')) return;
    const d = DB.get();
    d.teachers = d.teachers.filter(x=>x.id!==id);
    DB.persist();
    toast('已删除');
    this.render();
  },

  toggleTeacherSocialType() {
    const type = $('#tf_social_type').value;
    const label = $('#tf_social_label');
    if (label) label.textContent = type === 'pay' ? '社保扣除金额 (元)' : '社保补贴金额 (元)';
  },

  openTeacherDetail(id) {
    const t = DB.get().teachers.find(x=>x.id===id);
    if (!t) return;
    this.state.editingTeacherId = id;
    this.state.detailTab = 'info';
    this.renderTeacherDetail();
  },

  renderTeacherDetail() {
    const t = DB.get().teachers.find(x=>x.id===this.state.editingTeacherId);
    if (!t) return;
    const sal = this.calcTeacherSalary(t, this.state.currentMonth);

    const tabs = [
      {key:'info', label:'基本信息'},
      {key:'salary', label:'工资明细'},
      {key:'hours', label:'课时记录'},
      {key:'share', label:'消课分享'},
    ];

    let body = '';
    if (this.state.detailTab === 'info') {
      body = `
        <div class="info-list">
          <div class="info-item"><span class="info-label">姓名</span><span class="info-value">${t.name}</span></div>
          <div class="info-item"><span class="info-label">部门</span><span class="info-value">${t.dept||'-'}</span></div>
          <div class="info-item"><span class="info-label">职级</span><span class="info-value">${t.level||'-'}</span></div>
          <div class="info-item"><span class="info-label">科目</span><span class="info-value">${t.subject||'-'}</span></div>
          <div class="info-item"><span class="info-label">电话</span><span class="info-value">${t.phone||'-'}</span></div>
          <div class="info-item"><span class="info-label">基本工资</span><span class="info-value">${fmtMoney(t.baseSalary)}</span></div>
          <div class="info-item"><span class="info-label">绩效基数</span><span class="info-value">${fmtMoney(t.perfBase)}</span></div>
          <div class="info-item"><span class="info-label">小课分成</span><span class="info-value">${t.shareRate||DB.get().settings.defaultShareRate}%</span></div>
          <div class="info-item"><span class="info-label">社保</span><span class="info-value">${t.socialType==='pay'?`缴纳 (扣${fmtMoney(t.socialInsurance)})`:t.socialType==='none'?`不缴纳 ${t.socialInsurance>0?'(补贴'+fmtMoney(t.socialInsurance)+')':'(无补贴)'}`:'未设置'}</span></div>
          <div class="info-item"><span class="info-label">岗位</span><span class="info-value">${t.isAdmin?'管理岗':'普通教师'}</span></div>
          <div class="info-item"><span class="info-label">教师类型</span><span class="info-value">${(t.jobType||'full')==='full'?'全职':(t.jobType==='hourly'?'时薪制':'兼职')} ${(t.jobType||'full')==='part'?'<span class="tag tag-gray">无全勤奖</span>':(t.jobType==='hourly'?'<span class="tag tag-cyan">按时薪算</span>':'<span class="tag tag-green">享全勤奖</span>')}</span></div>
          ${t.jobType==='hourly' ? `
            <div class="info-item"><span class="info-label">时薪</span><span class="info-value">${fmtMoney(t.hourlyRate)} / 小时</span></div>
            <div class="info-item"><span class="info-label">每日工时</span><span class="info-value">${t.dailyHours||8} 小时</span></div>
          ` : ''}
          <div class="info-item"><span class="info-label">备注</span><span class="info-value">${t.notes||'-'}</span></div>
        </div>
      `;
    } else if (this.state.detailTab === 'salary') {
      body = this.renderTeacherSalaryDetail(t, sal);
    } else if (this.state.detailTab === 'hours') {
      const logs = DB.get().hourLogs.filter(l=>l.teacherId===t.id);
      body = `
        <div class="highlight-box">小课课时费 = 该教师本月消耗课时 × 学生单课时单价 × 分成比例(${t.shareRate||DB.get().settings.defaultShareRate}%)</div>
        ${logs.length ? `
          <div class="table-wrap"><table>
            <thead><tr><th>日期</th><th>学生</th><th>消耗</th><th>单价</th><th>教师课时费</th><th>剩余</th></tr></thead>
            <tbody>
              ${logs.map(l=>{
                const s = DB.get().students.find(x=>x.id===l.studentId);
                return `<tr>
                  <td>${fmtDate(l.date)}</td>
                  <td>${s?s.name:'-'}</td>
                  <td><strong>${l.hours}</strong></td>
                  <td>${fmtMoney(l.unitPrice)}</td>
                  <td><strong style="color:var(--success)">${fmtMoney(l.hours*l.unitPrice*(t.shareRate||DB.get().settings.defaultShareRate)/100)}</strong></td>
                  <td>${l.remainAfter}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table></div>
        ` : `<div class="empty-state"><div class="empty-state-icon">⏱️</div><div class="empty-state-text">暂无课时记录</div></div>`}
      `;
    } else if (this.state.detailTab === 'share') {
      // 渲染分享链接管理 (内嵌)
      const shares = DB.get().teacherShares.filter(s => s.teacherId === t.id && !s.revokedAt);
      const baseUrl = location.origin + location.pathname + location.search;
      const cloudCfg = DB.getCloudConfig();
      const cloudParam = (cloudCfg.enabled && cloudCfg.url && cloudCfg.key)
        ? '&c=' + btoa(unescape(encodeURIComponent(JSON.stringify({u:cloudCfg.url,k:cloudCfg.key}))))
        : '';
      body = `
        <div class="highlight-box">
          📤 生成的链接发给教师，打开后只显示该教师绑定学生的姓名和剩余课时，可自行消课，其他数据全部隐藏。
        </div>
        ${!cloudCfg.enabled ? `
          <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:12px;margin-bottom:12px;font-size:12px;color:#856404">
            ⚠️ <strong>未启用云端同步！</strong>老师用其他设备打开链接会看不到数据。请先到「系统设置 → 云端同步」配置。
          </div>
        ` : ''}
        ${shares.length ? `
          <div style="font-weight:600;margin-bottom:10px">当前有效链接 (${shares.length})</div>
          ${shares.map(sh => {
            const link = `${baseUrl}#share=${sh.code}${cloudParam}`;
            return `
            <div style="background:#f9fafb;border-radius:8px;padding:12px;margin-bottom:8px">
              <div style="font-size:11px;color:var(--text-light);margin-bottom:4px">创建于 ${fmtDate(sh.createdAt)} ${cloudParam?'· ☁️ 跨设备可用':''}</div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <input class="form-input" readonly value="${link}" style="font-size:11px;flex:1;min-width:200px" onclick="this.select()">
                <button class="btn btn-primary btn-sm" onclick="navigator.clipboard.writeText('${link}').then(()=>toast('链接已复制'))">📋 复制</button>
                <button class="btn btn-danger btn-sm" onclick="App.revokeShare('${sh.id}')">作废</button>
              </div>
            </div>`;
          }).join('')}
        ` : `<div style="color:var(--text-light);font-size:13px;margin-bottom:12px">暂无有效链接</div>`}
        <button class="btn btn-primary" onclick="App.createShare('${t.id}')">➕ 生成新链接</button>
      `;
    }

    this.openModal(`
      <div class="modal-header">
        <div class="modal-title">教师档案 · ${t.name}</div>
        <button class="modal-close" data-close-modal>×</button>
      </div>
      <div class="modal-body">
        <div class="teacher-detail-tabs">
          ${tabs.map(tt=>`<div class="detail-tab ${this.state.detailTab===tt.key?'active':''}" onclick="App.state.detailTab='${tt.key}'; App.renderTeacherDetail()">${tt.label}</div>`).join('')}
        </div>
        ${body}
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-close-modal>关闭</button>
        <button class="btn btn-primary" onclick="App.closeModal(); App.openTeacherForm('${t.id}')">编辑</button>
      </div>
    `, 'large');
  },

  renderTeacherSalaryDetail(t, sal) {
    const isFullTime = (t.jobType || 'full') === 'full';
    const isHourly = t.jobType === 'hourly';
    return `
      <div class="highlight-box">
        当前结算月份: ${this.state.currentMonth} | ${isHourly?'⏱️ 时薪制':(isFullTime?'全职':'兼职')} | 修改月份请到「工资结算」页面
      </div>

      <div class="salary-section">
        <div class="salary-section-title">📅 出勤与绩效</div>
        <div class="salary-grid">
          ${this.salItem('应出勤天数', sal.shouldDays, `${sal.shouldDays} 天`)}
          ${this.salItem('实际出勤天数', sal.actualDays, `${sal.actualDays} 天`)}
          ${isHourly
            ? this.salItem('实际工时', sal.actualHours, `${sal.actualHours} 小时 (${sal.actualDays}×${t.dailyHours||8}h)`)
            : this.salItem('绩效得分', sal.perfScore, `${sal.perfScore}%`)}
        </div>
        ${!isHourly ? `<div style="margin-top:12px"><button class="btn btn-secondary btn-sm" onclick="App.openSalaryEdit('${t.id}')">✏️ 修改本月出勤/绩效</button></div>` : `<div style="margin-top:12px"><button class="btn btn-secondary btn-sm" onclick="App.openAbsentModal('${t.id}')">📅 去考勤管理标记缺勤</button></div>`}
      </div>

      <div class="salary-section">
        <div class="salary-section-title">💰 工资构成</div>
        <div class="salary-grid">
          ${isHourly
            ? this.salItem('时薪工资', sal.hourlySalary, fmtMoney(sal.hourlySalary) + ` = ${fmtMoney(t.hourlyRate)} × ${sal.actualHours}h`)
            : this.salItem('基本工资', sal.baseSalary, fmtMoney(sal.baseSalary))}
          ${!isHourly ? this.salItem('绩效工资', sal.perfSalary, fmtMoney(sal.perfSalary) + ` = ${fmtMoney(sal.perfBase)} × ${sal.perfScore}%`) : ''}
          ${!isHourly ? this.salItem('全勤奖', sal.fullAttendBonus, !isFullTime
            ? `${fmtMoney(0)} (兼职)`
            : (sal.fullAttendBonus>0 ? `${fmtMoney(sal.fullAttendBonus)} ✅` : `${fmtMoney(0)} ❌`)) : ''}
          ${!isHourly ? this.salItem('绩效津贴', sal.perfAllowance, sal.perfAllowance>0?`${fmtMoney(sal.perfAllowance)} (初中部)`:`${fmtMoney(0)}`) : ''}
          ${this.salItem('课时费', sal.courseFee, fmtMoney(sal.courseFee) + ` (分成${t.shareRate||DB.get().settings.defaultShareRate}%)`)}
          ${this.salItem('岗位补助', sal.postBonus, sal.postBonus>0?`${fmtMoney(sal.postBonus)} (管理岗)`:`${fmtMoney(0)}`)}
          ${this.salItem('交通补贴', sal.transportBonus, sal.transportBonus>0?`${fmtMoney(sal.transportBonus)} (晚辅)`:`${fmtMoney(0)}`)}
          ${!isHourly && sal.leaveDeduction > 0 ? this.salItem('请假扣除', sal.leaveDeduction, `-${fmtMoney(sal.leaveDeduction)} = ${fmtMoney(sal.baseSalary)}÷${sal.shouldDays}×${sal.absentCount}`) : ''}
          ${this.salItem('社保', sal.socialType, sal.socialType==='pay'
            ? `-${fmtMoney(sal.socialDeduction)} (扣除)`
            : `${sal.socialSubsidy>0?'+'+fmtMoney(sal.socialSubsidy):''} ${sal.socialSubsidy>0?'(补贴)':'(无)'}`)}
        </div>
      </div>

      <div class="salary-total">
        <span class="salary-total-label">本月实发工资</span>
        <span class="salary-total-value">${fmtMoney(sal.total)}</span>
      </div>
    `;
  },

  salItem(label, raw, display) {
    return `
      <div class="salary-item">
        <div class="salary-item-label">${label}</div>
        <div class="salary-item-value">${display}</div>
      </div>
    `;
  },

  openSalaryEdit(teacherId) {
    const t = DB.get().teachers.find(x=>x.id===teacherId);
    const sal = this.calcTeacherSalary(t, this.state.currentMonth);
    const monthKey = this.state.currentMonth;
    const rec = t.salaryRecords?.[monthKey] || {};

    this.openModal(`
      <div class="modal-header">
        <div class="modal-title">修改 ${t.name} · ${monthKey} 工资参数</div>
        <button class="modal-close" data-close-modal>×</button>
      </div>
      <div class="modal-body">
        <div class="form-row-3">
          <div class="form-group">
            <label class="form-label">应出勤天数</label>
            <input class="form-input" type="number" id="se_should" value="${rec.shouldDays ?? 22}">
          </div>
          <div class="form-group">
            <label class="form-label">实际出勤天数<span class="hint">自动计算</span></label>
            <input class="form-input" type="number" id="se_actual" value="${rec.actualDays ?? ((rec.shouldDays ?? 22) - (rec.absentDays||[]).length)}" readonly style="background:#f3f4f6">
            <div class="form-hint">去「考勤管理」标记缺勤，此处自动更新</div>
          </div>
          <div class="form-group">
            <label class="form-label">绩效得分 (0-100%)</label>
            <input class="form-input" type="number" id="se_perf" value="${rec.perfScore ?? 80}" step="0.1" min="0" max="100">
            <div class="form-hint">如 80 表示 80%, 绩效工资 = 绩效基数 × 得分%</div>
          </div>
        </div>
        <div class="form-row-3">
          <div class="form-group">
            <label class="form-label">全勤奖 (元)</label>
            <input class="form-input" type="number" id="se_full" value="${rec.fullAttendBonus ?? 200}">
            <div class="form-hint">默认200, 应出勤=实际出勤时发放</div>
          </div>
          <div class="form-group">
            <label class="form-label">绩效津贴</label>
            <select class="form-select" id="se_perfallow">
              <option value="0" ${rec.perfAllowance===0?'selected':''}>无</option>
              <option value="200" ${rec.perfAllowance===200?'selected':''}>200 (初中部, 非寒暑假)</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">岗位补助</label>
            <select class="form-select" id="se_post">
              <option value="0">无</option>
              <option value="200" ${t.isAdmin?'selected':''}>200 (管理岗)</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">交通补贴</label>
            <select class="form-select" id="se_transport">
              <option value="0">无</option>
              <option value="300" ${rec.transportBonus===300?'selected':''}>300 (晚辅接送)</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">社保</label>
            <select class="form-select" id="se_social_type" onchange="App.toggleSocialType()">
              <option value="none" ${(!rec.socialType || rec.socialType==='none')?'selected':''}>不缴纳（发放社保补贴）</option>
              <option value="pay" ${rec.socialType==='pay'?'selected':''}>缴纳（扣除个人部分）</option>
            </select>
            <div id="se_social_amount_wrap" style="margin-top:8px">
              <label class="form-label" id="se_social_label">${rec.socialType==='pay'?'社保扣除金额 (元)':'社保补贴金额 (元)'}</label>
              <input class="form-input" type="number" id="se_social" value="${rec.socialInsurance ?? t.socialInsurance ?? 0}">
            </div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">备注</label>
          <input class="form-input" id="se_note" value="${rec.note||''}" placeholder="本月特殊说明">
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-close-modal>取消</button>
        <button class="btn btn-primary" onclick="App.saveSalaryEdit('${teacherId}')">保存</button>
      </div>
    `);
  },

  saveSalaryEdit(teacherId) {
    const d = DB.get();
    const t = d.teachers.find(x=>x.id===teacherId);
    if (!t) return;
    const monthKey = this.state.currentMonth;
    if (!t.salaryRecords) t.salaryRecords = {};
    const oldRec = t.salaryRecords[monthKey] || {};
    const socialType = $('#se_social_type').value;
    const shouldDays = Number($('#se_should').value)||0;
    const absentDays = oldRec.absentDays || [];
    const actualDays = shouldDays - absentDays.length;
    t.salaryRecords[monthKey] = {
      shouldDays,
      actualDays,
      absentDays,  // 保留考勤记录
      perfScore: Number($('#se_perf').value)||0,
      fullAttendBonus: Number($('#se_full').value)||0,
      perfAllowance: Number($('#se_perfallow').value)||0,
      postBonus: Number($('#se_post').value)||0,
      transportBonus: Number($('#se_transport').value)||0,
      socialType,
      socialInsurance: Number($('#se_social').value)||0,
      note: $('#se_note').value.trim(),
    };
    DB.persist();
    this.closeModal();
    toast('工资参数已更新');
    this.renderTeacherDetail();
  },

  toggleSocialType() {
    const type = $('#se_social_type').value;
    const label = $('#se_social_label');
    if (label) label.textContent = type === 'pay' ? '社保扣除金额 (元)' : '社保补贴金额 (元)';
  },

  /* ====================================================================
   *  工资计算引擎 (核心)
   * ================================================================== */
  calcTeacherSalary(t, month) {
    const rec = t.salaryRecords?.[month] || {};
    const settings = DB.get().settings;
    const jobType = t.jobType || 'full';
    const isHourly = jobType === 'hourly';
    const isFullTime = jobType === 'full';

    const shouldDays = rec.shouldDays ?? 22;
    // 缺勤记录: absentDays 存日期字符串, absentHalfDays 存半天日期
    // 统一用 absentRecords: { '日期': 'full'|'half' }
    const absentRecords = rec.absentRecords || {};
    // 兼容旧格式 absentDays (全为全天)
    (rec.absentDays || []).forEach(d => { if (!absentRecords[d]) absentRecords[d] = 'full'; });
    const fullAbsent = Object.values(absentRecords).filter(v => v === 'full').length;
    const halfAbsent = Object.values(absentRecords).filter(v => v === 'half').length;
    const absentCount = fullAbsent + halfAbsent * 0.5;  // 缺勤天数(半天算0.5)
    const actualDays = rec.actualDays ?? (shouldDays - absentCount);

    if (isHourly) {
      // ===== 时薪制兼职: 工资 = 时薪 × 实际出勤工时 =====
      const hourlyRate = Number(t.hourlyRate) || 0;
      const dailyHours = Number(t.dailyHours) || 8;
      const actualHours = actualDays * dailyHours;
      const hourlySalary = Math.round(hourlyRate * actualHours * 100) / 100;

      // 课时费 (时薪制也有课时费)
      const logs = DB.get().hourLogs.filter(l =>
        l.teacherId === t.id && l.date.startsWith(month)
      );
      const shareRate = t.shareRate ?? settings.defaultShareRate;
      let courseFee = 0;
      logs.forEach(l => { courseFee += l.hours * (l.unitPrice||0) * shareRate / 100; });

      const postBonus = t.isAdmin ? (rec.postBonus || 200) : (rec.postBonus || 0);
      const transportBonus = rec.transportBonus || 0;
      const socialType = rec.socialType || (t.socialInsurance > 0 ? 'pay' : 'none');
      const socialAmount = rec.socialInsurance ?? t.socialInsurance ?? 0;
      const socialDeduction = socialType === 'pay' ? socialAmount : 0;
      const socialSubsidy = socialType === 'none' ? socialAmount : 0;

      const total = hourlySalary + courseFee + postBonus + transportBonus
        + socialSubsidy - socialDeduction;

      return {
        jobType, shouldDays, actualDays, absentCount, actualHours,
        hourlyRate, hourlySalary,
        baseSalary: 0, perfBase: 0, perfSalary: 0, perfScore: 0,
        fullAttendBonus: 0, perfAllowance: 0, courseFee,
        postBonus, transportBonus,
        socialType, socialAmount, socialDeduction, socialSubsidy,
        socialInsurance: socialDeduction,
        total: Math.round(total * 100) / 100,
      };
    }

    // ===== 全职/兼职: 原有逻辑 =====
    const perfScore = rec.perfScore ?? 80;
    const baseSalary = Number(t.baseSalary) || 0;
    const perfBase = Number(t.perfBase) || 0;
    const perfSalary = Math.round(perfBase * perfScore / 100 * 100) / 100;

    // 请假扣除工资 = 基本工资 / 应出勤天数 × 请假天数
    const leaveDeduction = (shouldDays > 0 && absentCount > 0)
      ? Math.round(baseSalary / shouldDays * absentCount * 100) / 100 : 0;

    // 全勤奖: 全职 + 应出勤 = 实际出勤
    const fullAttendBonus = (isFullTime && shouldDays === actualDays && actualDays > 0)
      ? (rec.fullAttendBonus ?? 200) : 0;

    const isVacation = /^.*(01|02|07|08)$/.test(month);
    const perfAllowance = (t.dept === '初中部' && !isVacation)
      ? (rec.perfAllowance === 0 ? 0 : (rec.perfAllowance ?? 200)) : 0;

    const logs = DB.get().hourLogs.filter(l =>
      l.teacherId === t.id && l.date.startsWith(month)
    );
    const shareRate = t.shareRate ?? settings.defaultShareRate;
    let courseFee = 0;
    logs.forEach(l => { courseFee += l.hours * (l.unitPrice||0) * shareRate / 100; });

    const postBonus = t.isAdmin ? (rec.postBonus || 200) : (rec.postBonus || 0);
    const transportBonus = rec.transportBonus || 0;
    const socialType = rec.socialType || (t.socialInsurance > 0 ? 'pay' : 'none');
    const socialAmount = rec.socialInsurance ?? t.socialInsurance ?? 0;
    const socialDeduction = socialType === 'pay' ? socialAmount : 0;
    const socialSubsidy = socialType === 'none' ? socialAmount : 0;

    const total = baseSalary + perfSalary + fullAttendBonus + perfAllowance
      + courseFee + postBonus + transportBonus + socialSubsidy
      - socialDeduction - leaveDeduction;

    return {
      jobType, shouldDays, actualDays, absentCount,
      baseSalary, perfBase, perfSalary, perfScore,
      leaveDeduction,
      fullAttendBonus, perfAllowance, courseFee,
      postBonus, transportBonus,
      socialType, socialAmount, socialDeduction, socialSubsidy,
      socialInsurance: socialDeduction,
      total: Math.round(total * 100) / 100,
    };
  },

  /* ====================================================================
   *  视图: 考勤管理
   * ================================================================== */
  viewAttendance() {
    const d = DB.get();
    const teachers = d.teachers;
    const month = this.state.currentMonth;
    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const tab = this.state.attendanceTab || 'teacher';

    const getAttendance = (t) => {
      const rec = t.salaryRecords?.[month] || {};
      const shouldDays = rec.shouldDays ?? 22;
      const absentRecords = rec.absentRecords || {};
      // 兼容旧格式
      (rec.absentDays || []).forEach(dd => { if (!absentRecords[dd]) absentRecords[dd] = 'full'; });
      const fullAbsent = Object.values(absentRecords).filter(v => v === 'full').length;
      const halfAbsent = Object.values(absentRecords).filter(v => v === 'half').length;
      const absentCount = fullAbsent + halfAbsent * 0.5;
      const actualDays = shouldDays - absentCount;
      const absentLabels = Object.entries(absentRecords).map(([dd, type]) =>
        `<span class="tag ${type==='half'?'tag-orange':'tag-red'}">${dd.slice(8)}日${type==='half'?'(半)':''}</span>`
      );
      return { shouldDays, absentCount, actualDays, absentLabels, hasAbsent: Object.keys(absentRecords).length > 0 };
    };

    // 晚辅导/暑期班学生 (默认出勤, 标记缺勤)
    const eveningSummerStudents = d.students.filter(s =>
      (s.enrollTypes||[]).some(t => t === 'evening' || t === 'summer')
    );

    // 周末托学生 (默认缺勤, 标记出勤)
    const weekendStudents = d.students.filter(s =>
      (s.enrollTypes||[]).includes('weekend')
    );

    // 获取学生考勤记录
    const getStudentAttendance = (s, type) => {
      // type: 'evening_summer' | 'weekend'
      const records = s.attendanceRecords?.[month]?.[type] || {};
      return records;
    };

    // 统计学生考勤
    const countStudentAtt = (s, type, defaultPresent) => {
      const records = getStudentAttendance(s, type);
      const marked = Object.keys(records).length;
      if (defaultPresent) {
        // 晚辅导/暑期班: 默认出勤, 标记的是缺勤
        const absent = Object.values(records).filter(v => v === 'absent').length;
        const halfAbsent = Object.values(records).filter(v => v === 'half').length;
        return { absent, halfAbsent, marked, present: daysInMonth - absent - halfAbsent };
      } else {
        // 周末托: 默认缺勤, 标记的是出勤
        const present = Object.values(records).filter(v => v === 'present').length;
        return { present, absent: daysInMonth - present, marked };
      }
    };

    const tabBtn = (key, label, icon) => `
      <button class="btn ${tab===key?'btn-primary':'btn-secondary'} btn-sm" onclick="App.state.attendanceTab='${key}'; App.render()">
        ${icon} ${label}
      </button>
    `;

    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="title-icon"></span>考勤管理</div>
          <div class="month-selector">
            <button class="month-nav-btn" onclick="App.state.currentMonth=monthNav(App.state.currentMonth,-1); App.render()">‹</button>
            <input type="month" value="${month}" onchange="App.state.currentMonth=this.value; App.render()">
            <button class="month-nav-btn" onclick="App.state.currentMonth=monthNav(App.state.currentMonth,1); App.render()">›</button>
          </div>
        </div>

        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          ${tabBtn('teacher','教师考勤','🧑‍🏫')}
          ${tabBtn('evening_summer','晚辅导/暑期班','📚')}
          ${tabBtn('weekend','周末托','📅')}
        </div>

        ${tab === 'teacher' ? `
          <div class="highlight-box">
            📅 ${month} 共 ${daysInMonth} 天 | 点击日期循环切换：出勤 → 半天缺勤 → 全天缺勤 → 出勤<br>
            实际出勤 = 应出勤 - 缺勤天数（半天算 0.5 天）
          </div>

          ${teachers.length ? `
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>教师</th>
                    <th>类型</th>
                    <th>应出勤</th>
                    <th>缺勤天数</th>
                    <th>实际出勤</th>
                    <th>缺勤日期</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  ${teachers.map(t => {
                    const att = getAttendance(t);
                    const typeTag = (t.jobType||'full')==='full'?'<span class="tag tag-green">全职</span>'
                      :(t.jobType==='hourly'?'<span class="tag tag-cyan">时薪</span>':'<span class="tag tag-gray">兼职</span>');
                    return `<tr>
                      <td><strong>${t.name}</strong></td>
                      <td>${typeTag}</td>
                      <td>
                        <input type="number" class="salary-item-input" style="width:60px;text-align:center" value="${att.shouldDays}" min="0" max="${daysInMonth}" onchange="App.setShouldDays('${t.id}', this.value)">
                      </td>
                      <td><strong style="color:${att.absentCount>0?'var(--danger)':'var(--success)'}">${att.absentCount}</strong></td>
                      <td><strong>${att.actualDays}</strong></td>
                      <td>${att.hasAbsent ? att.absentLabels.join(' ') : '<span style="color:var(--text-light)">无缺勤</span>'}</td>
                      <td>
                        <button class="btn btn-ghost btn-sm" onclick="App.openAbsentModal('${t.id}')">${att.hasAbsent?'编辑缺勤':'标记缺勤'}</button>
                      </td>
                    </tr>`;
                  }).join('')}
                </tbody>
              </table>
            </div>
          ` : `<div class="empty-state"><div class="empty-state-icon">📅</div><div class="empty-state-text">暂无教师，请先添加教师</div></div>`}
        ` : ''}

        ${tab === 'evening_summer' ? `
          <div class="highlight-box">
            📚 <strong>晚辅导/暑期班考勤</strong> — 默认所有学生出勤，由年级固定老师标记缺勤<br>
            点击日期循环切换：出勤 → 半天缺勤 → 全天缺勤 → 出勤
          </div>
          ${eveningSummerStudents.length ? `
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>学生</th>
                    <th>年级</th>
                    <th>年级老师</th>
                    <th>出勤</th>
                    <th>缺勤</th>
                    <th>半天缺</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  ${eveningSummerStudents.map(s => {
                    const att = countStudentAtt(s, 'evening_summer', true);
                    const gts = (s.gradeTeachers||[]).map(gt => {
                      const t = d.teachers.find(x=>x.id===gt.teacherId);
                      return t ? t.name : null;
                    }).filter(Boolean);
                    const types = (s.enrollTypes||[]).filter(t => t === 'evening' || t === 'summer')
                      .map(t => `<span class="tag ${ENROLL_TYPES.find(x=>x.key===t)?.cls}">${ENROLL_TYPES.find(x=>x.key===t)?.label}</span>`).join(' ');
                    return `<tr>
                      <td><strong>${s.name}</strong></td>
                      <td>${s.grade||'-'} ${types}</td>
                      <td>${gts.length ? gts.map(n=>`<span class="tag tag-cyan">${n}</span>`).join(' ') : '<span style="color:var(--danger)">未绑定</span>'}</td>
                      <td><strong style="color:var(--success)">${att.present}</strong></td>
                      <td><strong style="color:${att.absent>0?'var(--danger)':'var(--text-light)'}">${att.absent}</strong></td>
                      <td><strong style="color:${att.halfAbsent>0?'var(--accent)':'var(--text-light)'}">${att.halfAbsent||0}</strong></td>
                      <td>
                        <button class="btn btn-ghost btn-sm" onclick="App.openStudentAbsentModal('${s.id}', 'evening_summer')">${att.marked>0?'编辑':'标记缺勤'}</button>
                      </td>
                    </tr>`;
                  }).join('')}
                </tbody>
              </table>
            </div>
          ` : `<div class="empty-state"><div class="empty-state-icon">📚</div><div class="empty-state-text">暂无晚辅导/暑期班学生</div></div>`}
        ` : ''}

        ${tab === 'weekend' ? `
          <div class="highlight-box">
            📅 <strong>周末托考勤</strong> — 默认所有学生缺勤，由任意老师标记出勤<br>
            点击日期循环切换：缺勤 → 出勤 → 缺勤
          </div>
          ${weekendStudents.length ? `
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>学生</th>
                    <th>年级</th>
                    <th>已标记出勤</th>
                    <th>缺勤</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  ${weekendStudents.map(s => {
                    const att = countStudentAtt(s, 'weekend', false);
                    return `<tr>
                      <td><strong>${s.name}</strong> <span class="tag tag-green">周末托</span></td>
                      <td>${s.grade||'-'}</td>
                      <td><strong style="color:var(--success)">${att.present}</strong></td>
                      <td><strong style="color:var(--text-light)">${att.absent}</strong></td>
                      <td>
                        <button class="btn btn-ghost btn-sm" onclick="App.openStudentAbsentModal('${s.id}', 'weekend')">${att.marked>0?'编辑':'标记出勤'}</button>
                      </td>
                    </tr>`;
                  }).join('')}
                </tbody>
              </table>
            </div>
          ` : `<div class="empty-state"><div class="empty-state-icon">📅</div><div class="empty-state-text">暂无周末托学生</div></div>`}
        ` : ''}
      </div>
    `;
  },

  setShouldDays(teacherId, val) {
    const d = DB.get();
    const t = d.teachers.find(x=>x.id===teacherId);
    if (!t) return;
    const month = this.state.currentMonth;
    if (!t.salaryRecords) t.salaryRecords = {};
    if (!t.salaryRecords[month]) t.salaryRecords[month] = {};
    t.salaryRecords[month].shouldDays = Number(val)||0;
    DB.persist();
    toast('应出勤天数已更新');
    this.render();
  },

  openAbsentModal(teacherId) {
    const d = DB.get();
    const t = d.teachers.find(x=>x.id===teacherId);
    if (!t) return;
    const month = this.state.currentMonth;
    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const rec = t.salaryRecords?.[month] || {};
    const absentRecords = rec.absentRecords || {};
    // 兼容旧格式
    (rec.absentDays || []).forEach(dd => { if (!absentRecords[dd]) absentRecords[dd] = 'full'; });

    const dayCells = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${month}-${String(day).padStart(2,'0')}`;
      const status = absentRecords[dateStr] || 'present';  // present | half | full
      const weekday = new Date(y, m-1, day).getDay();
      const isWeekend = weekday === 0 || weekday === 6;
      const cls = status === 'full' ? 'absent' : (status === 'half' ? 'half-absent' : '');
      const label = status === 'full' ? '全天缺' : (status === 'half' ? '半天缺' : '出');
      dayCells.push(`
        <div class="absent-day-cell ${cls} ${isWeekend?'weekend':''}" data-date="${dateStr}" data-status="${status}" onclick="App.cycleAbsentDay(this)">
          <div class="day-num">${day}</div>
          <div class="day-status">${label}</div>
        </div>
      `);
    }

    this.openModal(`
      <div class="modal-header">
        <div class="modal-title">标记缺勤 · ${t.name} (${month})</div>
        <button class="modal-close" data-close-modal>×</button>
      </div>
      <div class="modal-body">
        <div class="highlight-box">
          点击日期循环切换：<strong>出勤 → 半天缺 → 全天缺 → 出勤</strong><br>
          灰色=周末，橙色=半天缺勤，红色=全天缺勤
        </div>
        <div class="absent-calendar">${dayCells.join('')}</div>
        <div style="margin-top:12px;display:flex;gap:12px;font-size:12px;flex-wrap:wrap">
          <span><span class="dot dot-green"></span>出勤</span>
          <span><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--accent);margin-right:6px"></span>半天缺勤</span>
          <span><span class="dot dot-red"></span>全天缺勤</span>
          <span style="color:var(--text-light)">灰色背景=周末</span>
        </div>
        <div id="absentSummary" style="margin-top:12px;padding:10px;background:var(--primary-light);border-radius:8px;font-size:13px"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="App.clearAllAbsent()">全部出勤</button>
        <button class="btn btn-secondary" data-close-modal>取消</button>
        <button class="btn btn-primary" onclick="App.saveAbsent('${teacherId}')">保存</button>
      </div>
    `);

    this.updateAbsentSummary();
  },

  cycleAbsentDay(el) {
    // 循环: present → half → full → present
    const cur = el.dataset.status || 'present';
    let next, cls, label;
    if (cur === 'present') { next = 'half'; cls = 'half-absent'; label = '半天缺'; }
    else if (cur === 'half') { next = 'full'; cls = 'absent'; label = '全天缺'; }
    else { next = 'present'; cls = ''; label = '出'; }
    el.dataset.status = next;
    el.className = 'absent-day-cell ' + cls + (el.classList.contains('weekend') ? ' weekend' : '');
    el.querySelector('.day-status').textContent = label;
    this.updateAbsentSummary();
  },

  updateAbsentSummary() {
    const cells = $$('.absent-day-cell');
    let full = 0, half = 0;
    cells.forEach(el => {
      const s = el.dataset.status;
      if (s === 'full') full++;
      else if (s === 'half') half++;
    });
    const total = full + half * 0.5;
    const el = $('#absentSummary');
    if (el) el.innerHTML = `全天缺勤 <strong style="color:var(--danger)">${full}</strong> 天，半天缺勤 <strong style="color:var(--accent)">${half}</strong> 天，合计 <strong style="color:var(--danger)">${total}</strong> 天`;
  },

  clearAllAbsent() {
    $$('.absent-day-cell').forEach(el => {
      el.dataset.status = 'present';
      el.classList.remove('absent', 'half-absent');
      el.querySelector('.day-status').textContent = '出';
    });
    this.updateAbsentSummary();
  },

  saveAbsent(teacherId) {
    const d = DB.get();
    const t = d.teachers.find(x=>x.id===teacherId);
    if (!t) return;
    const month = this.state.currentMonth;
    if (!t.salaryRecords) t.salaryRecords = {};
    if (!t.salaryRecords[month]) t.salaryRecords[month] = {};
    // 收集缺勤记录
    const absentRecords = {};
    $$('.absent-day-cell').forEach(el => {
      const s = el.dataset.status;
      if (s === 'full' || s === 'half') absentRecords[el.dataset.date] = s;
    });
    const shouldDays = t.salaryRecords[month].shouldDays ?? 22;
    const fullAbsent = Object.values(absentRecords).filter(v => v === 'full').length;
    const halfAbsent = Object.values(absentRecords).filter(v => v === 'half').length;
    t.salaryRecords[month].absentRecords = absentRecords;
    t.salaryRecords[month].absentDays = Object.keys(absentRecords); // 兼容
    t.salaryRecords[month].actualDays = shouldDays - fullAbsent - halfAbsent * 0.5;
    DB.persist();
    this.closeModal();
    toast(`已保存 ${t.name} 的考勤记录`);
    this.render();
  },

  /* ---- 学生考勤 (晚辅导/暑期班 + 周末托) ---- */
  openStudentAbsentModal(studentId, attType) {
    const d = DB.get();
    const s = d.students.find(x=>x.id===studentId);
    if (!s) return;
    const month = this.state.currentMonth;
    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const isWeekend = attType === 'weekend';
    const records = s.attendanceRecords?.[month]?.[attType] || {};

    const dayCells = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${month}-${String(day).padStart(2,'0')}`;
      const weekday = new Date(y, m-1, day).getDay();
      const isWeekendDay = weekday === 0 || weekday === 6;
      let status, cls, label;
      if (isWeekend) {
        // 周末托: 默认缺勤, 标记出勤
        status = records[dateStr] || 'absent';
        if (status === 'present') { cls = 'present'; label = '出'; }
        else { cls = 'absent'; label = '缺'; }
      } else {
        // 晚辅导/暑期班: 默认出勤, 标记缺勤
        status = records[dateStr] || 'present';
        if (status === 'absent') { cls = 'absent'; label = '全天缺'; }
        else if (status === 'half') { cls = 'half-absent'; label = '半天缺'; }
        else { cls = ''; label = '出'; }
      }
      dayCells.push(`
        <div class="absent-day-cell ${cls} ${isWeekendDay?'weekend':''}" data-date="${dateStr}" data-status="${status}" data-type="${attType}" onclick="App.cycleStudentAbsentDay(this)">
          <div class="day-num">${day}</div>
          <div class="day-status">${label}</div>
        </div>
      `);
    }

    const title = isWeekend ? `标记出勤 · ${s.name} (${month})` : `标记缺勤 · ${s.name} (${month})}`;
    const hint = isWeekend
      ? '点击日期循环切换：<strong>缺勤 → 出勤 → 缺勤</strong>（周末托默认缺勤，标记出勤）'
      : '点击日期循环切换：<strong>出勤 → 半天缺 → 全天缺 → 出勤</strong>（晚辅导/暑期班默认出勤）';

    this.openModal(`
      <div class="modal-header">
        <div class="modal-title">${title}</div>
        <button class="modal-close" data-close-modal>×</button>
      </div>
      <div class="modal-body">
        <div class="highlight-box">${hint}</div>
        <div class="absent-calendar">${dayCells.join('')}</div>
        <div style="margin-top:12px;display:flex;gap:12px;font-size:12px;flex-wrap:wrap">
          ${isWeekend ? `
            <span><span class="dot dot-green"></span>出勤</span>
            <span><span class="dot dot-red"></span>缺勤（默认）</span>
          ` : `
            <span><span class="dot dot-green"></span>出勤（默认）</span>
            <span><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--accent);margin-right:6px"></span>半天缺勤</span>
            <span><span class="dot dot-red"></span>全天缺勤</span>
          `}
          <span style="color:var(--text-light)">灰色背景=周末</span>
        </div>
        <div id="absentSummary" style="margin-top:12px;padding:10px;background:var(--primary-light);border-radius:8px;font-size:13px"></div>
      </div>
      <div class="modal-footer">
        ${isWeekend ? '<button class="btn btn-secondary" onclick="App.clearAllStudentAbsent()">全部缺勤</button>' : '<button class="btn btn-secondary" onclick="App.clearAllStudentAbsent()">全部出勤</button>'}
        <button class="btn btn-secondary" data-close-modal>取消</button>
        <button class="btn btn-primary" onclick="App.saveStudentAbsent('${studentId}', '${attType}')">保存</button>
      </div>
    `);

    this.updateStudentAbsentSummary(attType);
  },

  cycleStudentAbsentDay(el) {
    const cur = el.dataset.status || 'present';
    const attType = el.dataset.type;
    let next, cls, label;
    if (attType === 'weekend') {
      // 周末托: absent → present → absent
      if (cur === 'absent') { next = 'present'; cls = 'present'; label = '出'; }
      else { next = 'absent'; cls = 'absent'; label = '缺'; }
    } else {
      // 晚辅导/暑期班: present → half → absent → present
      if (cur === 'present') { next = 'half'; cls = 'half-absent'; label = '半天缺'; }
      else if (cur === 'half') { next = 'absent'; cls = 'absent'; label = '全天缺'; }
      else { next = 'present'; cls = ''; label = '出'; }
    }
    el.dataset.status = next;
    el.className = 'absent-day-cell ' + cls + (el.classList.contains('weekend') ? ' weekend' : '');
    el.querySelector('.day-status').textContent = label;
    this.updateStudentAbsentSummary(attType);
  },

  updateStudentAbsentSummary(attType) {
    const cells = $$('.absent-day-cell');
    let present = 0, absent = 0, half = 0;
    cells.forEach(el => {
      const s = el.dataset.status;
      if (s === 'present') present++;
      else if (s === 'absent') absent++;
      else if (s === 'half') half++;
    });
    const el = $('#absentSummary');
    if (el) {
      if (attType === 'weekend') {
        el.innerHTML = `出勤 <strong style="color:var(--success)">${present}</strong> 天，缺勤 <strong style="color:var(--text-light)">${absent}</strong> 天`;
      } else {
        const totalAbsent = absent + half * 0.5;
        el.innerHTML = `出勤 <strong style="color:var(--success)">${present}</strong> 天，全天缺勤 <strong style="color:var(--danger)">${absent}</strong> 天，半天缺勤 <strong style="color:var(--accent)">${half}</strong> 天，合计缺勤 <strong style="color:var(--danger)">${totalAbsent}</strong> 天`;
      }
    }
  },

  clearAllStudentAbsent() {
    const attType = $$('.absent-day-cell')[0]?.dataset.type;
    $$('.absent-day-cell').forEach(el => {
      if (attType === 'weekend') {
        el.dataset.status = 'absent';
        el.classList.remove('present');
        el.classList.add('absent');
        el.querySelector('.day-status').textContent = '缺';
      } else {
        el.dataset.status = 'present';
        el.classList.remove('absent', 'half-absent');
        el.querySelector('.day-status').textContent = '出';
      }
    });
    this.updateStudentAbsentSummary(attType);
  },

  saveStudentAbsent(studentId, attType) {
    const d = DB.get();
    const s = d.students.find(x=>x.id===studentId);
    if (!s) return;
    const month = this.state.currentMonth;
    if (!s.attendanceRecords) s.attendanceRecords = {};
    if (!s.attendanceRecords[month]) s.attendanceRecords[month] = {};
    // 收集考勤记录
    const records = {};
    $$('.absent-day-cell').forEach(el => {
      const status = el.dataset.status;
      const date = el.dataset.date;
      if (attType === 'weekend') {
        // 周末托: 只记录出勤的日期
        if (status === 'present') records[date] = 'present';
      } else {
        // 晚辅导/暑期班: 只记录缺勤的日期
        if (status === 'absent' || status === 'half') records[date] = status;
      }
    });
    s.attendanceRecords[month][attType] = records;
    DB.persist();
    this.closeModal();
    toast(`已保存 ${s.name} 的考勤记录`);
    this.render();
  },

  /* ====================================================================
   *  视图: 工资结算
   * ================================================================== */
  viewSalary() {
    const d = DB.get();
    const teachers = d.teachers;
    const month = this.state.currentMonth;

    const rows = teachers.map(t => {
      const sal = this.calcTeacherSalary(t, month);
      return { t, sal };
    });
    const grandTotal = rows.reduce((s,r)=>s+r.sal.total, 0);

    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="title-icon"></span>工资结算</div>
          <div class="month-selector">
            <button class="month-nav-btn" onclick="App.state.currentMonth=monthNav(App.state.currentMonth,-1); App.render()">‹</button>
            <input type="month" value="${month}" onchange="App.state.currentMonth=this.value; App.render()">
            <button class="month-nav-btn" onclick="App.state.currentMonth=monthNav(App.state.currentMonth,1); App.render()">›</button>
          </div>
        </div>

        <div class="highlight-box">
          结算月份: <strong>${month}</strong> | 教师数: ${teachers.length} | 工资合计: <strong>${fmtMoney(grandTotal)}</strong>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>教师</th>
                <th>基本工资</th>
                <th>绩效工资</th>
                <th>全勤奖</th>
                <th>绩效津贴</th>
                <th>课时费</th>
                <th>岗位补助</th>
                <th>交通补贴</th>
                <th>请假扣除</th>
                <th>社保</th>
                <th>实发</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              ${rows.length ? rows.map(({t,sal}) => {
                const isHourly = t.jobType === 'hourly';
                return `
                <tr>
                  <td><strong>${t.name}</strong><br><span style="font-size:11px;color:var(--text-light)">${t.dept} · ${isHourly?'时薪':(t.level||'')} ${isHourly?`(${fmtMoney(t.hourlyRate)}/h)`:''}</span></td>
                  <td>${isHourly ? `<span style="color:var(--text-light)">—</span>` : fmtMoney(sal.baseSalary)}</td>
                  <td>${isHourly ? `<span style="color:var(--cyan)">${fmtMoney(sal.hourlySalary)}</span><br><span style="font-size:10px;color:var(--text-light)">${fmtMoney(t.hourlyRate)}×${sal.actualHours}h</span>` : `${fmtMoney(sal.perfSalary)}<br><span style="font-size:10px;color:var(--text-light)">${sal.perfBase}×${sal.perfScore}%</span>`}</td>
                  <td>${isHourly ? '<span style="color:var(--text-light)">—</span>' : ((t.jobType||'full')==='part'?'<span style="color:var(--text-light)">兼职</span>':(sal.fullAttendBonus>0?`<span style="color:var(--success)">${fmtMoney(sal.fullAttendBonus)}</span>`:'-'))}</td>
                  <td>${isHourly ? '-' : (sal.perfAllowance>0?fmtMoney(sal.perfAllowance):'-')}</td>
                  <td>${sal.courseFee>0?fmtMoney(sal.courseFee):'-'}</td>
                  <td>${sal.postBonus>0?fmtMoney(sal.postBonus):'-'}</td>
                  <td>${sal.transportBonus>0?fmtMoney(sal.transportBonus):'-'}</td>
                  <td>${(!isHourly && sal.leaveDeduction>0) ? `<span style="color:var(--danger)">-${fmtMoney(sal.leaveDeduction)}</span><br><span style="font-size:10px;color:var(--text-light)">${sal.absentCount}天</span>` : '-'}</td>
                  <td>${sal.socialType==='pay'
                    ? `<span style="color:var(--danger)">-${fmtMoney(sal.socialDeduction)}</span>`
                    : (sal.socialSubsidy>0
                      ? `<span style="color:var(--success)">+${fmtMoney(sal.socialSubsidy)}</span>`
                      : '-')}</td>
                  <td><strong style="color:var(--primary);font-size:15px">${fmtMoney(sal.total)}</strong></td>
                  <td>
                    <button class="btn btn-ghost btn-sm" onclick="App.openSalaryEdit('${t.id}')">调整</button>
                    <button class="btn btn-ghost btn-sm" onclick="App.openTeacherDetail('${t.id}')">详情</button>
                  </td>
                </tr>
              `;}).join('') : `<tr><td colspan="12" class="table-empty">暂无教师</td></tr>`}
            </tbody>
            <tfoot>
              <tr style="background:var(--primary-light);font-weight:700">
                <td>合计</td>
                <td colspan="9"></td>
                <td style="color:var(--primary);font-size:16px">${fmtMoney(grandTotal)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    `;
  },

  /* ====================================================================
   *  视图: 课时消耗
   * ================================================================== */
  viewHours() {
    const d = DB.get();
    const privateStudents = d.students.filter(s => (s.enrollTypes||[]).includes('private'));
    const month = this.state.currentMonth;
    const monthLogs = d.hourLogs.filter(l => l.date.startsWith(month));

    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="title-icon"></span>课时消耗记录</div>
          <div class="month-selector">
            <button class="month-nav-btn" onclick="App.state.currentMonth=monthNav(App.state.currentMonth,-1); App.render()">‹</button>
            <input type="month" value="${month}" onchange="App.state.currentMonth=this.value; App.render()">
            <button class="month-nav-btn" onclick="App.state.currentMonth=monthNav(App.state.currentMonth,1); App.render()">›</button>
          </div>
        </div>

        <div class="consume-panel">
          <div class="consume-panel-header">
            <div class="consume-panel-title">⚡ 快速消课 — 点击学生即可记录</div>
            <button class="btn btn-primary btn-sm" onclick="App.openConsumeForm()">+ 手动记录</button>
          </div>
          ${privateStudents.length ? `
            <div class="consume-quick-grid">
              ${privateStudents.map(s => {
                const ths = s.teacherHours || [];
                const remainInfo = ths.length
                  ? ths.map(th => {
                      const t = d.teachers.find(x=>x.id===th.teacherId);
                      return `${t?t.name:'?'}:${th.hours||0}`;
                    }).join(' | ')
                  : `${s.remainHours||0} 课时`;
                return `
                <div class="consume-quick-item">
                  <div class="consume-quick-name">${s.name}</div>
                  <div class="consume-quick-info">剩余 ${remainInfo}</div>
                  <div class="consume-quick-actions">
                    <button class="consume-mini-btn" onclick="App.openConsumeForm('${s.id}')">消课</button>
                  </div>
                </div>`;
              }).join('')}
            </div>
          ` : `<div style="text-align:center;padding:12px;color:#5a4500">暂无小课学生，请先在学生管理中添加报名"小课"</div>`}
        </div>

        <div class="card-title" style="margin:16px 0 10px"><span class="title-icon"></span>${month} 消课明细</div>
        ${monthLogs.length ? `
          <div class="table-wrap">
            <table>
              <thead><tr><th>日期</th><th>学生</th><th>教师</th><th>消耗</th><th>单价</th><th>教师课时费</th><th>剩余</th><th>操作</th></tr></thead>
              <tbody>
                ${monthLogs.slice().reverse().map(l => {
                  const s = d.students.find(x=>x.id===l.studentId);
                  const t = d.teachers.find(x=>x.id===l.teacherId);
                  return `<tr>
                    <td>${fmtDate(l.date)}</td>
                    <td>${s?s.name:'已删除'}</td>
                    <td>${t?t.name:'-'}</td>
                    <td><strong style="color:var(--danger)">-${l.hours}</strong></td>
                    <td>${fmtMoney(l.unitPrice)}</td>
                    <td><strong style="color:var(--success)">${fmtMoney(l.hours*l.unitPrice*(t?(t.shareRate||DB.get().settings.defaultShareRate):0)/100)}</strong></td>
                    <td>${l.remainAfter}</td>
                    <td><button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="App.delHourLog('${l.id}')">删除</button></td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        ` : `<div class="empty-state"><div class="empty-state-icon">⏱️</div><div class="empty-state-text">本月暂无消课记录</div></div>`}
      </div>
    `;
  },

  openConsumeForm(studentId=null) {
    const d = DB.get();
    const privateStudents = d.students.filter(s => (s.enrollTypes||[]).includes('private'));
    if (!privateStudents.length) { toast('暂无小课学生', 'warning'); return; }

    const s = studentId ? d.students.find(x=>x.id===studentId) : null;
    const preStudent = s ? s.id : '';

    // 根据学生获取绑定教师列表 (小课绑定 + 有课时分配的老师)
    const getBoundTeachers = (sid) => {
      const stu = d.students.find(x=>x.id===sid);
      if (!stu) return [];
      // 优先: teacherHours 中有分配的老师
      const ths = stu.teacherHours || [];
      if (ths.length) {
        return ths.map(th => {
          const t = d.teachers.find(x=>x.id===th.teacherId);
          return t ? { id: t.id, name: t.name, rate: t.shareRate || d.settings.defaultShareRate, hours: th.hours } : null;
        }).filter(Boolean);
      }
      // 兼容旧数据: 没有 teacherHours, 用绑定的小课老师
      const bindings = (stu.teacherBindings || []).filter(b => b.enrollType === 'private' || !b.enrollType);
      if (bindings.length) {
        return bindings.map(b => {
          const t = d.teachers.find(x=>x.id===b.teacherId);
          return t ? { id: t.id, name: t.name, rate: t.shareRate || d.settings.defaultShareRate, hours: stu.remainHours||0 } : null;
        }).filter(Boolean);
      }
      const all = (stu.teacherBindings || []).map(b => {
        const t = d.teachers.find(x=>x.id===b.teacherId);
        return t ? { id: t.id, name: t.name, rate: t.shareRate || d.settings.defaultShareRate, hours: stu.remainHours||0 } : null;
      }).filter(Boolean);
      return all.length ? all : d.teachers.map(t => ({ id: t.id, name: t.name, rate: t.shareRate || d.settings.defaultShareRate, hours: stu.remainHours||0 }));
    };

    // 初始教师列表
    const initTeachers = preStudent ? getBoundTeachers(preStudent) : [];
    const preTeacher = initTeachers.length ? initTeachers[0].id : (d.teachers[0]?.id || '');

    const pf = s?.projectFees?.private || {};
    const initHours = initTeachers.length ? initTeachers[0].hours : 0;

    this.openModal(`
      <div class="modal-header">
        <div class="modal-title">记录课时消耗</div>
        <button class="modal-close" data-close-modal>×</button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">学生<span class="required">*</span></label>
            <select class="form-select" id="cf_student" onchange="App.onConsumeStudentChange()">
              ${privateStudents.map(s=>`<option value="${s.id}" ${preStudent===s.id?'selected':''}>${s.name} (剩${s.remainHours||0})</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">授课教师<span class="required">*</span></label>
            <select class="form-select" id="cf_teacher" onchange="App.updateConsumeRemaining()">
              ${initTeachers.map(t=>`<option value="${t.id}" ${preTeacher===t.id?'selected':''}>${t.name} (${t.rate}%) 剩${t.hours}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-row-3">
          <div class="form-group">
            <label class="form-label">消耗课时<span class="required">*</span></label>
            <input class="form-input" type="number" id="cf_hours" value="1" min="0.5" step="0.5">
          </div>
          <div class="form-group">
            <label class="form-label">单课时单价 (元)</label>
            <input class="form-input" type="number" id="cf_price" value="${pf.unitPrice||100}">
          </div>
          <div class="form-group">
            <label class="form-label">日期</label>
            <input class="form-input" type="date" id="cf_date" value="${today()}">
          </div>
        </div>
        <div class="highlight-box" id="cf_preview">填写后将显示课时费预览</div>
        <div class="form-group">
          <label class="form-label">备注</label>
          <input class="form-input" id="cf_note" placeholder="可选">
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-close-modal>取消</button>
        <button class="btn btn-primary" onclick="App.saveConsume()">确认消课</button>
      </div>
    `);

    ['cf_hours','cf_price'].forEach(id => {
      const el = $('#'+id);
      if (el) el.oninput = () => this.updateConsumeRemaining();
    });
    this.updateConsumeRemaining();
  },

  onConsumeStudentChange() {
    const sid = $('#cf_student')?.value;
    if (!sid) return;
    const d = DB.get();
    const s = d.students.find(x=>x.id===sid);
    if (!s) return;
    // 获取该学生的老师+课时分配
    const ths = s.teacherHours || [];
    let teachers;
    if (ths.length) {
      teachers = ths.map(th => {
        const t = d.teachers.find(x=>x.id===th.teacherId);
        return t ? { id: t.id, name: t.name, rate: t.shareRate || d.settings.defaultShareRate, hours: th.hours } : null;
      }).filter(Boolean);
    } else {
      const bindings = (s.teacherBindings || []).filter(b => b.enrollType === 'private' || !b.enrollType);
      if (bindings.length) {
        teachers = bindings.map(b => {
          const t = d.teachers.find(x=>x.id===b.teacherId);
          return t ? { id: t.id, name: t.name, rate: t.shareRate || d.settings.defaultShareRate, hours: s.remainHours||0 } : null;
        }).filter(Boolean);
      } else {
        const all = (s.teacherBindings || []).map(b => {
          const t = d.teachers.find(x=>x.id===b.teacherId);
          return t ? { id: t.id, name: t.name, rate: t.shareRate || d.settings.defaultShareRate, hours: s.remainHours||0 } : null;
        }).filter(Boolean);
        teachers = all.length ? all : d.teachers.map(t => ({ id: t.id, name: t.name, rate: t.shareRate || d.settings.defaultShareRate, hours: s.remainHours||0 }));
      }
    }
    const sel = $('#cf_teacher');
    if (sel) {
      sel.innerHTML = teachers.map(t => `<option value="${t.id}">${t.name} (${t.rate}%) 剩${t.hours}</option>`).join('');
    }
    // 更新单价
    const pf = s?.projectFees?.private || {};
    const priceEl = $('#cf_price');
    if (priceEl && pf.unitPrice) priceEl.value = pf.unitPrice;
    this.updateConsumeRemaining();
  },

  updateConsumeRemaining() {
    const sid = $('#cf_student')?.value;
    const tid = $('#cf_teacher')?.value;
    const hours = Number($('#cf_hours')?.value)||0;
    const price = Number($('#cf_price')?.value)||0;
    if (!sid || !tid) return;
    const s = DB.get().students.find(x=>x.id===sid);
    const t = DB.get().teachers.find(x=>x.id===tid);
    if (!s || !t) return;
    // 从该老师的分配课时中扣减
    const teacherHours = this.getTeacherHours(s, tid);
    const remain = teacherHours - hours;
    const fee = hours * price * (t.shareRate||DB.get().settings.defaultShareRate) / 100;
    const el = $('#cf_preview');
    if (el) el.innerHTML = `
      ${t.name} 课时: <strong>${teacherHours}</strong> → 消耗后 <strong style="color:${remain<0?'var(--danger)':'var(--success)'}">${remain}</strong> |
      教师课时费: <strong>${fmtMoney(fee)}</strong> = ${hours} × ${fmtMoney(price)} × ${t.shareRate||DB.get().settings.defaultShareRate}%
    `;
  },

  saveConsume() {
    const sid = $('#cf_student').value;
    const tid = $('#cf_teacher').value;
    const hours = Number($('#cf_hours').value)||0;
    const price = Number($('#cf_price').value)||0;
    const date = $('#cf_date').value;
    const note = $('#cf_note').value.trim();

    if (hours <= 0) { toast('请填写正确的课时数', 'error'); return; }
    const d = DB.get();
    const s = d.students.find(x=>x.id===sid);
    if (!s) return;
    // 检查该老师的课时
    const teacherHours = this.getTeacherHours(s, tid);
    if (teacherHours < hours) { toast(`${d.teachers.find(x=>x.id===tid)?.name} 的剩余课时不足 (${teacherHours})`, 'error'); return; }

    // 从该老师的分配课时中扣减
    if (!s.teacherHours) s.teacherHours = [];
    const th = s.teacherHours.find(x => x.teacherId === tid);
    if (th) {
      th.hours -= hours;
    } else {
      // 兼容旧数据: 创建 teacherHours
      s.teacherHours.push({ teacherId: tid, hours: (s.remainHours||0) - hours });
    }
    // 更新汇总 remainHours
    s.remainHours = (s.teacherHours || []).reduce((sum, x) => sum + (x.hours||0), 0);

    const log = {
      id: uid(),
      studentId: sid,
      teacherId: tid,
      hours, unitPrice: price,
      date: new Date(date).toISOString(),
      remainAfter: teacherHours - hours,
      note,
    };
    d.hourLogs.push(log);
    DB.persist();
    this.closeModal();
    toast(`已记录 ${s.name} 消课 ${hours} 课时`);
    this.render();
  },

  delHourLog(id) {
    if (!confirm('确认删除该消课记录？课时会退回给对应老师。')) return;
    const d = DB.get();
    const log = d.hourLogs.find(x=>x.id===id);
    if (!log) return;
    const s = d.students.find(x=>x.id===log.studentId);
    if (s) {
      // 课时退回给该老师
      if (!s.teacherHours) s.teacherHours = [];
      const th = s.teacherHours.find(x => x.teacherId === log.teacherId);
      if (th) {
        th.hours += log.hours;
      } else {
        s.teacherHours.push({ teacherId: log.teacherId, hours: log.hours });
      }
      s.remainHours = (s.teacherHours || []).reduce((sum, x) => sum + (x.hours||0), 0);
    }
    d.hourLogs = d.hourLogs.filter(x=>x.id!==id);
    DB.persist();
    toast('已删除, 课时已退回');
    this.render();
  },

  /* 快速消课面板 (dashboard入口) */
  openConsumePanel() {
    this.view = 'hours';
    this.render();
  },

  /* ====================================================================
   *  视图: 收支总览
   * ================================================================== */
  viewFinance() {
    const d = DB.get();
    const month = this.state.currentMonth;
    const monthPays = d.payments.filter(p => p.date.startsWith(month));
    const income = monthPays.reduce((s,p)=>s+(Number(p.amount)||0),0);
    const salary = d.teachers.reduce((s,t)=>s+this.calcTeacherSalary(t,month).total,0);
    const net = income - salary;

    // 学生缴费列表
    return `
      <div class="stats-grid">
        ${this.statCard('green','💰', fmtMoney(income), '本月收入', `${monthPays.length} 笔`)}
        ${this.statCard('red','💸', fmtMoney(salary), '本月工资', `${d.teachers.length} 名教师`)}
        ${this.statCard(net>=0?'blue':'orange','📊', fmtMoney(net), '本月结余', net>=0?'盈利':'亏损')}
        ${this.statCard('purple','📋', fmtMoney(d.payments.reduce((s,p)=>s+p.amount,0)), '累计收入', '全部月份')}
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="title-icon"></span>${month} 缴费明细</div>
          <button class="btn btn-primary btn-sm" onclick="App.openPaymentForm()">+ 登记缴费</button>
        </div>
        ${monthPays.length ? `
          <div class="table-wrap">
            <table>
              <thead><tr><th>日期</th><th>学生</th><th>项目</th><th>金额</th><th>方式</th><th>备注</th><th>操作</th></tr></thead>
              <tbody>
                ${monthPays.slice().reverse().map(p => {
                  const s = d.students.find(x=>x.id===p.studentId);
                  const etype = ENROLL_TYPES.find(x=>x.key===p.enrollType);
                  return `<tr>
                    <td>${fmtDate(p.date)}</td>
                    <td>${s?s.name:'已删除'}</td>
                    <td>${etype ? `<span class="tag ${etype.cls}">${etype.label}</span>` : (p.enrollType||'-')}</td>
                    <td><strong style="color:var(--success)">${fmtMoney(p.amount)}</strong></td>
                    <td><span class="tag ${p.mode==='monthly'?'tag-blue':'tag-green'}">${PAY_MODES.find(m=>m.key===p.mode)?.label||'-'}</span></td>
                    <td>${p.note||'-'}</td>
                    <td><button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="App.delPayment('${p.id}')">删除</button></td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        ` : `<div class="empty-state"><div class="empty-state-icon">💰</div><div class="empty-state-text">本月暂无缴费</div></div>`}
      </div>
    `;
  },

  openPaymentForm() {
    const d = DB.get();
    if (!d.students.length) { toast('请先添加学生', 'warning'); return; }
    this.openModal(`
      <div class="modal-header">
        <div class="modal-title">登记缴费</div>
        <button class="modal-close" data-close-modal>×</button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">学生<span class="required">*</span></label>
            <select class="form-select" id="pf_student" onchange="App.updatePaymentDefault()">
              ${d.students.map(s=>`<option value="${s.id}">${s.name} (${s.grade||'-'})</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">缴费项目<span class="required">*</span></label>
            <select class="form-select" id="pf_enrollType" onchange="App.updatePaymentDefault()">
              ${ENROLL_TYPES.map(t=>`<option value="${t.key}">${t.label}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">金额 (元)<span class="required">*</span></label>
            <input class="form-input" type="number" id="pf_amount" value="0">
          </div>
          <div class="form-group">
            <label class="form-label">缴费方式</label>
            <select class="form-select" id="pf_mode">
              ${PAY_MODES.map(m=>`<option value="${m.key}">${m.label}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">日期</label>
            <input class="form-input" type="date" id="pf_date" value="${today()}">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">备注</label>
          <input class="form-input" id="pf_note" placeholder="如: 7月晚辅导学费">
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-close-modal>取消</button>
        <button class="btn btn-primary" onclick="App.savePayment()">保存</button>
      </div>
    `);
    this.updatePaymentDefault();
  },

  updatePaymentDefault() {
    const sid = $('#pf_student')?.value;
    const etype = $('#pf_enrollType')?.value;
    if (!sid) return;
    const s = DB.get().students.find(x=>x.id===sid);
    if (!s) return;
    const pf = s.projectFees?.[etype] || {};
    const modeEl = $('#pf_mode');
    const amtEl = $('#pf_amount');
    // 根据项目自动填费用
    if (amtEl && (!amtEl.value || amtEl.value === '0')) {
      amtEl.value = pf.monthly || pf.oneTime || 0;
    }
    // 有月费默认按月, 只有一次性费用默认一次性
    if (modeEl) {
      if (pf.monthly && !pf.oneTime) modeEl.value = 'monthly';
      else if (!pf.monthly && pf.oneTime) modeEl.value = 'one_time';
    }
    // 更新该学生的项目列表
    const typeSel = $('#pf_enrollType');
    if (typeSel && s.enrollTypes) {
      // 保留当前选中项, 重新生成选项(仅显示学生报名的类型)
      const curVal = typeSel.value;
      typeSel.innerHTML = (s.enrollTypes||[]).map(t => {
        const f = ENROLL_TYPES.find(x=>x.key===t);
        return f ? `<option value="${t}" ${curVal===t?'selected':''}>${f.label}</option>` : '';
      }).join('');
    }
  },

  savePayment() {
    const sid = $('#pf_student').value;
    const amount = Number($('#pf_amount').value)||0;
    const mode = $('#pf_mode').value;
    const enrollType = $('#pf_enrollType').value;
    const date = $('#pf_date').value;
    const note = $('#pf_note').value.trim();
    if (amount <= 0) { toast('请填写正确金额', 'error'); return; }
    if (!enrollType) { toast('请选择缴费项目', 'error'); return; }
    const d = DB.get();
    d.payments.push({
      id: uid(),
      studentId: sid,
      amount, mode,
      enrollType,
      date: new Date(date).toISOString(),
      note,
    });
    DB.persist();
    this.closeModal();
    toast('缴费已登记');
    this.render();
  },

  delPayment(id) {
    if (!confirm('确认删除该缴费记录？')) return;
    const d = DB.get();
    d.payments = d.payments.filter(x=>x.id!==id);
    DB.persist();
    toast('已删除');
    this.render();
  },

  /* ====================================================================
   *  视图: 系统设置
   * ================================================================== */
  viewSettings() {
    const s = DB.get().settings;
    const d = DB.get();
    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="title-icon"></span>系统设置</div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">机构名称</label>
            <input class="form-input" id="set_orgname" value="${s.orgName}">
          </div>
          <div class="form-group">
            <label class="form-label">默认分成比例 (%)<span class="hint">教师默认拿多少</span></label>
            <input class="form-input" type="number" id="set_share" value="${s.defaultShareRate}" min="0" max="100">
          </div>
        </div>
        <button class="btn btn-primary" onclick="App.saveSettings()">保存设置</button>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="title-icon" style="background:#9333ea"></span>☁️ 云端同步 (Supabase)</div>
          ${DB.getCloudConfig().enabled ? '<span class="tag tag-green">已启用</span>' : '<span class="tag tag-gray">未启用</span>'}
        </div>
        <div class="highlight-box">
          📌 启用后，所有数据（学生/教师/缴费/消课/工资）实时同步到云端，<strong>电脑、手机、教师分享端跨设备互通</strong>。<br>
          需要先去 <a href="https://supabase.com" target="_blank" style="color:var(--primary)">supabase.com</a> 免费注册一个项目，填入下方信息即可。
        </div>
        <div class="form-group">
          <label class="form-label">Project URL <span class="hint">形如 https://xxxx.supabase.co</span></label>
          <input class="form-input" id="cloud_url" value="${DB.getCloudConfig().url||''}" placeholder="https://xxxx.supabase.co">
        </div>
        <div class="form-group">
          <label class="form-label">anon public key <span class="hint">Project Settings → API → anon public</span></label>
          <input class="form-input" id="cloud_key" value="${DB.getCloudConfig().key||''}" placeholder="eyJhbGciOi..." style="font-size:11px">
        </div>
        <div class="form-hint" style="margin-bottom:12px">
          ⚠️ 填好后请先点击「创建数据表」按钮（只需一次），再点「保存并启用」。
        </div>
        <div class="data-actions">
          <button class="btn btn-secondary" onclick="App.cloudCreateTable()">🛠️ 创建数据表</button>
          <button class="btn btn-primary" onclick="App.saveCloudConfig()">💾 保存并启用</button>
          <button class="btn btn-secondary" onclick="App.cloudSyncNow()">🔄 立即同步</button>
          ${DB.getCloudConfig().enabled ? '<button class="btn btn-danger" onclick="App.disableCloud()">禁用云端</button>' : ''}
        </div>
        <div class="form-hint" style="margin-top:12px">
          ${DB.getCloudConfig().enabled ? '✅ 已启用。每次修改数据会自动推送云端（防抖800ms），打开页面会自动拉取最新数据。' : '未启用时，数据仅存本地浏览器。'}
        </div>

        ${DB.getCloudConfig().enabled ? `
          <hr class="divider">
          <div style="font-weight:600;font-size:13px;margin-bottom:10px">🔗 管理员共享链接</div>
          <div class="form-hint" style="margin-bottom:10px">
            把这个链接发给其他管理员，打开后自动连接云端、拉取数据，无需再手动配置。
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input class="form-input" readonly id="admin_share_link" value="${location.origin + location.pathname + location.search}#admin=1&c=${btoa(unescape(encodeURIComponent(JSON.stringify({u:DB.getCloudConfig().url,k:DB.getCloudConfig().key}))))}" style="font-size:11px;flex:1;min-width:200px" onclick="this.select()">
            <button class="btn btn-primary btn-sm" onclick="App.copyAdminLink()">📋 复制链接</button>
          </div>
        ` : ''}
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="title-icon"></span>导出 Excel</div>
        </div>
        <div class="data-actions">
          <button class="btn btn-secondary" onclick="App.exportExcel('students')">📋 学生数据</button>
          <button class="btn btn-secondary" onclick="App.exportExcel('teachers')">🧑‍🏫 教师数据</button>
          <button class="btn btn-secondary" onclick="App.exportExcel('payments')">💰 缴费记录</button>
          <button class="btn btn-secondary" onclick="App.exportExcel('hours')">⏱️ 消课记录</button>
          <button class="btn btn-secondary" onclick="App.exportExcel('attendance')">📅 考勤记录</button>
          <button class="btn btn-secondary" onclick="App.exportExcel('salary')">💸 工资结算</button>
          <button class="btn btn-primary" onclick="App.exportExcel('all')">📦 全部导出</button>
        </div>
        <div class="form-hint" style="margin-top:12px">
          点击按钮即可导出对应 Excel 文件 (.xlsx)。"全部导出"会把所有数据汇总到一个多 Sheet 工作簿。
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="title-icon"></span>数据备份</div>
        </div>
        <div class="data-actions">
          <button class="btn btn-secondary" onclick="App.exportData()">⬇️ 导出 JSON 备份</button>
          <button class="btn btn-secondary" onclick="App.importData()">⬆️ 导入 JSON</button>
          <input type="file" id="importFile" accept=".json" style="display:none" onchange="App.handleImport(this)">
          <button class="btn btn-danger" onclick="App.resetData()">🗑️ 重置全部数据</button>
        </div>
        <div class="form-hint" style="margin-top:12px">
          数据存储在浏览器本地 (localStorage), 同一浏览器/域名下电脑和手机端可共享。建议定期导出备份。
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="title-icon"></span>数据统计</div>
        </div>
        <div class="info-list">
          <div class="info-item"><span class="info-label">学生总数</span><span class="info-value">${d.students.length}</span></div>
          <div class="info-item"><span class="info-label">教师总数</span><span class="info-value">${d.teachers.length}</span></div>
          <div class="info-item"><span class="info-label">缴费记录</span><span class="info-value">${d.payments.length} 条</span></div>
          <div class="info-item"><span class="info-label">消课记录</span><span class="info-value">${d.hourLogs.length} 条</span></div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="title-icon"></span>关于</div>
        </div>
        <div style="font-size:13px;color:var(--text-light);line-height:1.8">
          <strong>博智托管管理工作台</strong> v2.0<br>
          功能涵盖: 学生管理 / 教师管理 / 工资结算 / 课时消耗 / 收支总览 / 教师消课分享 / Excel 导出 / 云端同步<br>
          适配设备: 🖥️ 电脑 / 📱 H5 移动端<br>
          数据互通: 本地存储 + Supabase 云端同步, 跨设备实时互通
        </div>
      </div>
    `;
  },

  saveSettings() {
    const d = DB.get();
    d.settings.orgName = $('#set_orgname').value.trim() || '博智托管';
    d.settings.defaultShareRate = Number($('#set_share').value)||60;
    DB.persist();
    toast('设置已保存');
    this.render();
  },

  /* ---- 云端同步相关 ---- */
  async cloudCreateTable() {
    const url = $('#cloud_url')?.value.trim();
    const key = $('#cloud_key')?.value.trim();
    if (!url || !key) { toast('请先填写 URL 和 key', 'error'); return; }
    toast('正在创建数据表...', 'info');
    const sql = `CREATE TABLE IF NOT EXISTS bozhi_data (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE bozhi_data ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public all" ON bozhi_data;
CREATE POLICY "public all" ON bozhi_data FOR ALL USING (true) WITH CHECK (true);
INSERT INTO bozhi_data (id, payload, updated_at)
VALUES ('main', '{"students":[],"teachers":[],"hourLogs":[],"payments":[],"teacherShares":[],"settings":{"orgName":"博智托管","defaultShareRate":60}}'::jsonb, NOW())
ON CONFLICT (id) DO NOTHING;`;
    // Supabase 新版没有 exec_sql RPC, 所以直接弹出 SQL 让用户手动执行
    this.showSqlHelp(url, key, sql, true);
  },

  showSqlHelp(url, key, sql, isCreateTable=false) {
    this.openModal(`
      <div class="modal-header">
        <div class="modal-title">${isCreateTable?'🛠️ 创建数据表':'📋 SQL 指引'}</div>
        <button class="modal-close" data-close-modal>×</button>
      </div>
      <div class="modal-body">
        <div class="highlight-box">
          <strong>操作步骤：</strong><br>
          1. 打开 <a href="${url.replace('/rest/v1','')}" target="_blank" style="color:var(--primary)">Supabase Dashboard</a><br>
          2. 左侧菜单点「SQL Editor」<br>
          3. 点「New query」新建查询<br>
          4. 粘贴下方 SQL，点「Run」执行<br>
          5. 看到 Success 后，回到这里点「💾 保存并启用」
        </div>
        <textarea class="form-textarea" readonly style="min-height:240px;font-family:monospace;font-size:12px;background:#1e293b;color:#86efac;padding:12px;border-radius:8px" onclick="this.select()">${sql}</textarea>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-close-modal>关闭</button>
        <button class="btn btn-primary" onclick="navigator.clipboard.writeText(\`${sql.replace(/`/g,'\\`')}\`).then(()=>toast('SQL已复制, 去Supabase执行'))">📋 复制 SQL</button>
      </div>
    `);
  },

  async saveCloudConfig() {
    const url = $('#cloud_url')?.value.trim();
    const key = $('#cloud_key')?.value.trim();
    if (!url || !key) { toast('请填写完整', 'error'); return; }
    // 简单验证 URL
    try { new URL(url); } catch { toast('URL 格式不正确', 'error'); return; }

    DB.setCloudConfig({ url, key, enabled: true });
    toast('云端同步已启用, 正在上传数据...');
    // 立即推送一次
    const r = await DB.cloudPush();
    if (r.ok) {
      toast('数据已上传云端, 跨设备同步生效', 'success');
      localStorage.setItem('bozhi_trustee_last_sync', new Date().toISOString());
    } else {
      toast('上传失败: 请先点「创建数据表」', 'error');
    }
    this.render();
  },

  async cloudSyncNow() {
    const cfg = DB.getCloudConfig();
    if (!cfg.enabled) { toast('请先保存并启用云端', 'warning'); return; }
    toast('正在拉取云端数据...', 'info');
    const r = await DB.cloudPull();
    if (r.ok) {
      toast('同步成功', 'success');
      this.render();
    } else {
      toast('拉取失败: ' + (r.reason || r.error || '未知错误') + ', 尝试推送...', 'warning');
      const r2 = await DB.cloudPush();
      if (r2.ok) toast('已推送本地数据到云端', 'success');
      else toast('推送也失败: ' + (r2.error || ''), 'error');
    }
  },

  disableCloud() {
    if (!confirm('禁用云端同步？本地数据保留, 但不再自动同步。')) return;
    DB.clearCloudConfig();
    toast('已禁用云端同步');
    this.render();
  },

  copyAdminLink() {
    const link = $('#admin_share_link').value;
    navigator.clipboard.writeText(link).then(() => toast('管理员链接已复制'));
  },

  exportData() {
    const data = JSON.stringify(DB.get(), null, 2);
    const blob = new Blob([data], {type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `博智托管_数据备份_${today()}.json`;
    a.click();
    toast('已导出');
  },

  importData() {
    $('#importFile').click();
  },

  handleImport(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const obj = JSON.parse(e.target.result);
        if (!obj.students || !obj.teachers) throw new Error('格式不对');
        if (!confirm('导入将覆盖现有数据, 确认继续？')) return;
        localStorage.setItem('bozhi_trustee_data_v1', JSON.stringify(obj));
        DB.load();
        toast('导入成功');
        this.render();
      } catch (err) {
        toast('文件格式错误: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
  },

  resetData() {
    if (!confirm('⚠️ 确认重置全部数据？此操作不可恢复！')) return;
    if (!confirm('再次确认: 所有学生、教师、缴费、课时记录将被清空！')) return;
    DB.reset();
    toast('已重置');
    this.render();
  },

  /* ====================================================================
   *  模态框
   * ================================================================== */
  openModal(html, size='') {
    const root = $('#modalRoot');
    root.innerHTML = `<div class="modal-overlay" onclick="if(event.target===this)App.closeModal()"><div class="modal ${size}">${html}</div></div>`;
    document.body.style.overflow = 'hidden';
  },

  closeModal() {
    $('#modalRoot').innerHTML = '';
    document.body.style.overflow = '';
  },

  /* ====================================================================
   *  教师消课分享模式 (独立视图, 数据隔离)
   * ================================================================== */
  viewShareConsume() {
    const d = DB.get();
    // shareTeacherId 为 null = 正在从云端拉取数据
    if (!this.shareTeacherId) {
      const cloudOn = DB.getCloudConfig().enabled;
      if (!cloudOn) {
        return `<div class="empty-state" style="padding:80px 20px">
          <div class="empty-state-icon" style="font-size:56px">🔒</div>
          <div style="font-size:16px;font-weight:600;margin:12px 0 6px">无法访问</div>
          <div style="color:var(--text-light);max-width:360px;margin:0 auto 16px">
            此分享链接需要云端同步支持，但当前未配置云端。<br>请联系管理员开启云端同步后重试。
          </div>
          <button class="btn btn-primary" onclick="location.hash=''">返回工作台</button>
        </div>`;
      }
      return `<div class="empty-state" style="padding:80px 20px">
        <div style="font-size:40px;animation:spin 1s linear infinite;display:inline-block">⏳</div>
        <div style="font-size:14px;margin-top:12px;color:var(--text-light)">正在从云端加载学生数据...</div>
      </div>
      <style>@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}</style>`;
    }
    const t = d.teachers.find(x=>x.id===this.shareTeacherId);
    if (!t) {
      return `<div class="empty-state"><div class="empty-state-icon">🔒</div><div class="empty-state-text">链接已失效或教师不存在</div>
        <button class="btn btn-primary" onclick="location.hash=''">返回工作台</button></div>`;
    }

    // 该教师绑定的学生 (只显示小课绑定 或 有课时分配的)
    const myStudents = d.students.filter(s =>
      (s.enrollTypes||[]).includes('private') && (
        (s.teacherBindings||[]).some(b => b.teacherId === t.id) ||
        (s.teacherHours||[]).some(th => th.teacherId === t.id)
      )
    );

    // 本月消课记录
    const month = this.state.currentMonth;
    const myLogs = d.hourLogs.filter(l =>
      l.teacherId === t.id && l.date.startsWith(month)
    );
    const monthHours = myLogs.reduce((s,l)=>s+l.hours, 0);

    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="title-icon" style="background:#34a853"></span>${t.name} 老师的消课台</div>
          <div class="month-selector">
            <button class="month-nav-btn" onclick="App.state.currentMonth=monthNav(App.state.currentMonth,-1); App.render()">‹</button>
            <input type="month" value="${month}" onchange="App.state.currentMonth=this.value; App.render()">
            <button class="month-nav-btn" onclick="App.state.currentMonth=monthNav(App.state.currentMonth,1); App.render()">›</button>
          </div>
        </div>

        <div class="stats-grid">
          ${this.statCard('green','👥', myStudents.length, '我的学生', '小课绑定')}
          ${this.statCard('orange','⏱️', monthHours, '本月消课', '课时')}
          ${this.statCard('blue','📚', myLogs.length, '消课次数', month)}
        </div>

        <div class="highlight-box">
          👋 点击学生下方的按钮即可快速消课。仅显示学生姓名与你分配的剩余课时，其他数据已隐藏。
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="title-icon" style="background:#34a853"></span>我的学生</div>
        </div>
        ${myStudents.length ? `
          <div class="consume-quick-grid">
            ${myStudents.map(s => {
              const myHours = this.getTeacherHours(s, t.id);
              return `
              <div class="consume-quick-item">
                <div class="consume-quick-name">${s.name}</div>
                <div class="consume-quick-info">剩余 <strong style="color:${myHours<=2?'var(--danger)':'var(--success)'}">${myHours}</strong> 课时</div>
                <div class="consume-quick-actions">
                  <button class="consume-mini-btn" onclick="App.shareQuickConsume('${s.id}', 1)">-1</button>
                  <button class="consume-mini-btn" onclick="App.shareQuickConsume('${s.id}', 2)">-2</button>
                  <button class="consume-mini-btn" onclick="App.shareConsumeForm('${s.id}')">自定义</button>
                </div>
              </div>`;
            }).join('')}
          </div>
        ` : `<div class="empty-state"><div class="empty-state-icon">👥</div><div class="empty-state-text">暂无绑定的小课学生</div></div>`}
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="title-icon" style="background:#34a853"></span>${month} 消课记录</div>
        </div>
        ${myLogs.length ? `
          <div class="table-wrap">
            <table>
              <thead><tr><th>日期</th><th>学生</th><th>消耗</th><th>剩余</th></tr></thead>
              <tbody>
                ${myLogs.slice().reverse().map(l => {
                  const s = d.students.find(x=>x.id===l.studentId);
                  return `<tr>
                    <td>${fmtDate(l.date)}</td>
                    <td>${s?s.name:'-'}</td>
                    <td><strong style="color:var(--danger)">-${l.hours}</strong></td>
                    <td>${l.remainAfter}</td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        ` : `<div class="empty-state"><div class="empty-state-icon">⏱️</div><div class="empty-state-text">本月暂无消课记录</div></div>`}
      </div>
    `;
  },

  shareQuickConsume(studentId, hours) {
    const s = DB.get().students.find(x=>x.id===studentId);
    if (!s) return;
    const tid = this.shareTeacherId;
    const teacherHours = this.getTeacherHours(s, tid);
    if (teacherHours < hours) { toast('你的剩余课时不足', 'error'); return; }
    const d = DB.get();
    const pf = s.projectFees?.private || {};
    const unitPrice = pf.unitPrice || 100;
    // 从该老师的分配课时中扣减
    if (!s.teacherHours) s.teacherHours = [];
    const th = s.teacherHours.find(x => x.teacherId === tid);
    if (th) {
      th.hours -= hours;
    } else {
      s.teacherHours.push({ teacherId: tid, hours: teacherHours - hours });
    }
    s.remainHours = (s.teacherHours || []).reduce((sum, x) => sum + (x.hours||0), 0);
    const log = {
      id: uid(),
      studentId,
      teacherId: tid,
      hours,
      unitPrice,
      date: new Date().toISOString(),
      remainAfter: teacherHours - hours,
    };
    d.hourLogs.push(log);
    DB.persist();
    toast(`已为 ${s.name} 消课 ${hours} 课时`);
    this.render();
  },

  shareConsumeForm(studentId=null) {
    const d = DB.get();
    const t = d.teachers.find(x=>x.id===this.shareTeacherId);
    const myStudents = d.students.filter(s =>
      (s.enrollTypes||[]).includes('private') && (
        (s.teacherBindings||[]).some(b => b.teacherId === this.shareTeacherId) ||
        (s.teacherHours||[]).some(th => th.teacherId === this.shareTeacherId)
      )
    );
    if (!myStudents.length) { toast('暂无可消课学生', 'warning'); return; }

    const s = studentId ? d.students.find(x=>x.id===studentId) : null;
    const preStudent = s ? s.id : '';

    this.openModal(`
      <div class="modal-header">
        <div class="modal-title">记录课时消耗</div>
        <button class="modal-close" data-close-modal>×</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">学生<span class="required">*</span></label>
          <select class="form-select" id="cf_student" onchange="App.updateShareConsume()">
            ${myStudents.map(s=>`<option value="${s.id}" ${preStudent===s.id?'selected':''}>${s.name} (剩${this.getTeacherHours(s, this.shareTeacherId)})</option>`).join('')}
          </select>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">消耗课时<span class="required">*</span></label>
            <input class="form-input" type="number" id="cf_hours" value="1" min="0.5" step="0.5" oninput="App.updateShareConsume()">
          </div>
          <div class="form-group">
            <label class="form-label">日期</label>
            <input class="form-input" type="date" id="cf_date" value="${today()}">
          </div>
        </div>
        <div class="highlight-box" id="cf_preview">填写后将显示剩余课时</div>
        <div class="form-group">
          <label class="form-label">备注</label>
          <input class="form-input" id="cf_note" placeholder="可选">
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-close-modal>取消</button>
        <button class="btn btn-primary" onclick="App.saveShareConsume()">确认消课</button>
      </div>
    `);
    this.updateShareConsume();
  },

  updateShareConsume() {
    const sid = $('#cf_student')?.value;
    const hours = Number($('#cf_hours')?.value)||0;
    if (!sid) return;
    const s = DB.get().students.find(x=>x.id===sid);
    if (!s) return;
    const myHours = this.getTeacherHours(s, this.shareTeacherId);
    const remain = myHours - hours;
    const el = $('#cf_preview');
    if (el) el.innerHTML = `
      你的剩余课时: <strong>${myHours}</strong> → 消耗后 <strong style="color:${remain<0?'var(--danger)':'var(--success)'}">${remain}</strong>
    `;
  },

  saveShareConsume() {
    const sid = $('#cf_student').value;
    const hours = Number($('#cf_hours').value)||0;
    const date = $('#cf_date').value;
    const note = $('#cf_note').value.trim();
    if (hours <= 0) { toast('请填写正确的课时数', 'error'); return; }
    const d = DB.get();
    const s = d.students.find(x=>x.id===sid);
    if (!s) return;
    const tid = this.shareTeacherId;
    const teacherHours = this.getTeacherHours(s, tid);
    if (teacherHours < hours) { toast('你的剩余课时不足', 'error'); return; }
    const pf = s.projectFees?.private || {};
    // 从该老师的分配课时中扣减
    if (!s.teacherHours) s.teacherHours = [];
    const th = s.teacherHours.find(x => x.teacherId === tid);
    if (th) {
      th.hours -= hours;
    } else {
      s.teacherHours.push({ teacherId: tid, hours: teacherHours - hours });
    }
    s.remainHours = (s.teacherHours || []).reduce((sum, x) => sum + (x.hours||0), 0);
    const log = {
      id: uid(),
      studentId: sid,
      teacherId: tid,
      hours,
      unitPrice: pf.unitPrice || 100,
      date: new Date(date).toISOString(),
      remainAfter: teacherHours - hours,
      note,
    };
    d.hourLogs.push(log);
    DB.persist();
    this.closeModal();
    toast(`已记录 ${s.name} 消课 ${hours} 课时`);
    this.render();
  },

  /* ====================================================================
   *  教师分享端 - 考勤管理
   *  规则: 
   *    - 晚辅导/暑期班: 只有学生的年级固定老师可以标记缺勤
   *    - 周末托: 所有老师都可以标记出勤
   * ================================================================== */
  viewShareAttendance() {
    const d = DB.get();
    const t = d.teachers.find(x=>x.id===this.shareTeacherId);
    if (!t) {
      return `<div class="empty-state"><div class="empty-state-icon">🔒</div><div class="empty-state-text">链接已失效</div>
        <button class="btn btn-primary" onclick="location.hash=''">返回工作台</button></div>`;
    }
    const month = this.state.currentMonth;
    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();

    // 晚辅导/暑期班: 该老师是年级固定老师的学生
    const eveningSummerStudents = d.students.filter(s =>
      (s.enrollTypes||[]).some(et => et === 'evening' || et === 'summer') &&
      (s.gradeTeachers||[]).some(gt => gt.teacherId === t.id)
    );

    // 周末托: 所有学生（任意老师可标记出勤）
    const weekendStudents = d.students.filter(s =>
      (s.enrollTypes||[]).includes('weekend')
    );

    const getStudentAttendance = (s, type) => {
      return s.attendanceRecords?.[month]?.[type] || {};
    };

    const countStudentAtt = (s, type, defaultPresent) => {
      const records = getStudentAttendance(s, type);
      const marked = Object.keys(records).length;
      if (defaultPresent) {
        const absent = Object.values(records).filter(v => v === 'absent').length;
        const halfAbsent = Object.values(records).filter(v => v === 'half').length;
        return { absent, halfAbsent, marked, present: daysInMonth - absent - halfAbsent };
      } else {
        const present = Object.values(records).filter(v => v === 'present').length;
        return { present, absent: daysInMonth - present, marked };
      }
    };

    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="title-icon" style="background:#34a853"></span>${t.name} 的考勤台</div>
          <div class="month-selector">
            <button class="month-nav-btn" onclick="App.state.currentMonth=monthNav(App.state.currentMonth,-1); App.render()">‹</button>
            <input type="month" value="${month}" onchange="App.state.currentMonth=this.value; App.render()">
            <button class="month-nav-btn" onclick="App.state.currentMonth=monthNav(App.state.currentMonth,1); App.render()">›</button>
          </div>
        </div>

        <div class="stats-grid">
          ${this.statCard('green','📚', eveningSummerStudents.length, '晚辅导/暑期班学生', '固定老师')}
          ${this.statCard('orange','📅', weekendStudents.length, '周末托学生', '全员可标记')}
        </div>
      </div>

      <!-- 晚辅导/暑期班 -->
      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="title-icon" style="background:#1890ff"></span>📚 晚辅导/暑期班 — 默认出勤，标记缺勤</div>
        </div>
        <div class="highlight-box">
          你是以下学生的<strong>年级固定老师</strong>，可为其标记缺勤。默认所有学生出勤。
        </div>
        ${eveningSummerStudents.length ? `
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>学生</th>
                  <th>年级</th>
                  <th>出勤</th>
                  <th>缺勤</th>
                  <th>半天缺</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${eveningSummerStudents.map(s => {
                  const att = countStudentAtt(s, 'evening_summer', true);
                  const types = (s.enrollTypes||[]).filter(et => et === 'evening' || et === 'summer')
                    .map(et => `<span class="tag ${ENROLL_TYPES.find(x=>x.key===et)?.cls}">${ENROLL_TYPES.find(x=>x.key===et)?.label}</span>`).join(' ');
                  return `<tr>
                    <td><strong>${s.name}</strong> ${types}</td>
                    <td>${s.grade||'-'}</td>
                    <td><strong style="color:var(--success)">${att.present}</strong></td>
                    <td><strong style="color:${att.absent>0?'var(--danger)':'var(--text-light)'}">${att.absent}</strong></td>
                    <td><strong style="color:${att.halfAbsent>0?'var(--accent)':'var(--text-light)'}">${att.halfAbsent||0}</strong></td>
                    <td>
                      <button class="btn btn-ghost btn-sm" onclick="App.shareOpenStudentAbsentModal('${s.id}', 'evening_summer')">${att.marked>0?'编辑':'标记缺勤'}</button>
                    </td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        ` : `<div class="empty-state"><div class="empty-state-icon">📚</div><div class="empty-state-text">暂无你作为固定老师的晚辅导/暑期班学生</div></div>`}
      </div>

      <!-- 周末托 -->
      <div class="card">
        <div class="card-header">
          <div class="card-title"><span class="title-icon" style="background:#fa8c16"></span>📅 周末托 — 默认缺勤，标记出勤</div>
        </div>
        <div class="highlight-box">
          所有老师都可以标记周末托学生的出勤。默认所有学生缺勤，点击标记出勤。
        </div>
        ${weekendStudents.length ? `
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>学生</th>
                  <th>年级</th>
                  <th>已标记出勤</th>
                  <th>缺勤</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                ${weekendStudents.map(s => {
                  const att = countStudentAtt(s, 'weekend', false);
                  return `<tr>
                    <td><strong>${s.name}</strong> <span class="tag tag-green">周末托</span></td>
                    <td>${s.grade||'-'}</td>
                    <td><strong style="color:var(--success)">${att.present}</strong></td>
                    <td><strong style="color:var(--text-light)">${att.absent}</strong></td>
                    <td>
                      <button class="btn btn-ghost btn-sm" onclick="App.shareOpenStudentAbsentModal('${s.id}', 'weekend')">${att.marked>0?'编辑':'标记出勤'}</button>
                    </td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        ` : `<div class="empty-state"><div class="empty-state-icon">📅</div><div class="empty-state-text">暂无周末托学生</div></div>`}
      </div>
    `;
  },

  shareOpenStudentAbsentModal(studentId, attType) {
    const d = DB.get();
    const s = d.students.find(x=>x.id===studentId);
    if (!s) return;
    const month = this.state.currentMonth;
    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const isWeekend = attType === 'weekend';
    const records = s.attendanceRecords?.[month]?.[attType] || {};

    const dayCells = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${month}-${String(day).padStart(2,'0')}`;
      const weekday = new Date(y, m-1, day).getDay();
      const isWeekendDay = weekday === 0 || weekday === 6;
      let status, cls, label;
      if (isWeekend) {
        status = records[dateStr] || 'absent';
        if (status === 'present') { cls = 'present'; label = '出'; }
        else { cls = 'absent'; label = '缺'; }
      } else {
        status = records[dateStr] || 'present';
        if (status === 'absent') { cls = 'absent'; label = '全天缺'; }
        else if (status === 'half') { cls = 'half-absent'; label = '半天缺'; }
        else { cls = ''; label = '出'; }
      }
      dayCells.push(`
        <div class="absent-day-cell ${cls} ${isWeekendDay?'weekend':''}" data-date="${dateStr}" data-status="${status}" data-type="${attType}" onclick="App.cycleStudentAbsentDay(this)">
          <div class="day-num">${day}</div>
          <div class="day-status">${label}</div>
        </div>
      `);
    }

    const title = isWeekend ? `标记出勤 · ${s.name} (${month})` : `标记缺勤 · ${s.name} (${month})`;
    const hint = isWeekend
      ? '点击日期切换：<strong>缺勤 → 出勤 → 缺勤</strong>（周末托默认缺勤）'
      : '点击日期切换：<strong>出勤 → 半天缺 → 全天缺 → 出勤</strong>（默认出勤）';

    this.openModal(`
      <div class="modal-header">
        <div class="modal-title">${title}</div>
        <button class="modal-close" data-close-modal>×</button>
      </div>
      <div class="modal-body">
        <div class="highlight-box">${hint}</div>
        <div class="absent-calendar">${dayCells.join('')}</div>
        <div style="margin-top:12px;display:flex;gap:12px;font-size:12px;flex-wrap:wrap">
          ${isWeekend ? `
            <span><span class="dot dot-green"></span>出勤</span>
            <span><span class="dot dot-red"></span>缺勤（默认）</span>
          ` : `
            <span><span class="dot dot-green"></span>出勤（默认）</span>
            <span><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--accent);margin-right:6px"></span>半天缺勤</span>
            <span><span class="dot dot-red"></span>全天缺勤</span>
          `}
          <span style="color:var(--text-light)">灰色=周末</span>
        </div>
        <div id="absentSummary" style="margin-top:12px;padding:10px;background:var(--primary-light);border-radius:8px;font-size:13px"></div>
      </div>
      <div class="modal-footer">
        ${isWeekend ? '<button class="btn btn-secondary" onclick="App.clearAllStudentAbsent()">全部缺勤</button>' : '<button class="btn btn-secondary" onclick="App.clearAllStudentAbsent()">全部出勤</button>'}
        <button class="btn btn-secondary" data-close-modal>取消</button>
        <button class="btn btn-primary" onclick="App.saveShareStudentAbsent('${studentId}', '${attType}')">保存</button>
      </div>
    `);

    this.updateStudentAbsentSummary(attType);
  },

  saveShareStudentAbsent(studentId, attType) {
    const d = DB.get();
    const s = d.students.find(x=>x.id===studentId);
    if (!s) return;
    const month = this.state.currentMonth;
    if (!s.attendanceRecords) s.attendanceRecords = {};
    if (!s.attendanceRecords[month]) s.attendanceRecords[month] = {};
    const records = {};
    $$('.absent-day-cell').forEach(el => {
      const status = el.dataset.status;
      const date = el.dataset.date;
      if (attType === 'weekend') {
        if (status === 'present') records[date] = 'present';
      } else {
        if (status === 'absent' || status === 'half') records[date] = status;
      }
    });
    s.attendanceRecords[month][attType] = records;
    DB.persist();
    this.closeModal();
    toast(`已保存 ${s.name} 的考勤记录`);
    this.render();
  },

  /* ====================================================================
   *  教师分享链接管理 (后台)
   * ================================================================== */
  openShareManager(teacherId) {
    const d = DB.get();
    const t = d.teachers.find(x=>x.id===teacherId);
    if (!t) return;
    const shares = d.teacherShares.filter(s => s.teacherId === teacherId && !s.revokedAt);
    const baseUrl = location.origin + location.pathname + location.search;
    const cloudCfg = DB.getCloudConfig();
    // 如果启用了云端, 把配置编码进链接 (base64), 这样老师设备打开后能自动连接云端
    const cloudParam = (cloudCfg.enabled && cloudCfg.url && cloudCfg.key)
      ? '&c=' + btoa(unescape(encodeURIComponent(JSON.stringify({u:cloudCfg.url,k:cloudCfg.key}))))
      : '';

    this.openModal(`
      <div class="modal-header">
        <div class="modal-title">教师消课分享链接 · ${t.name}</div>
        <button class="modal-close" data-close-modal>×</button>
      </div>
      <div class="modal-body">
        <div class="highlight-box">
          📤 生成专属链接发给教师，打开后只能看到自己绑定学生的姓名和剩余课时，可自行消课。其他数据（费用、分成、工资）全部隐藏。
        </div>

        ${!cloudCfg.enabled ? `
          <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:12px;margin-bottom:12px;font-size:12px;color:#856404">
            ⚠️ <strong>未启用云端同步！</strong>老师用自己的手机/电脑打开链接会看不到数据。<br>
            请先到「系统设置 → 云端同步」配置 Supabase，否则分享链接只能在同一浏览器使用。
          </div>
        ` : ''}

        ${shares.length ? `
          <div style="font-weight:600;margin-bottom:10px">当前有效链接 (${shares.length})</div>
          ${shares.map(sh => {
            const link = `${baseUrl}#share=${sh.code}${cloudParam}`;
            return `
            <div style="background:#f9fafb;border-radius:8px;padding:12px;margin-bottom:8px">
              <div style="font-size:11px;color:var(--text-light);margin-bottom:4px">创建于 ${fmtDate(sh.createdAt)} ${cloudParam?'· ☁️ 跨设备可用':''}</div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <input class="form-input" readonly value="${link}" style="font-size:11px;flex:1;min-width:200px" onclick="this.select()">
                <button class="btn btn-primary btn-sm" onclick="navigator.clipboard.writeText('${link}').then(()=>toast('链接已复制'))">📋 复制</button>
                <button class="btn btn-danger btn-sm" onclick="App.revokeShare('${sh.id}')">作废</button>
              </div>
            </div>
            `;
          }).join('')}
        ` : `<div style="color:var(--text-light);font-size:13px;margin-bottom:12px">暂无有效链接</div>`}

        <button class="btn btn-primary" onclick="App.createShare('${teacherId}')">➕ 生成新链接</button>

        <hr class="divider">
        <div style="font-size:12px;color:var(--text-light);line-height:1.7">
          <strong>📌 使用说明：</strong><br>
          1. 复制链接发给老师（微信/短信均可）<br>
          2. 老师在任意手机/电脑浏览器打开即可看到自己绑定的学生<br>
          3. 老师消课后，数据自动同步到你的工作台<br>
          4. 作废链接后，该链接将无法再访问
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" data-close-modal>关闭</button>
      </div>
    `);
  },

  createShare(teacherId) {
    const d = DB.get();
    const code = uid() + uid().slice(0,4);
    d.teacherShares.push({
      id: uid(),
      teacherId,
      code,
      createdAt: new Date().toISOString(),
    });
    DB.persist();
    toast('链接已生成');
    this.openShareManager(teacherId);
  },

  revokeShare(shareId) {
    if (!confirm('确认作废该链接？作废后教师将无法通过此链接访问。')) return;
    const d = DB.get();
    const sh = d.teacherShares.find(x=>x.id===shareId);
    if (sh) sh.revokedAt = new Date().toISOString();
    DB.persist();
    toast('已作废');
    this.openShareManager(sh.teacherId);
  },

  /* ====================================================================
   *  Excel 导出
   * ================================================================== */
  exportExcel(type) {
    if (typeof XLSX === 'undefined') { toast('Excel库加载失败', 'error'); return; }
    const d = DB.get();
    const wb = XLSX.utils.book_new();
    const ws2a = (data, name) => {
      const ws = XLSX.utils.aoa_to_sheet(data);
      XLSX.utils.book_append_sheet(wb, ws, name);
    };

    if (type === 'students' || type === 'all') {
      const rows = [['姓名','年级','监护人','电话','学校','地址','报名类型','绑定教师','年级固定老师','小课课时分配','小课剩余总课时','备注','建档日期']];
      d.students.forEach(s => {
        const teachers = (s.teacherBindings||[]).map(b => {
          const t = d.teachers.find(x=>x.id===b.teacherId);
          return t ? t.name + (b.subject?`(${b.subject})`:'') : '';
        }).join('; ');
        const gts = (s.gradeTeachers||[]).map(gt => {
          const t = d.teachers.find(x=>x.id===gt.teacherId);
          return t ? t.name : '';
        }).join('; ');
        const thStr = (s.teacherHours||[]).map(th => {
          const t = d.teachers.find(x=>x.id===th.teacherId);
          return (t?t.name:'已删除')+':'+(th.hours||0);
        }).join('; ');
        rows.push([
          s.name, s.grade||'', s.guardian||'', s.phone||'', s.school||'', s.addr||'',
          (s.enrollTypes||[]).map(t=>ENROLL_TYPES.find(x=>x.key===t)?.label||t).join('/'),
          teachers, gts, thStr || (s.remainHours||0), s.remainHours||0, s.notes||'',
          s.createdAt ? new Date(s.createdAt).toLocaleDateString('zh-CN') : ''
        ]);
      });
      ws2a(rows, '学生列表');
    }

    if (type === 'teachers' || type === 'all') {
      const rows = [['姓名','部门','类型','职级','科目','电话','基本工资','绩效基数','小课分成(%)','时薪(元/h)','每日工时','社保','管理岗','备注']];
      d.teachers.forEach(t => {
        rows.push([
          t.name, t.dept||'', (t.jobType||'full')==='full'?'全职':(t.jobType==='hourly'?'时薪制':'兼职'), t.level||'', t.subject||'', t.phone||'',
          t.baseSalary||0, t.perfBase||0, t.shareRate||d.settings.defaultShareRate,
          t.hourlyRate||0, t.dailyHours||8,
          t.socialType==='pay'?'缴纳'+(t.socialInsurance||0):'不缴纳'+(t.socialInsurance||0),
          t.isAdmin?'是':'否', t.notes||''
        ]);
      });
      ws2a(rows, '教师列表');
    }

    if (type === 'payments' || type === 'all') {
      const rows = [['日期','学生','项目','金额','缴费方式','备注']];
      d.payments.slice().reverse().forEach(p => {
        const s = d.students.find(x=>x.id===p.studentId);
        rows.push([
          fmtDate(p.date), s?s.name:'已删除',
          ENROLL_TYPES.find(x=>x.key===p.enrollType)?.label || p.enrollType || '-',
          p.amount, PAY_MODES.find(m=>m.key===p.mode)?.label || p.mode, p.note||''
        ]);
      });
      ws2a(rows, '缴费记录');
    }

    if (type === 'hours' || type === 'all') {
      const rows = [['日期','学生','授课教师','消耗课时','课时单价','教师课时费','剩余课时','备注']];
      d.hourLogs.slice().reverse().forEach(l => {
        const s = d.students.find(x=>x.id===l.studentId);
        const t = d.teachers.find(x=>x.id===l.teacherId);
        const rate = t ? (t.shareRate||d.settings.defaultShareRate) : 0;
        const fee = l.hours * (l.unitPrice||0) * rate / 100;
        rows.push([
          fmtDate(l.date), s?s.name:'已删除', t?t.name:'-',
          l.hours, l.unitPrice||0, fee.toFixed(2), l.remainAfter, l.note||''
        ]);
      });
      ws2a(rows, '消课记录');
    }

    if (type === 'attendance' || type === 'all') {
      const month = this.state.currentMonth;
      const [y, m] = month.split('-').map(Number);
      const daysInMonth = new Date(y, m, 0).getDate();
      const header = ['学生','年级','类型'];
      for (let day = 1; day <= daysInMonth; day++) header.push(`${day}日`);
      header.push('出勤天数','缺勤天数');
      const rows = [header];
      d.students.forEach(s => {
        // 晚辅导/暑期班
        if ((s.enrollTypes||[]).some(t => t === 'evening' || t === 'summer')) {
          const recs = s.attendanceRecords?.[month]?.evening_summer || {};
          const row = [s.name, s.grade||'', '晚辅导/暑期班'];
          let present = 0, absent = 0;
          for (let day = 1; day <= daysInMonth; day++) {
            const ds = `${month}-${String(day).padStart(2,'0')}`;
            const status = recs[ds] || 'present';
            if (status === 'absent') { row.push('缺'); absent++; }
            else if (status === 'half') { row.push('半缺'); absent += 0.5; }
            else { row.push('出'); present++; }
          }
          row.push(present, absent);
          rows.push(row);
        }
        // 周末托
        if ((s.enrollTypes||[]).includes('weekend')) {
          const recs = s.attendanceRecords?.[month]?.weekend || {};
          const row = [s.name, s.grade||'', '周末托'];
          let present = 0, absent = 0;
          for (let day = 1; day <= daysInMonth; day++) {
            const ds = `${month}-${String(day).padStart(2,'0')}`;
            const status = recs[ds] || 'absent';
            if (status === 'present') { row.push('出'); present++; }
            else { row.push('缺'); absent++; }
          }
          row.push(present, absent);
          rows.push(row);
        }
      });
      ws2a(rows, '学生考勤_'+month);
    }

    if (type === 'salary' || type === 'all') {
      const month = this.state.currentMonth;
      const rows = [['教师','部门','类型','职级','基本工资/时薪','绩效基数','绩效得分(%)','绩效工资/时薪工资','应出勤','实际出勤','请假天数','请假扣除','全勤奖','绩效津贴','课时费','岗位补助','交通补贴','社保类型','社保金额','实发工资','月份']];
      d.teachers.forEach(t => {
        const sal = this.calcTeacherSalary(t, month);
        const isHourly = t.jobType === 'hourly';
        rows.push([
          t.name, t.dept||'', (t.jobType||'full')==='full'?'全职':(t.jobType==='hourly'?'时薪制':'兼职'), t.level||'',
          isHourly ? (t.hourlyRate||0)+'元/h' : sal.baseSalary,
          isHourly ? '-' : sal.perfBase,
          isHourly ? '-' : sal.perfScore,
          isHourly ? sal.hourlySalary : sal.perfSalary,
          sal.shouldDays, sal.actualDays,
          isHourly ? '-' : sal.absentCount,
          isHourly ? '-' : sal.leaveDeduction,
          isHourly ? '-' : sal.fullAttendBonus,
          isHourly ? '-' : sal.perfAllowance,
          sal.courseFee, sal.postBonus, sal.transportBonus,
          sal.socialType==='pay'?'缴纳扣除':'不缴纳补贴',
          sal.socialType==='pay'?sal.socialDeduction:sal.socialSubsidy,
          sal.total, month
        ]);
      });
      // 合计行
      const total = d.teachers.reduce((s,t)=>s+this.calcTeacherSalary(t,month).total,0);
      rows.push(['合计','','','','','','','','','','','','','','',total.toFixed(2),month]);
      ws2a(rows, '工资结算_'+month);
    }

    const fn = type === 'all' ? `博智托管_全部数据_${today()}.xlsx` : `博智托管_${type}_${today()}.xlsx`;
    XLSX.writeFile(wb, fn);
    toast('Excel 已导出');
  },
};

/* 启动 */
document.addEventListener('DOMContentLoaded', () => App.init());
