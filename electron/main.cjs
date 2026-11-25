const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');
const AdmZip = require('adm-zip');
const unrar = require('node-unrar-js');

// Each running instance extracts into its own folder, so one instance clearing its
// cache can't delete the pages another instance is showing.
const CACHE_ROOT = path.join(app.getPath('temp'), 'comic-glass-reader');
const INSTANCE_PREFIX = 'instance-';
const CACHE_DIR = path.join(CACHE_ROOT, INSTANCE_PREFIX + process.pid);

// Launched as `electron electron/main.cjs`, Electron would store data in a generic
// "Electron" folder shared by every unpackaged Electron app; give the app its own.
const LEGACY_USER_DATA = app.getPath('userData');
app.setPath('userData', path.join(app.getPath('appData'), 'Comic Glass Reader'));

function clearCache() {
  if (fs.existsSync(CACHE_DIR)) {
    try {
      fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    } catch (err) {
      console.error("Failed to clear cache:", err);
    }
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Remove folders left behind by instances that crashed or were killed.
function clearStaleCaches() {
  let entries;
  try {
    entries = fs.readdirSync(CACHE_ROOT);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(INSTANCE_PREFIX)) continue;
    const pid = Number(name.slice(INSTANCE_PREFIX.length));
    if (pid === process.pid || (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid))) continue;
    try {
      fs.rmSync(path.join(CACHE_ROOT, name), { recursive: true, force: true });
    } catch (err) {
      console.error("Failed to clear stale cache:", err);
    }
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
    },
  });

  win.loadURL('http://localhost:5173');
}

app.whenReady().then(() => {
  clearCache();
  clearStaleCaches();
  createWindow();
});

app.on('will-quit', () => {
  clearCache();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- Bookmarks (persisted to userData/bookmarks.json) ---

const BOOKMARKS_FILE = path.join(app.getPath('userData'), 'bookmarks.json');

// One-time move of bookmarks saved before the app had its own data folder
const LEGACY_BOOKMARKS_FILE = path.join(LEGACY_USER_DATA, 'bookmarks.json');
if (!fs.existsSync(BOOKMARKS_FILE) && fs.existsSync(LEGACY_BOOKMARKS_FILE)) {
  try {
    fs.mkdirSync(path.dirname(BOOKMARKS_FILE), { recursive: true });
    fs.copyFileSync(LEGACY_BOOKMARKS_FILE, BOOKMARKS_FILE);
  } catch (err) {
    console.error("Failed to migrate bookmarks:", err);
  }
}

function readBookmarks() {
  try {
    const data = JSON.parse(fs.readFileSync(BOOKMARKS_FILE, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeBookmarks(bookmarks) {
  try {
    const tmp = BOOKMARKS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(bookmarks, null, 2));
    fs.renameSync(tmp, BOOKMARKS_FILE);
  } catch (err) {
    console.error("Failed to save bookmarks:", err);
  }
}

// Most recent first, flagging files that have since been moved or deleted
function sortedBookmarks(bookmarks) {
  return [...bookmarks]
    .sort((a, b) => b.lastOpened - a.lastOpened)
    .map(b => ({ ...b, missing: !fs.existsSync(b.filePath) }));
}

ipcMain.handle('bookmarks-get', () => {
  return sortedBookmarks(readBookmarks());
});

// Insert or update the bookmark for a file; returns the full updated list
ipcMain.handle('bookmarks-save', (_event, { filePath, lastPage, totalPages }) => {
  const bookmarks = readBookmarks().filter(b => b.filePath !== filePath);
  bookmarks.push({
    filePath,
    name: path.basename(filePath, path.extname(filePath)),
    lastPage,
    totalPages,
    lastOpened: Date.now(),
  });
  writeBookmarks(bookmarks);
  return sortedBookmarks(bookmarks);
});

ipcMain.handle('bookmarks-remove', (_event, filePath) => {
  const bookmarks = readBookmarks().filter(b => b.filePath !== filePath);
  writeBookmarks(bookmarks);
  return sortedBookmarks(bookmarks);
});

// --- Comic loading ---

ipcMain.handle('open-comic-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Comic Books', extensions: ['cbz', 'cbr', 'zip', 'rar'] }]
  });

  if (canceled || filePaths.length === 0) return null;
  return loadComic(filePaths[0]);
});

ipcMain.handle('open-comic-path', async (_event, filePath) => {
  if (!fs.existsSync(filePath)) return null;
  return loadComic(filePath);
});

// The comic extracted into CACHE_DIR. Opening it again reuses its pages rather than
// extracting over the ones on screen (and under the detection worker).
let loaded = null;

async function loadComic(filePath) {
  if (loaded?.filePath === filePath && fs.existsSync(CACHE_DIR)) return loaded;
  try {
    loaded = null;
    clearCache();
    fs.mkdirSync(CACHE_DIR, { recursive: true });

    const ext = path.extname(filePath).toLowerCase();

    // Handle CBZ / ZIP
    if (ext === '.cbz' || ext === '.zip') {
      const zip = new AdmZip(filePath);
      zip.extractAllTo(CACHE_DIR, true);
    } 
    // Handle CBR / RAR
    else if (ext === '.cbr' || ext === '.rar') {
      const extractor = await unrar.createExtractorFromFile({
        filepath: filePath,
        targetPath: CACHE_DIR
      });
      // Consuming generator extracts files directly into CACHE_DIR
      [...extractor.extract().files];
    }

    function getImages(dir, fileList = []) {
      const files = fs.readdirSync(dir);
      files.forEach(file => {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
          getImages(fullPath, fileList);
        } else if (!file.includes('__MACOSX') && /\.(jpg|jpeg|png|webp)$/i.test(file)) {
          fileList.push(fullPath);
        }
      });
      return fileList;
    }

    const imageFiles = getImages(CACHE_DIR);
    imageFiles.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    loaded = { filePath, pages: imageFiles.map(file => url.pathToFileURL(file).href) };
    return loaded;

  } catch (error) {
    console.error("Failed to process comic file:", error);
    return null;
  }
}