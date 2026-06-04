#!/usr/bin/env node
/**
 * Fetch the Windows ffmpeg.exe binary so electron-builder can include it
 * when packaging from macOS/Linux.
 *
 * ffmpeg-static's postinstall only downloads the binary for the host OS,
 * so cross-building for Windows from a Mac leaves node_modules/ffmpeg-static/
 * without ffmpeg.exe — the installed app then fails with ENOENT at runtime.
 *
 * This script reads the release tag from node_modules/ffmpeg-static/package.json
 * (so it stays in sync with whatever version is installed) and pulls the matching
 * win32-x64 build from the official ffmpeg-static GitHub release.
 *
 * Usage: node scripts/fetch-windows-ffmpeg.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream');
const { promisify } = require('util');

const pipelineAsync = promisify(pipeline);

const FFMPEG_DIR = path.join(__dirname, '..', 'node_modules', 'ffmpeg-static');
const TARGET = path.join(FFMPEG_DIR, 'ffmpeg.exe');

function log(msg) {
  process.stdout.write(`[fetch-windows-ffmpeg] ${msg}\n`);
}

async function main() {
  if (!fs.existsSync(FFMPEG_DIR)) {
    throw new Error(
      `node_modules/ffmpeg-static not found at ${FFMPEG_DIR}. Run "npm install" first.`
    );
  }

  if (fs.existsSync(TARGET) && fs.statSync(TARGET).size > 1_000_000) {
    log(`ffmpeg.exe already present (${fs.statSync(TARGET).size} bytes). Skipping download.`);
    return;
  }

  const ffmpegPkg = require(path.join(FFMPEG_DIR, 'package.json'));
  const releaseTag = ffmpegPkg['ffmpeg-static']['binary-release-tag'];
  if (!releaseTag) throw new Error('Could not read binary-release-tag from ffmpeg-static');

  const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${releaseTag}/ffmpeg-win32-x64.gz`;
  log(`Downloading ${url}`);

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
  }

  const tmp = `${TARGET}.download`;
  await pipelineAsync(
    res.body,
    zlib.createGunzip(),
    fs.createWriteStream(tmp)
  );

  fs.renameSync(tmp, TARGET);
  fs.chmodSync(TARGET, 0o755);

  const size = fs.statSync(TARGET).size;
  if (size < 1_000_000) {
    throw new Error(`Downloaded ffmpeg.exe is suspiciously small (${size} bytes)`);
  }
  log(`Wrote ${TARGET} (${size} bytes). Done.`);
}

main().catch((err) => {
  process.stderr.write(`[fetch-windows-ffmpeg] ERROR: ${err.message}\n`);
  process.exit(1);
});
