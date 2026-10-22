/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Imagens da Meta/CDN são exibidas via <img>; não usamos next/image remoto.
  output: 'standalone',
  experimental: { externalDir: true },
};
export default nextConfig;
