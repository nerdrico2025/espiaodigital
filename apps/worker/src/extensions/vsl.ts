// Fase 06 — VSL: download + preparação de mídia (áudio/vídeo + trechos).
// Só conteúdo público: sem DRM bypass, sem login, sem proxy.
// Usa o manifest já guardado na captura; se não houver, reabre a página
// (mesmo contexto do Funil) e fareja .m3u8/.mpd por até 30s.

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, devices } from 'playwright';
import type { VslChunk, VslExtractor, VslExtractResult } from '../interfaces.js';

const CHUNK_SEC = 600; // 10 min
const MAX_REDUCED_VIDEO_BYTES = 150 * 1024 * 1024; // 150 MB

function run(cmd: string, args: string[], timeoutMs = 300_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} excedeu ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} saiu com código ${code}: ${stderr.slice(0, 300)}`));
    });
  });
}

async function ffprobeDuration(file: string): Promise<number | null> {
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', file,
    ], 60_000);
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Classifica o motivo de falha do yt-dlp para uma mensagem amigável. */
function failReasonFrom(msg: string): string {
  const m = msg.toLowerCase();
  if (/drm|widevine|encrypt/.test(m)) return 'mídia indisponível: protegida por DRM';
  if (/403|forbidden/.test(m)) return 'mídia indisponível: acesso negado (403)';
  if (/token|expired|expirou/.test(m)) return 'mídia indisponível: token expirado';
  if (/private|login|sign in|unavailable/.test(m)) return 'mídia indisponível: vídeo privado/bloqueado';
  return `mídia indisponível: ${msg.slice(0, 120)}`;
}

/** Reabre a página e fareja o primeiro manifest de vídeo (.m3u8/.mpd). */
async function sniffManifest(pageUrl: string, timeoutMs = 30_000): Promise<string | null> {
  let found: string | null = null;
  const browser = await chromium.launch({ headless: true });
  try {
    const device = devices['iPhone 13'];
    const context = await browser.newContext({
      ...device,
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      extraHTTPHeaders: { referer: 'https://www.facebook.com/' },
    });
    const page = await context.newPage();
    page.on('request', (r) => {
      const u = r.url();
      if (!found && /\.(m3u8|mpd)(\?|$)/i.test(u)) found = u;
    });
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    const t0 = Date.now();
    while (!found && Date.now() - t0 < timeoutMs) {
      await page.waitForTimeout(1000);
    }
    await context.close();
  } finally {
    await browser.close().catch(() => {});
  }
  return found;
}

export class RealVsl implements VslExtractor {
  async extract(input: {
    pageUrl: string;
    manifestUrl: string | null;
    player: string | null;
    maxMinutes: number;
  }): Promise<VslExtractResult> {
    const base: VslExtractResult = {
      ok: false,
      failReason: null,
      player: input.player,
      manifestUrl: input.manifestUrl,
      durationSeconds: null,
      tooLong: false,
      audioPath: null,
      videoPath: null,
      videoBytes: null,
      chunks: [],
    };

    // Fonte: manifest guardado > URL direta (YouTube/Vimeo) > sniff da página.
    let source = input.manifestUrl ?? input.pageUrl;
    let manifestUrl = input.manifestUrl;
    const isDirectVideo = /youtube\.com|youtu\.be|vimeo\.com/i.test(input.pageUrl);
    if (!manifestUrl && !isDirectVideo) {
      manifestUrl = await sniffManifest(input.pageUrl).catch(() => null);
      if (manifestUrl) source = manifestUrl;
    }
    base.manifestUrl = manifestUrl;

    const referer = input.pageUrl;
    const dir = await mkdtemp(path.join(tmpdir(), 'espiao-vsl-'));
    const videoFile = path.join(dir, 'video.mp4');

    try {
      // 1) Duração ANTES de baixar (quando possível) para respeitar o teto.
      const probed = await this.probeDuration(source, referer);
      if (probed != null && probed > input.maxMinutes * 60) {
        return { ...base, durationSeconds: probed, tooLong: true, failReason: 'VSL longa demais para o limite' };
      }

      // 2) Download com yt-dlp (HLS/DASH ou página). Referer ajuda no Vimeo/CDN.
      const ytArgs = ['--no-warnings', '--no-playlist', '-f', 'bv*[height<=1080]+ba/b', '--referer', referer, '-o', videoFile, source];
      try {
        await run('yt-dlp', ytArgs);
      } catch (e) {
        return { ...base, failReason: failReasonFrom(e instanceof Error ? e.message : String(e)) };
      }

      const vstat = await stat(videoFile).catch(() => null);
      if (!vstat || vstat.size === 0) return { ...base, failReason: 'mídia indisponível: download vazio' };

      const duration = (await ffprobeDuration(videoFile)) ?? probed ?? null;
      if (duration != null && duration > input.maxMinutes * 60) {
        return { ...base, durationSeconds: duration, tooLong: true, failReason: 'VSL longa demais para o limite' };
      }

      // 3) Áudio mp3 mono 16kHz (sempre).
      const audioFile = path.join(dir, 'audio.mp3');
      await run('ffmpeg', ['-y', '-i', videoFile, '-ac', '1', '-ar', '16000', '-vn', '-b:a', '48k', audioFile]);

      // 4) Vídeo reduzido 480p — só se ficar ≤150MB.
      let videoPath: string | null = null;
      let videoBytes: number | null = null;
      try {
        const reduced = path.join(dir, 'reduced480.mp4');
        await run('ffmpeg', [
          '-y', '-i', videoFile, '-vf', 'scale=-2:480', '-c:v', 'libx264', '-crf', '30',
          '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '96k', reduced,
        ]);
        const rstat = await stat(reduced).catch(() => null);
        if (rstat && rstat.size <= MAX_REDUCED_VIDEO_BYTES) {
          videoPath = reduced;
          videoBytes = rstat.size;
        }
      } catch {
        videoPath = null;
      }

      // 5) Divide o áudio em trechos de até 10 min, guardando o deslocamento.
      const segPattern = path.join(dir, 'chunk_%03d.mp3');
      await run('ffmpeg', [
        '-y', '-i', audioFile, '-f', 'segment', '-segment_time', String(CHUNK_SEC),
        '-c', 'copy', segPattern,
      ]);
      const files = (await readdir(dir)).filter((f) => /^chunk_\d+\.mp3$/.test(f)).sort();
      const chunks: VslChunk[] = [];
      for (let i = 0; i < files.length; i++) {
        const p = path.join(dir, files[i]!);
        const d = (await ffprobeDuration(p)) ?? CHUNK_SEC;
        chunks.push({ path: p, offsetSec: i * CHUNK_SEC, durationSec: d });
      }
      if (chunks.length === 0) chunks.push({ path: audioFile, offsetSec: 0, durationSec: duration ?? 0 });

      return {
        ...base,
        ok: true,
        durationSeconds: duration,
        audioPath: audioFile,
        videoPath,
        videoBytes,
        chunks,
      };
    } catch (e) {
      return { ...base, failReason: failReasonFrom(e instanceof Error ? e.message : String(e)) };
    }
  }

  private async probeDuration(source: string, referer: string): Promise<number | null> {
    try {
      const { stdout } = await run(
        'yt-dlp',
        ['--no-warnings', '--skip-download', '--print', 'duration', '--referer', referer, source],
        60_000,
      );
      const n = Number(stdout.trim().split('\n')[0]);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }
}
