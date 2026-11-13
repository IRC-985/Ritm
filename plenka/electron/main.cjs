// Плёнка для Windows: окно Electron, приложение отдаётся по протоколу app://
const { app, BrowserWindow, protocol, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');

const DIST = path.join(__dirname, '..', 'dist');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// больше памяти для больших RAW
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=8192');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600,
    title: 'Плёнка', backgroundColor: '#16130f', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.loadURL('app://plenka/index.html');
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(() => {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    let p = decodeURIComponent(url.pathname);
    if (p === '/' || p === '') p = '/index.html';
    const file = path.normalize(path.join(DIST, p));
    if (!file.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
    try {
      const body = await fs.readFile(file);
      return new Response(body, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
