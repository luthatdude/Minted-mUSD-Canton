/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Stub out React-Native-only modules that MetaMask SDK imports but never
  // uses in a browser environment. Without this, webpack emits a "Module not
  // found" warning and the client-side JS bundle can fail to hydrate.
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        '@react-native-async-storage/async-storage': false,
      };
    }
    return config;
  },

  // Security headers — CSP is now set dynamically per-request in _document.tsx
  // with a unique nonce (FE-H-03 remediation). Only non-CSP headers remain here.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
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
