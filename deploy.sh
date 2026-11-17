#!/system/bin/sh
# 无界 (Boundless) 扩展部署 / 回滚脚本
#   sh deploy.sh            把 ./无界 推回雨见浏览器的已解压扩展目录
#   sh deploy.sh --restore  用 ./备份_原版 覆盖回浏览器（回滚）
# 需要 root（终端本身已是 root）。执行完记得重启雨见浏览器。

set -e

BASE=$(cd "$(dirname "$0")" && pwd)
SRC="$BASE/无界"
ORIG="$BASE/备份_原版"
PKG_DIR="/proc/1/root/data/data/com.yjllq.chrome.beta"
[ -d "$PKG_DIR" ] || PKG_DIR="/data/data/com.yjllq.chrome.beta"
DST="$PKG_DIR/app_chrome/Default/UnpackedExtensions/密码箱拓展_NP0AJV"
OWNER="u0_a491:u0_a491"

MODE="deploy"
[ "$1" = "--restore" ] && MODE="restore"

if [ "$MODE" = "restore" ]; then
  SRC="$ORIG"
  echo "== 回滚：$ORIG -> $DST"
fi

[ -d "$SRC" ] || { echo "!! 源目录不存在: $SRC"; exit 1; }
[ -f "$SRC/manifest.json" ] || { echo "!! 缺少 manifest.json"; exit 1; }
[ -d "$(dirname "$DST")" ] || { echo "!! 扩展目录不存在（浏览器版本/路径可能变了）: $(dirname "$DST")"; exit 1; }

# --- 0. manifest.json 自检（避免 JSON 语法错导致扩展直接不加载）
if command -v python3 >/dev/null 2>&1; then
  python3 -c "import json,sys;json.load(open(sys.argv[1],encoding='utf-8'))" "$SRC/manifest.json" \
    || { echo "!! manifest.json 不是合法 JSON，已中止"; exit 1; }
  echo "== manifest.json OK"
fi

# --- 1. 部署前自动快照（保留最近 3 份）
if [ "$MODE" = "deploy" ]; then
  TS=$(date +%Y%m%d-%H%M%S)
  SNAP="$BASE/备份_部署前自动/$TS"
  mkdir -p "$SNAP"
  cp -a "$DST/." "$SNAP/" 2>/dev/null || true
  echo "== 已快照当前线上版本到 备份_部署前自动/$TS"
  ls -1d "$BASE/备份_部署前自动"/* 2>/dev/null | sort | tail -n +4 | while read -r old; do
    rm -rf "$old"
  done
fi

# --- 2. 覆盖写入 + 修权限（浏览器以 u0_a491 运行，权限不对会加载失败）
cp -a "$SRC/." "$DST/"
chown -R "$OWNER" "$DST"
find "$DST" -type d -exec chmod 700 {} \;
find "$DST" -type f -exec chmod 600 {} \;

# --- 3. 校验
echo "== 校验（左侧源码 / 右侧线上）"
( cd "$SRC" && md5sum * ) | while read -r sum name; do
  line=$(md5sum "$DST/$name" | cut -d' ' -f1)
  if [ "$line" = "$sum" ]; then echo "  ok  $name"; else echo "  BAD $name"; fi
done

echo
echo "✅ $([ "$MODE" = "restore" ] && echo 回滚 || echo 部署)完成：$DST"
echo "→ 请重启雨见浏览器（或关掉其全部进程）后，扩展才会重新加载。"
echo "→ 扩展 ID 应仍为 ccgoeefbkokagomicodphmepbgigbcnb（路径未变，所以数据不会丢）。"