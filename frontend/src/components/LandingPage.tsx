import React, { useRef, useEffect, useState, useMemo } from "react";
import * as THREE from "three";

// ════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════

interface LandingPageProps {
  onLaunchApp: () => void;
}

interface GlobalStat {
  label: string;
  value: string;
  suffix?: string;
  color: string;
}

// ════════════════════════════════════════════════════════════════
// THREE.js Scene — Animated particle field + orbiting rings
// ════════════════════════════════════════════════════════════════

function useThreeScene(containerRef: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // ── Setup ───────────────────────────────────────────────
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 5;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    // ── Particle field ──────────────────────────────────────
    const PARTICLE_COUNT = 2000;
    const particleGeo = new THREE.BufferGeometry();
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const velocities = new Float32Array(PARTICLE_COUNT * 3);
    const colors = new Float32Array(PARTICLE_COUNT * 3);
    const sizes = new Float32Array(PARTICLE_COUNT);

    const palette = [
      new THREE.Color(0x338bff), // brand blue
      new THREE.Color(0xa855f7), // purple
      new THREE.Color(0x06b6d4), // cyan
      new THREE.Color(0xf59e0b), // amber
      new THREE.Color(0x10b981), // emerald
    ];

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const i3 = i * 3;
      // Spherical distribution
      const radius = 3 + Math.random() * 6;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);

      positions[i3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      positions[i3 + 2] = radius * Math.cos(phi);

      velocities[i3] = (Math.random() - 0.5) * 0.002;
      velocities[i3 + 1] = (Math.random() - 0.5) * 0.002;
      velocities[i3 + 2] = (Math.random() - 0.5) * 0.002;

      const color = palette[Math.floor(Math.random() * palette.length)];
      colors[i3] = color.r;
      colors[i3 + 1] = color.g;
      colors[i3 + 2] = color.b;

      sizes[i] = Math.random() * 3 + 0.5;
    }

    particleGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    particleGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    particleGeo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));

    // Custom shader for smooth glowing particles
    const particleMat = new THREE.ShaderMaterial({
      vertexShader: `
        attribute float size;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * (300.0 / -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          float d = length(gl_PointCoord - vec2(0.5));
          if (d > 0.5) discard;
          float alpha = 1.0 - smoothstep(0.0, 0.5, d);
          alpha *= 0.6;
          gl_FragColor = vec4(vColor, alpha);
        }
      `,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const particles = new THREE.Points(particleGeo, particleMat);
    scene.add(particles);

    // ── Central glowing orb ─────────────────────────────────
    const orbGeo = new THREE.SphereGeometry(0.5, 64, 64);
    const orbMat = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vPosition;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vPosition = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vNormal;
        varying vec3 vPosition;
        uniform float uTime;
        void main() {
          float fresnel = pow(1.0 - abs(dot(vNormal, vec3(0.0, 0.0, 1.0))), 3.0);
          vec3 blue = vec3(0.2, 0.54, 1.0);
          vec3 purple = vec3(0.66, 0.33, 0.97);
          vec3 color = mix(blue, purple, fresnel + sin(uTime * 0.5) * 0.3);
          float pulse = 0.7 + 0.3 * sin(uTime * 2.0);
          gl_FragColor = vec4(color, fresnel * pulse * 0.9);
        }
      `,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      side: THREE.FrontSide,
      depthWrite: false,
    });
    const orb = new THREE.Mesh(orbGeo, orbMat);
    scene.add(orb);

    // ── Orbiting rings ──────────────────────────────────────
    const rings: THREE.Mesh[] = [];
    const ringRadii = [1.2, 1.8, 2.5];
    const ringColors = [0x338bff, 0xa855f7, 0xf59e0b];

    ringRadii.forEach((radius, idx) => {
      const ringGeo = new THREE.TorusGeometry(radius, 0.008, 16, 100);
      const ringMat = new THREE.MeshBasicMaterial({
        color: ringColors[idx],
        transparent: true,
        opacity: 0.35,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = Math.PI / 2 + (idx - 1) * 0.4;
      ring.rotation.y = idx * 0.7;
      scene.add(ring);
      rings.push(ring);
    });

    // ── Connection lines (neural network effect) ────────────
    const lineGeo = new THREE.BufferGeometry();
    const linePositions = new Float32Array(300 * 6); // 300 connections, 2 points each
    lineGeo.setAttribute("position", new THREE.BufferAttribute(linePositions, 3));
    const lineMat = new THREE.LineBasicMaterial({
      color: 0x338bff,
      transparent: true,
      opacity: 0.06,
    });
    const lines = new THREE.LineSegments(lineGeo, lineMat);
    scene.add(lines);

    // ── Mouse interaction ───────────────────────────────────
    let mouseX = 0;
    let mouseY = 0;
    const onMouseMove = (e: MouseEvent) => {
      mouseX = (e.clientX / window.innerWidth - 0.5) * 2;
      mouseY = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener("mousemove", onMouseMove);

    // ── Resize ──────────────────────────────────────────────
    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener("resize", onResize);

    // ── Animation loop ──────────────────────────────────────
    let animId: number;
    const clock = new THREE.Clock();

    function animate() {
      animId = requestAnimationFrame(animate);
      const elapsed = clock.getElapsedTime();

      // Smooth camera follow mouse
      camera.position.x += (mouseX * 0.5 - camera.position.x) * 0.02;
      camera.position.y += (-mouseY * 0.3 - camera.position.y) * 0.02;
      camera.lookAt(0, 0, 0);

      // Animate particles
      const pos = particleGeo.attributes.position.array as Float32Array;
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const i3 = i * 3;
        pos[i3] += velocities[i3];
        pos[i3 + 1] += velocities[i3 + 1];
        pos[i3 + 2] += velocities[i3 + 2];

        // Soft boundary — pull back toward center
        const dist = Math.sqrt(pos[i3] ** 2 + pos[i3 + 1] ** 2 + pos[i3 + 2] ** 2);
        if (dist > 8) {
          const pull = 0.0005;
          pos[i3] -= pos[i3] * pull;
          pos[i3 + 1] -= pos[i3 + 1] * pull;
          pos[i3 + 2] -= pos[i3 + 2] * pull;
        }
      }
      particleGeo.attributes.position.needsUpdate = true;

      // Update connection lines (connect nearby particles)
      const linePos = lineGeo.attributes.position.array as Float32Array;
      let lineIdx = 0;
      const maxConnections = 300;
      const connectDist = 1.5;

      for (let i = 0; i < Math.min(PARTICLE_COUNT, 200) && lineIdx < maxConnections; i++) {
        const i3 = i * 3;
        for (let j = i + 1; j < Math.min(PARTICLE_COUNT, 200) && lineIdx < maxConnections; j++) {
          const j3 = j * 3;
          const dx = pos[i3] - pos[j3];
          const dy = pos[i3 + 1] - pos[j3 + 1];
          const dz = pos[i3 + 2] - pos[j3 + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < connectDist) {
            const li = lineIdx * 6;
            linePos[li] = pos[i3];
            linePos[li + 1] = pos[i3 + 1];
            linePos[li + 2] = pos[i3 + 2];
            linePos[li + 3] = pos[j3];
            linePos[li + 4] = pos[j3 + 1];
            linePos[li + 5] = pos[j3 + 2];
            lineIdx++;
          }
        }
      }
      // Zero out unused
      for (let i = lineIdx * 6; i < linePos.length; i++) linePos[i] = 0;
      lineGeo.attributes.position.needsUpdate = true;

      // Rotate particles field slowly
      particles.rotation.y = elapsed * 0.05;
      particles.rotation.x = Math.sin(elapsed * 0.03) * 0.1;

      // Orb pulsing
      orbMat.uniforms.uTime.value = elapsed;
      const scale = 1 + Math.sin(elapsed * 1.5) * 0.08;
      orb.scale.setScalar(scale);

      // Rotate rings
      rings.forEach((ring, idx) => {
        ring.rotation.z = elapsed * (0.15 + idx * 0.08) * (idx % 2 === 0 ? 1 : -1);
        ring.rotation.x = Math.PI / 2 + (idx - 1) * 0.4 + Math.sin(elapsed * 0.3 + idx) * 0.15;
      });

      renderer.render(scene, camera);
    }

    animate();

    // ── Cleanup ─────────────────────────────────────────────
    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      particleGeo.dispose();
      particleMat.dispose();
      orbGeo.dispose();
      orbMat.dispose();
      lineGeo.dispose();
      lineMat.dispose();
      rings.forEach((r) => { r.geometry.dispose(); (r.material as THREE.MeshBasicMaterial).dispose(); });
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [containerRef]);
}

// ════════════════════════════════════════════════════════════════
// Animated Counter
// ════════════════════════════════════════════════════════════════

function AnimatedCounter({ value, duration = 2000 }: { value: number; duration?: number }) {
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const startVal = 0;
    function tick() {
      const elapsed = Date.now() - start;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.floor(startVal + (value - startVal) * eased));
      if (progress < 1) requestAnimationFrame(tick);
    }
    tick();
  }, [value, duration]);

  return <>{display.toLocaleString()}</>;
}

// ════════════════════════════════════════════════════════════════
// Landing Page Component
// ════════════════════════════════════════════════════════════════

export function LandingPage({ onLaunchApp }: LandingPageProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useThreeScene(canvasRef);

  // Fade in after mount
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 100);
    return () => clearTimeout(t);
  }, []);

  const stats: GlobalStat[] = useMemo(
    () => [
      { label: "mUSD Supply", value: "24.8M", suffix: "", color: "text-brand-400" },
      { label: "Staking APY", value: "12.4", suffix: "%", color: "text-emerald-400" },
      { label: "Active Users", value: "3,847", suffix: "", color: "text-purple-400" },
      { label: "Canton Attestation Value", value: "18.2M", suffix: "", color: "text-amber-400" },
    ],
    []
  );

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#030712]">
      {/* THREE.js canvas — behind everything */}
      <div ref={canvasRef} className="absolute inset-0 z-0" />

      {/* Dark vignette overlay for text legibility */}
      <div className="pointer-events-none absolute inset-0 z-[1]"
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 30%, rgba(3,7,18,0.65) 70%, rgba(3,7,18,0.9) 100%)",
        }}
      />

      {/* Top nav bar — minimal */}
      <nav className="relative z-20 flex items-center justify-between px-6 py-5 sm:px-10 lg:px-16">
        {/* Logo */}
        <div className="flex items-center gap-3">
          <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-purple-600 shadow-[0_0_20px_rgba(51,139,255,0.4)]">
            <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <span className="text-xl font-bold">
            <span className="text-white">Minted</span>
            <span className="bg-gradient-to-r from-brand-400 to-purple-400 bg-clip-text text-transparent">Protocol</span>
          </span>
        </div>

        {/* Nav links + Launch App */}
        <div className="flex items-center gap-8">
          <div className="hidden items-center gap-6 sm:flex">
            {["About", "Docs", "Community"].map((item) => (
              <a
                key={item}
                href="#"
                className="text-sm font-medium text-gray-400 transition-colors hover:text-white"
              >
                {item}
              </a>
            ))}
          </div>

          <button
            onClick={onLaunchApp}
            className="group relative overflow-hidden rounded-xl bg-gradient-to-r from-brand-500 to-purple-600 px-6 py-2.5 text-sm font-bold text-white shadow-[0_0_24px_rgba(51,139,255,0.4)] transition-all duration-300 hover:shadow-[0_0_40px_rgba(51,139,255,0.6)] hover:scale-105"
          >
            <span className="relative z-10 flex items-center gap-2">
              Launch App
              <svg className="h-4 w-4 transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
            </span>
            {/* Shine sweep */}
            <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/20 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
          </button>
        </div>
      </nav>

      {/* ═══════ HERO SECTION ═══════ */}
      <div
        className={`relative z-10 flex min-h-[calc(100vh-80px)] flex-col items-center justify-center px-4 transition-all duration-1000 ${
          visible ? "translate-y-0 opacity-100" : "translate-y-8 opacity-0"
        }`}
      >
        {/* Badge */}
        <div className="mb-6 flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 backdrop-blur-sm">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-400" />
          </span>
          <span className="text-xs font-medium text-gray-300">
            Powered by Canton Network × Ethereum
          </span>
        </div>

        {/* Main headline */}
        <h1 className="max-w-4xl text-center">
          <span className="block text-5xl font-extrabold leading-tight tracking-tight text-white sm:text-6xl lg:text-7xl">
            The currency for the
          </span>
          <span className="mt-2 block text-5xl font-extrabold leading-tight tracking-tight sm:text-6xl lg:text-7xl">
            <span className="bg-gradient-to-r from-brand-400 via-purple-400 to-amber-400 bg-clip-text text-transparent">
              Web3 Ownership Economy
            </span>
          </span>
        </h1>

        {/* Subtitle */}
        <p className="mt-6 max-w-2xl text-center text-lg text-gray-400 sm:text-xl">
          Mint, stake, and earn with a fully-backed stablecoin — validated in real time
          by attestations on the Canton Network.
        </p>

        {/* CTA buttons */}
        <div className="mt-10 flex items-center gap-4">
          <button
            onClick={onLaunchApp}
            className="group relative overflow-hidden rounded-2xl bg-gradient-to-r from-brand-500 via-purple-500 to-brand-500 bg-[length:200%_100%] px-8 py-4 text-lg font-bold text-white shadow-[0_0_30px_rgba(51,139,255,0.5)] transition-all duration-500 hover:bg-right hover:shadow-[0_0_50px_rgba(51,139,255,0.7)] hover:scale-105"
          >
            <span className="relative z-10 flex items-center gap-3">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              Launch App
              <svg className="h-5 w-5 transition-transform group-hover:translate-x-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
            </span>
            <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/10 to-transparent transition-transform duration-1000 group-hover:translate-x-full" />
          </button>

          <a
            href="#"
            className="rounded-2xl border border-white/10 bg-white/5 px-8 py-4 text-lg font-semibold text-white backdrop-blur-sm transition-all duration-300 hover:border-white/20 hover:bg-white/10"
          >
            Read Docs
          </a>
        </div>

        {/* ═══════ GLOBAL STATS ═══════ */}
        <div
          className={`mt-20 w-full max-w-4xl transition-all duration-1000 delay-500 ${
            visible ? "translate-y-0 opacity-100" : "translate-y-8 opacity-0"
          }`}
        >
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {stats.map((stat) => (
              <div
                key={stat.label}
                className="group relative rounded-2xl border border-white/[0.06] bg-white/[0.03] p-5 backdrop-blur-sm transition-all duration-300 hover:border-white/10 hover:bg-white/[0.06]"
              >
                {/* Hover glow */}
                <div className="pointer-events-none absolute inset-0 rounded-2xl opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                  style={{
                    background: `radial-gradient(ellipse at center, ${
                      stat.color.includes("brand")
                        ? "rgba(51,139,255,0.08)"
                        : stat.color.includes("emerald")
                        ? "rgba(16,185,129,0.08)"
                        : stat.color.includes("purple")
                        ? "rgba(168,85,247,0.08)"
                        : "rgba(245,158,11,0.08)"
                    } 0%, transparent 70%)`,
                  }}
                />

                <p className="text-xs font-medium uppercase tracking-wider text-gray-500">
                  {stat.label}
                </p>
                <p className={`mt-2 text-2xl font-bold ${stat.color} sm:text-3xl`}>
                  {stat.value}
                  {stat.suffix && <span className="text-lg">{stat.suffix}</span>}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Scroll indicator */}
        <div
          className={`mt-16 flex flex-col items-center gap-2 transition-all duration-1000 delay-700 ${
            visible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
          }`}
        >
          <span className="text-xs font-medium uppercase tracking-widest text-gray-600">
            Scroll to explore
          </span>
          <div className="flex h-8 w-5 items-start justify-center rounded-full border border-gray-700 p-1">
            <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-500" />
          </div>
        </div>
      </div>

      {/* ═══════ FEATURES SECTION (below fold) ═══════ */}
      <div className="relative z-10 border-t border-white/5 bg-gradient-to-b from-[#030712] to-[#0a0f1e]">
        <div className="mx-auto max-w-6xl px-6 py-24 sm:px-10">
          <div className="mb-16 text-center">
            <h2 className="text-3xl font-bold text-white sm:text-4xl">
              Built for the future of{" "}
              <span className="bg-gradient-to-r from-brand-400 to-purple-400 bg-clip-text text-transparent">
                digital finance
              </span>
            </h2>
            <p className="mt-4 text-gray-500">
              A fully-backed stablecoin with institutional-grade infrastructure
            </p>
          </div>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                icon: "M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z",
                title: "1:1 Fully Backed",
                desc: "Every mUSD is backed by USDC held in the protocol treasury, verified on-chain at all times.",
                color: "from-brand-500 to-blue-600",
              },
              {
                icon: "M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z",
                title: "Canton Attestations",
                desc: "Real-time validation via the Canton Network ensures every mint, redeem, and transfer is verifiable.",
                color: "from-amber-500 to-yellow-500",
              },
              {
                icon: "M13 7h8m0 0v8m0-8l-8 8-4-4-6 6",
                title: "AI Yield Engine",
                desc: "Our AI aggregation engine optimizes yield across hundreds of DeFi protocols automatically.",
                color: "from-emerald-500 to-cyan-500",
              },
              {
                icon: "M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4",
                title: "Cross-Chain Bridge",
                desc: "Seamlessly move assets between Ethereum, Canton, and L2 networks with a single click.",
                color: "from-purple-500 to-pink-500",
              },
              {
                icon: "M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4",
                title: "Borrow & Leverage",
                desc: "Deposit collateral, borrow mUSD, and access leveraged positions up to 3x.",
                color: "from-red-500 to-orange-500",
              },
              {
                icon: "M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z",
                title: "Points & Rewards",
                desc: "Earn points for protocol participation with multipliers for early adopters and active users.",
                color: "from-brand-500 to-purple-500",
              },
            ].map((feature) => (
              <div
                key={feature.title}
                className="group rounded-2xl border border-white/[0.06] bg-white/[0.02] p-6 transition-all duration-300 hover:border-white/10 hover:bg-white/[0.04]"
              >
                <div
                  className={`mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br ${feature.color} shadow-lg`}
                >
                  <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={feature.icon} />
                  </svg>
                </div>
                <h3 className="mb-2 text-lg font-semibold text-white">{feature.title}</h3>
                <p className="text-sm leading-relaxed text-gray-500">{feature.desc}</p>
              </div>
            ))}
          </div>

          {/* Bottom CTA */}
          <div className="mt-20 text-center">
            <button
              onClick={onLaunchApp}
              className="group relative overflow-hidden rounded-2xl bg-gradient-to-r from-brand-500 to-purple-600 px-10 py-4 text-lg font-bold text-white shadow-[0_0_30px_rgba(51,139,255,0.4)] transition-all duration-300 hover:shadow-[0_0_50px_rgba(51,139,255,0.6)] hover:scale-105"
            >
              <span className="relative z-10 flex items-center gap-2">
                Start Earning Now
                <svg className="h-5 w-5 transition-transform group-hover:translate-x-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
              </span>
              <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/10 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
            </button>
          </div>
        </div>

        {/* Footer */}
        <footer className="border-t border-white/5 px-6 py-8 sm:px-10">
          <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 sm:flex-row">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-purple-600">
                <svg className="h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <span className="text-sm text-gray-600">© 2026 Minted Protocol. All rights reserved.</span>
            </div>
            <div className="flex items-center gap-6">
              {["Docs", "GitHub", "Discord", "Terms"].map((link) => (
                <a key={link} href="#" className="text-sm text-gray-600 transition-colors hover:text-gray-300">
                  {link}
                </a>
              ))}
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

export default LandingPage;
