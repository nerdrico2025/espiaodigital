import type { Candidate } from '@espiao/shared';

/** Extensão futura: tráfego/estimativas de visitas do site do candidato. */
export interface SiteTrafficProvider {
  enrich(candidate: Candidate): Promise<{ monthlyVisits: number | null; source: string }>;
}
