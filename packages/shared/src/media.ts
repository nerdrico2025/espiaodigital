// Helpers de mídia compartilhados (nome de arquivo, narração).

/** Mensagem padrão quando um vídeo não tem fala detectável. */
export const SEM_NARRACAO_MSG =
  'Sem narração detectada (provavelmente só música ou texto na tela).';

/** Há narração quando o texto transcrito tem pelo menos 3 palavras. */
export function temNarracao(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.trim().split(/\s+/).filter(Boolean).length >= 3;
}

/** Slug seguro para nome de arquivo: sem acentos, minúsculo, só [a-z0-9_]. */
export function slug(s: string | null | undefined): string {
  const out = (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return out || 'item';
}

/** Extensão a partir do storage_path; cai em mp4/jpg conforme o tipo. */
export function extFromPath(path: string | null | undefined, mediaType: string): string {
  const m = (path ?? '').match(/\.([a-z0-9]{2,5})(?:\?|$)/i);
  if (m && m[1]) return m[1].toLowerCase();
  return mediaType === 'video' ? 'mp4' : 'jpg';
}

/**
 * Nome de arquivo amigável: {anunciante}_{nivel}_{dias}d_{id-curto}.{ext}
 * Ex.: arcads_medio_15d_a1b2c3.mp4
 */
export function mediaFileName(args: {
  candidate: string | null;
  nivel: string | null;
  dias: number | null;
  creativeId: string;
  storagePath: string | null;
  mediaType: string;
}): string {
  const nivel = args.nivel ? slug(args.nivel) : 'na';
  const dias = args.dias == null ? 'na' : String(args.dias);
  const short = args.creativeId.replace(/-/g, '').slice(0, 6) || 'media';
  const ext = extFromPath(args.storagePath, args.mediaType);
  return `${slug(args.candidate)}_${nivel}_${dias}d_${short}.${ext}`;
}
