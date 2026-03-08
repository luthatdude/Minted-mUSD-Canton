import React from "react";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";

export function PostEffects({ quality }: { quality: "medium" | "high" }) {
  return (
    <EffectComposer>
      <Bloom
        intensity={quality === "high" ? 0.8 : 0.5}
        luminanceThreshold={0.3}
        luminanceSmoothing={0.9}
        mipmapBlur
      />
      <Vignette offset={0.3} darkness={0.6} />
    </EffectComposer>
  );
}
