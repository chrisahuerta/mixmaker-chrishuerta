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

// =====================================================
// EXPORT MIX - Uses raw ffmpeg command for reliability
// Normalizes ALL songs to 44100 Hz, stereo, 192kbps
// This prevents static/glitches between songs
// =====================================================
ipcMain.handle('export-mix', async (event, config) => {
  try {
    const ffmpegPath = getFFmpegPath();
    if (!ffmpegPath) return { success: false, error: 'FFmpeg no encontrado' };

    const { songs, outputPath, mixName, genre } = config;
    if (!songs || songs.length === 0) return { success: false, error: 'No hay canciones' };
    if (!outputPath) return { success: false, error: 'No se seleccionó carpeta de exportación' };

    const { v4: uuidv4 } = require('uuid');
    const { execFile } = require('child_process');

    const outputFile = path.join(outputPath, `${mixName}.mp3`);

    // Step 1: Convert each song to a normalized WAV temp file
    // This ensures ALL songs have the same sample rate, channels, and format
    const tempDir = path.join(outputPath, `.mixmaker_temp_${uuidv4()}`);
    await fs.mkdir(tempDir, { recursive: true });

    console.log('=== EXPORT START ===');
    console.log(`Songs: ${songs.length}, Output: ${outputFile}`);
    console.log(`Temp dir: ${tempDir}`);

    const tempFiles = [];

    for (let i = 0; i < songs.length; i++) {
      const song = songs[i];
      const tempFile = path.join(tempDir, `part_${String(i).padStart(4, '0')}.wav`);
      tempFiles.push(tempFile);

      console.log(`Converting ${i + 1}/${songs.length}: ${song.title}`);

      // Convert each song to WAV with uniform format: 44100 Hz, stereo, 16-bit
      await new Promise((resolve, reject) => {
        execFile(ffmpegPath, [
          '-i', song.path,
          '-ar', '44100',       // Sample rate: 44100 Hz
          '-ac', '2',           // Channels: stereo
          '-sample_fmt', 's16', // 16-bit audio
          '-y',                 // Overwrite if exists
          tempFile
        ], (error, stdout, stderr) => {
          if (error) {
            console.error(`Error converting ${song.title}:`, error.message);
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }

    // Step 2: Create concat file pointing to the normalized WAV files
    const concatFile = path.join(tempDir, 'concat_list.txt');
    let concatContent = '';
    for (const tempFile of tempFiles) {
      const safePath = tempFile.replace(/\\/g, '/').replace(/'/g, "'\\''");
      concatContent += `file '${safePath}'\n`;
    }
    await fs.writeFile(concatFile, concatContent, 'utf-8');

    console.log('All songs normalized. Concatenating to final MP3...');

    // Step 3: Concat all normalized WAVs into final MP3
    await new Promise((resolve, reject) => {
      execFile(ffmpegPath, [
        '-f', 'concat',
        '-safe', '0',
        '-i', concatFile,
        '-codec:a', 'libmp3lame',
        '-b:a', '192k',
        '-ar', '44100',
        '-ac', '2',
        '-y',
        outputFile
      ], (error, stdout, stderr) => {
        if (error) {
          console.error('FFmpeg concat error:', error.message);
          reject(error);
        } else {
          resolve();
        }
      });
    });

    console.log('Final MP3 created successfully!');

    // Step 4: Clean up temp files
    try {
      for (const tempFile of tempFiles) {
        await fs.unlink(tempFile);
      }
      await fs.unlink(concatFile);
      await fs.rmdir(tempDir);
      console.log('Temp files cleaned up');
    } catch (cleanErr) {
      console.warn('Could not clean all temp files:', cleanErr.message);
    }

    // Step 5: Generate tracklist .txt
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
    console.log(`Tracklist exported: ${tracklistFile}`);
    console.log('=== EXPORT COMPLETE ===');

    return { success: true, outputFile, tracklistFile, message: 'Mix y tracklist exportados' };

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
