const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');
const AdmZip = require('adm-zip');
const unrar = require('node-unrar-js');

const CACHE_DIR = path.join(app.getPath('temp'), 'comic-glass-reader-cache');

function clearCache() {
  if (fs.existsSync(CACHE_DIR)) {
    try {
      fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    } catch (err) {
      console.error("Failed to clear cache:", err);
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
  createWindow();
});

app.on('will-quit', () => {
  clearCache();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('open-comic-file', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Comic Books', extensions: ['cbz', 'cbr', 'zip', 'rar'] }]
    });

    if (canceled || filePaths.length === 0) return null;

    clearCache();
    fs.mkdirSync(CACHE_DIR, { recursive: true });

    const filePath = filePaths[0];
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
      const extracted = extractor.extract();
      for (const file of extracted.files) {
        if (file.fileHeader.flags.directory) continue;
        const outPath = path.join(CACHE_DIR, file.fileHeader.name);
        const outDir = path.dirname(outPath);
        if (!fs.existsSync(outDir)) {
          fs.mkdirSync(outDir, { recursive: true });
        }
        fs.writeFileSync(outPath, file.extraction);
      }
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

    return imageFiles.map(file => url.pathToFileURL(file).href);

  } catch (error) {
    console.error("Failed to process comic file:", error);
    return null;
  }
});