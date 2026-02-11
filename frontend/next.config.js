/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  
  // FIX FE-H1: Add security headers including Content Security Policy
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // FIX FE-01: Remove 'unsafe-inline' in production for script-src
              process.env.NODE_ENV === 'production'
                ? "script-src 'self' 'strict-dynamic'"
                : "script-src 'self' 'unsafe-eval' 'unsafe-inline'", // Dev only
              "style-src 'self' 'unsafe-inline'", // Required for Tailwind
              // FIX FE-01: Expand connect-src for WalletConnect, Canton API, points API (HTTPS only)
              "connect-src 'self' https://*.infura.io wss://*.infura.io https://*.alchemy.com wss://*.alchemy.com https://*.walletconnect.com wss://*.walletconnect.com https://*.canton.network https://api.coingecko.com",
              "img-src 'self' data: https:",
              "font-src 'self' data:",
              "frame-ancestors 'none'",
            ].join('; '),
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
