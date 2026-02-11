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

        {/* Enter App */}
        <button
          onClick={onLaunchApp}
          className="group relative overflow-hidden rounded-xl bg-gradient-to-r from-brand-500 to-purple-600 px-6 py-2.5 text-sm font-bold text-white shadow-[0_0_24px_rgba(51,139,255,0.4)] transition-all duration-300 hover:shadow-[0_0_40px_rgba(51,139,255,0.6)] hover:scale-105"
        >
          <span className="relative z-10 flex items-center gap-2">
            Enter App
            <svg className="h-4 w-4 transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
          </span>
          <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/20 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
        </button>
      </nav>

      {/* ═══════ HERO SECTION ═══════ */}
      <div
        className={`relative z-10 flex min-h-[calc(100vh-80px)] flex-col items-center justify-center px-4 transition-all duration-1000 ${
          visible ? "translate-y-0 opacity-100" : "translate-y-8 opacity-0"
        }`}
      >
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

      </div>
    </div>
  );
}

export default LandingPage;
