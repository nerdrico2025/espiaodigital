import type { ConsolidatedCompetitor } from '@espiao/shared';

/** Extensão futura: síntese comparativa entre vários concorrentes. */
export interface MultiPlayerSynthesis {
  synthesize(competitors: ConsolidatedCompetitor[]): Promise<{ marketPatterns: string[] }>;
}
