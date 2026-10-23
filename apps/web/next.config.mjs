/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Imagens da Meta/CDN são exibidas via <img>; não usamos next/image remoto.
  // Sem `output: 'standalone'`: o Dockerfile do web mantém node_modules completo
  // e sobe com `next start`. O modo standalone exigiria copiar server.js + public
  // + .next/static para uma imagem mínima; como não fazemos esse copy dance,
  // standalone não traz ganho e ainda faz o `next start` emitir aviso.
  experimental: { externalDir: true },
};
export default nextConfig;
