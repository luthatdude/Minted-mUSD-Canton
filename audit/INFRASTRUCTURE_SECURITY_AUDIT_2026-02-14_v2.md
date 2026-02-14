# Minted mUSD Protocol — Infrastructure & DevOps Security Audit

**Audit Date:** February 14, 2026  
**Auditor Role:** Infrastructure / DevOps Specialist  
**Scope:** Kubernetes manifests, Docker, CI/CD, build tooling, secret management, monitoring  
**Overall Infrastructure Maturity Score: 8.2 / 10**

---

## Executive Summary

The Minted mUSD Canton infrastructure demonstrates **strong security posture** overall. The team has clearly invested significant effort in hardening: SHA-pinned images, External Secrets Operator integration, file-mounted credentials (avoiding `/proc` exposure), Pod Security Standards `restricted` enforcement, default-deny NetworkPolicies, comprehensive Prometheus alerting, and cosign image signing in CI. This places the infrastructure ahead of the vast majority of DeFi protocol deployments.

**Key strengths:**
- All GitHub Actions pinned to SHA commit hashes
- Container images (core workloads) pinned to SHA256 digests
- Secret templates ship with empty `stringData: {}` — no default credentials
- External Secrets Operator integration with AWS Secrets Manager
- Restricted PSS labels on namespace, `readOnlyRootFilesystem`, `drop: ALL` capabilities
- Comprehensive network policies with default-deny baseline
- NGINX hardened with rate-limiting, strict TLS 1.2+, security headers, method filtering
- Loki log aggregation, Prometheus alerting with bridge and oracle-specific rules
- Docker Compose uses `read_only`, `no-new-privileges`, resource limits, Docker secrets
- SBOM generation (Syft) and Trivy image scanning in CI

**Areas requiring attention:** A handful of images lack SHA-pinning, monitoring pods are under-hardened, kubeconform is downloaded without integrity check, and the backup offsite configuration still has placeholder bucket names.

---

## Findings

### CRITICAL

*No critical findings.* All previously reported critical items (INFRA-CRIT-01 JWT generation, hardcoded secrets) have been remediated.

---

### HIGH

#### INFRA-H-01 — Unpinned Container Images in Monitoring & Sidecars

**Severity:** HIGH  
**Files:**
- [k8s/monitoring/loki-stack.yaml](k8s/monitoring/loki-stack.yaml#L102): `grafana/loki:3.3.2`
- [k8s/monitoring/loki-stack.yaml](k8s/monitoring/loki-stack.yaml#L263): `grafana/promtail:3.3.2`
- [k8s/base/postgres-statefulset.yaml](k8s/base/postgres-statefulset.yaml#L176): `bitnami/pgbouncer:1.23.1`
- [k8s/base/postgres-statefulset.yaml](k8s/base/postgres-statefulset.yaml#L256): `prometheuscommunity/postgres-exporter:v0.15.0`

**Description:** Four container images use mutable tags instead of SHA256 digests. All core workload images (postgres, nginx, canton, busybox, alpine) are correctly pinned, but these sidecar/monitoring images are not. An attacker who compromises these registries can inject malicious code via tag overwrite.

**Impact:** Supply-chain attack vector. A compromised `bitnami/pgbouncer` image would run in the same pod as PostgreSQL with access to mounted database credentials. A compromised `postgres-exporter` already reads DB credentials via `secretKeyRef` env vars.

**Recommendation:**
```yaml
# Pin each image. Example:
# docker pull bitnami/pgbouncer:1.23.1
# docker inspect --format='{{index .RepoDigests 0}}' bitnami/pgbouncer:1.23.1
image: bitnami/pgbouncer:1.23.1@sha256:<actual-digest>
image: prometheuscommunity/postgres-exporter:v0.15.0@sha256:<actual-digest>
image: grafana/loki:3.3.2@sha256:<actual-digest>
image: grafana/promtail:3.3.2@sha256:<actual-digest>
```

---

#### INFRA-H-02 — postgres-exporter Reads Credentials via Environment Variables

**Severity:** HIGH  
**File:** [k8s/base/postgres-statefulset.yaml](k8s/base/postgres-statefulset.yaml#L261-L272)

**Description:** The `postgres-exporter` sidecar reads `DATA_SOURCE_USER` and `DATA_SOURCE_PASS` via `secretKeyRef` env vars, unlike all other containers which use file-mounted secrets. Env vars are visible in `/proc/<pid>/environ` to any process in the same PID namespace.

```yaml
env:
  - name: DATA_SOURCE_USER
    valueFrom:
      secretKeyRef:
        name: postgres-credentials
        key: username
  - name: DATA_SOURCE_PASS
    valueFrom:
      secretKeyRef:
        name: postgres-credentials
        key: password
```

**Impact:** If an attacker gains shell access to any container in the pod (e.g., via a vulnerability in the postgres-exporter image), they can read the database password from `/proc/1/environ`.

**Recommendation:** Use postgres-exporter's `DATA_SOURCE_URI` or `DATA_SOURCE_NAME` with file-based credential loading. Alternatively, use the `--extend.query-path` with a pgpass file mounted from the secret. Wrap the entrypoint with `export DATA_SOURCE_PASS=$(cat /run/secrets/db-password)` like other sidecars.

---

#### INFRA-H-03 — kubeconform Downloaded Without Integrity Verification

**Severity:** HIGH  
**File:** [.github/workflows/ci.yml](.github/workflows/ci.yml#L448-L452)

**Description:** The K8s manifest validation job downloads kubeconform from GitHub Releases using `wget` with the `latest` tag and no checksum verification:

```yaml
- name: Install kubeconform
  run: |
    wget -q https://github.com/yannh/kubeconform/releases/latest/download/kubeconform-linux-amd64.tar.gz
    tar xf kubeconform-linux-amd64.tar.gz
    sudo mv kubeconform /usr/local/bin/
```

**Impact:** Supply-chain attack risk. If the GitHub Release is compromised or `latest` is overwritten, a malicious binary could be installed into the CI runner and could modify manifests, exfiltrate secrets, or tamper with the validation results.

**Recommendation:** Pin to a specific release version and verify the SHA256 checksum:
```yaml
- name: Install kubeconform
  run: |
    KUBECONFORM_VERSION="v0.6.7"
    EXPECTED_SHA="<pin-sha256-here>"
    wget -q "https://github.com/yannh/kubeconform/releases/download/${KUBECONFORM_VERSION}/kubeconform-linux-amd64.tar.gz"
    echo "${EXPECTED_SHA}  kubeconform-linux-amd64.tar.gz" | sha256sum --check --strict
    tar xf kubeconform-linux-amd64.tar.gz
    sudo mv kubeconform /usr/local/bin/
```

---

### MEDIUM

#### INFRA-M-01 — Monitoring Stack Pods Lack Hardened Security Contexts

**Severity:** MEDIUM  
**File:** [k8s/monitoring/loki-stack.yaml](k8s/monitoring/loki-stack.yaml#L90-L100)

**Description:** The Loki StatefulSet and Promtail DaemonSet have minimal security hardening compared to the Canton workloads:
- **Loki:** Has `runAsNonRoot: true` but lacks `seccompProfile`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, and `capabilities.drop: ["ALL"]`.
- **Promtail:** Runs as `runAsUser: 0` (root), which is necessary for reading host log paths, but lacks `readOnlyRootFilesystem` and `seccompProfile: RuntimeDefault`.
- **Neither** has `automountServiceAccountToken: false` on the ServiceAccount.

**Impact:** Increased blast radius if either monitoring pod is compromised. Loki could write arbitrary files; Promtail as root could escalate.

**Recommendation:**
- Add `seccompProfile: RuntimeDefault`, `allowPrivilegeEscalation: false`, `capabilities.drop: ["ALL"]`, and `readOnlyRootFilesystem: true` to Loki containers.
- Add `seccompProfile: RuntimeDefault`, `allowPrivilegeEscalation: false`, and `capabilities.drop: ["ALL"]` to Promtail (root is required for log reading, but privileges can still be restricted).
- Set `automountServiceAccountToken: false` on Loki SA. Promtail SA needs token for K8s API discovery but should have its scope audited.

---

#### INFRA-M-02 — Offsite Backup Buckets Still Have Placeholder Names

**Severity:** MEDIUM  
**File:** [k8s/canton/postgres-backup-cronjob.yaml](k8s/canton/postgres-backup-cronjob.yaml#L33-L36)

**Description:** The backup ConfigMap still contains placeholder values:
```yaml
BACKUP_S3_BUCKET: "REPLACE_WITH_ACTUAL_BUCKET_NAME"
BACKUP_GCS_BUCKET: "REPLACE_WITH_ACTUAL_GCS_BUCKET_NAME"
```

The CronJob gracefully handles this (warning log instead of failure), but in production this means **no off-site backups exist**. The backup script will log `WARNING: No BACKUP_S3_BUCKET or BACKUP_GCS_BUCKET set — backup is on-cluster only!`.

**Impact:** If the Kubernetes cluster is lost (cloud provider failure, accidental deletion, ransomware), all Canton ledger data is unrecoverable.

**Recommendation:** Before production deployment, create an S3/GCS bucket with versioning and encryption, update the ConfigMap, and verify at least one successful offsite backup. Add a Prometheus alert for missing offsite uploads.

---

#### INFRA-M-03 — NGINX ServiceMonitor Uses `insecureSkipVerify: true`

**Severity:** MEDIUM  
**File:** [k8s/monitoring/service-monitors.yaml](k8s/monitoring/service-monitors.yaml#L51)

**Description:**
```yaml
tlsConfig:
  insecureSkipVerify: true  # Self-signed internal cert for metrics scraping
```

**Impact:** Prometheus will accept any certificate when scraping NGINX metrics, allowing a MITM attacker in the cluster network to intercept or modify metrics data. While this is less severe than data-plane TLS bypass, falsified metrics could mask an ongoing attack.

**Recommendation:** Configure the ServiceMonitor with the internal CA certificate used by NGINX:
```yaml
tlsConfig:
  ca:
    secret:
      name: nginx-tls
      key: ca.crt
  insecureSkipVerify: false
```

---

#### INFRA-M-04 — Postgres StatefulSet HA Controller Not Deployed

**Severity:** MEDIUM  
**File:** [k8s/base/postgres-statefulset.yaml](k8s/base/postgres-statefulset.yaml#L68-L70)

**Description:** The StatefulSet runs 2 replicas for HA, but the annotations explicitly state no HA controller is deployed:
```yaml
musd.io/ha-status: "placeholder-requires-patroni-or-operator"
musd.io/ha-controller: "none — deploy Patroni, CrunchyPGO, or CloudNativePG"
```

Without a HA controller, the second pod is a cold standby with no replication, no automatic failover, and potential split-brain risk if both pods write to separate PVCs.

**Impact:** False HA — the team may believe they have database redundancy when they don't. The second pod may corrupt data or consume resources without providing failover.

**Recommendation:** Either deploy a HA controller (Patroni, CloudNativePG, or CrunchyData PGO) or reduce replicas back to 1 until a proper HA solution is implemented. Document this limitation.

---

#### INFRA-M-05 — JWT Token Generated in Init Container Has Static 1h Expiry

**Severity:** MEDIUM  
**File:** [k8s/canton/participant-deployment.yaml](k8s/canton/participant-deployment.yaml#L88-L107)

**Description:** The `generate-json-api-token` init container creates a JWT with a 1-hour expiry at pod startup. If the pod runs for longer than 1 hour (which it will — it's a Deployment), the JSON API token expires and the JSON API sidecar loses authentication.

```bash
EXP=$(($(date +%s) + 3600))
```

**Impact:** The JSON API will stop accepting authenticated requests after 1 hour, causing service disruption.

**Recommendation:** Either:
1. Implement a sidecar that periodically regenerates the JWT token (e.g., a CronJob-like loop in a sidecar container writing to the shared emptyDir volume).
2. Use a longer-lived token (e.g., 24h) with a pod restart strategy that runs well within the window.
3. Use the JSON API's native secret-based auth (`--secret-key-file`) which doesn't require pre-generated tokens.

---

#### INFRA-M-06 — Sepolia Fallback RPC Uses `demo` API Key

**Severity:** MEDIUM  
**File:** [hardhat.config.ts](hardhat.config.ts#L34)

**Description:**
```typescript
url: RPC_URL || "https://eth-sepolia.g.alchemy.com/v2/demo",
```

The `demo` Alchemy key has severe rate limits, may expose request patterns to anyone who knows the key, and could be deprecated at any time.

**Impact:** CI test runs or development against Sepolia may silently use the shared `demo` key, causing rate limiting or unreliable test results.

**Recommendation:** Remove the fallback entirely — fail fast if `RPC_URL` is not set:
```typescript
url: RPC_URL || (() => { throw new Error("RPC_URL env var required for Sepolia"); })(),
```

---

#### INFRA-M-07 — Loki ServiceAccount Does Not Disable Token Mounting

**Severity:** MEDIUM  
**File:** [k8s/monitoring/loki-stack.yaml](k8s/monitoring/loki-stack.yaml#L159-L163)

**Description:** The `loki` ServiceAccount doesn't set `automountServiceAccountToken: false`. Loki doesn't need Kubernetes API access, but will have a token mounted by default.

**Impact:** If Loki is compromised, the attacker gets a Kubernetes API token for free. While no explicit RBAC is bound, default permissions may still allow some API discovery.

**Recommendation:** Add `automountServiceAccountToken: false` to the Loki ServiceAccount.

---

#### INFRA-M-08 — DAML SDK Version Mismatch Between Image and `daml.yaml`

**Severity:** MEDIUM  
**File:** [k8s/canton/participant-deployment.yaml](k8s/canton/participant-deployment.yaml#L133-L137)

**Description:** The deployment uses `digitalasset/daml-sdk:2.9.3` but the CI job references `DAML_SDK_VERSION: "2.10.3"`. The comment in the deployment states:
```yaml
# TODO: Align with daml.yaml sdk-version (currently 2.10.3) when image becomes available
```

**Impact:** The Canton participant may run on an older SDK version with different behavior, bug fixes, or security patches than what was tested in CI.

**Recommendation:** Track and resolve this version mismatch. If 2.10.3 image is not yet available, document the delta and run integration tests against 2.9.3 specifically.

---

### LOW

#### INFRA-L-01 — PgBouncer Service Port Mapping Is Misleading

**Severity:** LOW  
**File:** [k8s/base/postgres-statefulset.yaml](k8s/base/postgres-statefulset.yaml#L33-L36)

**Description:** The Service maps port `5432` (standard PostgreSQL) to `targetPort: 6432` (PgBouncer). Clients connecting to what they think is PostgreSQL are actually hitting PgBouncer. While this is functional, it can cause confusion during incident response.

**Impact:** Operational confusion. Engineers debugging database issues may not realize they're connected through PgBouncer.

**Recommendation:** Either use port 6432 on the Service or add prominent documentation/annotations about the port redirection.

---

#### INFRA-L-02 — Configmap Checksum Annotation Is Placeholder

**Severity:** LOW  
**File:** [k8s/canton/participant-deployment.yaml](k8s/canton/participant-deployment.yaml#L57)

**Description:**
```yaml
checksum/config: "__INJECT_AT_DEPLOY_TIME__"
```

If the deploy pipeline forgets to inject the real hash, config changes won't trigger pod restarts.

**Impact:** Configuration drift — pods may run with stale configs after a ConfigMap update.

**Recommendation:** Use a Kustomize or Helm mechanism for automatic ConfigMap hash injection, or use a CI step that validates the annotation was replaced before `kubectl apply`.

---

#### INFRA-L-03 — `audit-ci.json` Allowlists One Vulnerability Without Expiry

**Severity:** LOW  
**File:** [audit-ci.json](audit-ci.json)

**Description:** `GHSA-37qj-frw5-hhjh` is allowlisted but there's no documented expiry or re-evaluation date. The comment says "mitigated via npm override" but the override should be verified periodically.

**Impact:** The allowlisted vulnerability may become exploitable if the override is removed or the package dependency changes.

**Recommendation:** Add a comment with the date when this was last verified and a scheduled review date. Consider setting up a CI job that checks whether allowlisted GHSAs are still relevant.

---

#### INFRA-L-04 — `Promtail` Runs as Root

**Severity:** LOW  
**File:** [k8s/monitoring/loki-stack.yaml](k8s/monitoring/loki-stack.yaml#L259)

**Description:** `runAsUser: 0` is required for Promtail to read `/var/log/pods` and `/var/lib/docker/containers`, but this is acknowledged with a comment. No further privilege restrictions are applied.

**Impact:** Accepted risk, but should be documented in the security posture documentation.

**Recommendation:** Already necessary; add `allowPrivilegeEscalation: false`, `capabilities.drop: ["ALL"]`, and `seccompProfile: RuntimeDefault` to limit what root can do.

---

### INFO

#### INFRA-I-01 — Comprehensive CI Pipeline (Positive Finding)

**Severity:** INFO (Positive)  
**File:** [.github/workflows/ci.yml](.github/workflows/ci.yml)

The CI pipeline includes:
- Hardhat compile/test/coverage with 90% threshold enforcement
- Foundry fuzz & invariant testing (1024 runs, 256 depth)
- Slither static analysis (reduced exclusions, `fail-on: high`)
- Mythril symbolic execution (build-failing, not advisory)
- UUPS storage layout validation
- Certora formal verification (build-failing)
- Docker build + Trivy scan (fail on CRITICAL/HIGH)
- SBOM generation (Syft) + cosign image signing
- K8s manifest validation (kubeconform)
- Dependency audit (`npm audit` + `audit-ci`)
- Gitleaks secret scanning
- DAML build & test with installer checksum verification

This is an **exemplary CI pipeline** for a DeFi protocol.

---

#### INFRA-I-02 — Docker Compose Security Hardening (Positive Finding)

**Severity:** INFO (Positive)  
**File:** [relay/docker-compose.yml](relay/docker-compose.yml)

All services use:
- Docker secrets (not env vars) for credentials
- `read_only: true` filesystem
- `no-new-privileges: true`
- Resource limits (CPU + memory)
- Localhost-bound health ports
- JSON file logging with rotation
- Network isolation (`bridge_internal` for inter-service, `bridge_external` for internet)

---

#### INFRA-I-03 — Secret Templates Ship Empty (Positive Finding)

**Severity:** INFO (Positive)  
**File:** [k8s/canton/secrets.yaml](k8s/canton/secrets.yaml)

Secret templates use `stringData: {}` and `data: ""` — deployment fails if secrets aren't configured. This is a **defense-in-depth** pattern that prevents accidental deployment with default credentials.

---

#### INFRA-I-04 — Default-Deny Network Policy Baseline (Positive Finding)

**Severity:** INFO (Positive)  
**File:** [k8s/canton/network-policy.yaml](k8s/canton/network-policy.yaml#L187-L200)

A catch-all default-deny policy exists:
```yaml
name: default-deny
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
```

Any new pod in the namespace starts with zero network access until explicitly granted.

---

#### INFRA-I-05 — Incident Runbook References Exist but Are Placeholders

**Severity:** INFO  
**File:** [k8s/monitoring/prometheus-rules.yaml](k8s/monitoring/prometheus-rules.yaml#L278-L313)

The `incident-runbook-references` ConfigMap has a well-structured index of alert-to-runbook mappings, but all URLs point to `docs.example.com`. Actual runbooks should be authored before production launch.

---

## Scoring Breakdown

| Category | Score | Notes |
|----------|-------|-------|
| **Secret Management** | 9/10 | ESO integration, file-mounted creds, empty templates, gitleaks scanning. Minor: postgres-exporter uses env vars |
| **Container Security** | 8/10 | SHA-pinned core images, restricted PSS, readonly rootfs. Minor: 4 images lack digest pins |
| **Network Security** | 9/10 | Default-deny, per-component policies, NGINX hardened with rate limits/WAF. Excellent |
| **CI/CD Security** | 9/10 | SHA-pinned Actions, Trivy/cosign/SBOM, Slither/Mythril/Certora build-breaking. Minor: kubeconform unverified download |
| **RBAC** | 9/10 | Zero-permission roles, automountServiceAccountToken: false, ClusterRole deny-all binding |
| **Monitoring & Alerting** | 8/10 | Prometheus rules for all layers (NGINX, Canton, bridge, oracle, DB, pods). Loki log aggregation. Runbooks are placeholder |
| **Backup & DR** | 6/10 | CronJob exists, integrity check, 30-day retention. But offsite bucket is placeholder, no restore testing documented |
| **TLS/Certificate Mgmt** | 8/10 | TLS enforced on Postgres, Canton Ledger API, NGINX. `sslmode=verify-full`. cert-manager documented but not deployed |
| **Build Tool Config** | 8/10 | Foundry 10K fuzz runs, Hardhat optimizer, Slither config tightened. Minor: demo Alchemy key fallback |

**Overall: 8.2 / 10**

---

## Priority Remediation Roadmap

| Priority | ID | Action |
|----------|----|--------|
| P1 | INFRA-H-01 | Pin all 4 remaining container images to SHA256 digests |
| P1 | INFRA-H-02 | Switch postgres-exporter to file-based credentials |
| P1 | INFRA-H-03 | Pin kubeconform version + verify checksum in CI |
| P2 | INFRA-M-02 | Configure actual offsite backup bucket before production |
| P2 | INFRA-M-04 | Deploy a HA controller (CloudNativePG recommended) or reduce to 1 replica |
| P2 | INFRA-M-05 | Fix JWT token 1h expiry (sidecar rotation or native JSON API auth) |
| P3 | INFRA-M-01 | Harden Loki/Promtail security contexts |
| P3 | INFRA-M-03 | Fix metrics TLS skip verify |
| P3 | INFRA-M-06 | Remove demo Alchemy fallback |
| P3 | INFRA-M-08 | Resolve DAML SDK version mismatch |

---

*Report generated by Infrastructure/DevOps Specialist Auditor — February 14, 2026*
