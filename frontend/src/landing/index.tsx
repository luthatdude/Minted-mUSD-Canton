import React, { lazy, Suspense, useState } from "react";
import { useDeviceCapability } from "./useDeviceCapability";
import { LandingFallback } from "./LandingFallback";

const LandingScene = lazy(() =>
  import("./LandingScene").then((m) => ({ default: m.LandingScene }))
);
const LandingOverlay = lazy(() =>
  import("./LandingOverlay").then((m) => ({ default: m.LandingOverlay }))
);

interface LandingGateProps {
  onConnectEthereum: () => void;
  onConnectCanton: () => void;
  isEthConnecting: boolean;
  isCantonConnecting: boolean;
}

export function LandingGate({
  onConnectEthereum,
  onConnectCanton,
  isEthConnecting,
  isCantonConnecting,
}: LandingGateProps) {
  const { tier } = useDeviceCapability();
  const [sceneError, setSceneError] = useState(false);

  // Low-end devices or WebGL failure → CSS-only fallback
  if (tier === "low" || sceneError) {
    return (
      <LandingFallback
        onConnectEthereum={onConnectEthereum}
        onConnectCanton={onConnectCanton}
        isEthConnecting={isEthConnecting}
        isCantonConnecting={isCantonConnecting}
      />
    );
  }

  const quality = tier as "medium" | "high";

  return (
    <div className="relative min-h-screen bg-[#050510]">
      <Suspense
        fallback={
          <LandingFallback
            onConnectEthereum={onConnectEthereum}
            onConnectCanton={onConnectCanton}
            isEthConnecting={isEthConnecting}
            isCantonConnecting={isCantonConnecting}
          />
        }
      >
        <ErrorBoundary onError={() => setSceneError(true)}>
          <LandingScene quality={quality} />
        </ErrorBoundary>
        <LandingOverlay
          onConnectEthereum={onConnectEthereum}
          onConnectCanton={onConnectCanton}
          isEthConnecting={isEthConnecting}
          isCantonConnecting={isCantonConnecting}
        />
      </Suspense>
    </div>
  );
}

/** Minimal error boundary for WebGL crashes */
class ErrorBoundary extends React.Component<
  { children: React.ReactNode; onError: () => void },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

export default LandingGate;
