// Ponto de extensão (NÃO implementado) — Prompt B.
// Download, transcrição e divisão em blocos da VSL a partir do manifest
// (.m3u8/.mpd) detectado na captura de funil. Mantido como interface vazia.

export interface VslExtractor {
  /** Baixa a VSL do manifest, transcreve e divide em blocos. */
  extract(input: {
    investigationId: string;
    funnelId: string;
    manifestUrl: string;
  }): Promise<{
    storagePath: string | null;
    transcription: string | null;
    blocos: { timestamp: string; descricao: string }[] | null;
  }>;
}

// Implementação pendente (Prompt B).
