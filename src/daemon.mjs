import { runNetworkScan } from './scanner.mjs';
import { processScanAlerts } from './notifier.mjs';

const SCAN_INTERVAL_SEC = parseInt(process.env.SCAN_INTERVAL_SEC || '60', 10);
const TOLERANCE_SCANS = parseInt(process.env.TOLERANCE_SCANS || '2', 10);
const RETRY_INTERVAL_SEC = 10; // Check every 10s while router is booting

let isRunning = true;
let wasWaitingNetwork = false;

function log(msg) {
  const time = new Date().toLocaleTimeString('es-AR');
  console.log(`[${time}] ${msg}`);
}

async function startDaemon() {
  log(`🛰️  Daemon de monitoreo de red iniciado.`);
  log(`⏱️  Intervalo normal: ${SCAN_INTERVAL_SEC}s | Espera de arranque: ${RETRY_INTERVAL_SEC}s | Tolerancia offline: ${TOLERANCE_SCANS} escaneos`);

  process.on('SIGINT', () => {
    log('Recibida señal SIGINT. Deteniendo daemon...');
    isRunning = false;
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    log('Recibida señal SIGTERM. Deteniendo daemon...');
    isRunning = false;
    process.exit(0);
  });

  while (isRunning) {
    let nextWaitSec = SCAN_INTERVAL_SEC;

    try {
      const res = await runNetworkScan(null, TOLERANCE_SCANS);

      if (!res.networkReady) {
        if (!wasWaitingNetwork) {
          log(`⏳ ${res.message || 'Esperando a que el router/módem termine de arrancar...'}`);
          wasWaitingNetwork = true;
        }
        // Poll faster while waiting for router to finish booting
        nextWaitSec = RETRY_INTERVAL_SEC;
      } else {
        if (wasWaitingNetwork) {
          log(`🌐 ¡Router y red listos! (${res.subnet}). ${res.totalDiscovered} dispositivos detectados.`);
          wasWaitingNetwork = false;
        }

        let summary = `Escaneo OK: ${res.totalDiscovered} activos (${res.durationMs}ms)`;

        if (res.newDevices.length > 0) {
          summary += ` | +${res.newDevices.length} nuevos`;
        }
        if (res.reconnectedDevices.length > 0) {
          summary += ` | ↑${res.reconnectedDevices.length} reconectados`;
        }
        if (res.wentOffline.length > 0) {
          summary += ` | ↓${res.wentOffline.length} desconectados`;
        }

        log(summary);

        // Alertas automáticas opcionales por WhatsApp (nuevos dispositivos y llegadas de personas)
        try {
          await processScanAlerts(res);
        } catch (alertErr) {
          log(`⚠️ Error procesando alertas: ${alertErr.message}`);
        }
      }
    } catch (err) {
      log(`❌ Error durante el escaneo: ${err.message}`);
      nextWaitSec = RETRY_INTERVAL_SEC;
    }

    if (!isRunning) break;
    await new Promise((resolve) => setTimeout(resolve, nextWaitSec * 1000));
  }
}

startDaemon();
