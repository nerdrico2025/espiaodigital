import type { Candidate, NormalizedAd } from '@espiao/shared';

/** Extensão futura: coleta de criativos/sinais do Instagram. */
export interface InstagramProvider {
  fetchCreatives(candidate: Candidate): Promise<NormalizedAd[]>;
}
