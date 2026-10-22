import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DownloadResult, MediaPipeline } from '../interfaces.js';
import { retry } from '../util/retry.js';

export interface Uploader {
  /** Envia um buffer ao storage e devolve o path salvo. */
  upload(storagePath: string, data: Buffer, contentType: string): Promise<void>;
}

function run(cmd: string, args: string[], timeoutMs = 180_000): Promise<{ stdout: string; stderr: string }> {
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

async function fetchBuffer(url: string, timeoutMs = 120_000): Promise<Buffer> {
  return retry(
    async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error(`download ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      } finally {
        clearTimeout(t);
      }
    },
    { label: 'download mídia', retries: 2 },
  );
}

async function ffprobeDuration(file: string): Promise<number | null> {
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ]);
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export class RealMedia implements MediaPipeline {
  constructor(private uploader: Uploader) {}

  async download(input: {
    investigationId: string;
    creativeId: string;
    mediaType: 'image' | 'video';
    url: string;
    previewUrl?: string | null;
  }): Promise<DownloadResult> {
    const base = `${input.investigationId}/${input.creativeId}`;
    try {
      if (input.mediaType === 'image') {
        const buf = await fetchBuffer(input.url);
        const storagePath = `${base}.jpg`;
        await this.uploader.upload(storagePath, buf, 'image/jpeg');
        return { ok: true, storagePath, previewPath: null };
      }

      // Vídeo: baixa a mídia (direto ou via yt-dlp) e extrai o áudio.
      const dir = await mkdtemp(path.join(tmpdir(), 'espiao-'));
      const videoFile = path.join(dir, 'video.mp4');

      const direct = /\.mp4(\?|$)/i.test(input.url);
      if (direct) {
        const buf = await fetchBuffer(input.url);
        await writeFile(videoFile, buf);
      } else {
        // yt-dlp resolve URLs de página/CDN da Meta.
        await run('yt-dlp', ['-o', videoFile, '-f', 'mp4/best', input.url]);
      }

      const size = (await stat(videoFile)).size;
      if (!size) throw new Error('vídeo vazio');

      const storagePath = `${base}.mp4`;
      await this.uploader.upload(storagePath, await readFile(videoFile), 'video/mp4');

      // Áudio mono 16kHz WAV para transcrição.
      const audioFile = path.join(dir, 'audio.wav');
      await run('ffmpeg', ['-y', '-i', videoFile, '-ac', '1', '-ar', '16000', '-vn', audioFile]);
      const durationSeconds = await ffprobeDuration(videoFile);

      let previewPath: string | null = null;
      if (input.previewUrl) {
        try {
          const prev = await fetchBuffer(input.previewUrl, 30_000);
          previewPath = `${base}-preview.jpg`;
          await this.uploader.upload(previewPath, prev, 'image/jpeg');
        } catch {
          previewPath = null;
        }
      }

      return { ok: true, storagePath, previewPath, localAudioPath: audioFile, durationSeconds };
    } catch (e) {
      return {
        ok: false,
        storagePath: null,
        previewPath: null,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}
