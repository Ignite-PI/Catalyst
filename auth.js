/* ============================================================
   CATALYST - Identity, Access & User Management
   ------------------------------------------------------------
   Layered architecture designed for future Entra ID / SSO:

     AuthProvider.authenticate()   <- swap point for SSO.
                                    Today: shared password.
                                    Future: MSAL/OIDC token.
     UserStore                     <- persistence adapter.
                                    Today: users.js seed +
                                           localStorage overlay.
                                    Future: API / database.

   User model fields are provider-agnostic (ObjectId, upn,
   role) so Entra claims can map directly without a redesign.
   ============================================================ */

const CATALYST_AUTH = (() => {

  // ── Constants ─────────────────────────────────────────────
  const LS_USERS   = 'catalyst_users_v1';
  const LS_AUDIT   = 'catalyst_audit_v1';
  const LS_LOGINS  = 'catalyst_logins_v1';
  const SS_SESSION = 'catalyst_session';

  // Shared password for the pre-SSO phase.
  // Removed entirely once Entra ID authenticate() is wired in.
  const SHARED_PASSWORD = 'Catalyst@Ignite2026';

  const ROLES = ['Admin', 'Manager', 'Leadership'];

  // ── Persistence layer (localStorage) ──────────────────────
  function _readLS(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function _writeLS(key, val) {
    localStorage.setItem(key, JSON.stringify(val));
  }

  // ── UserStore ─────────────────────────────────────────────
  // Seed (users.js) -> localStorage overlay.
  // The seed populates the store only on first launch (or if the
  // stored version is older). Admin edits live in localStorage.
  const UserStore = {
    _users: null,

    _ensureLoaded() {
      if (this._users) return;
      const stored = _readLS(LS_USERS, null);
      const seed   = (window.CATALYST_USERS_SEED && window.CATALYST_USERS_SEED.users) || [];
      if (stored && Array.isArray(stored.users) && stored.users.length) {
        this._users = stored.users;
      } else {
        this._users = seed.map(u => ({ ...u }));
        this._persist();
      }
    },

    _persist() { _writeLS(LS_USERS, { users: this._users }); },

    all()           { this._ensureLoaded(); return [...this._users]; },
    find(domainId)  { this._ensureLoaded(); return this._users.find(u => u.DomainId.toUpperCase() === String(domainId).toUpperCase()) || null; },

    add(user, actor) {
      this._ensureLoaded();
      if (this.find(user.DomainId)) throw new Error('Domain ID already exists');
      const rec = {
        DomainId:  user.DomainId.trim(),
        Name:      user.Name.trim(),
        Manager:   (user.Manager || '').trim(),
        Role:      ROLES.includes(user.Role) ? user.Role : 'Leadership',
        Email:     (user.Email || '').trim(),
        Active:    true,
        CreatedBy: actor,
        CreatedAt: new Date().toISOString(),
      };
      this._users.push(rec);
      this._persist();
      Audit.log(actor, rec.DomainId, 'USER_ADDED', 'record', '', JSON.stringify({Name:rec.Name, Role:rec.Role}));
      return rec;
    },

    update(domainId, patch, actor) {
      const u = this.find(domainId);
      if (!u) throw new Error('User not found: ' + domainId);
      ['Name','Manager','Email'].forEach(f => {
        if (patch[f] !== undefined && patch[f] !== u[f]) {
          Audit.log(actor, domainId, 'USER_UPDATED', f, u[f], patch[f]);
          u[f] = patch[f];
        }
      });
      this._persist();
      return u;
    },

    setActive(domainId, active, actor) {
      const u = this.find(domainId);
      if (!u) throw new Error('User not found: ' + domainId);
      if (u.Active !== active) {
        u.Active = active;
        Audit.log(actor, domainId, active ? 'USER_REACTIVATED' : 'USER_DISABLED', 'Active', String(!active), String(active));
        this._persist();
      }
      return u;
    },

    setRole(domainId, role, actor) {
      const u = this.find(domainId);
      if (!u) throw new Error('User not found: ' + domainId);
      if (!ROLES.includes(role)) throw new Error('Invalid role: ' + role);
      if (u.Role !== role) {
        Audit.log(actor, domainId, 'ROLE_CHANGED', 'Role', u.Role, role);
        u.Role = role;
        this._persist();
      }
      return u;
    },
  };

  // ── Audit trail ───────────────────────────────────────────
  const Audit = {
    log(actor, target, action, field, oldVal, newVal) {
      const log = _readLS(LS_AUDIT, []);
      log.push({
        Timestamp: new Date().toISOString(),
        Actor:     actor,
        Target:    target,
        Action:    action,
        Field:     field  || '',
        OldValue:  oldVal || '',
        NewValue:  newVal || '',
      });
      _writeLS(LS_AUDIT, log);
    },
    all() { return _readLS(LS_AUDIT, []); },
  };

  // ── Login activity ────────────────────────────────────────
  const LoginActivity = {
    record(domainId, success, detail) {
      const log = _readLS(LS_LOGINS, []);
      log.push({ Timestamp: new Date().toISOString(), DomainId: domainId, Success: !!success, Detail: detail || '' });
      _writeLS(LS_LOGINS, log);
    },
    all() { return _readLS(LS_LOGINS, []); },
  };

  // ── AuthProvider ──────────────────────────────────────────
  // THE SSO SWAP POINT. Replace authenticate() with an MSAL
  // token flow; the rest of the app never changes.
  const AuthProvider = {
    authenticate(domainId, password) {
      const user = UserStore.find(domainId);
      if (!user)            return { ok:false, reason:'Unknown Domain ID' };
      if (!user.Active)     return { ok:false, reason:'Account disabled. Contact an Admin.' };
      if (password !== SHARED_PASSWORD) return { ok:false, reason:'Incorrect password' };
      return { ok:true, user };
    },
  };

  // ── Session ───────────────────────────────────────────────
  function currentUser() {
    try {
      const s = sessionStorage.getItem(SS_SESSION);
      if (!s) return null;
      const sess = JSON.parse(s);
      const u = UserStore.find(sess.DomainId);
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

  return { UserStore, Audit, LoginActivity, AuthProvider, ROLES, currentUser, login, logout, isAdmin };
})();


/* ============================================================
   UI LAYER - login gate + User Management page
   ============================================================ */
const CatalystAuthUI = (() => {

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ── Login gate ────────────────────────────────────────────
  function initGate(onReady) {
    const overlay = document.getElementById('loginOverlay');
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

    const form = document.getElementById('loginForm');
    const errEl = document.getElementById('loginError');
    form.addEventListener('submit', e => {
      e.preventDefault();
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

  function _applyIdentity(user) {
    const chip = document.getElementById('currentUserChip');
    if (chip) {
      chip.style.display = 'flex';
      chip.querySelector('.cu-name').textContent = user.Name;
      chip.querySelector('.cu-role').textContent = user.Role;
    }
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.style.display = '';
    // Admin-only nav item
    if (user.Role === 'Admin') {
      const nav = document.querySelector('.nav-item[data-page="users"]');
      if (nav) nav.style.display = '';
    }
  }

  // ── User Management page ──────────────────────────────────
  function renderUsersPage() {
    if (!CATALYST_AUTH.isAdmin()) return;
    _renderUserTable();
    _renderAuditTable();
    _renderLoginActivity();
  }

  function _roleBadge(role) {
    const cls = role === 'Admin' ? 'role-admin' : role === 'Manager' ? 'role-manager' : 'role-lead';
    return `<span class="role-badge ${cls}">${esc(role)}</span>`;
  }

  function _renderUserTable() {
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
          ${u.DomainId !== me.DomainId
            ? `<button class="btn-mini ${u.Active ? 'btn-warn' : 'btn-ok'}"
                 onclick="CatalystAuthUI.toggleActive('${esc(u.DomainId)}')">${u.Active ? 'Disable' : 'Enable'}</button>`
            : ''}
        </td>
      </tr>`).join('');
  }

  function _renderAuditTable() {
    const tbody = document.getElementById('auditTableBody');
    if (!tbody) return;
    const rows = CATALYST_AUTH.Audit.all().slice().reverse();
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

  function _renderLoginActivity() {
    const tbody = document.getElementById('loginActivityBody');
    if (!tbody) return;
    const rows = CATALYST_AUTH.LoginActivity.all().slice().reverse().slice(0, 200);
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
    document.getElementById('modalSaveBtn').addEventListener('click', () => {
      try { onSave(); _closeModal(); renderUsersPage(); }
      catch (err) { document.getElementById('modalError').textContent = err.message; }
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
      () => {
        const v = id => document.getElementById(id).value;
        if (!v('mDomain').trim() || !v('mName').trim()) throw new Error('Domain ID and Name are required.');
        CATALYST_AUTH.UserStore.add(
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
      () => {
        const v = id => document.getElementById(id).value;
        CATALYST_AUTH.UserStore.update(domainId,
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
      () => {
        CATALYST_AUTH.UserStore.setRole(domainId, document.getElementById('mRole').value,
          CATALYST_AUTH.currentUser().DomainId);
      });
  }

  function toggleActive(domainId) {
    const u = CATALYST_AUTH.UserStore.find(domainId);
    if (!u) return;
    CATALYST_AUTH.UserStore.setActive(domainId, !u.Active, CATALYST_AUTH.currentUser().DomainId);
    renderUsersPage();
  }

  return { initGate, renderUsersPage, addUser, editUser, changeRole, toggleActive, closeModal: _closeModal };
})();
