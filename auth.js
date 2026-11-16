/* ============================================================
   CATALYST - Identity, Access & User Management
   ------------------------------------------------------------
   Backend: SharePoint Lists (shared source of truth)
     CATALYST_Users         - roster, roles, Active flag
     CATALYST_AuditLog      - append-only change history
     CATALYST_LoginActivity - append-only login attempts

   Fallback: localStorage (LOCAL MODE) when the dashboard is
   not served from SharePoint — clearly flagged in the UI.

   SSO seam: AuthProvider.authenticate() is the single swap
   point for Entra ID. User model carries Upn/EntraObjectId.
   ============================================================ */

const CATALYST_AUTH = (() => {

  // ── Constants ─────────────────────────────────────────────
  const LS_USERS   = 'catalyst_users_v1';
  const LS_AUDIT   = 'catalyst_audit_v1';
  const LS_LOGINS  = 'catalyst_logins_v1';
  const LS_CONFIG  = 'catalyst_config_v1';
  const SS_SESSION = 'catalyst_session';
  const ROLES = ['Admin', 'Manager', 'Leadership'];

  // Defaults — used only when the CATALYST_Configuration list is unreachable
  const CONFIG_DEFAULTS = {
    SharedPassword:  'Catalyst@Ignite2026',
    SlaThreshold:    '0.85',
    SessionTimeoutMin: '480',
    LoginActivityRetentionDays: '90',
    AppVersion: '1.0',
  };

  const CFG = () => window.CATALYST_SP_CONFIG || { enabled: false };

  // ── SharePoint REST client ────────────────────────────────
  const SP = {
    _digest: null, _digestAt: 0,

    _base() { return CFG().siteUrl.replace(/\/+$/, '') + '/_api'; },

    async _digestToken() {
      if (this._digest && Date.now() - this._digestAt < 25 * 60 * 1000) return this._digest;
      const r = await fetch(this._base() + '/contextinfo', {
        method: 'POST', credentials: 'include',
        headers: { Accept: 'application/json;odata=nometadata' },
      });
      if (!r.ok) throw new Error('Digest fetch failed: ' + r.status);
      const j = await r.json();
      this._digest = j.FormDigestValue; this._digestAt = Date.now();
      return this._digest;
    },

    async items(list, query = '') {
      const url = `${this._base()}/web/lists/getbytitle('${encodeURIComponent(list)}')/items?${query}`;
      const r = await fetch(url, { credentials: 'include',
        headers: { Accept: 'application/json;odata=nometadata' } });
      if (!r.ok) throw new Error(`SP GET ${list} failed: ${r.status}`);
      return (await r.json()).value;
    },

    async createItem(list, body) {
      const digest = await this._digestToken();
      const r = await fetch(`${this._base()}/web/lists/getbytitle('${encodeURIComponent(list)}')/items`, {
        method: 'POST', credentials: 'include',
        headers: {
          Accept: 'application/json;odata=nometadata',
          'Content-Type': 'application/json;odata=nometadata',
          'X-RequestDigest': digest,
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`SP create ${list} failed: ${r.status} ${await r.text()}`);
      return r.json();
    },

    async updateItem(list, id, body) {
      const digest = await this._digestToken();
      const r = await fetch(`${this._base()}/web/lists/getbytitle('${encodeURIComponent(list)}')/items(${id})`, {
        method: 'POST', credentials: 'include',
        headers: {
          Accept: 'application/json;odata=nometadata',
          'Content-Type': 'application/json;odata=nometadata',
          'X-RequestDigest': digest,
          'IF-MATCH': '*',
          'X-HTTP-Method': 'MERGE',
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`SP update ${list}#${id} failed: ${r.status}`);
    },

    async reachable() {
      if (!CFG().enabled) return false;
      try {
        await this.items(CFG().lists.users, '$top=1&$select=Id');
        return true;
      } catch (e) { return false; }
    },
  };

  // ── localStorage helpers (fallback + read cache) ──────────
  function _readLS(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch (e) { return fallback; }
  }
  function _writeLS(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }

  const _spUserToModel = it => ({
    SpId: it.Id, DomainId: it.Title, Name: it.AssociateName, Manager: it.Manager,
    Email: it.Email, Role: it.Role, Active: !!it.Active,
    CreatedBy: it.CreatedByDomainId, CreatedAt: it.Created,
    Upn: it.Upn || '', EntraObjectId: it.EntraObjectId || '',
  });
  const _modelToSp = u => ({
    Title: u.DomainId, AssociateName: u.Name, Manager: u.Manager,
    Email: u.Email, Role: u.Role, Active: u.Active,
  });

  // ── UserStore ─────────────────────────────────────────────
  const UserStore = {
    _cache: null, _loadedAt: 0,
    backend: 'local',           // 'sp' | 'local' — set by load()

    async load(force = false) {
      if (this._cache && !force && Date.now() - this._loadedAt < (CFG().cacheTtlMs || 15000)) return;
      if (await SP.reachable()) {
        const items = await SP.items(CFG().lists.users, '$select=Id,Title,AssociateName,Manager,Email,Role,Active,CreatedByDomainId,Upn,EntraObjectId,Created&$top=5000');
        this._cache = items.map(_spUserToModel);
        this.backend = 'sp';
        _writeLS(LS_USERS, { users: this._cache });   // offline read cache
      } else {
        this.backend = 'local';
        const stored = _readLS(LS_USERS, null);
        const seed   = (window.CATALYST_USERS_SEED && window.CATALYST_USERS_SEED.users) || [];
        this._cache = (stored && Array.isArray(stored.users) && stored.users.length)
          ? stored.users : seed.map(u => ({ ...u }));
        _writeLS(LS_USERS, { users: this._cache });
      }
      this._loadedAt = Date.now();
    },

    all()  { return this._cache ? [...this._cache] : []; },
    find(domainId) {
      if (!this._cache) return null;
      const id = String(domainId).toUpperCase();
      return this._cache.find(u => u.DomainId.toUpperCase() === id) || null;
    },

    async add(user, actor) {
      if (this.find(user.DomainId)) throw new Error('Domain ID already exists');
      const rec = {
        DomainId: user.DomainId.trim(), Name: user.Name.trim(),
        Manager: (user.Manager || '').trim(), Email: (user.Email || '').trim(),
        Role: ROLES.includes(user.Role) ? user.Role : 'Leadership',
        Active: true, CreatedBy: actor, CreatedAt: new Date().toISOString(),
      };
      if (this.backend === 'sp') {
        const created = await SP.createItem(CFG().lists.users, { ..._modelToSp(rec), CreatedByDomainId: actor });
        rec.SpId = created.Id;
      }
      this._cache.push(rec);
      _writeLS(LS_USERS, { users: this._cache });
      Audit.log(actor, rec.DomainId, 'USER_ADDED', 'record', '', JSON.stringify({ Name: rec.Name, Role: rec.Role }));
      return rec;
    },

    async update(domainId, patch, actor) {
      const u = this.find(domainId);
      if (!u) throw new Error('User not found: ' + domainId);
      const changed = {};
      ['Name', 'Manager', 'Email'].forEach(f => {
        if (patch[f] !== undefined && patch[f] !== u[f]) {
          Audit.log(actor, domainId, 'USER_UPDATED', f, u[f], patch[f]);
          changed[f === 'Name' ? 'AssociateName' : f] = patch[f];
          u[f] = patch[f];
        }
      });
      if (this.backend === 'sp' && u.SpId && Object.keys(changed).length) {
        await SP.updateItem(CFG().lists.users, u.SpId, changed);
      }
      _writeLS(LS_USERS, { users: this._cache });
      return u;
    },

    async setActive(domainId, active, actor) {
      const u = this.find(domainId);
      if (!u) throw new Error('User not found: ' + domainId);
      if (u.Active === active) return u;
      u.Active = active;
      if (this.backend === 'sp' && u.SpId) {
        await SP.updateItem(CFG().lists.users, u.SpId, { Active: active });
      }
      Audit.log(actor, domainId, active ? 'USER_REACTIVATED' : 'USER_DISABLED', 'Active', String(!active), String(active));
      _writeLS(LS_USERS, { users: this._cache });
      return u;
    },

    async setRole(domainId, role, actor) {
      const u = this.find(domainId);
      if (!u) throw new Error('User not found: ' + domainId);
      if (!ROLES.includes(role)) throw new Error('Invalid role: ' + role);
      if (u.Role === role) return u;
      const old = u.Role; u.Role = role;
      if (this.backend === 'sp' && u.SpId) {
        await SP.updateItem(CFG().lists.users, u.SpId, { Role: role });
      }
      Audit.log(actor, domainId, 'ROLE_CHANGED', 'Role', old, role);
      _writeLS(LS_USERS, { users: this._cache });
      return u;
    },
  };

  // ── Audit trail (append-only) ─────────────────────────────
  const Audit = {
    log(actor, target, action, field, oldVal, newVal) {
      const rec = {
        Timestamp: new Date().toISOString(), Actor: actor, Target: target,
        Action: action, Field: field || '', OldValue: oldVal || '', NewValue: newVal || '',
      };
      if (UserStore.backend === 'sp') {
        SP.createItem(CFG().lists.audit, {
          Title: 'AUD', Actor: actor, Target: target, Action: action,
          Field: field || '', OldValue: String(oldVal || ''), NewValue: String(newVal || ''),
        }).catch(e => console.warn('SP audit write failed', e));
      } else {
        const log = _readLS(LS_AUDIT, []); log.push(rec); _writeLS(LS_AUDIT, log);
      }
    },
    async all() {
      if (UserStore.backend === 'sp') {
        const items = await SP.items(CFG().lists.audit,
          '$select=Created,Actor,Target,Action,Field,OldValue,NewValue&$orderby=Id desc&$top=2000');
        return items.map(it => ({
          Timestamp: it.Created, Actor: it.Actor, Target: it.Target,
          Action: it.Action, Field: it.Field, OldValue: it.OldValue, NewValue: it.NewValue,
        }));
      }
      return _readLS(LS_AUDIT, []);
    },
  };

  // ── Login activity (append-only) ──────────────────────────
  const LoginActivity = {
    record(domainId, success, detail) {
      if (UserStore.backend === 'sp') {
        SP.createItem(CFG().lists.logins, {
          Title: 'LOG', DomainId: domainId, Success: !!success, Detail: detail || '',
        }).catch(e => console.warn('SP login write failed', e));
      } else {
        const log = _readLS(LS_LOGINS, []);
        log.push({ Timestamp: new Date().toISOString(), DomainId: domainId, Success: !!success, Detail: detail || '' });
        _writeLS(LS_LOGINS, log);
      }
    },
    async all() {
      if (UserStore.backend === 'sp') {
        const items = await SP.items(CFG().lists.logins,
          '$select=Created,DomainId,Success,Detail&$orderby=Id desc&$top=500');
        return items.map(it => ({ Timestamp: it.Created, DomainId: it.DomainId, Success: it.Success, Detail: it.Detail }));
      }
      return _readLS(LS_LOGINS, []);
    },
  };

  // ── AppConfig — shared application settings ──────────────
  // Source of truth: CATALYST_Configuration list (Title=key, ConfigValue=value).
  // localStorage mirrors it as an offline cache only.
  const AppConfig = {
    _cfg: null,

    async load() {
      if (UserStore.backend === 'sp') {
        try {
          const items = await SP.items(CFG().lists.config,
            '$select=Title,ConfigValue,ConfigGroup&$top=500');
          this._cfg = { ...CONFIG_DEFAULTS };
          items.forEach(it => { if (it.Title) this._cfg[it.Title] = it.ConfigValue; });
          _writeLS(LS_CONFIG, this._cfg);
          return;
        } catch (e) { console.warn('Config load from SP failed', e); }
      }
      this._cfg = { ...CONFIG_DEFAULTS, ...(_readLS(LS_CONFIG, {}) || {}) };
    },

    get(key, fallback) {
      const v = this._cfg?.[key];
      return (v === undefined || v === null || v === '') ? fallback : v;
    },
    getNum(key, fallback) { const n = parseFloat(this.get(key, '')); return isNaN(n) ? fallback : n; },
  };

  // ── AuthProvider — SSO swap point ─────────────────────────
  const AuthProvider = {
    authenticate(domainId, password) {
      const user = UserStore.find(domainId);
      if (!user)                          return { ok: false, reason: 'Unknown Domain ID' };
      if (!user.Active)                   return { ok: false, reason: 'Account disabled. Contact an Admin.' };
      if (password !== AppConfig.get('SharedPassword', CONFIG_DEFAULTS.SharedPassword))
                                          return { ok: false, reason: 'Incorrect password' };
      return { ok: true, user };
    },
  };

  // ── Session ───────────────────────────────────────────────
  function currentUser() {
    try {
      const s = sessionStorage.getItem(SS_SESSION);
      if (!s) return null;
      const u = UserStore.find(JSON.parse(s).DomainId);
      return (u && u.Active) ? u : null;
    } catch (e) { return null; }
  }

  function login(domainId, password) {
    const res = AuthProvider.authenticate(domainId, password);
    LoginActivity.record(domainId, res.ok, res.ok ? 'Login success' : res.reason);
    if (res.ok) {
      sessionStorage.setItem(SS_SESSION, JSON.stringify({ DomainId: res.user.DomainId, at: Date.now() }));
      Audit.log(res.user.DomainId, res.user.DomainId, 'LOGIN', '', '', '');
    }
    return res;
  }

  function logout() {
    const u = currentUser();
    if (u) Audit.log(u.DomainId, u.DomainId, 'LOGOUT', '', '', '');
    sessionStorage.removeItem(SS_SESSION);
    location.reload();
  }

  function isAdmin() {
    const u = currentUser();
    return !!(u && u.Role === 'Admin');
  }

  return { UserStore, Audit, LoginActivity, AppConfig, AuthProvider, ROLES, currentUser, login, logout, isAdmin, backendMode: () => UserStore.backend };
})();


/* ============================================================
   UI LAYER - login gate + User Management page
   ============================================================ */
const CatalystAuthUI = (() => {

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── Login gate ────────────────────────────────────────────
  async function initGate(onReady) {
    const overlay = document.getElementById('loginOverlay');
    // Load the user store (SP first, local fallback) before any auth check
    try { await CATALYST_AUTH.UserStore.load(); }
    catch (e) { console.warn('UserStore load failed, using seed/local', e); CATALYST_AUTH.UserStore.backend = 'local'; }
    await CATALYST_AUTH.AppConfig.load();

    const user = CATALYST_AUTH.currentUser();
    if (user) {
      overlay?.remove();
      _applyIdentity(user);
      onReady();
      return;
    }
    if (!overlay) { onReady(); return; }
    overlay.style.display = 'flex';
    document.body.classList.add('auth-locked');
    _showModeBanner();

    const form = document.getElementById('loginForm');
    const errEl = document.getElementById('loginError');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      // Refresh roster before authenticating so a new user can log in
      // immediately after being added by another admin.
      try { await CATALYST_AUTH.UserStore.load(true); } catch (e) {}
      const dom = document.getElementById('loginDomain').value.trim();
      const pwd = document.getElementById('loginPassword').value;
      const res = CATALYST_AUTH.login(dom, pwd);
      if (!res.ok) {
        errEl.textContent = res.reason;
        errEl.style.display = 'block';
        return;
      }
      overlay.remove();
      document.body.classList.remove('auth-locked');
      _applyIdentity(res.user);
      onReady();
    });
  }

  function _showModeBanner() {
    if (CATALYST_AUTH.backendMode() === 'sp') return;
    const overlay = document.getElementById('loginOverlay');
    if (!overlay || document.getElementById('localModeNote')) return;
    const n = document.createElement('div');
    n.id = 'localModeNote';
    n.className = 'local-mode-note';
    n.textContent = 'LOCAL MODE — not connected to SharePoint. Changes stay on this machine.';
    overlay.querySelector('.login-card')?.appendChild(n);
  }

  function _applyIdentity(user) {
    const chip = document.getElementById('currentUserChip');
    if (chip) {
      chip.style.display = 'flex';
      chip.querySelector('.cu-name').textContent = user.Name;
      chip.querySelector('.cu-role').textContent = user.Role;
    }
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.style.display = '';
    if (user.Role === 'Admin') {
      const nav = document.querySelector('.nav-item[data-page="users"]');
      if (nav) nav.style.display = '';
    }
  }

  // ── User Management page ──────────────────────────────────
  async function renderUsersPage() {
    if (!CATALYST_AUTH.isAdmin()) return;
    _renderModeNote();
    try { await CATALYST_AUTH.UserStore.load(); } catch (e) {}
    await _renderUserTable();
    await _renderAuditTable();
    await _renderLoginActivity();
  }

  function _renderModeNote() {
    const page = document.getElementById('page-users');
    if (!page) return;
    let n = document.getElementById('umModeNote');
    if (!n) {
      n = document.createElement('div');
      n.id = 'umModeNote';
      page.querySelector('.page-header')?.after(n);
    }
    if (CATALYST_AUTH.backendMode() === 'sp') {
      n.className = 'um-mode um-mode-sp';
      n.textContent = 'Connected to SharePoint — changes are shared with all users.';
    } else {
      n.className = 'um-mode um-mode-local';
      n.textContent = 'LOCAL MODE — changes are saved only on this machine.';
    }
  }

  function _roleBadge(role) {
    const cls = role === 'Admin' ? 'role-admin' : role === 'Manager' ? 'role-manager' : 'role-lead';
    return `<span class="role-badge ${cls}">${esc(role)}</span>`;
  }

  async function _renderUserTable() {
    const tbody = document.getElementById('usersTableBody');
    if (!tbody) return;
    const me = CATALYST_AUTH.currentUser();
    tbody.innerHTML = CATALYST_AUTH.UserStore.all().map(u => `
      <tr class="${u.Active ? '' : 'user-inactive'}">
        <td><strong>${esc(u.DomainId)}</strong></td>
        <td>${esc(u.Name)}</td>
        <td>${esc(u.Manager)}</td>
        <td>${_roleBadge(u.Role)}</td>
        <td>${esc(u.Email)}</td>
        <td><span class="status-pill ${u.Active ? 'status-active' : 'status-disabled'}">${u.Active ? 'Active' : 'Disabled'}</span></td>
        <td class="user-actions">
          <button class="btn-mini" onclick="CatalystAuthUI.editUser('${esc(u.DomainId)}')">Edit</button>
          <button class="btn-mini" onclick="CatalystAuthUI.changeRole('${esc(u.DomainId)}')">Role</button>
          ${me && u.DomainId !== me.DomainId
            ? `<button class="btn-mini ${u.Active ? 'btn-warn' : 'btn-ok'}"
                 onclick="CatalystAuthUI.toggleActive('${esc(u.DomainId)}')">${u.Active ? 'Disable' : 'Enable'}</button>`
            : ''}
        </td>
      </tr>`).join('');
  }

  async function _renderAuditTable() {
    const tbody = document.getElementById('auditTableBody');
    if (!tbody) return;
    const rows = (await CATALYST_AUTH.Audit.all()).slice();
    tbody.innerHTML = rows.length ? rows.map(a => `
      <tr>
        <td>${new Date(a.Timestamp).toLocaleString()}</td>
        <td>${esc(a.Actor)}</td>
        <td>${esc(a.Target)}</td>
        <td><span class="audit-action">${esc(a.Action)}</span></td>
        <td>${esc(a.Field)}</td>
        <td>${esc(a.OldValue)}</td>
        <td>${esc(a.NewValue)}</td>
      </tr>`).join('')
      : '<tr><td colspan="7" class="empty-cell">No audit events yet.</td></tr>';
  }

  async function _renderLoginActivity() {
    const tbody = document.getElementById('loginActivityBody');
    if (!tbody) return;
    const rows = (await CATALYST_AUTH.LoginActivity.all()).slice(0, 200);
    tbody.innerHTML = rows.length ? rows.map(l => `
      <tr>
        <td>${new Date(l.Timestamp).toLocaleString()}</td>
        <td>${esc(l.DomainId)}</td>
        <td><span class="status-pill ${l.Success ? 'status-active' : 'status-disabled'}">${l.Success ? 'Success' : 'Failed'}</span></td>
        <td>${esc(l.Detail)}</td>
      </tr>`).join('')
      : '<tr><td colspan="4" class="empty-cell">No login activity recorded.</td></tr>';
  }

  // ── Add / Edit modal ──────────────────────────────────────
  function _openModal(title, bodyHtml, onSave) {
    _closeModal();
    const wrap = document.createElement('div');
    wrap.id = 'userModal';
    wrap.className = 'modal-overlay';
    wrap.innerHTML = `
      <div class="modal-card">
        <div class="modal-head"><h3>${esc(title)}</h3>
          <button class="modal-x" onclick="CatalystAuthUI.closeModal()">&times;</button></div>
        <div class="modal-body">${bodyHtml}</div>
        <div class="modal-foot">
          <button class="btn-mini" onclick="CatalystAuthUI.closeModal()">Cancel</button>
          <button class="btn-mini btn-primary" id="modalSaveBtn">Save</button>
        </div>
        <div class="modal-error" id="modalError"></div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', e => { if (e.target === wrap) _closeModal(); });
    document.getElementById('modalSaveBtn').addEventListener('click', async () => {
      const btn = document.getElementById('modalSaveBtn');
      btn.disabled = true;
      try { await onSave(); _closeModal(); renderUsersPage(); }
      catch (err) {
        btn.disabled = false;
        document.getElementById('modalError').textContent = err.message;
      }
    });
  }
  function _closeModal() { document.getElementById('userModal')?.remove(); }

  function addUser() {
    _openModal('Add User', `
      <label>Domain ID<input id="mDomain" placeholder="e.g. AL70683"></label>
      <label>Associate Name<input id="mName" placeholder="Last, First"></label>
      <label>Manager<input id="mManager" placeholder="Last, First"></label>
      <label>Email<input id="mEmail" type="email" placeholder="name@carelon.com"></label>
      <label>Role<select id="mRole">
        ${CATALYST_AUTH.ROLES.map(r => `<option>${r}</option>`).join('')}
      </select></label>`,
      async () => {
        const v = id => document.getElementById(id).value;
        if (!v('mDomain').trim() || !v('mName').trim()) throw new Error('Domain ID and Name are required.');
        await CATALYST_AUTH.UserStore.add(
          { DomainId: v('mDomain'), Name: v('mName'), Manager: v('mManager'), Email: v('mEmail'), Role: v('mRole') },
          CATALYST_AUTH.currentUser().DomainId);
      });
  }

  function editUser(domainId) {
    const u = CATALYST_AUTH.UserStore.find(domainId);
    if (!u) return;
    _openModal('Edit User — ' + domainId, `
      <label>Associate Name<input id="mName" value="${esc(u.Name)}"></label>
      <label>Manager<input id="mManager" value="${esc(u.Manager)}"></label>
      <label>Email<input id="mEmail" type="email" value="${esc(u.Email)}"></label>`,
      async () => {
        const v = id => document.getElementById(id).value;
        await CATALYST_AUTH.UserStore.update(domainId,
          { Name: v('mName').trim(), Manager: v('mManager').trim(), Email: v('mEmail').trim() },
          CATALYST_AUTH.currentUser().DomainId);
      });
  }

  function changeRole(domainId) {
    const u = CATALYST_AUTH.UserStore.find(domainId);
    if (!u) return;
    _openModal('Change Role — ' + domainId, `
      <p class="modal-note">Current role: ${_roleBadge(u.Role)}</p>
      <label>New Role<select id="mRole">
        ${CATALYST_AUTH.ROLES.map(r => `<option ${r === u.Role ? 'selected' : ''}>${r}</option>`).join('')}
      </select></label>`,
      async () => {
        await CATALYST_AUTH.UserStore.setRole(domainId, document.getElementById('mRole').value,
          CATALYST_AUTH.currentUser().DomainId);
      });
  }

  async function toggleActive(domainId) {
    const u = CATALYST_AUTH.UserStore.find(domainId);
    if (!u) return;
    await CATALYST_AUTH.UserStore.setActive(domainId, !u.Active, CATALYST_AUTH.currentUser().DomainId);
    renderUsersPage();
  }

  return { initGate, renderUsersPage, addUser, editUser, changeRole, toggleActive, closeModal: _closeModal };
})();
