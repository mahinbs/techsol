'use strict';
/**
 * Electron shell — Techsol Automation desktop app.
 * Boots the embedded Express server on a free port, then opens the UI window.
 * Data lives in the OS user-data directory; Zoho mode via env or config.
 */
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

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
