#!/usr/bin/env bash
set -e

PLIST_NAME="com.antigravity.network-tracker.plist"
TARGET_PLIST="${HOME}/Library/LaunchAgents/${PLIST_NAME}"

echo "🛑 Desinstalando servicio LaunchAgent..."

if [ -f "${TARGET_PLIST}" ]; then
    launchctl unload "${TARGET_PLIST}" 2>/dev/null || true
    rm -f "${TARGET_PLIST}"
    echo "✔ Servicio detenido y desinstalado de ${TARGET_PLIST}"
else
    echo "ℹ No se encontró el servicio instalado."
fi
