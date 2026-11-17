// ================= 加密与解密 (V2) =================
const BOUNDLESS_SALT = "boundless_salt_2026";

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

async function getAesKey(pwd) {
    const res = await chrome.storage.local.get(['user_salt']);
    const saltStr = res.user_salt || BOUNDLESS_SALT;
    const keyMat = await crypto.subtle.importKey("raw", new TextEncoder().encode(pwd), {name: "PBKDF2"}, false, ["deriveKey"]);
    return await crypto.subtle.deriveKey({name: "PBKDF2", salt: new TextEncoder().encode(saltStr), iterations: 100000, hash: "SHA-256"}, keyMat, {name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]);
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

async function encryptStr(str, pwd) {
    const key = await getAesKey(pwd);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({name: "AES-GCM", iv}, key, new TextEncoder().encode(str));
    return btoa(JSON.stringify({ v: 2, i: buf2b64(iv), c: buf2b64(cipher) }));
}

// ================= 全局状态 =================
let currentDomain = window.location.hostname;
let isIframe = window.top !== window.self;
let logPrefix = isIframe ? "[无界 🌌 Iframe]" : "[无界 🌌]";
let shadowHost = null;
let shadowRoot = null;
let activeInput = null; 
let currentMatches = []; 
let listenersAttached = false;
let ignoredCredentials = [];

// ================= 🚫 站点禁用（画布 / 本地 HTML / 含密钥页面） =================
// 名单存在 chrome.storage.local 的 disabled_sites，支持三种写法：
//   example.com            域名，同时匹配其所有子域
//   localhost:8080         带端口的主机，精确匹配
//   file:///sdcard/a.html  单个本地文件；只写 file:// 表示禁用全部本地文件
let siteBlocked = true;          // 未知期间先按“禁用”处理：宁可不填，也不要在敏感页抢先注入
let siteKey = '';
let siteDisabledList = [];

function computeSiteKey() {
    try {
        const u = window.location;
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
    if (k.startsWith('file://')) return e === 'file://';        // 只允许整类本地文件
    if (k.includes('://')) return false;                         // 其它协议只做全等比较
    const hostOnly = k.split(':')[0];                            // 去掉端口再比一次
    return k.endsWith('.' + e) || hostOnly === e || hostOnly.endsWith('.' + e);
}

function isKeyDisabled(list, key) {
    return Array.isArray(list) && list.some(entry => siteKeyMatches(entry, key));
}

async function refreshSiteState() {
    siteKey = computeSiteKey();
    let list = [];
    try {
        const res = await chrome.storage.local.get(['disabled_sites']);
        list = Array.isArray(res.disabled_sites) ? res.disabled_sites : [];
    } catch (e) { list = []; }
    siteDisabledList = list;
    siteBlocked = isKeyDisabled(list, siteKey);
    return siteBlocked;
}

function teardownInPageUI() {
    hideShadowUI();
    if (shadowHost) { try { shadowHost.remove(); } catch (e) {} shadowHost = null; shadowRoot = null; }
    if (savePromptHost) { try { savePromptHost.remove(); } catch (e) {} savePromptHost = null; }
    currentMatches = []; activeInput = null;
}

function showPageToast(msg) {
    try {
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;';
        const root = host.attachShadow({ mode: 'closed' });
        root.innerHTML = `<style>
            @keyframes in { from { opacity:0; transform: translateY(10px);} to {opacity:1; transform: translateY(0);} }
            .t { background: rgba(17,24,39,.94); color:#fff; padding:11px 18px; border-radius:100px; font-family:-apple-system,sans-serif; font-size:13px; font-weight:600; box-shadow:0 8px 22px rgba(0,0,0,.22); animation: in .22s ease-out; white-space:nowrap; max-width:82vw; overflow:hidden; text-overflow:ellipsis; }
        </style><div class="t"></div>`;
        root.querySelector('.t').textContent = msg;
        document.documentElement.appendChild(host);
        setTimeout(() => { try { host.remove(); } catch (e) {} }, 2200);
    } catch (e) {}
}

async function disableThisSite() {
    const key = computeSiteKey();
    let list = [];
    try {
        const res = await chrome.storage.local.get(['disabled_sites']);
        list = Array.isArray(res.disabled_sites) ? res.disabled_sites.slice() : [];
    } catch (e) { list = []; }
    if (!isKeyDisabled(list, key)) list.push(key);
    await chrome.storage.local.set({ disabled_sites: list });
    chrome.storage.local.remove('pending_save');
    siteDisabledList = list; siteBlocked = true;
    teardownInPageUI();
    return key;
}

// ================= 智能数据审查与注入 =================
async function hashString(str) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function isValidAccountInput(input) {
    if (!input || input.tagName !== 'INPUT') return false;
    if (input.type === 'password' || input.type === 'email') return true;
    const blockedTypes = ['search', 'button', 'submit', 'radio', 'checkbox', 'file', 'hidden', 'image', 'color', 'date', 'range'];
    if (blockedTypes.includes(input.type)) return false;
    if (input.type === 'text' || input.type === 'tel' || input.type === 'number') {
        let attrs = [(input.id || ''), (input.name || ''), (input.placeholder || ''), (input.className || ''), (input.getAttribute('autocomplete') || '')].join(' ').toLowerCase();
        const blackList = ['search', 'query', 'keyword', 'find', '搜索', '查找', '查询', 'captcha', 'vcode', '验证码', 'comment', 'msg'];
        for (let word of blackList) { if (attrs.includes(word)) return false; }
        const whiteList = ['user', 'login', 'account', 'acc', 'phone', 'member', 'id', 'name', 'mail', 'qq', 'uin', 'mobile'];
        for (let word of whiteList) { if (attrs.includes(word)) return true; }
        if (input.form && input.form.querySelector('input[type="password"]')) return true;
        let parent = input.parentElement; let depth = 0;
        while (parent && depth < 3) {
            if (parent.querySelector('input[type="password"]')) return true;
            parent = parent.parentElement; depth++;
        }
        return false;
    }
    return false;
}

function executeFill(data, targetInput = null) {
    if (siteBlocked) return false;
    let filled = false;
    if (targetInput && isValidAccountInput(targetInput)) {
        if (targetInput.type === 'password' && data.pwd) targetInput.value = data.pwd;
        else if (data.acc) targetInput.value = data.acc;
        targetInput.dispatchEvent(new Event('input', { bubbles: true }));
        filled = true;
        let pwdInput = targetInput.form ? targetInput.form.querySelector('input[type="password"]') : null;
        if (!pwdInput) {
            let allPwdInputs = document.querySelectorAll('input[type="password"]');
            if (allPwdInputs.length > 0) pwdInput = allPwdInputs[0]; 
        }
        if (pwdInput && data.pwd && targetInput !== pwdInput) {
            pwdInput.value = data.pwd;
            pwdInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
    } else {
        let validTextInputs = Array.from(document.querySelectorAll('input')).filter(el => el.type !== 'password' && isValidAccountInput(el));
        let pwdInputs = document.querySelectorAll('input[type="password"]');
        if (validTextInputs.length > 0 && data.acc) {
            validTextInputs[0].value = data.acc;
            validTextInputs[0].dispatchEvent(new Event('input', { bubbles: true })); 
            filled = true;
        }
        if (pwdInputs.length > 0 && data.pwd) {
            pwdInputs[0].value = data.pwd;
            pwdInputs[0].dispatchEvent(new Event('input', { bubbles: true }));
            filled = true;
        }
    }
    return filled;
}

function renderShadowUI(matches) {
    if (siteBlocked) return;
    currentMatches = matches;
    if (shadowHost) shadowHost.remove();
    shadowHost = document.createElement('div');
    shadowHost.id = 'boundless-shadow-host';
    shadowHost.style.cssText = 'position: fixed; z-index: 2147483647; opacity: 0; pointer-events: none; transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1); margin-top: 6px;';
    shadowRoot = shadowHost.attachShadow({mode: 'closed'});
    let htmlContent = `
        <style>
            .b-container { background: rgba(255, 255, 255, 0.95); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border-radius: 14px; padding: 6px; box-shadow: 0 10px 32px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.06); border: 1px solid rgba(229, 231, 235, 0.8); font-family: -apple-system, sans-serif; display: flex; flex-direction: column; gap: 4px; max-height: 240px; overflow-y: auto; overscroll-behavior: contain; width: max-content; min-width: 180px; max-width: 280px; }
            .b-container::-webkit-scrollbar { display: none; }
            .b-item { display: flex; flex-direction: column; padding: 10px 14px; border-radius: 10px; cursor: pointer; transition: 0.15s; }
            .b-item:active { background: rgba(0,0,0,0.06); transform: scale(0.98); }
            .b-acc { font-size: 15px; font-weight: 700; color: #111827; display: flex; align-items: center; gap: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .b-title { font-size: 12px; color: #6B7280; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .b-icon { font-size: 14px; }
            .b-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 4px 8px 6px 10px; border-bottom: 1px dashed rgba(229,231,235,0.9); margin-bottom: 2px; }
            .b-brand { font-size: 11px; font-weight: 700; color: #9CA3AF; letter-spacing: 1px; }
            .b-ban { border: none; background: transparent; color: #9CA3AF; font-size: 14px; line-height: 1; padding: 6px 8px; border-radius: 8px; cursor: pointer; min-width: 30px; min-height: 30px; display: flex; align-items: center; justify-content: center; }
            .b-ban:active { background: rgba(239,68,68,0.1); color: #EF4444; }
        </style>
        <div class="b-container">
            <div class="b-head"><span class="b-brand">🌌 无界</span><button class="b-ban" id="bBanSite" title="本页禁用无界">⛔</button></div>
    `;
    matches.forEach(m => {
        let title = (m.title || '通行证').replace(/</g, '&lt;'); let acc = (m.acc || '********').replace(/</g, '&lt;');
        let isMainIcon = m.isMain ? '<span class="b-icon">📌</span>' : '<span class="b-icon">👤</span>';
        htmlContent += `<div class="b-item" data-id="${m.id}"><div class="b-acc">${isMainIcon}${acc}</div><div class="b-title">${title}</div></div>`;
    });
    htmlContent += `</div>`;
    shadowRoot.innerHTML = htmlContent;
    document.documentElement.appendChild(shadowHost);
    shadowRoot.querySelectorAll('.b-item').forEach(el => {
        el.addEventListener('pointerdown', (e) => {
            e.preventDefault(); let targetData = matches.find(m => m.id === el.getAttribute('data-id'));
            if (targetData) { executeFill(targetData, activeInput); hideShadowUI(); }
        });
    });
    const banBtn = shadowRoot.getElementById('bBanSite');
    if (banBtn) banBtn.addEventListener('pointerdown', async (e) => {
        e.preventDefault(); e.stopPropagation();
        const key = await disableThisSite();
        showPageToast('已为本页禁用无界 · ' + key);
    });
}

function updateShadowPosition() {
    if (!shadowHost || !activeInput) return;
    const rect = activeInput.getBoundingClientRect();
    let left = rect.left; const viewportWidth = window.innerWidth;
    if (left + 200 > viewportWidth) left = Math.max(10, viewportWidth - 210);
    const viewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    let top = rect.bottom;
    if (top + 240 > viewportHeight) {
        top = Math.max(10, rect.top - 245);
    }
    shadowHost.style.top = `${top}px`; shadowHost.style.left = `${left}px`;
}

function showShadowUI(inputEl) {
    if (siteBlocked) return;
    if (shadowHost && inputEl && currentMatches.length > 0) {
        activeInput = inputEl; updateShadowPosition();
        shadowHost.style.opacity = '1'; shadowHost.style.pointerEvents = 'auto';
        window.addEventListener('scroll', updateShadowPosition, {passive: true});
        if (window.visualViewport) { window.visualViewport.addEventListener('resize', updateShadowPosition); window.visualViewport.addEventListener('scroll', updateShadowPosition); }
    }
}

function hideShadowUI() {
    if (shadowHost) {
        shadowHost.style.opacity = '0'; shadowHost.style.pointerEvents = 'none';
        window.removeEventListener('scroll', updateShadowPosition);
        if (window.visualViewport) { window.visualViewport.removeEventListener('resize', updateShadowPosition); window.visualViewport.removeEventListener('scroll', updateShadowPosition); }
    }
}

function attachFocusListeners() {
    if (listenersAttached) return;
    document.body.addEventListener('focusin', (e) => {
        if (siteBlocked) return;
        if (e.target.tagName === 'INPUT' && isValidAccountInput(e.target) && shadowHost) showShadowUI(e.target);
    });
    document.body.addEventListener('focusout', (e) => {
        if (siteBlocked) return;
        if (e.target.tagName === 'INPUT' && shadowHost) setTimeout(() => { if (document.activeElement?.tagName !== 'INPUT') hideShadowUI(); }, 150);
    });
    document.addEventListener('pointerdown', (e) => {
        if (siteBlocked) return;
        if (shadowHost && shadowHost.style.opacity === '1') if (e.target !== activeInput && !e.target.closest('#boundless-shadow-host')) hideShadowUI();
    });
    listenersAttached = true;
}

// ================= ✅ 智能捕获雷达 (防无限弹窗与防抖) =================
let savePromptHost = null;
let lastTypedAcc = '';
let lastTypedPwd = '';

function isSameSite(d1, d2) {
    if (d1 === d2) return true;
    let b1 = d1.split('.').slice(-2).join('.');
    let b2 = d2.split('.').slice(-2).join('.');
    return b1 === b2;
}

function showSavePrompt(acc, pwd) {
    if (siteBlocked) return;
    if (savePromptHost && !document.contains(savePromptHost)) savePromptHost = null;
    if (savePromptHost) return; 
    if (isIframe) {
        window.top.postMessage({ source: 'BOUNDLESS_EXTENSION', action: 'FORWARD_SAVE_PROMPT', acc: acc, pwd: pwd }, '*');
        return;
    }
    
    savePromptHost = document.createElement('div');
    savePromptHost.id = 'boundless-save-prompt';
    savePromptHost.style.cssText = 'position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 2147483647; animation: slideDown 0.3s cubic-bezier(0.16, 1, 0.3, 1); width: 90%; max-width: 320px;';
    
    let root = savePromptHost.attachShadow({mode: 'closed'});
    root.innerHTML = `
        <style>
            @keyframes slideDown { from { transform: translate(-50%, -100%); opacity: 0; } to { transform: translate(-50%, 0); opacity: 1; } }
            @keyframes fadeOut { to { opacity: 0; transform: translate(-50%, -20px); } }
            .box { background: rgba(255, 255, 255, 0.97); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border-radius: 16px; padding: 16px 18px; box-shadow: 0 12px 36px rgba(0,0,0,0.16); border: 1px solid rgba(226, 232, 240, 0.9); font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; flex-direction: column; }
            .title { font-size: 15px; font-weight: 700; color: #0F172A; display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
            .desc { font-size: 12px; color: #64748B; line-height: 1.4; margin-bottom: 12px; }
            .input-group { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
            .input-label { font-size: 11px; color: #475569; font-weight: 600; padding-left: 2px; }
            .input-field { width: 100%; padding: 9px 11px; border-radius: 10px; border: 1px solid #E2E8F0; background: #F8FAFC; font-size: 13px; color: #0F172A; box-sizing: border-box; outline: none; transition: 0.2s; font-family: inherit; }
            .input-field:focus { border-color: #4F46E5; background: #FFFFFF; box-shadow: 0 0 0 3px rgba(79,70,229,0.12); }
            .btns { display: flex; gap: 8px; margin-top: 6px; }
            .btn { flex: 1; padding: 10px; border-radius: 10px; border: none; font-size: 13px; font-weight: 700; cursor: pointer; transition: 0.15s; }
            .btn-save { background: linear-gradient(135deg, #4F46E5 0%, #6366F1 100%); color: white; box-shadow: 0 3px 10px rgba(79,70,229,0.25); }
            .btn-save:active { transform: scale(0.97); }
            .btn-ignore { background: #F1F5F9; color: #475569; }
            .btn-ignore:active { background: #E2E8F0; }
            .btn-ban { margin-top: 8px; background: transparent; border: none; color: #94A3B8; font-size: 11px; font-weight: 600; padding: 6px 0 0; cursor: pointer; }
            .btn-ban:active { color: #EF4444; }
            @media (prefers-color-scheme: dark) {
                .box { background: rgba(30, 41, 59, 0.97); border-color: rgba(51, 65, 85, 0.9); box-shadow: 0 12px 36px rgba(0,0,0,0.45); }
                .title { color: #F8FAFC; }
                .desc, .input-label { color: #94A3B8; }
                .input-field { background: #0F172A; border-color: #334155; color: #F8FAFC; }
                .input-field:focus { background: #1E293B; border-color: #6366F1; }
                .btn-ignore { background: #334155; color: #E2E8F0; }
            }
        </style>
        <div class="box">
            <div class="title"><span>🔑</span> 保存登录信息</div>
            <div class="desc">检测到新的登录凭据，核对后可一键保存：</div>
            <div class="input-group">
                <label class="input-label">网站名称</label>
                <input type="text" id="prompt-title" class="input-field" placeholder="网站名称">
            </div>
            <div class="input-group">
                <label class="input-label">登录账号</label>
                <input type="text" id="prompt-acc" class="input-field" placeholder="未捕获到账号，可手动补全">
            </div>
            <div class="input-group" style="margin-bottom: 10px;">
                <label class="input-label">登录密码</label>
                <input type="text" id="prompt-pwd" class="input-field" placeholder="密码">
            </div>
            <div class="btns">
                <button class="btn btn-ignore" id="ignoreBtn">暂不保存</button>
                <button class="btn btn-save" id="saveBtn">✓ 保存</button>
            </div>
            <button class="btn-ban" id="banSiteBtn">⛔ 本页不再提示（禁用无界）</button>
        </div>
    `;
    document.documentElement.appendChild(savePromptHost);
    
    root.getElementById('prompt-title').value = document.title || currentDomain;
    root.getElementById('prompt-acc').value = acc || '';
    root.getElementById('prompt-pwd').value = pwd || '';

    function destroyPrompt() {
        if (!savePromptHost) return;
        savePromptHost.style.animation = 'fadeOut 0.2s forwards';
        setTimeout(() => { if (savePromptHost) savePromptHost.remove(); savePromptHost = null; }, 200);
    }

    root.getElementById('ignoreBtn').addEventListener('click', async () => {
        chrome.storage.local.remove('pending_save');
        ignoredCredentials.push(await hashString(acc + ':' + pwd)); // 内存拉黑防死循环
        destroyPrompt();
    });

    root.getElementById('banSiteBtn').addEventListener('click', async () => {
        const key = await disableThisSite();
        destroyPrompt();
        showPageToast('已为本页禁用无界 · ' + key);
    });
    
    root.getElementById('saveBtn').addEventListener('click', async () => {
        let btn = root.getElementById('saveBtn');
        btn.innerText = "封存中...";
        let finalTitle = root.getElementById('prompt-title').value.trim();
        let finalAcc = root.getElementById('prompt-acc').value.trim();
        let finalPwd = root.getElementById('prompt-pwd').value.trim();
        if (!finalPwd) { alert("⚠️ 密码不能为空！"); btn.innerText = "✦ 封存入界"; return; }

        try {
            await executeSaveToVault(finalTitle, finalAcc, finalPwd);
            chrome.storage.local.remove('pending_save');
            destroyPrompt();
        } catch (e) {
            if (e.message === "LOCKED") alert("⚠️ 无界处于锁定状态，请先点击浏览器扩展栏图标解锁。");
            else if (e.message === "HTTP_FALLBACK") {
                alert("💡 受系统安全限制，非安全(HTTP)网页密码已暂存。稍后打开【无界】扩展面板时将自动归档。");
                chrome.storage.local.remove('pending_save');
                destroyPrompt();
            } else alert("❌ 封存异常: " + e.message);
            if (btn) btn.innerText = "✦ 封存入界";
        }
    });
}

async function executeSaveToVault(title, acc, pwd) {
    const res = await chrome.storage.local.get(['user_config', 'unlock_token', 'encrypted_vault', 'vault_data']);
    const config = res.user_config || {};
    let vault = [];
    const newItem = { id: Date.now().toString(), domain: currentDomain, url: window.location.href, title: title || currentDomain, acc: acc || '', pwd: pwd, isMain: false };
    
    if (config.useMasterKey !== false) {
        if (!res.unlock_token) throw new Error("LOCKED");
        if (!window.crypto || !window.crypto.subtle) {
            const tempRes = await chrome.storage.local.get(['temp_unencrypted_vault']);
            let tempVault = tempRes.temp_unencrypted_vault || [];
            tempVault.unshift(newItem);
            await chrome.storage.local.set({ temp_unencrypted_vault: tempVault });
            throw new Error("HTTP_FALLBACK");
        }
        const dec = await decryptStr(res.encrypted_vault, res.unlock_token);
        if (dec) vault = JSON.parse(dec);
        newItem.isMain = vault.filter(i => isSameSite(i.domain, currentDomain)).length === 0;
        vault.unshift(newItem);
        const enc = await encryptStr(JSON.stringify(vault), res.unlock_token);
        await chrome.storage.local.set({ encrypted_vault: enc });
    } else {
        vault = res.vault_data || [];
        newItem.isMain = vault.filter(i => isSameSite(i.domain, currentDomain)).length === 0;
        vault.unshift(newItem);
        await chrome.storage.local.set({ vault_data: vault });
    }
}

async function stashPendingSave(acc, pwd) {
    if (siteBlocked) return;
    if (!pwd) return;
    const credHash = await hashString(acc + ':' + pwd);
    if (ignoredCredentials.includes(credHash)) return; // 被拉黑的密码静默拦截

    const res = await chrome.storage.local.get(['user_config', 'vault_data', 'encrypted_vault', 'unlock_token']);
    const config = res.user_config || {};
    if (config.autoSavePrompt === false) return; 
    
    let vault = [];
    if (config.useMasterKey !== false) {
        if (res.unlock_token) {
            const dec = await decryptStr(res.encrypted_vault, res.unlock_token);
            if (dec) vault = JSON.parse(dec);
        } else {
            chrome.storage.local.set({ pending_save: { acc, pwd, domain: currentDomain, time: Date.now() } });
            setTimeout(checkPendingSave, 800); return;
        }
    } else vault = res.vault_data || [];
    
    const exists = vault.some(i => isSameSite(i.domain, currentDomain) && i.pwd === pwd);
    if (exists) { chrome.storage.local.remove('pending_save'); return; }

    chrome.storage.local.set({ pending_save: { acc, pwd, domain: currentDomain, time: Date.now() } });
    setTimeout(checkPendingSave, 800); 
}

async function checkPendingSave() {
    if (siteBlocked) return;
    const res = await chrome.storage.local.get(['pending_save', 'user_config']);
    const config = res.user_config || {};
    if (config.autoSavePrompt === false) return;
    if (res.pending_save) {
        let { acc, pwd, domain, time } = res.pending_save;
        if (Date.now() - time < 600000 && isSameSite(currentDomain, domain)) {
            showSavePrompt(acc, pwd);
        } else if (Date.now() - time >= 600000) {
            chrome.storage.local.remove('pending_save');
        }
    }
}

// 持续跟踪用户键盘操作
document.addEventListener('input', (e) => {
    if (siteBlocked) return;
    if (e.target && e.target.tagName === 'INPUT') {
        if (e.target.type === 'password') {
            lastTypedPwd = e.target.value;
            let textInputs = Array.from(document.querySelectorAll('input')).filter(el => el.type !== 'password' && isValidAccountInput(el));
            if (textInputs.length > 0) lastTypedAcc = textInputs[0].value;
        } else if (isValidAccountInput(e.target)) {
            lastTypedAcc = e.target.value;
        }
    }
}, true);

function attemptCapture() {
    if (siteBlocked) return;
    let pwdInputs = document.querySelectorAll('input[type="password"]');
    let pwdToSave = (pwdInputs.length > 0 && pwdInputs[0].value) ? pwdInputs[0].value : lastTypedPwd;
    if (!pwdToSave) return;
    let textInputs = Array.from(document.querySelectorAll('input')).filter(el => el.type !== 'password' && isValidAccountInput(el));
    let accToSave = (textInputs.length > 0 && textInputs[0].value) ? textInputs[0].value : lastTypedAcc;
    stashPendingSave(accToSave, pwdToSave);
}

// 智能按键与触屏拦截
document.addEventListener('pointerdown', (e) => {
    if (siteBlocked) return;
    let target = e.target;
    if (!target) return;
    let tagName = target.tagName.toUpperCase();
    let isButtonLike = tagName === 'BUTTON' || 
                       (tagName === 'INPUT' && ['submit', 'button'].includes(target.type)) ||
                       target.getAttribute('role') === 'button' ||
                       target.classList.contains('btn') || 
                       target.classList.contains('button') ||
                       /login|submit|sign|click|登录|登入|提交|确定|进入/i.test(target.className + ' ' + target.id + ' ' + target.innerText);
    if (isButtonLike) attemptCapture();
}, true);

document.addEventListener('keydown', (e) => { if (e.key === 'Enter') attemptCapture(); }, true);
document.addEventListener('submit', () => { attemptCapture(); }, true);

// ================= 初始化 =================
async function initBoundless() {
    console.log(`${logPrefix} 初始化环境就绪.`);
    // 站点禁用优先：命中禁用名单就彻底不动这个页面
    if (await refreshSiteState()) {
        teardownInPageUI();
        console.log(`${logPrefix} 本页已在禁用名单中（${siteKey}），跳过注入.`);
        return;
    }
    const res = await chrome.storage.local.get(['user_config', 'unlock_token', 'unlock_time', 'encrypted_vault', 'vault_data']);
    const config = res.user_config || {};
    if (config.autoFill === false) { hideShadowUI(); currentMatches = []; return; }
    let vault = [];
    if (config.useMasterKey !== false) {
        let isSessionValid = false; let now = Date.now();
        let timeoutConfig = config.lockTimeout !== undefined ? config.lockTimeout : 30;
        if (timeoutConfig === -1) isSessionValid = true;
        else if (timeoutConfig === 0) isSessionValid = res.unlock_token && res.unlock_time && (now - res.unlock_time < 15 * 1000);
        else if (timeoutConfig > 0) isSessionValid = res.unlock_token && res.unlock_time && (now - res.unlock_time < timeoutConfig * 60 * 1000);
        if (isSessionValid) {
            if (timeoutConfig > 0 && (now - res.unlock_time > 60000)) chrome.storage.local.set({ unlock_time: now });
            const dec = await decryptStr(res.encrypted_vault, res.unlock_token);
            if (dec) vault = JSON.parse(dec);
        } else { hideShadowUI(); currentMatches = []; return; } 
    } else vault = res.vault_data || [];

    let matchedDataList = vault.filter(item => isSameSite(item.domain, currentDomain) && (item.acc || item.pwd));
    if (matchedDataList.length > 0) {
        renderShadowUI(matchedDataList); attachFocusListeners();
        let mainData = matchedDataList.find(m => m.isMain) || matchedDataList[0]; let activeEl = document.activeElement;
        if (!(activeEl && activeEl.tagName === 'INPUT' && isValidAccountInput(activeEl))) {
            if (!executeFill(mainData)) {
                let observer = new MutationObserver((mutations, obs) => { if (executeFill(mainData)) obs.disconnect(); });
                observer.observe(document.body, { childList: true, subtree: true }); setTimeout(() => observer.disconnect(), 3000); 
            }
        }
    } else { hideShadowUI(); currentMatches = []; }
    checkPendingSave();
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
        if (changes.disabled_sites) {
            refreshSiteState().then(blocked => {
                console.log(`${logPrefix} 禁用名单变化，本页当前状态：${blocked ? '已禁用' : '已启用'}`);
                if (blocked) teardownInPageUI(); else initBoundless();
            });
        }
        if (changes.unlock_time && (changes.unlock_time.newValue - (changes.unlock_time.oldValue || 0) > 2000)) initBoundless();
        if (changes.vault_data || changes.encrypted_vault || changes.user_config) initBoundless();
    }
});

window.addEventListener('message', (event) => {
    if (event.data && event.data.source === 'BOUNDLESS_EXTENSION' && event.data.action === 'FORWARD_SAVE_PROMPT') {
        if (!isIframe) stashPendingSave(event.data.acc, event.data.pwd);
    }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "FORCE_FILL_INJECT") {
        if (siteBlocked) { sendResponse({status: "blocked"}); return; }
        let target = document.activeElement; if (!target || target.tagName !== 'INPUT' || !isValidAccountInput(target)) target = null;
        executeFill(request.data, target); sendResponse({status: "success"});
    }
});

initBoundless();
