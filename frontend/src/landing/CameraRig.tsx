import React, { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

export function CameraRig() {
  const { camera, pointer } = useThree();
  const target = useRef(new THREE.Vector3(0, 2, 0));

  useFrame(({ clock }) => {
    const t = clock.elapsedTime * 0.15;

    // Slow orbit with mouse influence
    const orbitX = Math.sin(t) * 8 + pointer.x * 1.5;
    const orbitZ = Math.cos(t) * 8 + pointer.y * 1.5;
    const orbitY = 3.5 + Math.sin(t * 0.7) * 0.5;

    camera.position.lerp(new THREE.Vector3(orbitX, orbitY, orbitZ), 0.02);
    camera.lookAt(target.current);
  });

  return null;
}
