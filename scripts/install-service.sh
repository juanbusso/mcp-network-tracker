#!/usr/bin/env bash
set -e

PLIST_NAME="com.antigravity.network-tracker.plist"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_PLIST="${PROJECT_DIR}/${PLIST_NAME}"
TARGET_DIR="${HOME}/Library/LaunchAgents"
TARGET_PLIST="${TARGET_DIR}/${PLIST_NAME}"
NODE_BIN="$(command -v node || true)"

if [ -z "${NODE_BIN}" ]; then
    echo "❌ No se encontró 'node' en el PATH." >&2
    exit 1
fi

echo "📦 Instalando servicio de inicio automático en macOS (LaunchAgent)..."

mkdir -p "${TARGET_DIR}" "${PROJECT_DIR}/data"

# If already loaded, unload first
if launchctl list | grep -q "com.antigravity.network-tracker"; then
    echo "🔄 Deteniendo servicio anterior..."
    launchctl unload "${TARGET_PLIST}" 2>/dev/null || true
fi

# Render the plist template with this checkout's paths
sed -e "s|__PROJECT_DIR__|${PROJECT_DIR}|g" -e "s|__NODE_BIN__|${NODE_BIN}|g" "${SOURCE_PLIST}" > "${TARGET_PLIST}"
echo "✔ Archivo generado en ${TARGET_PLIST} (proyecto: ${PROJECT_DIR}, node: ${NODE_BIN})"

# Load service
launchctl load "${TARGET_PLIST}"
echo "✔ Servicio cargado e iniciado exitosamente con launchctl."
echo "🚀 El monitor de red ahora se iniciará automáticamente cada vez que enciendas la Mac o inicies sesión."
