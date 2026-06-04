#!/usr/bin/env bash
# =============================================================
#  Build: Playlist Studio (versión sin "7")
#  Uso:  bash build-ps.sh [mac|win|all]
#  Salida: dist-ps/
#
#  LOGOS: Coloca tus iconos en build-resources-ps/
#    - icon.png  (macOS, mínimo 512x512, preferible 1024x1024)
#    - icon.ico  (Windows, multi-resolución)
# =============================================================
set -e
cd "$(dirname "$0")"

TARGET="${1:-all}"
OLD_NAME="7 Playlist Studio"
NEW_NAME="Playlist Studio"

echo "🧹 Limpiando carpetas build/ y dist-ps/..."
rm -rf build dist-ps

echo "📦 Verificando dependencias..."
if [ ! -d node_modules ]; then
  npm install
fi

# Si el target incluye Windows, descargar ffmpeg.exe primero
if [[ "$TARGET" == "win" || "$TARGET" == "all" ]]; then
  echo "🪟 Descargando ffmpeg.exe para Windows..."
  npm run fetch-win-ffmpeg

  # Verificar que ffmpeg.exe existe y pesa más de 1 MB antes de continuar
  FFMPEG_EXE="node_modules/ffmpeg-static/ffmpeg.exe"
  if [ ! -f "$FFMPEG_EXE" ]; then
    echo "❌ ERROR: $FFMPEG_EXE no encontrado. El build fallaría con ENOENT."
    echo "   Ejecuta manualmente: node scripts/fetch-windows-ffmpeg.js"
    exit 1
  fi
  FFMPEG_SIZE=$(wc -c < "$FFMPEG_EXE")
  if [ "$FFMPEG_SIZE" -lt 1000000 ]; then
    echo "❌ ERROR: $FFMPEG_EXE parece corrupto (${FFMPEG_SIZE} bytes)."
    echo "   Elimínalo y vuelve a ejecutar el build para re-descargarlo."
    exit 1
  fi
  echo "  ✅ ffmpeg.exe listo ($(du -sh "$FFMPEG_EXE" | cut -f1))"
fi

echo "⚛️  Compilando React..."
npm run react-build

# ---------------------------------------------------------------
#  Parchear build/index.html — reemplazar nombre de la app
# ---------------------------------------------------------------
echo "🏷  Parcheando nombre de la app en build/index.html..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS: sed requiere extensión en -i
  sed -i '' "s/${OLD_NAME}/${NEW_NAME}/g" build/index.html
else
  # Linux/WSL
  sed -i "s/${OLD_NAME}/${NEW_NAME}/g" build/index.html
fi

# ---------------------------------------------------------------
#  Reemplazar logos en-app (logo512.png y logo192.png)
#  que aparecen en pantalla de inicio, escaneo y exportación
# ---------------------------------------------------------------
echo "🖼  Reemplazando logos en-app con el logo de Playlist Studio..."
cp build-resources-ps/logo512.png build/logo512.png
cp build-resources-ps/logo192.png build/logo192.png
echo "  ✅ logo512.png y logo192.png reemplazados"

# ---------------------------------------------------------------
#  Crear public/electron-ps.js — copia de electron.js con el
#  nombre de app actualizado en el footer del tracklist
# ---------------------------------------------------------------
echo "🏷  Generando public/electron-ps.js..."
sed "s/Generated with ${OLD_NAME}/Generated with ${NEW_NAME}/g" \
    public/electron.js > public/electron-ps.js

# ---------------------------------------------------------------
#  Empaquetar con la config de Playlist Studio
# ---------------------------------------------------------------
echo ""
case "$TARGET" in
  mac)
    echo "🍎 Empaquetando macOS (.dmg arm64 + x64)..."
    npx electron-builder --mac --config electron-builder-ps.json
    ;;
  win)
    echo "🪟 Empaquetando Windows (.exe NSIS x64)..."
    npx electron-builder --win --config electron-builder-ps.json
    ;;
  all|*)
    echo "🍎 Empaquetando macOS (.dmg arm64 + x64)..."
    npx electron-builder --mac --config electron-builder-ps.json
    echo "🪟 Empaquetando Windows (.exe NSIS x64)..."
    npx electron-builder --win --config electron-builder-ps.json
    ;;
esac

# ---------------------------------------------------------------
#  Limpiar archivos temporales
# ---------------------------------------------------------------
echo "🧹 Limpiando archivos temporales..."
rm -f public/electron-ps.js

echo ""
echo "✅ Playlist Studio listo. Instaladores en dist-ps/:"
ls -lh dist-ps/*.dmg dist-ps/*.exe 2>/dev/null || true
