# 无界 (Boundless) v7.3.4 — 雨见浏览器扩展源码包

从 **雨见浏览器(c)**（包名 `com.yjllq.chrome.beta`，版本 `8.0.5.3` / versionCode `1050`）里提取的「无界」扩展，已整理为可直接修改的工程目录。

- 提取时间：2026-11-13
- 原始路径（App 私有目录，需 root）：
  `/data/data/com.yjllq.chrome.beta/app_chrome/Default/UnpackedExtensions/密码箱拓展_NP0AJV/`
  （终端里读不到 `/data/data/xxx`，用 `/proc/1/root/data/data/...` 可绕过命名空间限制）
- 安装形态：**已解压扩展**（Preferences 里 `location: 4`），不是 crx
- 扩展 ID：`ccgoeefbkokagomicodphmepbgigbcnb`

> ⚠️ 关键：解压扩展的 ID 是**由绝对路径哈希出来的**。目录名或路径一改，ID 就变，`chrome.storage.local` 里的数据（加密星图、主控秘钥盐、配置）就会"失联"。
> 所以部署时必须保持原路径 + 原目录名 `密码箱拓展_NP0AJV`，否则请先导出「星图代码」备份再用新 ID 导入。

## ✨ 本次改造：按站点禁用（v7.3.5）

原来只能全局开关：一旦打开某个含密钥的画布 / 本地 HTML，扩展每次都会注入、自动填充，还会弹「凝结新星辰」，得手动点掉或等它自己消失。现在改成**按站点禁用**：

- **首页顶部新增一条「当前网页」状态条**：显示当前站点（含端口），右侧一键 `🚫 本页禁用` / `✅ 恢复启用`，即时生效（写完 storage 后 content script 立刻收到 `onChanged` 并拆掉页面里的浮层）。
- **页面内两个快捷入口**：
  - 账号选择浮层右上角的 `⛔`；
  - 「凝结新星辰」弹窗底部的「⛔ 本页不再提示（禁用无界）」。
  两者都会把当前站点写进禁用名单并立刻关闭弹窗，附一个页面内小 toast 提示。
- **设置页新增「🚫 已禁用的网站」**：列出名单，逐条 ✕ 恢复。
- **禁用后行为**：不自动填充、不浮出选择框、不检测输入、不弹保存提示、不响应强制注入（`FORCE_FILL_INJECT` 返回 `blocked`），连监听器都直接 return，等于这个页面上「不存在」。
- 新增 storage 键 `disabled_sites: string[]`。

### 名单写法（三档粒度）

| 写法 | 匹配范围 |
| --- | --- |
| `example.com` | 该域名及其所有子域（`a.example.com` 也命中） |
| `localhost:8080` | 带端口精确匹配；写 `localhost` 也能命中任意端口 |
| `file:///storage/emulated/0/x/画布.html` | 单个本地文件（自动按 tab 的 URL 生成） |
| `file://` | 懒人档：禁用**全部**本地文件页面 |

> 本地 HTML 的 `hostname` 是空串，所以这里用 `file://` + pathname 当键；同一个 canvas 换个目录就是另一个键，需要单独禁用。

## 目录说明

| 目录 | 用途 |
| --- | --- |
| `无界/` | **工作副本**，改这里 |
| `备份_原版/` | 提取时的原始版本，回滚用（勿改） |
| `备份_扩展数据/` | 扩展 `chrome.storage.local` 的 LevelDB 快照（加密星图 + 配置，无明文密码） |
| `deploy.sh` | 把 `无界/` 推回浏览器扩展目录（或 `--restore` 回滚原版） |

## 文件结构（v7.3.5 共 1948 行）

```
manifest.json   MV3；无 background，权限 tabs/activeTab/storage/unlimitedStorage
                        host_permissions: https://dav.jianguoyun.com/*
                        content_scripts: <all_urls> + all_frames，document_end
popup.html     22 KB    330 行，单页多面板（站点条 / vault / 编辑 / 备份导入 / WebDAV / 设置）
popup.js       51 KB   1028 行，全部业务逻辑（加密、解锁、列表渲染、导入导出、WebDAV、站点禁用）
content.js     26 KB    590 行，注入页面：站点闸门 + 自动填充 + 保存提示（Shadow DOM）
icon_{16,48,128}.png
```

## 核心逻辑速查（popup.js）

| 位置 | 作用 |
| --- | --- |
| L1-48 | 加密原语：`buf2b64/b642buf`、`hashPwd`（PBKDF2-SHA256 10 万次 → AES-GCM-256）、`encryptStr/decryptStr`（base64(iv‖密文)） |
| L3 | `DEFAULT_CONFIG = {useMasterKey:true, lockTimeout:30, autoFill:true, autoSavePrompt:true}` |
| L53-171 | 取当前标签页、`ensureUnlockToken()` 会话有效期判定（lockTimeout: -1 永久 / 0 仅 15 秒 / N 分钟） |
| L171-195 | `saveToStorage()`：加密写回 `encrypted_vault`（关护盾时写明文 `vault_data`） |
| L195-219 | `checkAndMergeTempVault()`：合并 content.js 暂存的 `temp_unencrypted_vault` |
| L355-391 | `renderVaultList()`：按当前域名分组（"匹配当前网页" / "全部资产"），搜索节流 120ms |
| L512-739 | 备份 / 导入：导出「星图代码」，`processImportCode()` 用自带 salt 优先、再试本地 salt、最后旧固定 salt |
| L581-601 | `decryptVaultWithFallback()` 三级 salt 回退（跨设备/重装容错） |
| L739-920 | WebDAV：`ensureWebdavDirs / webdavTest / webdavUpload / webdavDownload`（坚果云） |

### 数据模型

storage key：

```
user_salt              随机盐（base64），旧版回退 "boundless_salt_2026"
master_hash            主控秘钥的哈希（用于校验）
encrypted_vault        AES-GCM 密文（base64(iv‖cipher)）
vault_data             明文星图（仅在关闭护盾时）
unlock_token           本次会话秘钥（临时）
unlock_time            解锁时间戳
user_config            见 DEFAULT_CONFIG
webdav_config          {url, user, pass...}
disabled_sites         站点禁用名单（域名 / host:port / file://路径），v7.3.5 新增
pending_save           content.js 捕获到但尚未入柜的账号
temp_unencrypted_vault 待合并的明文条目
```

星图条目：

```js
{ id, domain, url, title, acc, pwd, isMain }
```

### content.js 行为

- `attachFocusListeners()`：聚焦账号/密码框时在输入框下方浮出「无界」胶囊（Shadow DOM，`showShadowUI`）
- `executeFill()`：选中条目后直接写入 input 并派发 input/change 事件
- `attemptCapture()` + `showSavePrompt()`：提交/回车时提示"是否凝结此刻"，`stashPendingSave()` 暂存，popup 打开后合并
- `postMessage({source:'BOUNDLESS_EXTENSION', ...})`：跨 iframe 把保存事件转发给顶层

## 修改 → 部署 → 验证

```sh
# 1) 改 无界/ 里的文件（注意 JSON 别多逗号）
# 2) 语法自检
python3 -c "import json;json.load(open('无界/manifest.json'))"
node --check 无界/popup.js 2>/dev/null || echo "无 node，跳过"

# 3) 推回浏览器（root 终端执行）
sh deploy.sh

# 4) 重启雨见浏览器（或关闭其所有进程），扩展才会重新加载

# 回滚
sh deploy.sh --restore
```

`deploy.sh` 做的事：把 `无界/*` 覆盖到 `密码箱拓展_NP0AJV/`，`chown u0_a491:u0_a491`、文件 600 / 目录 700（浏览器以该 uid 运行，权限不对会加载失败）。

## 待扩展时可留意的点

- 目前**没有 background service worker**：想加定时同步、跨页状态、右键菜单、omnibox，得新增 `background.js` 并在 manifest 里声明。
- `content_scripts` 是 `<all_urls>` + `all_frames`：注入面很大，改 content.js 要顾及 iframe 重复注入（已有 `initBoundless` 幂等判断）。
- 自动填充/保存提示在**移动端浏览器**里的输入框定位（`visualViewport`）容易飘，是常见改造点。
- 护盾关闭时会以明文写 `vault_data`，若增强安全可强制始终加密。
- WebDAV 目前硬编码坚果云域名（host_permissions 只放了 `dav.jianguoyun.com`），要换服务商需同步改 manifest。