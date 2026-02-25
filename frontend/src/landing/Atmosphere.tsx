import React from "react";
import { Stars } from "@react-three/drei";

export function Atmosphere({ quality }: { quality: "medium" | "high" }) {
  const starCount = quality === "high" ? 3000 : 1000;

  return (
    <>
      <fog attach="fog" args={["#050510", 10, 35]} />
      <ambientLight intensity={0.15} />
      <directionalLight
        position={[5, 10, 5]}
        intensity={0.4}
        color="#b3e5fc"
        castShadow={quality === "high"}
      />
      <pointLight position={[0, 6, 0]} intensity={0.6} color="#4fc3f7" distance={15} />
      <pointLight position={[-5, 3, -5]} intensity={0.3} color="#7c4dff" distance={10} />
      <Stars
        radius={30}
        depth={40}
        count={starCount}
        factor={3}
        saturation={0.2}
        fade
        speed={0.5}
      />
    </>
  );
}
