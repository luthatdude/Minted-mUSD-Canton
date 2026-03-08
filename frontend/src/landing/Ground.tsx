import React, { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

export function Ground() {
  const ref = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (ref.current) {
      const mat = ref.current.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 0.02 + Math.sin(clock.elapsedTime * 0.5) * 0.01;
    }
  });

  return (
    <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.5, 0]} receiveShadow>
      <planeGeometry args={[40, 40, 32, 32]} />
      <meshStandardMaterial
        color="#0a0a1a"
        emissive="#1a3a5a"
        emissiveIntensity={0.03}
        roughness={0.8}
        metalness={0.2}
        wireframe={false}
      />
    </mesh>
  );
}
