import { useState, useEffect } from "react";

export type DeviceTier = "low" | "medium" | "high";

interface DeviceCapability {
  tier: DeviceTier;
  supportsWebGL2: boolean;
  isMobile: boolean;
  pixelRatio: number;
}

function detectCapability(): DeviceCapability {
  if (typeof window === "undefined") {
    return { tier: "low", supportsWebGL2: false, isMobile: false, pixelRatio: 1 };
  }

  const isMobile =
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent
    ) || window.innerWidth < 768;

  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

  let supportsWebGL2 = false;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    supportsWebGL2 = !!gl;
    if (gl) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "";
      // Detect known low-end GPUs
      if (/SwiftShader|llvmpipe|Software/i.test(renderer)) {
        return { tier: "low", supportsWebGL2, isMobile, pixelRatio };
      }
    }
  } catch {
    supportsWebGL2 = false;
  }

  if (!supportsWebGL2) {
    return { tier: "low", supportsWebGL2: false, isMobile, pixelRatio };
  }

  if (isMobile) {
    return { tier: "medium", supportsWebGL2, isMobile, pixelRatio };
  }

  // Check hardware concurrency for high-tier
  const cores = navigator.hardwareConcurrency || 2;
  const tier: DeviceTier = cores >= 4 ? "high" : "medium";

  return { tier, supportsWebGL2, isMobile, pixelRatio };
}

export function useDeviceCapability(): DeviceCapability {
  const [capability, setCapability] = useState<DeviceCapability>({
    tier: "low",
    supportsWebGL2: false,
    isMobile: false,
    pixelRatio: 1,
  });

  useEffect(() => {
    setCapability(detectCapability());
  }, []);

  return capability;
}
