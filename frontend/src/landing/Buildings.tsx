import React, { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

interface BuildingProps {
  position: [number, number, number];
  height: number;
  width: number;
  depth: number;
  color: string;
  emissive: string;
  pulseSpeed?: number;
}

function Building({
  position,
  height,
  width,
  depth,
  color,
  emissive,
  pulseSpeed = 1,
}: BuildingProps) {
  const ref = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    if (ref.current) {
      const mat = ref.current.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity =
        0.15 + Math.sin(clock.elapsedTime * pulseSpeed + position[0]) * 0.08;
    }
  });

  return (
    <mesh
      ref={ref}
      position={[position[0], position[1] + height / 2, position[2]]}
      castShadow
      receiveShadow
    >
      <boxGeometry args={[width, height, depth]} />
      <meshStandardMaterial
        color={color}
        emissive={emissive}
        emissiveIntensity={0.15}
        roughness={0.3}
        metalness={0.7}
        transparent
        opacity={0.85}
      />
    </mesh>
  );
}

export function Buildings({ quality }: { quality: "medium" | "high" }) {
  const buildings = useMemo(() => {
    const count = quality === "high" ? 24 : 12;
    const items: BuildingProps[] = [];
    const colors = ["#1e3a5f", "#0d2137", "#1a2f4a", "#0a1929"];
    const emissives = ["#2196f3", "#4caf50", "#7c4dff", "#00bcd4"];

    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const radius = 4 + Math.random() * 8;
      items.push({
        position: [
          Math.cos(angle) * radius,
          -0.5,
          Math.sin(angle) * radius,
        ],
        height: 1 + Math.random() * 4,
        width: 0.4 + Math.random() * 0.8,
        depth: 0.4 + Math.random() * 0.8,
        color: colors[i % colors.length],
        emissive: emissives[i % emissives.length],
        pulseSpeed: 0.5 + Math.random() * 1.5,
      });
    }
    return items;
  }, [quality]);

  return (
    <group>
      {buildings.map((b, i) => (
        <Building key={i} {...b} />
      ))}
    </group>
  );
}
