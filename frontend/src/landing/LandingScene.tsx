import React, { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { Ground } from "./Ground";
import { Buildings } from "./Buildings";
import { DataParticles } from "./DataParticles";
import { Atmosphere } from "./Atmosphere";
import { CameraRig } from "./CameraRig";
import { PostEffects } from "./PostEffects";
import type { DeviceTier } from "./useDeviceCapability";

interface LandingSceneProps {
  quality: Exclude<DeviceTier, "low">;
}

export function LandingScene({ quality }: LandingSceneProps) {
  return (
    <Canvas
      shadows={quality === "high"}
      dpr={quality === "high" ? [1, 2] : [1, 1]}
      gl={{ antialias: quality === "high", powerPreference: "high-performance" }}
      camera={{ position: [8, 3.5, 8], fov: 50, near: 0.1, far: 100 }}
      style={{ position: "absolute", inset: 0 }}
    >
      <Suspense fallback={null}>
        <Atmosphere quality={quality} />
        <Ground />
        <Buildings quality={quality} />
        <DataParticles count={quality === "high" ? 200 : 100} />
        <CameraRig />
        <PostEffects quality={quality} />
      </Suspense>
    </Canvas>
  );
}
