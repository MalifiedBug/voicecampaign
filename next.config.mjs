/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  async rewrites() {
    return [
      {
        source: '/webhook/answer',
        destination: '/api/webhook/answer',
      },
      {
        source: '/webhook/hangup',
        destination: '/api/webhook/hangup',
      },
      {
        source: '/audio/:slug*',
        destination: '/api/audio/play/:slug*',
      },
    ];
  },
};

export default nextConfig;
