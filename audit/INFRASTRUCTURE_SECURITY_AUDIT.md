# Minted mUSD Protocol — Infrastructure & Operational Security Audit

**Auditor:** Minted Security Team — Infrastructure  
**Date:** 2026-02-13  
**Scope:** All infrastructure, deployment, CI/CD, Docker, Kubernetes, and configuration files  
**Repository:** `/Users/luiscuello/Minted-mUSD-Canton/`

---

## Executive Summary

The Minted mUSD protocol demonstrates **exceptionally strong infrastructure security posture** for a DeFi project. The Kubernetes manifests follow production-grade hardening (Pod Security Standards, read-only root filesystems, SHA-pinned images, network policies with default-deny, zero-permission RBAC, External Secrets Operator integration). The CI/CD pipeline is comprehensive with SHA-pinned GitHub Actions, multi-tool security scanning (Slither, Mythril, Trivy, gitleaks, Certora), and dependency auditing. Docker configurations employ multi-stage builds, non-root users, Docker secrets, and resource limits.

**Infrastructure Security Score: 8.5 / 10**  
**Operational Security Score: 7.8 / 10**

| Severity | Count |
|----------|-------|
| CRITICAL | 1 |
| HIGH | 3 |
| MEDIUM | 6 |
| LOW | 8 |
| INFORMATIONAL | 5 |

---

## Detailed Findings

---

### INFRA-CRIT-01: Canton & DAML SDK Image Digests Are Placeholders — Deployment Will Use Unknown Images

**Severity:** CRITICAL  
**File:** [k8s/canton/participant-deployment.yaml](../k8s/canton/participant-deployment.yaml#L143-L153)

**Description:**  
Both the Canton participant and DAML SDK JSON API containers use placeholder SHA256 digests:

```yaml
image: digitalasset/canton-open-source@sha256:MUST_REPLACE_WITH_REAL_DIGEST
image: digitalasset/daml-sdk@sha256:MUST_REPLACE_WITH_REAL_DIGEST
```

While these are clearly marked with `MUST_REPLACE` banner comments, there is no automated CI/CD validation that prevents deployment with these placeholders. A deployment pipeline that doesn't fail on invalid digests could pull an unexpected image or fail silently.

**Impact:** If deployed without replacement: (a) deployment fails entirely (best case), or (b) a misconfigured registry mirror could serve a malicious image (worst case). In a rush deployment scenario, an operator might comment out digest pinning and use a tag, losing supply-chain protection.

**Recommendation:**
1. Add a CI step that validates all K8s image references resolve to real SHA256 digests:
   ```bash
   grep -r 'MUST_REPLACE\|PLACEHOLDER' k8s/ && exit 1
   ```
2. Document the exact commands to pull real digests in a deployment runbook.
3. Consider using a policy engine (OPA Gatekeeper / Kyverno) to reject pods with non-SHA256 image references.

---

### INFRA-H-01: No DAST (Dynamic Application Security Testing) in CI Pipeline

**Severity:** HIGH  
**File:** [.github/workflows/ci.yml](../.github/workflows/ci.yml)

**Description:**  
The CI pipeline includes excellent static analysis (Slither, Mythril), dependency scanning (npm audit, audit-ci, Trivy), secret scanning (gitleaks), formal verification (Certora), and K8s manifest validation (kubeconform). However, there is **no DAST** — no runtime testing of the deployed application for API vulnerabilities, header misconfigurations, or authentication bypass.

For a financial protocol exposing a JSON API through NGINX, dynamic scanning of the actual HTTPS endpoints (TLS configuration, CORS, auth enforcement, rate-limit bypass) is essential.

**Impact:** Server-side misconfigurations, authentication bypass, or header injection vulnerabilities that only manifest at runtime would go undetected until production.

**Recommendation:**
1. Add a DAST job using OWASP ZAP or Nuclei against a staging deployment.
2. At minimum, add TLS configuration scanning with `testssl.sh` or `sslyze` in CI.
3. Add a smoke test that verifies rate limiting, JWT enforcement, and blocked admin endpoints on the NGINX proxy.

---

### INFRA-H-02: Missing Dockerfiles for bot/, points/, and frontend/ Services

**Severity:** HIGH  
**Files:** `bot/`, `points/`, `frontend/`

**Description:**  
Only `relay/Dockerfile` exists. The `bot/`, `points/`, and `frontend/` services have no Dockerfiles. The bot service handles liquidations with private key access; the points service runs an HTTP server. Without containerization:

- These services cannot benefit from image scanning (Trivy) in CI.
- They lack the security hardening that the relay Dockerfile provides (non-root user, read-only filesystem, multi-stage build).
- Deployment is ad-hoc — no reproducible, auditable build process.

**Impact:** Inconsistent security posture across services. The bot (which handles private keys for liquidation transactions) running without container isolation is a higher risk than the others.

**Recommendation:**
1. Create Dockerfiles for `bot/`, `points/`, and `frontend/` mirroring the relay's hardening pattern.
2. Add Trivy scanning for all images in the CI `docker` job.
3. For the frontend, use a multi-stage build with `node` builder → `nginx:alpine` runtime.

---

### INFRA-H-03: kubeconform Downloads Binary Without Checksum Verification

**Severity:** HIGH  
**File:** [.github/workflows/ci.yml](../.github/workflows/ci.yml#L370-L373)

**Description:**  
The `k8s-validate` job downloads kubeconform from GitHub Releases using `wget` without verifying a SHA256 checksum:

```yaml
- name: Install kubeconform
  run: |
    wget -q https://github.com/yannh/kubeconform/releases/latest/download/kubeconform-linux-amd64.tar.gz
    tar xf kubeconform-linux-amd64.tar.gz
    sudo mv kubeconform /usr/local/bin/
```

This uses `/latest/` (unpinned version) and has no integrity check. A compromised GitHub release or MITM attack could inject a malicious binary.

**Impact:** Supply-chain attack vector — a compromised kubeconform binary could exfiltrate secrets from the CI environment or silently pass malformed K8s manifests.

**Recommendation:**
1. Pin to a specific version and verify the SHA256 checksum:
   ```yaml
   wget -q https://github.com/yannh/kubeconform/releases/download/v0.6.4/kubeconform-linux-amd64.tar.gz
   echo "EXPECTED_SHA256  kubeconform-linux-amd64.tar.gz" | sha256sum -c -
   ```
2. Or use a SHA-pinned GitHub Action wrapper if one exists.

---

### INFRA-M-01: DAML SDK Installed via Unauthenticated Curl-Pipe-Bash

**Severity:** MEDIUM  
**File:** [.github/workflows/ci.yml](../.github/workflows/ci.yml#L271-L277)

**Description:**  
The DAML SDK is installed via the classic anti-pattern:

```yaml
curl -sSL https://get.daml.com/ | bash -s $DAML_SDK_VERSION
```

This downloads and executes a shell script from the internet without signature verification or checksum validation. If `get.daml.com` is compromised, arbitrary code runs in the CI environment.

**Impact:** Compromised DAML installer could exfiltrate `CERTORAKEY`, `GITHUB_TOKEN`, or other CI secrets.

**Recommendation:**
1. Download the installer, verify its checksum, then execute:
   ```bash
   curl -sSL https://get.daml.com/ -o install-daml.sh
   echo "EXPECTED_SHA256  install-daml.sh" | sha256sum -c -
   bash install-daml.sh $DAML_SDK_VERSION
   ```
2. Or use a pre-built DAML Docker image with a pinned digest.

---

### INFRA-M-02: Mythril Installed via Unpinned `pip3 install mythril`

**Severity:** MEDIUM  
**File:** [.github/workflows/ci.yml](../.github/workflows/ci.yml#L222)

**Description:**  
```yaml
- name: Install Mythril
  run: pip3 install mythril
```

No version pin. A malicious PyPI package update or dependency confusion attack could compromise the CI runner. All other tools in the pipeline are properly pinned.

**Impact:** Supply-chain risk — unpinned pip install could pull a compromised version.

**Recommendation:**
```yaml
run: pip3 install mythril==0.24.8  # Pin to audited version
```

---

### INFRA-M-03: Certora CLI Installed via Unpinned `pip3 install certora-cli`

**Severity:** MEDIUM  
**File:** [.github/workflows/ci.yml](../.github/workflows/ci.yml#L419)

**Description:**  
Same issue as Mythril — no version pin:
```yaml
- name: Install Certora CLI
  run: pip3 install certora-cli
```

**Impact:** Supply-chain risk.

**Recommendation:**
```yaml
run: pip3 install certora-cli==7.5.0  # Pin to specific version
```

---

### INFRA-M-04: NGINX Proxy ServiceMonitor Label Selector Mismatch

**Severity:** MEDIUM  
**File:** [k8s/monitoring/service-monitors.yaml](../k8s/monitoring/service-monitors.yaml#L31-L36)

**Description:**  
The NGINX ServiceMonitor selects pods with label `app: nginx-proxy`, but the actual NGINX deployment uses `app.kubernetes.io/name: nginx-proxy`. Same mismatch for Canton participant (`app: canton-participant` vs `app.kubernetes.io/name: canton-participant`) and PostgreSQL (`app: canton-postgres` vs `app.kubernetes.io/name: postgres`).

```yaml
# ServiceMonitor expects:
selector:
  matchLabels:
    app: nginx-proxy

# Actual deployment uses:
labels:
  app.kubernetes.io/name: nginx-proxy
```

**Impact:** Prometheus will not discover these services. Monitoring alerts (rate limiting, 5xx spikes, TLS failures, DB connection exhaustion) defined in `prometheus-rules.yaml` will never fire because no metrics are being scraped. This creates a **silent monitoring gap** — the alerting infrastructure appears configured but is non-functional.

**Recommendation:**  
Update all ServiceMonitor/PodMonitor selectors to use the `app.kubernetes.io/name` labels consistent with the actual deployments:
```yaml
selector:
  matchLabels:
    app.kubernetes.io/name: nginx-proxy
```

---

### INFRA-M-05: Backup CronJob Does Not Upload to Off-Cluster Storage

**Severity:** MEDIUM  
**File:** [k8s/canton/postgres-backup-cronjob.yaml](../k8s/canton/postgres-backup-cronjob.yaml)

**Description:**  
Database backups are stored only in a PVC within the same cluster. If the cluster is destroyed (infrastructure failure, ransomware, misconfigured IaC), all backups are lost along with the primary data.

The backup CronJob's NetworkPolicy also only allows egress to PostgreSQL and DNS — no S3/GCS egress is possible even if upload code were added.

**Impact:** No disaster recovery capability outside the cluster boundary. For a financial protocol managing stablecoin state, this could result in unrecoverable ledger loss.

**Recommendation:**
1. Add an S3/GCS upload step after backup verification using `aws s3 cp` or `gsutil cp`.
2. Update the `postgres-backup-netpol` to allow HTTPS egress to the cloud storage endpoint.
3. Enable server-side encryption (SSE-S3 or CMEK) for backup objects.
4. Implement backup restoration testing as a periodic job.

---

### INFRA-M-06: No SBOM (Software Bill of Materials) Generation

**Severity:** MEDIUM  
**File:** [.github/workflows/ci.yml](../.github/workflows/ci.yml)

**Description:**  
The CI pipeline does not generate an SBOM for either the npm packages or the Docker image. For a regulated financial protocol, SBOM generation is increasingly required by compliance frameworks (SOC2, EO 14028).

**Impact:** Inability to quickly identify affected components during a zero-day vulnerability disclosure (e.g., a new CVE in a transitive dependency).

**Recommendation:**
1. Add `syft` or `trivy sbom` to the Docker build job:
   ```yaml
   - name: Generate SBOM
     run: trivy image --format cyclonedx --output sbom.json musd-relay:ci
   ```
2. Upload SBOM as a build artifact for each release.

---

### INFRA-L-01: Slither Excludes a Large Number of Detectors

**Severity:** LOW  
**File:** [.github/workflows/ci.yml](../.github/workflows/ci.yml#L162-L178), [slither.config.json](../slither.config.json)

**Description:**  
The Slither invocation excludes 22+ detectors via `--exclude`. While each exclusion has a documented rationale in the CI comments, the sheer volume of exclusions reduces the tool's effectiveness. Notably, `reentrancy-benign`, `reentrancy-events`, `reentrancy-no-eth`, and `unused-return` are excluded — these can catch real bugs in new code added after the initial audit.

**Impact:** New code additions may introduce vulnerabilities in excluded categories that won't be caught by Slither.

**Recommendation:**
1. Instead of global excludes, use per-contract `// slither-disable-next-line` annotations for known false positives.
2. Run Slither with full detectors in a separate advisory (non-blocking) CI job.

---

### INFRA-L-02: Hardhat Config Falls Back to Alchemy Demo API Key

**Severity:** LOW  
**File:** [hardhat.config.ts](../hardhat.config.ts#L28)

**Description:**  
```typescript
url: RPC_URL || "https://eth-sepolia.g.alchemy.com/v2/demo",
```

The Sepolia network falls back to Alchemy's public demo key. While this is only for development/testing, the demo key has aggressive rate limits and could cause flaky CI. It also normalizes the practice of using shared API keys.

**Impact:** Flaky tests in CI when the demo key is rate-limited. No security impact for production.

**Recommendation:**
```typescript
url: RPC_URL || "",  // Require explicit RPC_URL for testnet deployments
```

---

### INFRA-L-03: `relay/tsconfig.json` Emits Source Maps to Production

**Severity:** LOW  
**File:** [relay/tsconfig.json](../relay/tsconfig.json)

**Description:**  
```json
"sourceMap": true,
"declarationMap": true
```

Source maps and declaration maps are included in the build output. If the `dist/` directory is deployed, `.map` files expose original TypeScript source code, variable names, and logic — useful for attackers reverse-engineering the relay's validation logic.

**Impact:** Information disclosure if `.map` files are accessible in the deployed container.

**Recommendation:**  
Either:
1. Set `"sourceMap": false` for production builds, or
2. Add `*.map` to `.dockerignore` to exclude them from the container image.

---

### INFRA-L-04: Docker Compose Health Checks Bind to Localhost But Ports Are Forwarded

**Severity:** LOW  
**File:** [relay/docker-compose.yml](../relay/docker-compose.yml#L66-L69)

**Description:**  
The relay service sets `HEALTH_BIND_HOST=127.0.0.1` and binds ports to `127.0.0.1:8080:8080`. However, Docker's internal healthcheck runs *inside* the container network namespace, where `127.0.0.1` refers to the container itself, not the host. This is actually correct behavior, but the env var `HEALTH_BIND_HOST=127.0.0.1` could prevent health checks from being reached by an orchestrator (K8s kubelet) if the service is later migrated to K8s without adjusting the bind address.

**Impact:** Low — works correctly in Docker Compose but could cause health check failures in K8s migration.

**Recommendation:**  
Document that the health endpoint must bind to `0.0.0.0` when deployed in K8s (where kubelet probes from outside the pod network namespace).

---

### INFRA-L-05: No Branch Protection Enforcement in CI

**Severity:** LOW  
**File:** [.github/workflows/ci.yml](../.github/workflows/ci.yml#L3-L7)

**Description:**  
The CI triggers on `push` to `main` and `audit-fixes`, and on PRs to `main`. However, there is no verification that branch protection rules (required reviews, status checks, signed commits) are enforced — this is a GitHub repo setting, not a CI configuration issue. The audit-fixes branch bypasses PR requirements.

**Impact:** Direct pushes to `main` or `audit-fixes` skip peer review.

**Recommendation:**
1. Enable GitHub branch protection requiring: 1+ approving review, all status checks passing, no direct pushes.
2. Remove `audit-fixes` from the direct push trigger or require PRs for it too.

---

### INFRA-L-06: Validator Containers Share the Same Docker Image as Relay

**Severity:** LOW  
**File:** [relay/docker-compose.yml](../relay/docker-compose.yml#L154-L260)

**Description:**  
All three validator containers and the relay service use the same Dockerfile/image. The validators only need the validator service code, but the image includes relay, yield-sync, price-oracle, and lending-keeper code. This increases attack surface — a vulnerability in an unused service file could be exploited if an attacker gains code execution.

**Impact:** Larger attack surface than necessary per container.

**Recommendation:**  
Consider multi-Dockerfile builds or a monorepo build that produces separate slim images per service:
```
relay/Dockerfile.relay
relay/Dockerfile.validator
relay/Dockerfile.yield-sync
```

---

### INFRA-L-07: `points/` Has No `package.json` — Dependency Management Unknown

**Severity:** LOW  
**File:** `points/`

**Description:**  
The `points/` directory contains TypeScript source files and a `package-lock.json` (62KB) but no `package.json`. This means:
- Dependencies cannot be inspected or audited.
- `npm ci` cannot be run (it requires `package.json`).
- The lock file may be stale or inconsistent.

**Impact:** Unauditable dependencies for the points service.

**Recommendation:**  
Create a `points/package.json` declaring all dependencies, or move the points service into the root workspace.

---

### INFRA-L-08: No Container Image Signing or Attestation

**Severity:** LOW  
**File:** [.github/workflows/ci.yml](../.github/workflows/ci.yml) (docker job)

**Description:**  
The Docker build job builds and scans the image but does not sign it with Cosign/Sigstore or generate provenance attestations. Without signing, there is no cryptographic proof that a running image was built by the CI pipeline.

**Impact:** An attacker who compromises the container registry could replace images. Image consumers cannot verify provenance.

**Recommendation:**
1. Add Cosign signing after the Docker build:
   ```yaml
   - uses: sigstore/cosign-installer@v3
   - run: cosign sign musd-relay:ci
   ```
2. Generate SLSA provenance with `slsa-framework/slsa-github-generator`.

---

### INFRA-I-01: Well-Structured Secret Management Architecture

**Severity:** INFORMATIONAL (Positive)  
**Files:** [k8s/canton/external-secrets.yaml](../k8s/canton/external-secrets.yaml), [k8s/canton/secrets.yaml](../k8s/canton/secrets.yaml), [relay/docker-compose.yml](../relay/docker-compose.yml)

**Description:**  
Secret management follows best practices across both environments:
- **K8s:** External Secrets Operator integration with AWS Secrets Manager. Template `secrets.yaml` has empty `stringData: {}` to prevent accidental deployment with defaults. Proper documentation for manual creation.
- **Docker Compose:** Uses Docker Secrets (file-based) instead of environment variables for all sensitive values (private keys, API tokens, RPC URLs). The `.dockerignore` excludes the `secrets/` directory.
- **Git:** `.gitignore` covers `.env`, `.env.*`, `secrets/`, `*.pem`, `*.key`, `credentials.json`.

No credentials found in version control.

---

### INFRA-I-02: Excellent Network Security Posture

**Severity:** INFORMATIONAL (Positive)  
**File:** [k8s/canton/network-policy.yaml](../k8s/canton/network-policy.yaml)

**Description:**  
Network policies demonstrate defense-in-depth:
- **Default deny all** ingress and egress for the entire namespace.
- Per-component policies with least-privilege port access.
- PostgreSQL only accepts traffic from Canton participant.
- NGINX proxy blocks intra-cluster traffic (prevents pod-to-pod bypass of WAF).
- Backup pods have zero ingress and minimal egress.
- DNS egress is explicitly allowed per-policy (not via default-allow).

---

### INFRA-I-03: Strong Container Security Hardening

**Severity:** INFORMATIONAL (Positive)  
**Files:** All K8s deployments, [relay/Dockerfile](../relay/Dockerfile), [relay/docker-compose.yml](../relay/docker-compose.yml)

**Description:**  
Every container in the stack follows hardening best practices:
- `runAsNonRoot: true` with explicit UID/GID
- `allowPrivilegeEscalation: false`
- `capabilities.drop: ["ALL"]`
- `readOnlyRootFilesystem: true`
- `seccompProfile.type: RuntimeDefault`
- SHA256-pinned images (where real digests are available)
- Resource requests and limits on all containers
- Pod Security Standards `restricted` enforced at namespace level
- `automountServiceAccountToken: false` on all ServiceAccounts
- `no-new-privileges:true` in Docker Compose

---

### INFRA-I-04: Comprehensive CI Security Pipeline

**Severity:** INFORMATIONAL (Positive)  
**File:** [.github/workflows/ci.yml](../.github/workflows/ci.yml)

**Description:**  
The CI pipeline covers an unusually broad set of security tools for a DeFi project:

| Tool | Category | Pinned? |
|------|----------|---------|
| Slither | Solidity SAST | SHA ✅ |
| Mythril | Symbolic execution | ❌ (pip unpinned) |
| Certora | Formal verification | ❌ (pip unpinned) |
| Trivy | Container scanning | SHA ✅ |
| gitleaks | Secret scanning | SHA ✅ |
| npm audit | Dependency audit | N/A ✅ |
| audit-ci | Dependency audit | N/A ✅ |
| kubeconform | K8s validation | ❌ (wget unpinned) |
| Foundry | Fuzz/invariant testing | SHA ✅ |

All GitHub Actions are SHA-pinned with version comments. Global permissions are set to `contents: read` with `security-events: write` only.

---

### INFRA-I-05: Monitoring and Alerting Coverage

**Severity:** INFORMATIONAL (Positive)  
**Files:** [k8s/monitoring/prometheus-rules.yaml](../k8s/monitoring/prometheus-rules.yaml), [k8s/monitoring/service-monitors.yaml](../k8s/monitoring/service-monitors.yaml)

**Description:**  
Prometheus alerting rules cover 6 categories with security-relevant alerts:
1. **NGINX:** Rate-limit hits, TLS failures, 5xx spikes, 401/403 brute-force detection
2. **Canton:** Participant down, high latency, DB connection pool exhaustion
3. **Bridge:** Relay down, abnormal volume, validation failures, validator rate limits
4. **Oracle:** Circuit breaker open, price source divergence, stale feeds
5. **Database:** PostgreSQL down, high connections, disk usage
6. **Pods:** Restart loops, OOM kills

However, see INFRA-M-04 — label selector mismatches mean these monitors may not actually scrape metrics.

---

## Summary Table

| ID | Severity | File(s) | Title |
|----|----------|---------|-------|
| INFRA-CRIT-01 | **CRITICAL** | participant-deployment.yaml | Placeholder image digests — deployment will use unknown images |
| INFRA-H-01 | **HIGH** | ci.yml | No DAST in CI pipeline |
| INFRA-H-02 | **HIGH** | bot/, points/, frontend/ | Missing Dockerfiles for 3 services |
| INFRA-H-03 | **HIGH** | ci.yml | kubeconform downloaded without checksum |
| INFRA-M-01 | **MEDIUM** | ci.yml | DAML SDK via unauthenticated curl-pipe-bash |
| INFRA-M-02 | **MEDIUM** | ci.yml | Mythril installed without version pin |
| INFRA-M-03 | **MEDIUM** | ci.yml | Certora CLI installed without version pin |
| INFRA-M-04 | **MEDIUM** | service-monitors.yaml | ServiceMonitor label selectors don't match deployments |
| INFRA-M-05 | **MEDIUM** | postgres-backup-cronjob.yaml | Backups stored only within cluster — no off-site DR |
| INFRA-M-06 | **MEDIUM** | ci.yml | No SBOM generation |
| INFRA-L-01 | **LOW** | ci.yml, slither.config.json | 22+ Slither detectors excluded globally |
| INFRA-L-02 | **LOW** | hardhat.config.ts | Alchemy demo API key fallback |
| INFRA-L-03 | **LOW** | relay/tsconfig.json | Source maps emitted to production |
| INFRA-L-04 | **LOW** | relay/docker-compose.yml | Health check localhost binding portability concern |
| INFRA-L-05 | **LOW** | ci.yml | No branch protection enforcement verification |
| INFRA-L-06 | **LOW** | relay/docker-compose.yml | All services share one monolithic image |
| INFRA-L-07 | **LOW** | points/ | Missing package.json — unauditable deps |
| INFRA-L-08 | **LOW** | ci.yml | No container image signing or attestation |
| INFRA-I-01 | **INFO** | secrets.yaml, external-secrets.yaml | ✅ Strong secret management architecture |
| INFRA-I-02 | **INFO** | network-policy.yaml | ✅ Excellent network security (default-deny) |
| INFRA-I-03 | **INFO** | All deployments | ✅ Comprehensive container hardening |
| INFRA-I-04 | **INFO** | ci.yml | ✅ Broad security tooling in CI |
| INFRA-I-05 | **INFO** | prometheus-rules.yaml | ✅ Security-aware monitoring rules |

---

## Scores

### Infrastructure Security: 8.5 / 10

| Category | Score | Notes |
|----------|-------|-------|
| Kubernetes Hardening | 9.5/10 | Namespace PSS restricted, default-deny netpol, zero-permission RBAC, SHA-pinned images, read-only rootfs, seccomp profiles |
| Docker Security | 8.0/10 | Relay Dockerfile is excellent; 3 services lack Dockerfiles entirely |
| Secret Management | 9.0/10 | External Secrets Operator + Docker Secrets + proper .gitignore; no leaked credentials |
| Network Isolation | 9.0/10 | Default-deny + per-component policies; NGINX blocks intra-cluster bypass |
| TLS Configuration | 9.0/10 | TLSv1.2+1.3 only, strong cipher suite, HSTS preload, session tickets disabled, OCSP stapling |
| Supply Chain | 7.0/10 | GitHub Actions SHA-pinned; pip installs unpinned; kubeconform unpinned; no SBOM; no image signing |
| Image Digests | 7.5/10 | PostgreSQL, NGINX, busybox pinned to SHA256; Canton/DAML have placeholder digests |

### Operational Security: 7.8 / 10

| Category | Score | Notes |
|----------|-------|-------|
| CI/CD Pipeline | 8.5/10 | 9 security tools; SHA-pinned Actions; missing DAST and SBOM |
| Monitoring | 7.0/10 | Comprehensive alert rules but ServiceMonitor label mismatches may prevent scraping |
| Disaster Recovery | 6.0/10 | Daily PG backups with integrity check, but on-cluster only — no off-site DR |
| Dependency Auditing | 9.0/10 | npm audit + audit-ci + Trivy; npm overrides for transitive CVEs; all lock files present |
| Branch Protection | 7.0/10 | CI on PRs; `audit-fixes` branch allows direct push; no signed commit requirement |
| Runbook / Operations | 7.0/10 | Good inline comments in all K8s manifests; restore instructions documented; no formal runbook |

---

## Appendix: Files Reviewed

### Kubernetes (16 files)
- `k8s/base/namespace.yaml` — Namespace with PSS restricted
- `k8s/base/postgres-statefulset.yaml` — PostgreSQL StatefulSet + Service
- `k8s/canton/participant-deployment.yaml` — Canton + JSON API sidecar Deployment
- `k8s/canton/participant-config.yaml` — Canton ConfigMap
- `k8s/canton/nginx-deployment.yaml` — NGINX proxy Deployment + Service + PDB + BackendConfig
- `k8s/canton/nginx-configmap.yaml` — NGINX configuration with rate limiting
- `k8s/canton/network-policy.yaml` — 5 NetworkPolicies + default deny
- `k8s/canton/secrets.yaml` — Secret templates (empty values)
- `k8s/canton/external-secrets.yaml` — ExternalSecret CRDs for AWS SM
- `k8s/canton/serviceaccount.yaml` — 4 ServiceAccounts + RBAC + ClusterRole
- `k8s/canton/pod-disruption-budget.yaml` — PDBs for Canton + PostgreSQL
- `k8s/canton/postgres-backup-cronjob.yaml` — Backup CronJob + PVC
- `k8s/monitoring/prometheus-rules.yaml` — 16 alerting rules across 6 groups
- `k8s/monitoring/service-monitors.yaml` — 3 ServiceMonitors + 3 PodMonitors

### Docker (2 files)
- `relay/Dockerfile` — Multi-stage build with SHA-pinned base
- `relay/docker-compose.yml` — 5 services with Docker Secrets, resource limits, read-only rootfs

### CI/CD (1 file)
- `.github/workflows/ci.yml` — 12 jobs: solidity, foundry, security, mythril, daml, relay, docker, k8s-validate, audit, certora, secret-scan, storage-layout

### Configuration (6 files)
- `hardhat.config.ts` — Solidity 0.8.26, optimizer 200 runs
- `foundry.toml` — Fuzz 1024 runs, invariant 256 runs
- `slither.config.json` — 5 excluded detectors
- `tsconfig.json` (root) — strict mode
- `relay/tsconfig.json` — source maps enabled
- `audit-ci.json` — 1 GHSA allowlisted

### Package Security (5 package.json, 5 lock files)
- Root, relay/, bot/, frontend/ — 0 production vulnerabilities (npm audit)
- All lock files present and substantial (344KB–269KB)
- npm overrides applied for `fast-xml-parser`, `cross-spawn`, `tar`, `form-data`, `qs`, `tough-cookie`

### Secret/Ignore Files (4 files)
- `.gitignore` — covers `.env*`, `secrets/`, `*.pem`, `*.key`
- `relay/.dockerignore` — excludes `node_modules`, `.env`, `secrets/`
- `relay/.trivyignore` — 6 CVEs documented as mitigated via overrides
- `bot/.gitignore` — covers `.env`
