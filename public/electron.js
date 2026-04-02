const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const isDev = require('electron-is-dev');

function getFFmpegPath() {
  if (isDev) {
    return require('ffmpeg-static');
  }
  const resourcePath = process.resourcesPath;
  const isWin = process.platform === 'win32';
  return path.join(resourcePath, 'ffmpeg-static', isWin ? 'ffmpeg.exe' : 'ffmpeg');
}

function getFFprobePath() {
  if (isDev) {
    return require('ffprobe-static').path;
  }
  const resourcePath = process.resourcesPath;
  const platform = process.platform;
  if (platform === 'win32') {
    return path.join(resourcePath, 'ffprobe-bin', 'win32', 'x64', 'ffprobe.exe');
  } else if (platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    return path.join(resourcePath, 'ffprobe-bin', 'darwin', arch, 'ffprobe');
  } else {
    return path.join(resourcePath, 'ffprobe-bin', 'linux', 'x64', 'ffprobe');
  }
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      enableRemoteModule: false,
    },
  });

  const startUrl = isDev
    ? 'http://localhost:3000'
    : `file://${path.join(__dirname, '../build/index.html')}`;
  mainWindow.loadURL(startUrl);
  if (isDev) mainWindow.webContents.openDevTools();
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.on('ready', createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (mainWindow === null) createWindow(); });

ipcMain.handle('select-music-folder', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Selecciona una carpeta con tus canciones',
    });
    return result.canceled ? null : result.filePaths[0];
  } catch (error) {
    return null;
  }
});

ipcMain.handle('scan-music-folder', async (event, folderPath) => {
  try {
    const { v4: uuidv4 } = require('uuid');
    const songs = [];
    const files = await fs.readdir(folderPath, { recursive: true });

    const ffmpegPath = getFFmpegPath();
    const ffprobePath = getFFprobePath();
    const ffmpeg = require('fluent-ffmpeg');
    if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
    if (ffprobePath) ffmpeg.setFfprobePath(ffprobePath);

    console.log('FFmpeg path:', ffmpegPath);
    console.log('FFprobe path:', ffprobePath);

    for (const file of files) {
      const fullPath = path.join(folderPath, file);
      const ext = path.extname(file).toLowerCase();
      if (['.mp3', '.wav'].includes(ext)) {
        let duration = 0;
        let title = path.basename(file, ext);
        let artist = 'Desconocido';

        try {
          const metadata = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(fullPath, (err, data) => {
              if (err) reject(err);
              else resolve(data);
            });
          });
          duration = Math.round(metadata.format.duration || 0);
          if (metadata.format && metadata.format.tags) {
            const tags = metadata.format.tags;
            title = tags.title || tags.TITLE || title;
            artist = tags.artist || tags.ARTIST || tags.album_artist || artist;
          }
        } catch (err) {
          console.warn(`ffprobe failed for ${file}:`, err.message);
        }

        console.log(`Scanned: ${title} | duration: ${duration}s | artist: ${artist}`);
        songs.push({ id: uuidv4(), title, artist, duration, path: fullPath, filename: file });
      }
    }
    console.log(`Total songs scanned: ${songs.length}, with duration: ${songs.filter(s => s.duration > 0).length}`);
    return { success: true, songs, count: songs.length };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('generate-mix', async (event, config) => {
  try {
    const { selectedSongs, songCount, genre, prioritySongs } = config;
    if (!selectedSongs || selectedSongs.length === 0) {
      return { success: false, error: 'No hay canciones seleccionadas' };
    }

    const count = Math.min(songCount || selectedSongs.length, selectedSongs.length);
    const priorityIds = (prioritySongs || []).map(s => s.id);
    const priorityList = [];
    const restList = [];

    for (const song of selectedSongs) {
      if (priorityIds.includes(song.id)) {
        priorityList.push(song);
      } else {
        restList.push(song);
      }
    }

    const shuffledPriority = [...priorityList].sort(() => Math.random() - 0.5);
    const shuffledRest = [...restList].sort(() => Math.random() - 0.5);

    const mix = [];
    for (const song of shuffledPriority) {
      if (mix.length >= count) break;
      mix.push(song);
    }
    for (const song of shuffledRest) {
      if (mix.length >= count) break;
      mix.push(song);
    }

    const totalDuration = Math.round(mix.reduce((sum, s) => sum + s.duration, 0) / 60);
    console.log(`Generated mix: ${mix.length} songs, ${totalDuration} minutes, priority: ${shuffledPriority.length}`);
    return { success: true, mix, totalDuration, genre, songCount: mix.length };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('export-mix', async (event, config) => {
  try {
    const ffmpeg = require('fluent-ffmpeg');
    const ffmpegPath = getFFmpegPath();
    if (!ffmpegPath) return { success: false, error: 'FFmpeg no encontrado' };
    ffmpeg.setFfmpegPath(ffmpegPath);

    const { songs, outputPath, mixName, genre } = config;
    if (!songs || songs.length === 0) return { success: false, error: 'No hay canciones' };
    if (!outputPath) return { success: false, error: 'No se seleccionó carpeta de exportación' };

    const { v4: uuidv4 } = require('uuid');
    const concatFile = path.join(outputPath, `.mix_${uuidv4()}.txt`);
    let concatContent = '';

    for (const song of songs) {
      // On Windows, backslashes in paths need to be escaped or converted
      const safePath = song.path.replace(/\\/g, '/').replace(/'/g, "\\'");
      concatContent += `file '${safePath}'\n`;
    }

    console.log('Concat file:', concatFile);
    console.log('Output path:', outputPath);
    await fs.writeFile(concatFile, concatContent, 'utf-8');
    const outputFile = path.join(outputPath, `${mixName}.mp3`);

    return new Promise((resolve) => {
      ffmpeg()
        .input(concatFile)
        .inputOption('-f concat')
        .inputOption('-safe 0')
        .audioCodec('libmp3lame')
        .audioBitrate('192k')
        .output(outputFile)
        .on('end', async () => {
          try {
            await fs.unlink(concatFile);

            // Generate tracklist .txt
            const tracklistFile = path.join(outputPath, `${mixName}_tracklist.txt`);
            const totalDur = songs.reduce((sum, s) => sum + s.duration, 0);
            const totalMin = Math.floor(totalDur / 60);
            const totalSec = totalDur % 60;
            let tracklistContent = `═══════════════════════════════════════\n`;
            tracklistContent += `  MixMaker - ${mixName}\n`;
            tracklistContent += `═══════════════════════════════════════\n`;
            tracklistContent += `  Genero: ${genre || 'Sin genero'}\n`;
            tracklistContent += `  Canciones: ${songs.length}\n`;
            tracklistContent += `  Duracion total: ${totalMin}:${totalSec.toString().padStart(2, '0')}\n`;
            tracklistContent += `  Fecha: ${new Date().toLocaleDateString('es-MX', { year: 'numeric', month: 'long', day: 'numeric' })}\n`;
            tracklistContent += `═══════════════════════════════════════\n\n`;

            let elapsed = 0;
            songs.forEach((song, i) => {
              const eMin = Math.floor(elapsed / 60);
              const eSec = elapsed % 60;
              const timestamp = `${eMin}:${eSec.toString().padStart(2, '0')}`;
              const dMin = Math.floor(song.duration / 60);
              const dSec = song.duration % 60;
              const duration = `${dMin}:${dSec.toString().padStart(2, '0')}`;
              tracklistContent += `  ${String(i + 1).padStart(2, '0')}. [${timestamp}] ${song.title} - ${song.artist} (${duration})\n`;
              elapsed += song.duration;
            });

            tracklistContent += `\n═══════════════════════════════════════\n`;
            tracklistContent += `  Generado con MixMaker v2\n`;
            tracklistContent += `═══════════════════════════════════════\n`;

            await fs.writeFile(tracklistFile, tracklistContent, 'utf-8');
            console.log(`Mix exported: ${outputFile}`);
            console.log(`Tracklist exported: ${tracklistFile}`);
            resolve({ success: true, outputFile, tracklistFile, message: 'Mix y tracklist exportados' });
          } catch (err) {
            console.error('Post-export error:', err);
            resolve({ success: true, outputFile, message: 'Mix exportado' });
          }
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err);
          resolve({ success: false, error: `FFmpeg: ${err.message}` });
        })
        .run();
    });
  } catch (error) {
    console.error('Export mix error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('save-mix-history', async (event, mixData) => {
  try {
    const historyDir = path.join(app.getPath('documents'), 'MixMaker_History');
    await fs.mkdir(historyDir, { recursive: true });
    const historyFile = path.join(historyDir, 'mixes.json');
    let history = [];
    try {
      const existing = await fs.readFile(historyFile, 'utf-8');
      history = JSON.parse(existing);
    } catch { }
    history.push({ ...mixData, savedAt: new Date().toISOString() });
    await fs.writeFile(historyFile, JSON.stringify(history, null, 2));
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-mix-history', async () => {
  try {
    const historyDir = path.join(app.getPath('documents'), 'MixMaker_History');
    const historyFile = path.join(historyDir, 'mixes.json');
    try {
      const data = await fs.readFile(historyFile, 'utf-8');
      return { success: true, history: JSON.parse(data) };
    } catch {
      return { success: true, history: [] };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
});
