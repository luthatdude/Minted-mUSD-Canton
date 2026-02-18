import { artifacts, network } from "hardhat";

const LOCAL_NETWORKS = new Set(["hardhat", "localhost"]);
const FORBIDDEN_ARTIFACT_MARKERS = ["harness", "certora"] as const;

function isForbiddenArtifact(fullyQualifiedName: string): boolean {
  const normalized = fullyQualifiedName.replace(/\\/g, "/").toLowerCase();
  return FORBIDDEN_ARTIFACT_MARKERS.some((marker) => normalized.includes(marker));
}

export async function assertSafeForNetworkDeployment(scriptName: string): Promise<void> {
  if (LOCAL_NETWORKS.has(network.name)) {
    return;
  }

  const fullyQualifiedNames = await artifacts.getAllFullyQualifiedNames();
  const forbiddenArtifacts = fullyQualifiedNames.filter(isForbiddenArtifact);

  if (forbiddenArtifacts.length === 0) {
    return;
  }

  const artifactList = forbiddenArtifacts.map((name) => `  - ${name}`).join("\n");
  throw new Error(
    [
      `Refusing to run ${scriptName} on network '${network.name}'.`,
      "Found verification-only artifacts in build outputs:",
      artifactList,
      "Delete those artifacts (for example with 'npx hardhat clean') and recompile production sources only.",
    ].join("\n")
  );
}
