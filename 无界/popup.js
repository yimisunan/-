// ================= 加密内核 (V2 内存优化版 + V1 兼容解码) =================
const BOUNDLESS_SALT = "boundless_salt_2026";
const DEFAULT_CONFIG = { useMasterKey: true, lockTimeout: 30, autoFill: true, autoSavePrompt: true };
window.userConfig = { ...DEFAULT_CONFIG };

function buf2b64(buf) {
    let binary = ''; let bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.byteLength; i++) { binary += String.fromCharCode(bytes[i]); }
    return btoa(binary);
}
function b642buf(b64) {
    let binary = atob(b64); let bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
    return bytes.buffer;
}

async function hashPwd(pwd) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pwd));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function getAesKey(pwd) {
  const res = await chrome.storage.local.get(['user_salt']);
  const saltStr = res.user_salt || BOUNDLESS_SALT;
  const keyMat = await crypto.subtle.importKey("raw", new TextEncoder().encode(pwd), {name: "PBKDF2"}, false, ["deriveKey"]);
  return await crypto.subtle.deriveKey({name: "PBKDF2", salt: new TextEncoder().encode(saltStr), iterations: 100000, hash: "SHA-256"}, keyMat, {name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]);
}
async function encryptStr(str, pwd) {
  const key = await getAesKey(pwd); 
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({name: "AES-GCM", iv}, key, new TextEncoder().encode(str));
  return btoa(JSON.stringify({ v: 2, i: buf2b64(iv), c: buf2b64(cipher) }));
}
async function decryptStr(base64, pwd) {
  try {
      const key = await getAesKey(pwd); 
      const parsed = JSON.parse(atob(base64));
      let iv, cipherData;
      if (parsed.v === 2) {
          iv = new Uint8Array(b642buf(parsed.i)); cipherData = new Uint8Array(b642buf(parsed.c));
      } else {
          iv = new Uint8Array(parsed.i); cipherData = new Uint8Array(parsed.c);
      }
      const dec = await crypto.subtle.decrypt({name: "AES-GCM", iv}, key, cipherData);
      return new TextDecoder().decode(dec);
  } catch (e) { return null; }
}

// 🛡️ 万能跨设备兼容获取 Tab 的安全函数
function isRestrictedTabUrl(url) {
    return !url || /^(chrome|chrome-extension|edge|about|kiwi|devtools):/i.test(url);
}

function getActiveTabSafely() {
    return new Promise(resolve => {
        try {
            chrome.tabs.query({ active: true, currentWindow: true }, activeTabs => {
                const current = (activeTabs && activeTabs[0]) ? activeTabs[0] : null;
                if (current && !isRestrictedTabUrl(current.url)) return resolve(current);

                chrome.tabs.query({ active: true }, tabs => {
                    const activeNormal = (tabs || []).find(t => t && !isRestrictedTabUrl(t.url));
                    if (activeNormal) return resolve(activeNormal);

                    chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }, fallbackTabs => {
                        if (fallbackTabs && fallbackTabs.length > 0) return resolve(fallbackTabs[0]);
                        resolve(current || ((tabs && tabs[0]) ? tabs[0] : null));
                    });
                });
            });
        } catch (e) { resolve(null); }
    });
}

// ---------------- 站点禁用名单（规则与 content.js 完全一致） ----------------
function siteKeyFromUrl(url) {
    try {
        const u = new URL(url);
        if (u.protocol === 'file:') return 'file://' + decodeURIComponent(u.pathname || '');
        if (u.protocol === 'http:' || u.protocol === 'https:') return (u.host || u.hostname || '').toLowerCase();
        return (u.protocol + '//' + (u.host || u.hostname || '')).toLowerCase();
    } catch (e) { return ''; }
}

function siteKeyMatches(entry, key) {
    if (!entry || !key) return false;
    const e = String(entry).trim().toLowerCase();
    const k = String(key).trim().toLowerCase();
    if (!e) return false;
    if (e === k) return true;
    if (k.startsWith('file://')) return e === 'file://';
    if (k.includes('://')) return false;
    const hostOnly = k.split(':')[0];
    return k.endsWith('.' + e) || hostOnly === e || hostOnly.endsWith('.' + e);
}

function isKeyDisabled(list, key) {
    return Array.isArray(list) && list.some(entry => siteKeyMatches(entry, key));
}

function loadDisabledSites() {
    return new Promise(resolve => {
        try {
            chrome.storage.local.get(['disabled_sites'], r => resolve(Array.isArray(r?.disabled_sites) ? r.disabled_sites : []));
        } catch (e) { resolve([]); }
    });
}

function saveDisabledSites(list) {
    return new Promise(resolve => { chrome.storage.local.set({ disabled_sites: list }, resolve); });
}

// ---------------- Toast 系统 ----------------
window.showToast = function(msg, type = 'info') {
    let toast = document.getElementById('toastBox');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toastBox';
        toast.className = 'toast-container';
        document.body.appendChild(toast);
    }
    const icon = type === 'error' ? '❌ ' : type === 'success' ? '✅ ' : '💡 ';
    toast.innerText = icon + msg;
    if (type === 'error') toast.style.background = 'rgba(239, 68, 68, 0.95)';
    else if (type === 'success') toast.style.background = 'rgba(16, 185, 129, 0.95)';
    else toast.style.background = 'rgba(17, 24, 39, 0.94)';
    toast.classList.remove('show');
    void toast.offsetWidth;
    toast.classList.add('show');
    if (window.toastTimer) clearTimeout(window.toastTimer);
    window.toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
};

const origAlert = window.alert;
window.alert = (msg) => { 
    if (msg.includes('❌') || msg.includes('⚠️')) window.showToast(msg, 'error');
    else window.showToast(msg, 'info');
};
// ---------------- Toast 系统结束 ----------------

// ================= UI与系统初始化 =================
document.addEventListener('DOMContentLoaded', () => {
  function tick() { try { if(navigator.vibrate) navigator.vibrate(15); } catch(e){} }
  function successVibrate() { try { if(navigator.vibrate) navigator.vibrate([20, 50, 20]); } catch(e){} }

  const pages = {
    'lock': document.getElementById('pageLock'),
    'vault': document.getElementById('pageVault'),
    'form': document.getElementById('pageForm'),
    'backup': document.getElementById('pageBackup'),
    'settings': document.getElementById('pageSettings')
  };
  let currentNavTarget = 'vault';
  let currentFilter = 'all';

  function updateVaultCount() {
    const badge = document.getElementById('vaultCountBadge');
    if (badge) badge.innerText = `${(window.currentVault || []).length} 条`;
  }

  function showModal({ title, desc, buttons }) {
    const overlay = document.getElementById('confirmModal');
    const titleEl = document.getElementById('modalTitle');
    const descEl = document.getElementById('modalDesc');
    const actionsEl = document.getElementById('modalActions');
    if (!overlay) return;
    titleEl.innerText = title || '确认操作';
    descEl.innerText = desc || '';
    actionsEl.innerHTML = '';
    buttons.forEach(btnCfg => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = btnCfg.className || 'main-btn btn-ghost';
      b.innerText = btnCfg.text;
      b.addEventListener('click', () => {
        overlay.classList.remove('show');
        if (typeof btnCfg.onClick === 'function') btnCfg.onClick();
      });
      actionsEl.appendChild(b);
    });
    overlay.classList.add('show');
  }

  function switchPage(pageKey, title = "", skipVibrate = false) {
    if (!skipVibrate) tick();
    Object.values(pages).forEach(p => p.classList.remove('active'));
    pages[pageKey].classList.add('active');
    try {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      document.body.style.overflowY = 'auto';
      document.documentElement.style.overflowY = 'auto';
    } catch (e) {}

    const mainHeader = document.getElementById('mainHeader');
    const formHeader = document.getElementById('formHeader');
    const bottomNav = document.getElementById('bottomNav');
    const manualLockBtn = document.getElementById('manualLockBtn');

    if (pageKey === 'form') {
      mainHeader.style.display = 'none';
      formHeader.style.display = 'flex';
      bottomNav.style.display = 'none';
      document.getElementById('topFormTitle').innerText = title;
    } else if (pageKey === 'lock') {
      mainHeader.style.display = 'flex';
      formHeader.style.display = 'none';
      bottomNav.style.display = 'none';
      manualLockBtn.style.display = 'none';
    } else {
      mainHeader.style.display = 'flex';
      formHeader.style.display = 'none';
      bottomNav.style.display = 'flex';
      manualLockBtn.style.display = (window.userConfig.useMasterKey) ? 'inline-flex' : 'none';
      document.querySelectorAll('.nav-tab[data-nav]').forEach(tab => {
        tab.classList.toggle('active', tab.getAttribute('data-nav') === pageKey);
      });
    }
    updateVaultCount();
  }

  document.getElementById('backBtn').addEventListener('click', () => {
    if (currentNavTarget === 'vault') renderVaultList(searchInput.value.trim());
    switchPage(currentNavTarget);
  });

  document.getElementById('navVaultBtn')?.addEventListener('click', () => {
    currentNavTarget = 'vault';
    renderVaultList(searchInput.value.trim());
    switchPage('vault');
  });

  function escapeHTML(str) { return (!str) ? '' : str.replace(/[&<>'"]/g, t => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[t] || t)); }
  function getAvatarHtml(title) {
    let cleanStr = (title || 'A').replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, ''); let char = cleanStr.charAt(0) ? cleanStr.charAt(0).toUpperCase() : '✦';
    let colors = ['#4F46E5', '#EC4899', '#0D9488', '#D97706', '#7C3AED', '#DC2626', '#0284C7', '#E11D48'];
    return `<div class="avatar-box" style="background-color:${colors[(char.charCodeAt(0)||0)%colors.length]};">${char}</div>`;
  }

  // ================= 🌐 当前网页 启用 / 禁用 =================
  const siteBar = document.getElementById('siteBar');
  const siteBarHost = document.getElementById('siteBarHost');
  const siteBarIcon = document.getElementById('siteBarIcon');
  const siteBarStatusText = document.getElementById('siteBarStatusText');
  const siteToggleBtn = document.getElementById('siteToggleBtn');
  let currentSiteKey = '';

  async function refreshSiteBar() {
    try {
      const tab = await getActiveTabSafely();
      const url = (tab && tab.url) || '';
      currentSiteKey = siteKeyFromUrl(url);
      if (!currentSiteKey || isRestrictedTabUrl(url)) { siteBar.style.display = 'none'; return; }
      siteBar.style.display = 'flex';
      const list = await loadDisabledSites();
      const blocked = isKeyDisabled(list, currentSiteKey);
      siteBar.classList.toggle('off', blocked);
      siteBarIcon.innerText = blocked ? '🚫' : '🌐';
      if (siteBarStatusText) siteBarStatusText.innerText = blocked ? '当前网页 · 已禁用助手' : '当前网页 · 助手运行中';
      siteBarHost.innerText = currentSiteKey;
      siteToggleBtn.innerText = blocked ? '恢复启用' : '本页禁用';
      siteToggleBtn.classList.toggle('on', !blocked);
    } catch (e) { siteBar.style.display = 'none'; }
  }

  document.getElementById('siteQuickAddBtn')?.addEventListener('click', () => {
    document.getElementById('showFormBtn')?.click();
  });

  siteToggleBtn.addEventListener('click', async () => {
    if (!currentSiteKey) return;
    tick();
    let list = await loadDisabledSites();
    const willDisable = !isKeyDisabled(list, currentSiteKey);
    if (willDisable) list.push(currentSiteKey);
    else list = list.filter(e => !siteKeyMatches(e, currentSiteKey));
    await saveDisabledSites(list);
    await refreshSiteBar();
    window.showToast(willDisable ? '已禁用：' + currentSiteKey : '已恢复启用', 'success');
    if (document.getElementById('pageSettings').classList.contains('active')) renderDisabledSites(list);
  });

  async function renderDisabledSites(list) {
    const box = document.getElementById('disabledSitesList');
    if (!box) return;
    const data = Array.isArray(list) ? list : await loadDisabledSites();
    if (!data.length) {
      box.innerHTML = '<div style="font-size:12px;color:var(--text-sub);padding:4px 0;line-height:1.5;">暂无禁用网站。可在首页顶部一键禁用，或在此手动添加域名。</div>';
      return;
    }
    box.innerHTML = data.map(k => `
      <div class="site-item">
        <div class="s-key">${escapeHTML(k)}</div>
        <button type="button" class="s-remove" data-key="${escapeHTML(k)}" title="移除">✕</button>
      </div>`).join('');
    box.querySelectorAll('.s-remove').forEach(btn => btn.addEventListener('click', async () => {
      tick();
      const key = btn.getAttribute('data-key');
      const cur = (await loadDisabledSites()).filter(e => e !== key);
      await saveDisabledSites(cur);
      renderDisabledSites(cur);
      refreshSiteBar();
      window.showToast('已恢复：' + key, 'success');
    }));
  }

  document.getElementById('addDisabledSiteBtn')?.addEventListener('click', async () => {
    const inp = document.getElementById('addDisabledSiteInput');
    const val = (inp?.value || '').trim().toLowerCase();
    if (!val) return window.showToast('请输入域名或路径', 'error');
    const list = await loadDisabledSites();
    if (!list.includes(val)) {
      list.push(val);
      await saveDisabledSites(list);
    }
    inp.value = '';
    renderDisabledSites(list);
    refreshSiteBar();
    window.showToast('已添加到禁用名单', 'success');
  });

  refreshSiteBar();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.disabled_sites) {
      refreshSiteBar();
      if (document.getElementById('pageSettings').classList.contains('active')) renderDisabledSites();
    }
  });

  window.unlockToken = null; window.currentVault = []; 

  async function ensureUnlockToken() {
    if (window.unlockToken) return window.unlockToken;
    try {
      const res = await chrome.storage.local.get(['unlock_token', 'unlock_time', 'user_config', 'encrypted_vault']);
      const cfg = { ...DEFAULT_CONFIG, ...(res.user_config || {}) };
      if (!res.unlock_token) return null;
      let valid = false;
      if (cfg.lockTimeout === -1) valid = true;
      else if (cfg.lockTimeout === 0) valid = res.unlock_time && (Date.now() - res.unlock_time < 15000);
      else valid = res.unlock_time && (Date.now() - res.unlock_time < cfg.lockTimeout * 60000);
      if (!valid) return null;
      // 校验 token 仍可解密，避免脏状态
      if (res.encrypted_vault) {
        const dec = await decryptStr(res.encrypted_vault, res.unlock_token);
        if (!dec) return null;
      }
      window.unlockToken = res.unlock_token;
      return window.unlockToken;
    } catch (e) { return null; }
  }

  async function saveToStorage(callback) {
    try {
      if (window.userConfig.useMasterKey) {
        const token = await ensureUnlockToken();
        if (!token) {
          window.showToast('安全状态丢失，请重新解锁后再保存', 'error');
          return;
        }
        let enc = await encryptStr(JSON.stringify(window.currentVault), token);
        chrome.storage.local.set({ encrypted_vault: enc, unlock_token: token, unlock_time: Date.now() }, () => {
          if (typeof callback === 'function') callback();
        });
      } else {
        chrome.storage.local.set({ vault_data: window.currentVault }, () => {
          if (typeof callback === 'function') callback();
        });
      }
    } catch (e) {
      window.showToast('保存失败: ' + (e.message || '未知错误'), 'error');
    }
  }

  function saveConfig() { chrome.storage.local.set({ user_config: window.userConfig }); }

  async function checkAndMergeTempVault() {
      if (!window.userConfig.useMasterKey || !window.unlockToken) return;
      chrome.storage.local.get(['temp_unencrypted_vault'], async (res) => {
          if (res.temp_unencrypted_vault && res.temp_unencrypted_vault.length > 0) {
              let changed = false;
              res.temp_unencrypted_vault.forEach(item => {
                  if (!window.currentVault.some(v => v.pwd === item.pwd && v.domain === item.domain)) {
                      item.isMain = window.currentVault.filter(i => i.domain === item.domain).length === 0;
                      window.currentVault.unshift(item); changed = true;
                  }
              });
              if (changed) {
                  await saveToStorage(() => { chrome.storage.local.remove('temp_unencrypted_vault'); renderVaultList(); });
              } else { chrome.storage.local.remove('temp_unencrypted_vault'); }
          }
      });
  }

  const lockTitle = document.getElementById('lockTitle'); const lockDesc = document.getElementById('lockDesc');
  const masterPwdInput = document.getElementById('masterPwdInput'); const unlockBtn = document.getElementById('unlockBtn');
  const cancelLockBtn = document.getElementById('cancelLockBtn');
  let authMode = 'unlock'; 

  function initSystem() {
    chrome.storage.local.get(['user_config', 'master_hash', 'encrypted_vault', 'vault_data', 'unlock_token', 'unlock_time'], async (res) => {
      if (res.user_config) window.userConfig = { ...DEFAULT_CONFIG, ...res.user_config };
      
      if (!window.userConfig.useMasterKey) {
        window.currentVault = res.vault_data || [];
        renderVaultList(); switchPage('vault', '', true); return;
      }

      if (res.master_hash) {
        let isSessionValid = false;
        // 即使“永不锁定”，也必须存在可用的 unlock_token，否则无法加密保存
        if (res.unlock_token) {
          if (window.userConfig.lockTimeout === -1) isSessionValid = true;
          else if (window.userConfig.lockTimeout >= 0) isSessionValid = res.unlock_time && (Date.now() - res.unlock_time < (window.userConfig.lockTimeout === 0 ? 15000 : window.userConfig.lockTimeout * 60000));
        }

        if (isSessionValid) {
          let dec = await decryptStr(res.encrypted_vault, res.unlock_token);
          if (dec) {
            window.unlockToken = res.unlock_token; window.currentVault = JSON.parse(dec);
            chrome.storage.local.set({ unlock_time: Date.now() }); 
            checkAndMergeTempVault(); 
            renderVaultList(); switchPage('vault', '', true); return;
          }
        }
        authMode = 'unlock'; lockTitle.innerText = "验证身份"; lockDesc.innerText = "请输入主控密码解锁您的密码库"; cancelLockBtn.style.display = 'none'; switchPage('lock', '', true);
      } else {
        authMode = 'setup'; window.currentVault = res.vault_data || [];
        lockTitle.innerText = "初始化安全保护"; lockDesc.innerHTML = "首次启用，请设置主控密码<br>⚠️ 离线加密机制，遗忘无法找回！"; cancelLockBtn.style.display = 'none'; switchPage('lock', '', true);
      }
    });
  }

  document.getElementById('toggleMasterEyeBtn')?.addEventListener('click', () => {
    const btn = document.getElementById('toggleMasterEyeBtn');
    if (masterPwdInput.type === 'password') { masterPwdInput.type = 'text'; btn.innerText = '🙈'; }
    else { masterPwdInput.type = 'password'; btn.innerText = '👁️'; }
  });

  masterPwdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); unlockBtn.click(); }
  });

  unlockBtn.addEventListener('click', async () => {
    let pwd = masterPwdInput.value.trim(); if (!pwd) return window.showToast('密码不能为空', 'error');
    const oldBtnText = unlockBtn.innerText;
    unlockBtn.innerText = "处理中...";
    unlockBtn.disabled = true;
    try {
      if (authMode === 'setup' || authMode === 'turn_on' || authMode === 'change_new') {
        const saltRes = await chrome.storage.local.get(['user_salt']);
        if (!saltRes.user_salt) {
          const randomSalt = crypto.getRandomValues(new Uint8Array(16));
          await chrome.storage.local.set({ user_salt: buf2b64(randomSalt) });
        }
        let hash = await hashPwd(pwd); let enc = await encryptStr(JSON.stringify(window.currentVault), pwd);
        window.userConfig.useMasterKey = true; saveConfig();
        await new Promise(resolve => chrome.storage.local.set({ master_hash: hash, encrypted_vault: enc, unlock_token: pwd, unlock_time: Date.now() }, resolve));
        chrome.storage.local.remove('vault_data');
        window.unlockToken = pwd; masterPwdInput.value = ''; masterPwdInput.type = 'password';
        if (authMode === 'turn_on' || authMode === 'change_new') {
          window.showToast(authMode === 'change_new' ? '主控密码已更新' : '安全护盾已开启', 'success');
          renderSettings(); switchPage('settings');
        } else {
          renderVaultList(); switchPage('vault');
        }
      } else {
        let hash = await hashPwd(pwd);
        const res = await new Promise(resolve => chrome.storage.local.get(['master_hash', 'encrypted_vault'], resolve));
        if (res.master_hash === hash) {
          if (authMode === 'turn_off') {
            window.userConfig.useMasterKey = false; saveConfig();
            await new Promise(resolve => chrome.storage.local.set({ vault_data: window.currentVault }, resolve));
            chrome.storage.local.remove(['encrypted_vault', 'master_hash', 'unlock_token', 'unlock_time']);
            window.unlockToken = null; masterPwdInput.value = ''; masterPwdInput.type = 'password';
            window.showToast('已关闭安全护盾', 'success');
            renderSettings(); switchPage('settings');
          } else if (authMode === 'change_verify') {
            masterPwdInput.value = '';
            authMode = 'change_new';
            lockTitle.innerText = "设置新主控密码";
            lockDesc.innerText = "请输入新的主控密码，本地数据将使用新密码重新加密";
            unlockBtn.innerText = "确认修改";
          } else {
            let dec = await decryptStr(res.encrypted_vault, pwd); window.unlockToken = pwd; window.currentVault = JSON.parse(dec || "[]");
            chrome.storage.local.set({ unlock_token: pwd, unlock_time: Date.now() });
            checkAndMergeTempVault();
            masterPwdInput.value = ''; masterPwdInput.type = 'password';
            renderVaultList(); switchPage('vault');
          }
        } else {
          window.showToast('主控密码错误', 'error');
        }
      }
    } finally {
      unlockBtn.disabled = false;
      if (authMode !== 'change_new') unlockBtn.innerText = oldBtnText === '处理中...' ? '确认' : oldBtnText;
    }
  });

  cancelLockBtn.addEventListener('click', () => {
    masterPwdInput.value = ''; masterPwdInput.type = 'password';
    unlockBtn.innerText = "解锁进入";
    renderSettings(); switchPage('settings');
  });
  document.getElementById('manualLockBtn').addEventListener('click', () => {
    window.unlockToken = null; window.currentVault = [];
    chrome.storage.local.remove(['unlock_token', 'unlock_time'], () => { tick(); initSystem(); });
  });

  document.getElementById('goSettingsBtn').addEventListener('click', () => {
    currentNavTarget = 'vault'; renderSettings(); switchPage('settings');
  });
  const tgMaster = document.getElementById('toggleMasterKey');
  const selTimeout = document.getElementById('selectLockTimeout');
  const tgAuto = document.getElementById('toggleAutoFill');
  const tgAutoSave = document.getElementById('toggleAutoSave');
  function renderSettings() {
      tgMaster.checked = window.userConfig.useMasterKey;
      selTimeout.value = window.userConfig.lockTimeout;
      tgAuto.checked = window.userConfig.autoFill;
      tgAutoSave.checked = window.userConfig.autoSavePrompt !== false;
      selTimeout.disabled = !window.userConfig.useMasterKey;
      const changeRow = document.getElementById('changeMasterPwdRow');
      if (changeRow) changeRow.style.display = window.userConfig.useMasterKey ? 'flex' : 'none';
      renderDisabledSites();
  }
  tgAuto.addEventListener('change', () => { window.userConfig.autoFill = tgAuto.checked; saveConfig(); });
  tgAutoSave.addEventListener('change', () => { window.userConfig.autoSavePrompt = tgAutoSave.checked; saveConfig(); });
  selTimeout.addEventListener('change', () => { window.userConfig.lockTimeout = parseInt(selTimeout.value); saveConfig(); });
  tgMaster.addEventListener('click', (e) => {
    e.preventDefault();
    if (window.userConfig.useMasterKey) {
      authMode = 'turn_off'; lockTitle.innerText = "关闭安全护盾"; lockDesc.innerText = "请输入当前主控密码以关闭保护并解密数据";
      unlockBtn.innerText = "确认关闭"; cancelLockBtn.style.display = 'inline-flex'; switchPage('lock');
    } else {
      authMode = 'turn_on'; lockTitle.innerText = "启用安全护盾"; lockDesc.innerHTML = "请设置主控密码<br>您的现有数据将立即被加密保护";
      unlockBtn.innerText = "确认启用"; cancelLockBtn.style.display = 'inline-flex'; switchPage('lock');
    }
  });
  document.getElementById('changeMasterPwdBtn')?.addEventListener('click', () => {
    authMode = 'change_verify'; lockTitle.innerText = "验证当前主控密码"; lockDesc.innerText = "请输入当前使用的主控密码以继续";
    unlockBtn.innerText = "下一步"; cancelLockBtn.style.display = 'inline-flex'; switchPage('lock');
  });

  // ================= 核心星图渲染 =================
  let editingId = null; 
  let activeTabId = null;
  let activeTabUrl = ""; 
  const vaultList = document.getElementById('vaultList');
  const currentTabVaultList = document.getElementById('currentTabVaultList');
  const searchBox = document.getElementById('searchBox');
  const searchInput = document.getElementById('searchInput');

  function renderItemHtml(item, isCurrentTab = false, isSubItem = false) {
      let ds = escapeHTML(item.title || item.domain), su = escapeHTML(item.url), sa = escapeHTML(item.acc), sp = escapeHTML(item.pwd);
      let hasCred = !!(item.acc || item.pwd);
      let mainStar = item.isMain ? `<span class="badge main-star">★ 默认</span>` : '';
      let badge = hasCred ? `<span class="badge pwd">🔑</span>` : `<span class="badge bm">⭐ 书签</span>`;
      let subText = sa ? sa : (su || item.domain || '网址书签');

      // 卡片右侧一键快捷按钮（无需展开即可操作）
      let quickHtml = '<div class="quick-actions">';
      if (isCurrentTab && hasCred) {
          quickHtml += `<button type="button" class="q-btn primary btn-inject" data-id="${item.id}" title="填充到当前网页">⚡ 填充</button>`;
      }
      if (sa) {
          quickHtml += `<button type="button" class="q-btn btn-copy-acc" data-acc="${sa}" title="复制账号">账号</button>`;
      }
      if (sp) {
          quickHtml += `<button type="button" class="q-btn btn-copy-pwd" data-pwd="${sp}" title="复制密码">密码</button>`;
      }
      if (!hasCred && su) {
          quickHtml += `<button type="button" class="q-btn soft-primary btn-open-url" data-url="${su}" title="打开网页">打开</button>`;
      }
      quickHtml += '</div>';

      // 展开后详细信息
      let detailRows = '';
      if (sa) {
          detailRows += `<div class="detail-row"><span class="detail-label">账号</span><span class="detail-val">${sa}</span><div class="detail-btns"><button type="button" class="mini-btn btn-copy-acc" data-acc="${sa}">复制</button></div></div>`;
      }
      if (sp) {
          detailRows += `<div class="detail-row"><span class="detail-label">密码</span><span class="detail-val pwd-mask" data-pwd="${sp}" data-revealed="0">••••••••</span><div class="detail-btns"><button type="button" class="mini-btn btn-reveal-pwd">显示</button><button type="button" class="mini-btn btn-copy-pwd" data-pwd="${sp}">复制</button></div></div>`;
      }
      if (su) {
          detailRows += `<div class="detail-row"><span class="detail-label">网址</span><span class="detail-val url-link btn-open-url" data-url="${su}">${su}</span><div class="detail-btns"><button type="button" class="mini-btn btn-open-url" data-url="${su}">访问</button></div></div>`;
      }

      let btnMainClass = item.isMain ? 'active' : '';
      let btnMainHtml = hasCred ? `<button type="button" class="footer-btn btn-main ${btnMainClass}" data-id="${item.id}">${item.isMain ? '★ 已设为默认' : '☆ 设为默认'}</button>` : '';
      let injectHtml = (isCurrentTab && hasCred) ? `<button type="button" class="footer-btn btn-inject" data-id="${item.id}">⚡ 填充</button>` : '';
      let editHtml = `<button type="button" class="footer-btn btn-edit" data-id="${item.id}">✏️ 编辑</button>`;

      let isMainClass = item.isMain ? 'is-main' : '';
      let currentMatchClass = (isCurrentTab && !isSubItem) ? 'current-match' : '';
      let subClass = isSubItem ? 'sub-item' : '';
      let avatarHtml = !isSubItem ? getAvatarHtml(ds) : '';
      let expandedClass = (isCurrentTab && !isSubItem) ? 'expanded' : '';

      return `
      <div class="item-card ${isMainClass} ${currentMatchClass} ${subClass} ${expandedClass}" data-id="${item.id}">
          <div class="item-header">
              ${avatarHtml}
              <div class="info">
                  <div class="title-row"><span class="title">${ds}</span>${badge}${mainStar}</div>
                  <div class="sub-line">${subText}</div>
              </div>
              ${quickHtml}
              <div class="expand-arrow">▼</div>
          </div>
          <div class="item-body">
              <div class="detail-grid">${detailRows}</div>
              <div class="item-footer-actions">${btnMainHtml}${injectHtml}${editHtml}</div>
          </div>
      </div>`;
  }

  function renderGroupHtml(domain, items, isCurrentTab = false) {
      if (items.length === 1) return renderItemHtml(items[0], isCurrentTab);
      let firstItem = items[0]; let groupTitle = escapeHTML(domain || firstItem.title || '聚合账号');
      let expandedClass = isCurrentTab ? 'expanded' : '';
      let html = `<div class="group-card ${expandedClass}"><div class="group-header">${getAvatarHtml(groupTitle)}<div class="info"><div class="title-row"><span class="title">${groupTitle}</span><span class="badge bm">${items.length} 个账号</span></div><div class="sub-line">点击展开查看全部账号</div></div><div class="expand-arrow">▼</div></div><div class="group-body">`;
      items.forEach(item => { html += renderItemHtml(item, isCurrentTab, true); }); html += `</div></div>`;
      return html;
  }

  function groupItemsByDomain(items) {
      let groups = {};
      items.forEach(item => { let key = item.domain || 'other'; if (!groups[key]) groups[key] = []; groups[key].push(item); });
      return Object.values(groups);
  }

  async function renderVaultList(filterText = '') {
    updateVaultCount();
    vaultList.innerHTML = ''; currentTabVaultList.innerHTML = '';
    searchBox.style.display = window.currentVault.length > 0 ? 'block' : 'none';
    if (window.currentVault.length === 0) return vaultList.innerHTML = `
        <div style="text-align:center; color:var(--text-sub); margin-top:48px; padding: 24px 16px;">
            <div style="font-size: 52px; margin-bottom: 12px;">🗂️</div>
            <div style="font-size:15px; font-weight:700; color:var(--text-main); margin-bottom:6px;">还没有保存任何记录</div>
            <div style="font-size:13px; line-height: 1.6;">点击底部「＋ 新增记录」或上方「＋ 存本页」<br>即可快速保存当前网站的账号密码或书签</div>
        </div>`;

    let currentDomain = "";
    try {
        let tab = await getActiveTabSafely();
        if (tab && tab.url) { activeTabId = tab.id; activeTabUrl = tab.url; currentDomain = new URL(tab.url).hostname; }
    } catch(e) {}

    let matchesCurrent = []; let others = []; let lower = filterText.toLowerCase();

    window.currentVault.forEach(item => {
      let hasCred = !!(item.acc || item.pwd);
      if (currentFilter === 'pwd' && !hasCred) return;
      if (currentFilter === 'bm' && hasCred) return;
      let isMatchSearch = !filterText || ((item.title && item.title.toLowerCase().includes(lower)) || (item.url && item.url.toLowerCase().includes(lower)) || (item.acc && item.acc.toLowerCase().includes(lower)));
      if (isMatchSearch) {
        if (!filterText && currentDomain && (currentDomain === item.domain || currentDomain.endsWith('.' + item.domain))) matchesCurrent.push(item);
        else others.push(item);
      }
    });

    if (matchesCurrent.length === 0 && others.length === 0) return vaultList.innerHTML = '<div style="text-align:center; color:var(--text-sub); margin-top:36px; font-size:13px;">未找到匹配的记录</div>';
    let currentTabGroups = groupItemsByDomain(matchesCurrent); let otherGroups = groupItemsByDomain(others);

    if (currentTabGroups.length > 0) {
        let html = `<div class="section-header"><div class="section-title highlight">⚡ 当前网页可用 (${matchesCurrent.length})</div></div>`;
        currentTabGroups.forEach(group => { html += renderGroupHtml(group[0].domain, group, true); });
        currentTabVaultList.innerHTML = html;
    }
    if (otherGroups.length > 0) {
        let html = `<div class="section-header"><div class="section-title">${currentTabGroups.length > 0 ? '全部记录' : '已保存记录'} (${others.length})</div></div>`;
        otherGroups.forEach(group => { html += renderGroupHtml(group[0].domain, group, false); });
        vaultList.innerHTML = html;
    }
  }

  // 搜索与分类筛选
  let searchTimer = null;
  const clearSearchBtn = document.getElementById('clearSearchBtn');
  searchInput.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (clearSearchBtn) clearSearchBtn.classList.toggle('visible', val.length > 0);
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderVaultList(val), 120);
  });
  clearSearchBtn?.addEventListener('click', () => {
    searchInput.value = '';
    clearSearchBtn.classList.remove('visible');
    renderVaultList('');
    searchInput.focus();
  });
  document.getElementById('filterTabs')?.addEventListener('click', (e) => {
    const pill = e.target.closest('.filter-pill');
    if (!pill) return;
    tick();
    currentFilter = pill.getAttribute('data-filter') || 'all';
    document.querySelectorAll('.filter-pill').forEach(p => p.classList.toggle('active', p === pill));
    renderVaultList(searchInput.value.trim());
  });

  // --- 密码小眼睛 & 随机强密码生成 ---
  const toggleEyeBtn = document.getElementById('toggleEyeBtn');
  const pwdInput = document.getElementById('pwdInput');
  if (toggleEyeBtn && pwdInput) {
      toggleEyeBtn.addEventListener('click', (e) => {
          e.preventDefault();
          if (pwdInput.type === 'password') { pwdInput.type = 'text'; toggleEyeBtn.innerText = '🙈'; }
          else { pwdInput.type = 'password'; toggleEyeBtn.innerText = '👁️'; }
      });
  }

  document.getElementById('genPwdBtn')?.addEventListener('click', () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
    const arr = new Uint32Array(16);
    crypto.getRandomValues(arr);
    let generated = '';
    for (let i = 0; i < arr.length; i++) generated += chars[arr[i] % chars.length];
    pwdInput.value = generated;
    pwdInput.type = 'text';
    if (toggleEyeBtn) toggleEyeBtn.innerText = '🙈';
    navigator.clipboard?.writeText(generated).catch(() => {});
    successVibrate();
    window.showToast('已生成 16 位强密码并复制', 'success');
  });

  document.getElementById('fillCurrentTabBtn')?.addEventListener('click', async () => {
    try {
      const tab = await getActiveTabSafely();
      if (!tab || isRestrictedTabUrl(tab.url)) return window.showToast('当前页面不支持获取网址', 'error');
      document.getElementById('titleInput').value = tab.title || '';
      document.getElementById('urlInput').value = tab.url || '';
      tick();
      window.showToast('已填入当前网页信息', 'success');
    } catch (e) {}
  });

  // ================= 动作代理 =================
  document.getElementById('pageVault').addEventListener('click', (e) => {
    let copyAccBtn = e.target.closest('.btn-copy-acc');
    if (copyAccBtn) {
        e.stopPropagation();
        navigator.clipboard.writeText(copyAccBtn.getAttribute('data-acc')).then(() => {
            successVibrate();
            window.showToast('账号已复制', 'success');
        });
        return;
    }

    let copyPwdBtn = e.target.closest('.btn-copy-pwd');
    if (copyPwdBtn) {
        e.stopPropagation();
        navigator.clipboard.writeText(copyPwdBtn.getAttribute('data-pwd')).then(() => {
            successVibrate();
            window.showToast('密码已复制', 'success');
        });
        return;
    }

    let revealBtn = e.target.closest('.btn-reveal-pwd');
    if (revealBtn) {
        e.stopPropagation();
        const row = revealBtn.closest('.detail-row');
        const valEl = row?.querySelector('.pwd-mask');
        if (valEl) {
            const shown = valEl.getAttribute('data-revealed') === '1';
            valEl.textContent = shown ? '••••••••' : valEl.getAttribute('data-pwd');
            valEl.setAttribute('data-revealed', shown ? '0' : '1');
            revealBtn.innerText = shown ? '显示' : '隐藏';
        }
        return;
    }

    let openUrlBtn = e.target.closest('.btn-open-url');
    if (openUrlBtn) {
        e.stopPropagation();
        const targetUrl = openUrlBtn.getAttribute('data-url');
        if (targetUrl) chrome.tabs.create({ url: targetUrl });
        return;
    }

    let editBtn = e.target.closest('.btn-edit');
    if (editBtn) {
        e.stopPropagation();
        let item = window.currentVault.find(x => x.id === editBtn.getAttribute('data-id'));
        if(item) {
            editingId = item.id;
            document.getElementById('titleInput').value = item.title || '';
            document.getElementById('urlInput').value = item.url || '';
            document.getElementById('accInput').value = item.acc || '';
            document.getElementById('pwdInput').value = item.pwd || '';
            document.getElementById('pwdInput').type = 'password';
            if (document.getElementById('toggleEyeBtn')) document.getElementById('toggleEyeBtn').innerText = '👁️';
            const mainCb = document.getElementById('isMainCheckbox');
            if (mainCb) mainCb.checked = !!item.isMain;
            document.getElementById('deleteBtn').style.display = 'inline-flex';
            currentNavTarget = 'vault';
            switchPage('form', '编辑记录');
        }
        return;
    }

    let mainBtn = e.target.closest('.btn-main');
    if (mainBtn) {
        e.stopPropagation(); tick(); let targetItem = window.currentVault.find(x => x.id === mainBtn.getAttribute('data-id'));
        if (targetItem) {
            const nextState = !targetItem.isMain;
            window.currentVault.forEach(item => { if (item.domain === targetItem.domain) item.isMain = false; });
            targetItem.isMain = nextState;
            saveToStorage(() => {
                window.showToast(nextState ? '已设为默认填充账号' : '已取消默认', 'success');
                renderVaultList(searchInput.value.trim());
            });
        } return;
    }

    let injectBtn = e.target.closest('.btn-inject');
    if (injectBtn && activeTabId) {
        e.stopPropagation(); successVibrate();
        if (!activeTabUrl || activeTabUrl.match(/^(chrome|chrome-extension|edge|about|kiwi):/i)) return window.showToast("安全限制：无法在浏览器内置页中填充", "error");
        let targetItem = window.currentVault.find(x => x.id === injectBtn.getAttribute('data-id'));
        if (targetItem) {
            injectBtn.innerText = '✓ 已填充';
            chrome.tabs.sendMessage(activeTabId, {action: "FORCE_FILL_INJECT", data: targetItem}, (response) => {
                if (chrome.runtime.lastError) {
                    window.showToast("页面未就绪或不支持自动填充", "error");
                    injectBtn.innerText = '⚡ 填充';
                } else if (response && response.status === 'blocked') {
                    window.showToast("当前网页已禁用无界助手", "error");
                    injectBtn.innerText = '⚡ 填充';
                } else { setTimeout(() => window.close(), 350); }
            });
        }
        return;
    }

    let itemHeader = e.target.closest('.item-header');
    if (itemHeader) { tick(); itemHeader.parentElement.classList.toggle('expanded'); return; }

    let groupHeader = e.target.closest('.group-header');
    if (groupHeader) { tick(); groupHeader.parentElement.classList.toggle('expanded'); return; }
  });

  // ================= 增删查改 =================
  document.getElementById('showFormBtn').addEventListener('click', async () => {
    editingId = null; document.getElementById('deleteBtn').style.display = 'none';
    try {
        let tab = await getActiveTabSafely();
        if (tab && !isRestrictedTabUrl(tab.url)) {
            document.getElementById('titleInput').value = tab.title || '';
            document.getElementById('urlInput').value = tab.url || '';
        } else {
            document.getElementById('titleInput').value = '';
            document.getElementById('urlInput').value = '';
        }
    } catch (e) { document.getElementById('titleInput').value = ''; document.getElementById('urlInput').value = ''; }
    document.getElementById('accInput').value = '';
    document.getElementById('pwdInput').value = '';
    document.getElementById('pwdInput').type = 'password';
    if (document.getElementById('toggleEyeBtn')) document.getElementById('toggleEyeBtn').innerText = '👁️';
    const mainCb = document.getElementById('isMainCheckbox');
    if (mainCb) mainCb.checked = true;
    currentNavTarget = 'vault'; switchPage('form', '新增记录');
  });

  document.getElementById('saveBtn').addEventListener('click', () => {
    let rawUrl = document.getElementById('urlInput').value.trim(); if (!rawUrl) return window.showToast('请填写网站地址！', 'error');
    if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) rawUrl = 'https://' + rawUrl;
    let domain = ''; try { domain = new URL(rawUrl).hostname; } catch(e) { return window.showToast('网址格式不正确', 'error'); }

    const accVal = document.getElementById('accInput').value.trim();
    const pwdVal = document.getElementById('pwdInput').value.trim();
    const mainCb = document.getElementById('isMainCheckbox');
    const wantMain = mainCb ? mainCb.checked && !!(accVal || pwdVal) : false;

    if (wantMain) {
      window.currentVault.forEach(i => { if (i.domain === domain) i.isMain = false; });
    }

    let newItem = {
      id: editingId || Date.now().toString(),
      domain: domain,
      url: rawUrl,
      title: document.getElementById('titleInput').value.trim() || domain,
      acc: accVal,
      pwd: pwdVal,
      isMain: wantMain
    };

    if (editingId) {
      let idx = window.currentVault.findIndex(i => i.id === editingId);
      if (idx > -1) window.currentVault[idx] = newItem;
    } else {
      window.currentVault.unshift(newItem);
    }
    saveToStorage(() => {
      successVibrate();
      window.showToast(editingId ? '记录已更新' : '已保存记录', 'success');
      document.getElementById('searchInput').value = '';
      if (clearSearchBtn) clearSearchBtn.classList.remove('visible');
      renderVaultList();
      switchPage('vault');
    });
  });

  document.getElementById('deleteBtn').addEventListener('click', () => {
    if (!editingId) return;
    showModal({
      title: '删除记录',
      desc: '确定要永久删除这条记录吗？此操作无法撤销。',
      buttons: [
        { text: '取消', className: 'main-btn btn-ghost' },
        {
          text: '确认删除',
          className: 'main-btn',
          onClick: () => {
            window.currentVault = window.currentVault.filter(i => i.id !== editingId);
            saveToStorage(() => {
              tick();
              window.showToast('已删除记录', 'success');
              document.getElementById('searchInput').value = '';
              renderVaultList();
              switchPage('vault');
            });
          }
        }
      ]
    });
  });

  // ================= 备份与导入 =================
  document.getElementById('showBackupBtn').addEventListener('click', () => {
    document.getElementById('backupTextarea').value = '';
    document.getElementById('backupTip').innerHTML = window.userConfig.useMasterKey ? "已开启 AES-256 加密保护，恢复时需使用相同的主控密码。" : "⚠️ 当前未开启安全护盾，备份码为明文格式，请妥善保管。";
    currentNavTarget = 'vault'; switchPage('backup');
  });

  function buildExportPayload(r) {
    // v3：带上 user_salt。否则跨设备/重装后 master_hash 能对上，但 AES 派生盐不一致，会报“数据解析失败”
    return window.userConfig.useMasterKey
      ? btoa(encodeURIComponent(JSON.stringify({
          v: 3,
          hash: r.master_hash,
          salt: r.user_salt || null,
          vault: r.encrypted_vault
        })))
      : btoa(encodeURIComponent(JSON.stringify(window.currentVault)));
  }

  function downloadTextFile(content, filename) {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  document.getElementById('doExportBtn').addEventListener('click', () => {
    if (window.currentVault.length === 0) return window.showToast('暂无星辰！', 'error');
    chrome.storage.local.get(['master_hash', 'encrypted_vault', 'user_salt'], (r) => {
      let exportData = buildExportPayload(r);
      document.getElementById('backupTextarea').value = exportData;
      navigator.clipboard.writeText(exportData).then(() => window.showToast('代码已生成并复制！', 'success')).catch(() => window.showToast('请手动全选复制', 'error'));
    });
  });

  // 仅绑定实际存在的按钮，避免整段脚本中断
  const exportFileBtn = document.getElementById('exportFileBtn');
  if (exportFileBtn) {
    exportFileBtn.addEventListener('click', () => {
      if (window.currentVault.length === 0) return window.showToast('暂无星辰！', 'error');
      chrome.storage.local.get(['master_hash', 'encrypted_vault', 'user_salt'], (r) => {
        const exportData = buildExportPayload(r);
        document.getElementById('backupTextarea').value = exportData;
        const dateStr = new Date().toISOString().slice(0,10);
        downloadTextFile(exportData, `boundless_backup_${dateStr}.txt`);
        window.showToast('已开始下载备份文件', 'success');
      });
    });
  }

  function isValidVaultSchema(arr) { return Array.isArray(arr) && (arr.length === 0 || (arr[0].hasOwnProperty('id') && arr[0].hasOwnProperty('domain') && arr[0].hasOwnProperty('url'))); }

  function normalizeBackupCode(raw) {
    if (!raw) return '';
    // 去掉 BOM、空白、可能被 WebDAV/编辑器污染的引号
    let code = String(raw).replace(/^\uFEFF/, '').trim();
    if ((code.startsWith('"') && code.endsWith('"')) || (code.startsWith("'") && code.endsWith("'"))) {
      code = code.slice(1, -1).trim();
    }
    // 去掉中间意外换行（部分客户端下载会插入）
    code = code.replace(/\s+/g, '');
    return code;
  }

  async function decryptVaultWithFallback(encVault, password, preferredSalt) {
    // 优先用备份自带 salt；失败再尝试本地 salt / 旧版固定 salt
    const local = await chrome.storage.local.get(['user_salt']);
    const candidates = [];
    if (preferredSalt) candidates.push(preferredSalt);
    if (local.user_salt && local.user_salt !== preferredSalt) candidates.push(local.user_salt);
    candidates.push(null); // 走 getAesKey 内部的 BOUNDLESS_SALT 回落

    let lastErr = null;
    for (const salt of candidates) {
      try {
        if (salt) await chrome.storage.local.set({ user_salt: salt });
        const text = await decryptStr(encVault, password);
        if (text) return { text, salt: salt || local.user_salt || null };
      } catch (e) { lastErr = e; }
    }
    if (lastErr) throw lastErr;
    return null;
  }

  async function processImportCode(code) {
      code = normalizeBackupCode(code);
      if (!code) return window.showToast('代码不可为空！', 'error');
      if (window.userConfig.useMasterKey) {
        const token = await ensureUnlockToken();
        if (!token) return window.showToast("安全拦截：请先解锁验证主控秘钥！", "error");
      }
      try {
        let dec;
        try {
          dec = JSON.parse(decodeURIComponent(atob(code)));
        } catch (e1) {
          // 兼容：有些备份可能只是 btoa(JSON) 没走 encodeURIComponent
          try { dec = JSON.parse(atob(code)); }
          catch (e2) { throw new Error('BACKUP_FORMAT'); }
        }

        let cloudVault = [];
        // 兼容 v2 / v3 加密备份
        if ((dec.v === 2 || dec.v === 3) && dec.hash && dec.vault) {
            if (!window.userConfig.useMasterKey) return window.showToast("云端是加密备份，请先开启并解锁安全护盾", "error");
            const localHashRes = await chrome.storage.local.get(['master_hash', 'user_salt']);
            if (localHashRes.master_hash && localHashRes.master_hash !== dec.hash) {
              return window.showToast("主控秘钥不一致：云端备份不是用当前密码加密的", "error");
            }

            // 先恢复备份中的 salt，再解密
            if (dec.salt) await chrome.storage.local.set({ user_salt: dec.salt });
            const result = await decryptVaultWithFallback(dec.vault, window.unlockToken, dec.salt || null);
            if (!result || !result.text) {
              return window.showToast("解密失败：主控秘钥不对，或备份盐值不匹配。请用原设备重新上传一次备份", "error");
            }
            // 固化可用 salt，避免后续保存又写坏
            if (result.salt) await chrome.storage.local.set({ user_salt: result.salt });
            // 若本地还没有 master_hash（新设备），写入云端 hash
            if (!localHashRes.master_hash && dec.hash) await chrome.storage.local.set({ master_hash: dec.hash });

            cloudVault = JSON.parse(result.text);
        } else if (isValidVaultSchema(dec)) {
            cloudVault = dec;
        } else {
            throw new Error("格式结构不匹配");
        }

        let localVault = window.currentVault || [];
        if (localVault.length === 0) {
            window.currentVault = cloudVault;
            return saveToStorage(() => { window.showToast('星图数据已成功恢复！', 'success'); renderVaultList(); switchPage('vault'); });
        }
        let userChoice = confirm(`发现本地有 ${localVault.length} 条，云端有 ${cloudVault.length} 条。\n👉 【确定】智能合并（推荐）\n👉 【取消】强制云端覆盖本地`);
        if (userChoice) {
            let addedCount = 0;
            cloudVault.forEach(cItem => {
                let exists = localVault.some(lItem => lItem.id === cItem.id || (lItem.domain === cItem.domain && lItem.acc === cItem.acc && lItem.pwd === cItem.pwd));
                if (!exists) { localVault.push(cItem); addedCount++; }
            });
            window.currentVault = localVault;
            saveToStorage(() => { window.showToast(`智能合并完成！新增 ${addedCount} 条`, 'success'); renderVaultList(); switchPage('vault'); });
        } else {
            if (confirm("🚨 警告：覆盖不可逆！确定吗？")) {
                window.currentVault = cloudVault;
                saveToStorage(() => { window.showToast('已使用云端覆盖本地！', 'success'); renderVaultList(); switchPage('vault'); });
            }
        }
      } catch (e) {
        if (e && e.message === 'BACKUP_FORMAT') window.showToast('备份格式无法识别，请重新从原设备上传', 'error');
        else window.showToast('恢复中断：' + (e.message || '代码已损坏或格式错误'), 'error');
      }
  }

  document.getElementById('doImportBtn').addEventListener('click', () => {
    let code = document.getElementById('backupTextarea').value.trim(); 
    processImportCode(code);
  });

  // --- 从文件读取 ---
  const importFileBtn = document.getElementById('importFileBtn');
  const fileInput = document.getElementById('fileInput');
  if (importFileBtn && fileInput) {
    importFileBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(evt) {
          processImportCode(evt.target.result.trim());
          fileInput.value = '';
      };
      reader.readAsText(file);
    });
  }

  // ================= 坚果云 WebDAV =================
  const DEFAULT_WEBDAV = {
    url: 'https://dav.jianguoyun.com/dav/',
    user: '',
    pass: '',
    path: '/boundless/boundless_backup.txt'
  };

  function setWebdavStatus(text, isError = false) {
    const el = document.getElementById('webdavStatus');
    if (!el) return;
    el.innerText = text || '';
    el.style.color = isError ? '#EF4444' : 'var(--text-sub)';
  }

  function getWebdavFormConfig() {
    return {
      url: (document.getElementById('webdavUrlInput')?.value || '').trim() || DEFAULT_WEBDAV.url,
      user: (document.getElementById('webdavUserInput')?.value || '').trim(),
      pass: (document.getElementById('webdavPassInput')?.value || '').trim(),
      path: (document.getElementById('webdavPathInput')?.value || '').trim() || DEFAULT_WEBDAV.path
    };
  }

  function normalizeWebdavBase(url) {
    let base = (url || DEFAULT_WEBDAV.url).trim();
    if (!base.endsWith('/')) base += '/';
    return base;
  }

  function normalizeWebdavPath(path) {
    let p = (path || DEFAULT_WEBDAV.path).trim();
    if (!p.startsWith('/')) p = '/' + p;
    return p;
  }

  function buildWebdavTarget(cfg) {
    const base = normalizeWebdavBase(cfg.url);
    const path = normalizeWebdavPath(cfg.path).replace(/^\/+/, '');
    return new URL(path, base).toString();
  }

  function webdavAuthHeader(user, pass) {
    return 'Basic ' + btoa(unescape(encodeURIComponent(user + ':' + pass)));
  }

  async function ensureWebdavDirs(cfg) {
    const base = normalizeWebdavBase(cfg.url);
    const path = normalizeWebdavPath(cfg.path);
    const parts = path.split('/').filter(Boolean);
    parts.pop(); // 去掉文件名
    let current = base.replace(/\/$/, '');
    for (const part of parts) {
      current += '/' + encodeURIComponent(part);
      try {
        const res = await fetch(current, {
          method: 'MKCOL',
          headers: { 'Authorization': webdavAuthHeader(cfg.user, cfg.pass) }
        });
        if (res.status === 401 || res.status === 403) throw new Error('账号或应用密码错误');
      } catch (e) {
        if (e.message && e.message.includes('账号')) throw e;
        // 目录已存在时常见 405/409，忽略
      }
    }
  }

  async function webdavTest(cfg) {
    if (!cfg.user || !cfg.pass) throw new Error('请先填写账号和应用密码');
    const base = normalizeWebdavBase(cfg.url);
    const res = await fetch(base, {
      method: 'PROPFIND',
      headers: {
        'Authorization': webdavAuthHeader(cfg.user, cfg.pass),
        'Depth': '0'
      }
    });
    if (res.status === 401 || res.status === 403) throw new Error('账号或应用密码错误');
    if (!(res.ok || res.status === 207)) throw new Error('连接失败 (' + res.status + ')');
    return true;
  }

  async function webdavUpload(cfg, content) {
    if (!cfg.user || !cfg.pass) throw new Error('请先填写账号和应用密码');
    await ensureWebdavDirs(cfg);
    const target = buildWebdavTarget(cfg);
    const res = await fetch(target, {
      method: 'PUT',
      headers: {
        'Authorization': webdavAuthHeader(cfg.user, cfg.pass),
        'Content-Type': 'text/plain; charset=utf-8'
      },
      body: content
    });
    if (res.status === 401 || res.status === 403) throw new Error('账号或应用密码错误');
    if (!res.ok && res.status !== 201 && res.status !== 204) throw new Error('上传失败 (' + res.status + ')');
    return true;
  }

  async function webdavDownload(cfg) {
    if (!cfg.user || !cfg.pass) throw new Error('请先填写账号和应用密码');
    const target = buildWebdavTarget(cfg);
    const res = await fetch(target, {
      method: 'GET',
      headers: { 'Authorization': webdavAuthHeader(cfg.user, cfg.pass) }
    });
    if (res.status === 401 || res.status === 403) throw new Error('账号或应用密码错误');
    if (res.status === 404) throw new Error('云端还没有备份文件，请先上传');
    if (!res.ok) throw new Error('拉取失败 (' + res.status + ')');
    return (await res.text()).trim();
  }

  function loadWebdavConfigToForm() {
    chrome.storage.local.get(['webdav_config'], (res) => {
      const cfg = { ...DEFAULT_WEBDAV, ...(res.webdav_config || {}) };
      const urlEl = document.getElementById('webdavUrlInput');
      const userEl = document.getElementById('webdavUserInput');
      const passEl = document.getElementById('webdavPassInput');
      const pathEl = document.getElementById('webdavPathInput');
      if (urlEl) urlEl.value = cfg.url || DEFAULT_WEBDAV.url;
      if (userEl) userEl.value = cfg.user || '';
      if (passEl) passEl.value = cfg.pass || '';
      if (pathEl) pathEl.value = cfg.path || DEFAULT_WEBDAV.path;
      if (cfg.user) setWebdavStatus('已加载坚果云配置：' + cfg.user);
    });
  }

  document.getElementById('saveWebdavBtn')?.addEventListener('click', () => {
    const cfg = getWebdavFormConfig();
    if (!cfg.user || !cfg.pass) return window.showToast('请填写账号和应用密码', 'error');
    chrome.storage.local.set({ webdav_config: cfg }, () => {
      setWebdavStatus('配置已保存');
      window.showToast('坚果云配置已保存', 'success');
    });
  });

  document.getElementById('testWebdavBtn')?.addEventListener('click', async () => {
    const cfg = getWebdavFormConfig();
    const btn = document.getElementById('testWebdavBtn');
    const old = btn.innerText;
    btn.innerText = '测试中...';
    try {
      await webdavTest(cfg);
      chrome.storage.local.set({ webdav_config: cfg });
      setWebdavStatus('连接成功，可以开始同步');
      window.showToast('坚果云连接成功', 'success');
    } catch (e) {
      setWebdavStatus(e.message || '连接失败', true);
      window.showToast(e.message || '连接失败', 'error');
    } finally {
      btn.innerText = old;
    }
  });

  document.getElementById('uploadCloudBtn').addEventListener('click', async () => {
    if (window.currentVault.length === 0) return window.showToast('暂无星辰可同步！', 'error');
    const cfg = getWebdavFormConfig();
    if (!cfg.user || !cfg.pass) return window.showToast('请先填写坚果云账号和应用密码', 'error');
    const btn = document.getElementById('uploadCloudBtn');
    const old = btn.innerText;
    btn.innerText = '上传中...';
    btn.disabled = true;
    setWebdavStatus('正在上传到坚果云...');
    try {
      chrome.storage.local.set({ webdav_config: cfg });
      let exportData;
      if (window.userConfig.useMasterKey) {
        const token = await ensureUnlockToken();
        if (!token) return window.showToast('请先解锁后再上传', 'error');
        const enc = await encryptStr(JSON.stringify(window.currentVault), token);
        const meta = await chrome.storage.local.get(['master_hash', 'user_salt']);
        // 上传必须带 salt，否则别的设备/重装后只能验证密码哈希，无法正确解密
        exportData = btoa(encodeURIComponent(JSON.stringify({
          v: 3,
          hash: meta.master_hash,
          salt: meta.user_salt || null,
          vault: enc
        })));
        await chrome.storage.local.set({ encrypted_vault: enc, unlock_time: Date.now() });
      } else {
        const r = await chrome.storage.local.get(['master_hash', 'encrypted_vault', 'user_salt']);
        exportData = buildExportPayload(r);
      }
      document.getElementById('backupTextarea').value = exportData;
      await webdavUpload(cfg, exportData);
      setWebdavStatus('上传成功：' + normalizeWebdavPath(cfg.path));
      window.showToast('已加密上传到坚果云', 'success');
    } catch (e) {
      setWebdavStatus(e.message || '上传失败', true);
      window.showToast(e.message || '上传失败', 'error');
    } finally {
      btn.innerText = old;
      btn.disabled = false;
    }
  });

  document.getElementById('downloadCloudBtn').addEventListener('click', async () => {
    const cfg = getWebdavFormConfig();
    if (!cfg.user || !cfg.pass) return window.showToast('请先填写坚果云账号和应用密码', 'error');
    const btn = document.getElementById('downloadCloudBtn');
    const old = btn.innerText;
    btn.innerText = '拉取中...';
    btn.disabled = true;
    setWebdavStatus('正在从坚果云拉取...');
    try {
      chrome.storage.local.set({ webdav_config: cfg });
      const data = await webdavDownload(cfg);
      if (!data) throw new Error('云端备份为空');
      document.getElementById('backupTextarea').value = data;
      setWebdavStatus('拉取成功，正在导入...');
      await processImportCode(data);
      setWebdavStatus('拉取并导入完成');
    } catch (e) {
      setWebdavStatus(e.message || '拉取失败', true);
      window.showToast(e.message || '拉取失败', 'error');
    } finally {
      btn.innerText = old;
      btn.disabled = false;
    }
  });

  document.getElementById('webdavConfigToggle')?.addEventListener('click', () => {
    const body = document.getElementById('webdavConfigBody');
    const arrow = document.getElementById('webdavConfigArrow');
    if (body) {
      const isOpen = body.classList.toggle('open');
      if (arrow) arrow.innerText = isOpen ? '▲' : '▼';
    }
  });

  document.getElementById('toggleWebdavEyeBtn')?.addEventListener('click', () => {
    const passEl = document.getElementById('webdavPassInput');
    const btn = document.getElementById('toggleWebdavEyeBtn');
    if (!passEl || !btn) return;
    if (passEl.type === 'password') { passEl.type = 'text'; btn.innerText = '🙈'; }
    else { passEl.type = 'password'; btn.innerText = '👁️'; }
  });

  document.getElementById('showBackupBtn')?.addEventListener('click', () => {
    setTimeout(loadWebdavConfigToForm, 0);
  });
  loadWebdavConfigToForm();

  initSystem();
});
