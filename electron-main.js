'use strict';
/**
 * Electron shell — Techsol Automation desktop app.
 * Boots the embedded Express server on a free port, then opens the UI window.
 * Data lives in the OS user-data directory; Zoho mode via env or config.
 */
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

// Safety net. The app polls a mailbox (IMAP/TLS) and WhatsApp (HTTPS) in the
// background. A socket can emit a stray 'error' or time out after its awaited
// call already returned; left unhandled, Node turns that into a fatal
// "A JavaScript error occurred in the main process" dialog and the app dies.
// These background hiccups are logged and swallowed — the poll loops reconnect
// on their own on the next tick, so the app stays up instead of crashing.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});

let win = null;
const PORT = process.env.PORT || 4577;

function startServer() {
  process.env.DB_PATH = process.env.DB_PATH || path.join(app.getPath('userData'), 'techsol.db');
  process.env.PORT = String(PORT);
  require(path.join(__dirname, 'server.js'));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 840,
    title: 'Techsol Automation — Commercial Workflows',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(`http://localhost:${PORT}`);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(() => {
  startServer();
  // give the server a moment to bind before loading
  setTimeout(createWindow, 700);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
