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

  const pages = { 'lock': document.getElementById('pageLock'), 'vault': document.getElementById('pageVault'), 'form': document.getElementById('pageForm'), 'backup': document.getElementById('pageBackup'), 'settings': document.getElementById('pageSettings') };
  let currentNavTarget = 'vault'; 

  function switchPage(pageKey, title = "", skipVibrate = false) {
    if (!skipVibrate) tick(); 
    Object.values(pages).forEach(p => p.classList.remove('active'));
    pages[pageKey].classList.add('active');
    // 切页时回到顶部，并确保 body 可滚动（部分安卓 WebView 需要强制刷新）
    try {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      document.body.style.overflowY = 'auto';
      document.documentElement.style.overflowY = 'auto';
    } catch (e) {}

    if (pageKey === 'vault' || pageKey === 'lock') {
      document.getElementById('mainHeader').style.display = 'flex';
      document.getElementById('formHeader').style.display = 'none';
      document.getElementById('manualLockBtn').style.display = (pageKey === 'vault' && window.userConfig.useMasterKey) ? 'block' : 'none';
      document.getElementById('goSettingsBtn').style.display = (pageKey === 'vault') ? 'block' : 'none';
    } else {
      document.getElementById('mainHeader').style.display = 'none';
      document.getElementById('formHeader').style.display = 'flex';
      document.getElementById('topFormTitle').innerText = title;
    }
    if (pageKey !== 'vault') document.getElementById('searchInput').value = '';
  }

  document.getElementById('backBtn').addEventListener('click', () => {
    if (currentNavTarget === 'vault') renderVaultList(); 
    switchPage(currentNavTarget);
  });

  function escapeHTML(str) { return (!str) ? '' : str.replace(/[&<>'"]/g, t => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[t] || t)); }
  function getAvatarHtml(title) {
    let cleanStr = (title || 'A').replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, ''); let char = cleanStr.charAt(0) ? cleanStr.charAt(0).toUpperCase() : '✦';
    let colors = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#f43f5e'];
    return `<div style="display:flex; width:46px; height:46px; background-color:${colors[(char.charCodeAt(0)||0)%colors.length]}; color:#fff; align-items:center; justify-content:center; font-size:22px; font-weight:bold; border-radius:14px; flex-shrink:0; margin-right:14px;">${char}</div>`;
  }

  // ================= 🌐 当前网页 启用 / 禁用 =================
  const siteBar = document.getElementById('siteBar');
  const siteBarHost = document.getElementById('siteBarHost');
  const siteBarIcon = document.getElementById('siteBarIcon');
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
      siteBarHost.innerText = currentSiteKey;
      siteToggleBtn.innerText = blocked ? '✅ 恢复启用' : '🚫 本页禁用';
      siteToggleBtn.classList.toggle('on', !blocked);
    } catch (e) { siteBar.style.display = 'none'; }
  }

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
      box.innerHTML = '<div style="font-size:12px;color:var(--text-sub);padding:2px 0;line-height:1.6;">还没有禁用任何网站。<br>在首页顶部点「🚫 本页禁用」即可加入。</div>';
      return;
    }
    box.innerHTML = data.map(k => `
      <div class="site-item">
        <div class="s-key">${escapeHTML(k)}</div>
        <button class="icon-btn s-remove" data-key="${escapeHTML(k)}">✕</button>
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
        authMode = 'unlock'; lockTitle.innerText = "✦ 验证身份"; lockDesc.innerText = "请输入主控秘钥解锁您的星图"; cancelLockBtn.style.display = 'none'; switchPage('lock', '', true);
      } else {
        authMode = 'setup'; window.currentVault = res.vault_data || []; 
        lockTitle.innerText = "✦ 初始化保护"; lockDesc.innerHTML = "首次启用，请设置主控秘钥<br>⚠️ 离线加密机制，遗忘无法找回！"; cancelLockBtn.style.display = 'none'; switchPage('lock', '', true);
      }
    });
  }

  unlockBtn.addEventListener('click', async () => {
    let pwd = masterPwdInput.value.trim(); if (!pwd) return window.showToast('秘钥不能为空', 'error');
    unlockBtn.innerText = "处理中...";
    if (authMode === 'setup' || authMode === 'turn_on') {
      // 仅首次初始化时生成随机盐；已有盐绝不覆盖，防止旧密文无法解密
      const saltRes = await chrome.storage.local.get(['user_salt']);
      if (!saltRes.user_salt) {
        const randomSalt = crypto.getRandomValues(new Uint8Array(16));
        await chrome.storage.local.set({ user_salt: buf2b64(randomSalt) });
      }
      let hash = await hashPwd(pwd); let enc = await encryptStr(JSON.stringify(window.currentVault), pwd);
      window.userConfig.useMasterKey = true; saveConfig();
      chrome.storage.local.set({ master_hash: hash, encrypted_vault: enc, unlock_token: pwd, unlock_time: Date.now() }, () => {
        chrome.storage.local.remove('vault_data'); window.unlockToken = pwd; masterPwdInput.value = ''; unlockBtn.innerText = "确认";
        if (authMode === 'turn_on') { renderSettings(); switchPage('settings', '⚙️ 星图枢纽'); } else { renderVaultList(); switchPage('vault'); }
      });
    } else {
      let hash = await hashPwd(pwd);
      chrome.storage.local.get(['master_hash', 'encrypted_vault'], async (res) => {
        if (res.master_hash === hash) {
          if (authMode === 'turn_off') {
            window.userConfig.useMasterKey = false; saveConfig();
            chrome.storage.local.set({ vault_data: window.currentVault }, () => {
              chrome.storage.local.remove(['encrypted_vault', 'master_hash', 'unlock_token', 'unlock_time']);
              window.unlockToken = null; masterPwdInput.value = ''; unlockBtn.innerText = "确认"; renderSettings(); switchPage('settings', '⚙️ 星图枢纽');
            });
          } else {
            let dec = await decryptStr(res.encrypted_vault, pwd); window.unlockToken = pwd; window.currentVault = JSON.parse(dec || "[]");
            chrome.storage.local.set({ unlock_token: pwd, unlock_time: Date.now() }); 
            checkAndMergeTempVault(); 
            masterPwdInput.value = ''; unlockBtn.innerText = "确认"; renderVaultList(); switchPage('vault');
          }
        } else { window.showToast('秘钥错误', 'error'); unlockBtn.innerText = "确认"; }
      });
    }
  });

  cancelLockBtn.addEventListener('click', () => { masterPwdInput.value = ''; unlockBtn.innerText = "确认"; renderSettings(); switchPage('settings', '⚙️ 星图枢纽'); });
  document.getElementById('manualLockBtn').addEventListener('click', () => { window.unlockToken = null; window.currentVault = []; chrome.storage.local.remove(['unlock_token', 'unlock_time'], () => { tick(); initSystem(); }); });

  document.getElementById('goSettingsBtn').addEventListener('click', () => { currentNavTarget = 'vault'; renderSettings(); switchPage('settings', '⚙️ 星图枢纽'); });
  const tgMaster = document.getElementById('toggleMasterKey'); const selTimeout = document.getElementById('selectLockTimeout'); const tgAuto = document.getElementById('toggleAutoFill'); const tgAutoSave = document.getElementById('toggleAutoSave');
  function renderSettings() { 
      tgMaster.checked = window.userConfig.useMasterKey; selTimeout.value = window.userConfig.lockTimeout; 
      tgAuto.checked = window.userConfig.autoFill; 
      tgAutoSave.checked = window.userConfig.autoSavePrompt !== false; 
      selTimeout.disabled = !window.userConfig.useMasterKey; 
      renderDisabledSites();
  }
  tgAuto.addEventListener('change', () => { window.userConfig.autoFill = tgAuto.checked; saveConfig(); });
  tgAutoSave.addEventListener('change', () => { window.userConfig.autoSavePrompt = tgAutoSave.checked; saveConfig(); });
  selTimeout.addEventListener('change', () => { window.userConfig.lockTimeout = parseInt(selTimeout.value); saveConfig(); });
  tgMaster.addEventListener('click', (e) => {
    e.preventDefault(); 
    if (window.userConfig.useMasterKey) { authMode = 'turn_off'; lockTitle.innerText = "关闭安全护盾"; lockDesc.innerText = "请输入当前主控秘钥以关闭保护并解密数据"; cancelLockBtn.style.display = 'block'; switchPage('lock'); } 
    else { authMode = 'turn_on'; lockTitle.innerText = "启用安全护盾"; lockDesc.innerHTML = "请设置主控秘钥<br>您的现有星图数据将立即被加密保护"; cancelLockBtn.style.display = 'block'; switchPage('lock'); }
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
      let badge = (item.acc || item.pwd) ? `<span class="badge pwd">🔑 通行证</span>` : `<span class="badge bm">⭐ 星标</span>`;
      let ah = sa ? `<div class="acc-text">账号: <span>${sa}</span></div>` : '<div class="acc-text">（星标网址）</div>';
      let ph = sp ? `<div class="detail-line" style="display:flex; align-items:center;">密钥: <span style="margin-left:4px; font-family:monospace; color:var(--text-main);">••••••••</span><button class="icon-btn copy-btn" data-pwd="${sp}" style="width:32px; height:32px; font-size:14px; margin-left:8px; background:rgba(99,102,241,0.1); border:none; border-radius:8px;">📋</button></div>` : '';
      let isMainClass = item.isMain ? 'is-main' : '';
      let btnMainClass = item.isMain ? 'active' : '';
      let btnMainHtml = (item.acc || item.pwd) ? `<button class="icon-btn btn-main ${btnMainClass}" data-id="${item.id}" title="设为默认主星">★</button>` : '';
      let injectHtml = (isCurrentTab && (item.acc || item.pwd)) ? `<button class="icon-btn btn-inject" data-id="${item.id}" title="强制注入当前网页">🚀</button>` : '';
      let editHtml = `<button class="icon-btn btn-edit" data-id="${item.id}" title="编辑 / 抹除">🪄</button>`;
      
      let subClass = isSubItem ? 'sub-item' : '';
      let avatarHtml = !isSubItem ? getAvatarHtml(ds) : '';
      let expandedClass = (isCurrentTab && !isSubItem) ? 'expanded' : '';

      return `
      <div class="item-card ${isMainClass} ${subClass} ${expandedClass}" data-id="${item.id}">
          <div class="item-header">${avatarHtml}<div class="info"><div class="title">${ds} ${badge}</div>${ah}</div><div class="expand-arrow">▼</div></div>
          <div class="item-body">${ph}<div class="detail-line" style="font-size: 11px; margin-top: 6px; color: #9CA3AF;">${su}</div><div class="action-icons">${btnMainHtml}${injectHtml}${editHtml}</div></div>
      </div>`;
  }

  function renderGroupHtml(domain, items, isCurrentTab = false) {
      if (items.length === 1) return renderItemHtml(items[0], isCurrentTab);
      let firstItem = items[0]; let groupTitle = escapeHTML(domain || firstItem.title || '聚合账号');
      let expandedClass = isCurrentTab ? 'expanded' : ''; 
      let html = `<div class="group-card ${expandedClass}"><div class="group-header">${getAvatarHtml(groupTitle)}<div class="info"><div class="title">${groupTitle} <span class="badge bm" style="background:#F3F4F6;color:#6B7280;">📦 ${items.length} 个账号</span></div><div class="acc-text" style="color: #9CA3AF; font-size: 11px;">点击展开 / 折叠</div></div><div class="expand-arrow">▼</div></div><div class="group-body">`;
      items.forEach(item => { html += renderItemHtml(item, isCurrentTab, true); }); html += `</div></div>`;
      return html;
  }

  function groupItemsByDomain(items) {
      let groups = {};
      items.forEach(item => { let key = item.domain || 'other'; if (!groups[key]) groups[key] = []; groups[key].push(item); });
      return Object.values(groups); 
  }

  async function renderVaultList(filterText = '') {
    vaultList.innerHTML = ''; currentTabVaultList.innerHTML = ''; searchBox.style.display = window.currentVault.length > 0 ? 'block' : 'none';
    if (window.currentVault.length === 0) return vaultList.innerHTML = `
        <div style="text-align:center; color:#9CA3AF; margin-top:60px;">
            <div style="font-size: 64px; margin-bottom: 16px; opacity: 0.8;">🌌</div>
            <div style="font-size:16px; font-weight:bold; color:var(--text-main); margin-bottom:8px;">星海浩瀚，此刻无界</div>
            <div style="font-size:13px; line-height: 1.6;">点击下方的「✦ 凝结此刻」<br>开始镌刻您的第一枚星辰吧</div>
        </div>`;
    
    let currentDomain = "";
    try {
        let tab = await getActiveTabSafely();
        if (tab && tab.url) { activeTabId = tab.id; activeTabUrl = tab.url; currentDomain = new URL(tab.url).hostname; }
    } catch(e) {}

    let matchesCurrent = []; let others = []; let lower = filterText.toLowerCase();
    
    window.currentVault.forEach(item => {
      let isMatchSearch = !filterText || ((item.title && item.title.toLowerCase().includes(lower)) || (item.url && item.url.toLowerCase().includes(lower)) || (item.acc && item.acc.toLowerCase().includes(lower)));
      if (isMatchSearch) { if (!filterText && currentDomain && (currentDomain === item.domain || currentDomain.endsWith('.' + item.domain))) matchesCurrent.push(item); else others.push(item); }
    });

    if (matchesCurrent.length === 0 && others.length === 0) return vaultList.innerHTML = '<div style="text-align:center; color:#9CA3AF; margin-top:40px; font-size:14px;">未搜索到相关星辰...</div>';
    let currentTabGroups = groupItemsByDomain(matchesCurrent); let otherGroups = groupItemsByDomain(others);

    // 一次性拼接后写入，避免循环 innerHTML += 造成多次回流
    if (currentTabGroups.length > 0) {
        let html = `<div class="section-title">✨ 匹配当前网页</div>`;
        currentTabGroups.forEach(group => { html += renderGroupHtml(group[0].domain, group, true); });
        currentTabVaultList.innerHTML = html;
    }
    if (otherGroups.length > 0) {
        let html = currentTabGroups.length > 0 ? `<div class="section-title" style="margin-top: 10px;">📦 全部资产</div>` : '';
        otherGroups.forEach(group => { html += renderGroupHtml(group[0].domain, group, false); });
        vaultList.innerHTML = html;
    }
  }
  // 搜索节流，避免每敲一字都全量重渲导致滚动/输入卡顿
  let searchTimer = null;
  searchInput.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderVaultList(val), 120);
  });

  // --- 密码小眼睛 ---
  const toggleEyeBtn = document.getElementById('toggleEyeBtn');
  const pwdInput = document.getElementById('pwdInput');
  if (toggleEyeBtn && pwdInput) {
      toggleEyeBtn.addEventListener('click', (e) => {
          e.preventDefault();
          if (pwdInput.type === 'password') {
              pwdInput.type = 'text';
              toggleEyeBtn.innerText = '🙈';
          } else {
              pwdInput.type = 'password';
              toggleEyeBtn.innerText = '👁️';
          }
      });
  }

  // ================= 动作代理 =================
  document.getElementById('pageVault').addEventListener('click', (e) => {
    let itemHeader = e.target.closest('.item-header');
    if (itemHeader) { tick(); itemHeader.parentElement.classList.toggle('expanded'); return; }
    
    let groupHeader = e.target.closest('.group-header');
    if (groupHeader) { tick(); groupHeader.parentElement.classList.toggle('expanded'); return; }

    let copyBtn = e.target.closest('.copy-btn');
    if (copyBtn) { e.stopPropagation(); navigator.clipboard.writeText(copyBtn.getAttribute('data-pwd')).then(() => { successVibrate(); copyBtn.innerText = '✅'; window.showToast('密钥已复制', 'success'); setTimeout(() => copyBtn.innerText = '📋', 1500); }); return; }
    
    let editBtn = e.target.closest('.btn-edit');
    if (editBtn) {
        let item = window.currentVault.find(x => x.id === editBtn.getAttribute('data-id'));
        if(item) { 
            editingId = item.id; 
            document.getElementById('titleInput').value = item.title || ''; 
            document.getElementById('urlInput').value = item.url || ''; 
            document.getElementById('accInput').value = item.acc || ''; 
            document.getElementById('pwdInput').value = item.pwd || ''; 
            document.getElementById('pwdInput').type = 'password';
            if (document.getElementById('toggleEyeBtn')) document.getElementById('toggleEyeBtn').innerText = '👁️';
            document.getElementById('deleteBtn').style.display = 'block'; 
            currentNavTarget = 'vault'; 
            switchPage('form', '🪄 修正星迹'); 
        }
        return;
    }

    let mainBtn = e.target.closest('.btn-main');
    if (mainBtn) {
        e.stopPropagation(); tick(); let targetItem = window.currentVault.find(x => x.id === mainBtn.getAttribute('data-id'));
        if (targetItem) {
            window.currentVault.forEach(item => { if (item.domain === targetItem.domain) item.isMain = false; });
            targetItem.isMain = !mainBtn.classList.contains('active'); saveToStorage(() => renderVaultList(searchInput.value.trim()));
        } return;
    }

    let injectBtn = e.target.closest('.btn-inject');
    if (injectBtn && activeTabId) {
        e.stopPropagation(); successVibrate();
        if (!activeTabUrl || activeTabUrl.match(/^(chrome|chrome-extension|edge|about|kiwi):/i)) return window.showToast("安全限制拦截：无法在扩展管理页或空白页中注入。", "error");
        let targetItem = window.currentVault.find(x => x.id === injectBtn.getAttribute('data-id'));
        if (targetItem) {
            injectBtn.innerText = '✅';
            chrome.tabs.sendMessage(activeTabId, {action: "FORCE_FILL_INJECT", data: targetItem}, (response) => {
                if (chrome.runtime.lastError) {
                    window.showToast("页面未完全加载或受保护", "error");
                    injectBtn.innerText = '🚀';
                } else { setTimeout(() => window.close(), 400); }
            });
        }
    }
  });

  // ================= 增删查改 =================
  document.getElementById('showFormBtn').addEventListener('click', async () => {
    editingId = null; document.getElementById('deleteBtn').style.display = 'none'; 
    try { 
        let tab = await getActiveTabSafely(); 
        document.getElementById('titleInput').value = tab?.title || ''; 
        document.getElementById('urlInput').value = tab?.url || ''; 
    } catch (e) { document.getElementById('titleInput').value = ''; document.getElementById('urlInput').value = ''; }
    document.getElementById('accInput').value = ''; 
    document.getElementById('pwdInput').value = ''; 
    document.getElementById('pwdInput').type = 'password';
    if (document.getElementById('toggleEyeBtn')) document.getElementById('toggleEyeBtn').innerText = '👁️';
    currentNavTarget = 'vault'; switchPage('form', '✦ 凝结资产');
  });

  document.getElementById('saveBtn').addEventListener('click', () => {
    let rawUrl = document.getElementById('urlInput').value.trim(); if (!rawUrl) return window.showToast('漫游网址为必填项！', 'error');
    if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) rawUrl = 'https://' + rawUrl;
    let domain = ''; try { domain = new URL(rawUrl).hostname; } catch(e) { return window.showToast('网址格式错误', 'error'); }
    
    let isMainFlag = false;
    if (!editingId) { let hasMain = window.currentVault.some(i => i.domain === domain && i.isMain); isMainFlag = !hasMain && (document.getElementById('accInput').value.trim() !== ""); }
    let newItem = { id: editingId || Date.now().toString(), domain: domain, url: rawUrl, title: document.getElementById('titleInput').value.trim() || domain, acc: document.getElementById('accInput').value.trim(), pwd: document.getElementById('pwdInput').value.trim() };
    
    if (editingId) { let idx = window.currentVault.findIndex(i => i.id === editingId); if (idx > -1) { newItem.isMain = window.currentVault[idx].isMain; window.currentVault[idx] = newItem; } } 
    else { newItem.isMain = isMainFlag; window.currentVault.unshift(newItem); }
    saveToStorage(() => {
      successVibrate();
      window.showToast(editingId ? '星迹已更新' : '星辰已封存', 'success');
      document.getElementById('searchInput').value = '';
      renderVaultList();
      switchPage('vault');
    });
  });

  document.getElementById('deleteBtn').addEventListener('click', () => {
    if(!editingId || !confirm("确定要抹除这条记录吗？")) return; 
    window.currentVault = window.currentVault.filter(i => i.id !== editingId); 
    saveToStorage(() => { tick(); document.getElementById('searchInput').value = ''; renderVaultList(); switchPage('vault'); });
  });

  // ================= 备份与导入 =================
  document.getElementById('showBackupBtn').addEventListener('click', () => { 
    document.getElementById('backupTextarea').value = ''; 
    document.getElementById('backupTip').innerHTML = window.userConfig.useMasterKey ? "系统已开启护盾。请妥善保存星图代码，恢复时需使用当前的【主控秘钥】验证。" : "⚠️ 护盾未开启，数据以明文导出。请将代码保存在安全的地方。";
    currentNavTarget = 'vault'; switchPage('backup', '✧ 星图备份'); 
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

  document.getElementById('showBackupBtn')?.addEventListener('click', () => {
    setTimeout(loadWebdavConfigToForm, 0);
  });
  loadWebdavConfigToForm();

  initSystem();
});
