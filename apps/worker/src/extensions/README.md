# Pontos de extensão (não implementados)

Interfaces deixadas de propósito sem implementação, para evolução futura:

- `site-traffic.ts` — enriquecer candidatos com tráfego do site (ex.: Similarweb).
- `instagram.ts` — coletar criativos/sinais do Instagram além da Ad Library.
- `multi-player.ts` — síntese comparativa entre vários concorrentes (padrões de mercado).

Cada arquivo exporta só a interface. Para ativar, implemente e injete em `deps.ts`.
