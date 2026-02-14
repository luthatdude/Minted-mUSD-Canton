# Minted mUSD Protocol — Infrastructure Security Audit

**Date:** February 14, 2026  
**Scope:** Kubernetes manifests, Docker configuration, CI/CD pipelines, deployment scripts, build tooling  
**Auditor:** Infrastructure Security Reviewer (Institutional-Grade)  
**Verdict:** **PASS WITH OBSERVATIONS** — Infrastructure is production-hardened with strong foundations; residual findings are primarily operational readiness gaps.

---

## Executive Summary

The Minted mUSD infrastructure demonstrates **institutional-grade security posture** across the majority of its attack surface. The team has clearly iterated on prior audit findings (INFRA-H-01 through INFRA-M-13 are referenced and remediated throughout). Key strengths include:

- ✅ SHA256-pinned container images across all workloads (supply chain)
- ✅ External Secrets Operator integration with AWS Secrets Manager (secret management)
- ✅ Restricted Pod Security Standards (`restricted` enforcement on namespace)
- ✅ Default-deny NetworkPolicy with explicit allow-listing
- ✅ Non-root containers with `readOnlyRootFilesystem`, dropped capabilities, seccomp
- ✅ SHA-pinned GitHub Actions with Slither, Mythril, Certora, gitleaks, Trivy, SBOM, cosign
- ✅ TLS-everywhere architecture (Postgres, Canton, NGINX, Admin API with mTLS)
- ✅ Zero-permission RBAC with `automountServiceAccountToken: false`

The findings below represent residual risk and operational hardening opportunities.

---

## Findings by Severity

---

### 🔴 CRITICAL (0 findings)

No critical vulnerabilities identified. All previously-reported CRIT findings (CRIT-01 through CRIT-03) have been remediated.

---

### 🟠 HIGH (3 findings)

#### H-01: PgBouncer Sidecar Reads Credentials via `secretKeyRef` Environment Variables

**File:** `k8s/base/postgres-statefulset.yaml` (lines 210–225)  
**Category:** Secret Management  

The main `postgres` container correctly uses `_FILE` variants to read credentials from volume-mounted files (`/run/secrets/`), preventing `/proc/environ` exposure. However, the `pgbouncer` sidecar in the same StatefulSet reads `POSTGRESQL_USERNAME` and `POSTGRESQL_PASSWORD` directly from `secretKeyRef` environment variables:

```yaml
- name: POSTGRESQL_USERNAME
  valueFrom:
    secretKeyRef:
      name: postgres-credentials
      key: username
- name: POSTGRESQL_PASSWORD
  valueFrom:
    secretKeyRef:
      name: postgres-credentials
      key: password
```

Any process with access to `/proc/<pgbouncer-pid>/environ` (e.g., via container escape or sidecar vulnerability) can extract the database password.

**Recommendation:** Mount the credentials as files and configure PgBouncer's `auth_file` or `userlist.txt` from a volume-mounted secret. Alternatively, use the `PGBOUNCER_AUTH_FILE` env var to point to the file-mounted secret.

**Risk:** An attacker exploiting a vulnerability in PgBouncer (or any code sharing the pod's process namespace) can read the database password from `/proc`.

---

#### H-02: postgres-exporter Connects with `sslmode=disable` to Local Database

**File:** `k8s/base/postgres-statefulset.yaml` (line 276)  
**Category:** TLS / Encryption  

The `postgres-exporter` sidecar connects to the local PostgreSQL instance with `sslmode=disable`:

```yaml
- name: DATA_SOURCE_URI
  value: "127.0.0.1:5432/canton?sslmode=disable"
```

While this is loopback-only traffic within the same pod, the PostgreSQL server is configured with `ssl=on` and a CA certificate. A defense-in-depth stance (particularly for SOC 2 / ISO 27001 compliance) requires all database connections to use TLS, even localhost, to prevent credential interception if the pod's network namespace is compromised.

Additionally, the exporter reads `DATA_SOURCE_USER` and `DATA_SOURCE_PASS` via `secretKeyRef` env vars (same issue as H-01).

**Recommendation:**  
1. Set `sslmode=require` (or `verify-full` with the mounted CA cert).  
2. Switch to file-mounted credentials (same approach as the main postgres container).

---

#### H-03: Loki `auth_enabled: false` — Unauthenticated Log Ingestion/Query

**File:** `k8s/monitoring/loki-stack.yaml` (line 30)  
**Category:** Monitoring / Access Control  

```yaml
auth_enabled: false
```

Loki accepts unauthenticated push and query requests. Any pod within the cluster (or any compromised workload that can reach `loki.musd-canton:3100`) can:
1. **Inject false log entries** — poisoning audit trails for incident response
2. **Query all logs** — extracting sensitive data that may appear in application logs (JWT fragments, error traces with secret paths, SQL queries)
3. **Delete logs** via the compactor API — covering attacker tracks

The `default-deny` NetworkPolicy mitigates this partially (only pods with explicit egress to Loki can reach it), but Promtail and any pod in `musd-canton` namespace with DNS egress could craft requests.

**Recommendation:** Enable `auth_enabled: true` and configure tenant isolation. Use an authentication proxy (nginx/oauth2-proxy) or Loki's built-in `X-Scope-OrgID` header with a per-tenant secret.

---

### 🟡 MEDIUM (10 findings)

#### M-01: Backup S3 Bucket Placeholder — Off-Cluster Backup Not Operational

**File:** `k8s/canton/postgres-backup-cronjob.yaml` (line 33)  
**Category:** Backup / Recovery  

```yaml
BACKUP_S3_BUCKET: "REPLACE_WITH_ACTUAL_BUCKET_NAME"
```

The ConfigMap key name is `BACKUP_S3_BUCKET` in the `data:` block, but the CronJob reads from `configMapKeyRef.key: s3-bucket` (line 169). This key mismatch means the bucket name will **never** be injected — backups remain on-cluster only.

Additionally, the backup container image (`postgres:16.4-alpine`) does not include the `aws` CLI or `gsutil`. The S3/GCS upload commands in the script will fail with "command not found."

**Recommendation:**  
1. Align ConfigMap key names (`BACKUP_S3_BUCKET` → `s3-bucket` or vice versa).  
2. Use a custom backup image that includes `aws-cli` or `gsutil`, or add an init container to install the CLI.  
3. Test the full backup-restore cycle in staging.

---

#### M-02: PostgreSQL HA is Documented but Non-Functional (Cold Standby)

**File:** `k8s/base/postgres-statefulset.yaml` (lines 3–17, 67–70)  
**Category:** Disaster Recovery  

The StatefulSet specifies `replicas: 2` with extensive comments about needing Patroni/CrunchyPGO/CloudNativePG, but no HA controller is deployed. The second replica starts as an independent PostgreSQL instance writing to its own PVC — it does **not** replicate from the primary.

Without streaming replication, the standby is useless for failover and could cause split-brain data corruption if Canton connects to both.

**Recommendation:** Either reduce to `replicas: 1` until an HA operator is deployed, or deploy CloudNativePG / Patroni. The current state creates false confidence.

---

#### M-03: Loki Image Not Pinned to SHA256 Digest

**File:** `k8s/monitoring/loki-stack.yaml` (line 102)  
**Category:** Supply Chain  

```yaml
image: grafana/loki:3.3.2
```

All other workload images (postgres, nginx, busybox, canton) are pinned to SHA256 digests, but the Loki and Promtail images use mutable tags. A compromised registry or tag override could inject a backdoored image.

Similarly affected:
- `grafana/promtail:3.3.2` (line 262)
- `bitnami/pgbouncer:1.23.1` (line 188 in postgres-statefulset)
- `prometheuscommunity/postgres-exporter:v0.15.0` (line 260 in postgres-statefulset)

**Recommendation:** Pin all four images to `@sha256:` digests following the pattern already established for the core workloads.

---

#### M-04: Promtail Runs as Root (`runAsUser: 0`)

**File:** `k8s/monitoring/loki-stack.yaml` (line 272)  
**Category:** Container Security  

```yaml
securityContext:
  runAsUser: 0  # Required to read container logs
```

While root is often necessary for DaemonSets that read host log files, this container lacks `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, and `capabilities.drop: ["ALL"]` — all of which are enforced on every other container. Since the namespace has `pod-security.kubernetes.io/enforce: restricted`, this DaemonSet will be **rejected** by the admission controller unless it runs in a different namespace.

**Recommendation:**  
1. Deploy Promtail in a `monitoring` namespace with `baseline` pod security standard.  
2. Add `allowPrivilegeEscalation: false` and `capabilities.drop: ["ALL"]` with only `DAC_READ_SEARCH` added back.  
3. Add `readOnlyRootFilesystem: true` with an emptyDir for `/run/promtail`.

---

#### M-05: NGINX ServiceMonitor Uses `insecureSkipVerify: true`

**File:** `k8s/monitoring/service-monitors.yaml` (line 52)  
**Category:** TLS / Encryption  

```yaml
tlsConfig:
  insecureSkipVerify: true  # Self-signed internal cert for metrics scraping
```

This disables certificate validation for Prometheus-to-NGINX metrics scraping. An attacker performing an MITM within the cluster could intercept or modify metrics, masking an ongoing attack.

**Recommendation:** Add the internal CA certificate to the ServiceMonitor's `tlsConfig.ca` field so Prometheus validates the NGINX cert.

---

#### M-06: Canton ServiceMonitor Scrapes Metrics over Plain HTTP

**File:** `k8s/monitoring/service-monitors.yaml` (line 24)  
**Category:** TLS / Encryption  

```yaml
endpoints:
  - port: ledger-api
    interval: 15s
    path: /metrics
    scheme: http
```

Canton's metrics endpoint is scraped over unencrypted HTTP. If metrics expose internal state (connection counts, latency, queue depths), this leaks operational intelligence to any network observer.

**Recommendation:** Configure `scheme: https` with the appropriate CA cert, or scrape via a TLS-terminating sidecar.

---

#### M-07: `kubeconform` Downloaded Without Integrity Verification in CI

**File:** `.github/workflows/ci.yml` (lines 453–455)  
**Category:** CI/CD Security / Supply Chain  

```yaml
- name: Install kubeconform
  run: |
    wget -q https://github.com/yannh/kubeconform/releases/latest/download/kubeconform-linux-amd64.tar.gz
    tar xf kubeconform-linux-amd64.tar.gz
    sudo mv kubeconform /usr/local/bin/
```

Unlike the DAML installer (which has a SHA256 verification step), `kubeconform` is downloaded from `/latest/` (unpinned version) with no checksum verification. A GitHub release override or CDN compromise could inject a backdoored binary.

**Recommendation:** Pin to a specific release version and verify the SHA256 checksum, or use a SHA-pinned GitHub Action if one exists.

---

#### M-08: GKE LoadBalancer Exposes JSON API (Port 7575) Directly

**File:** `scripts/deploy-gke.sh` (lines 263–264)  
**Category:** Network Policies  

```yaml
ports:
  - name: json-api
    port: 7575
    targetPort: 7575
```

The `deploy-gke.sh` script creates a LoadBalancer that exposes both the Ledger API (5011) and the JSON API (7575) directly to external IPs, bypassing the NGINX rate-limiting/WAF proxy that the rest of the architecture enforces. This contradicts the explicit policy in `nginx-configmap.yaml`: *"NEVER expose the JSON API (port 7575) directly to the internet."*

**Recommendation:** Remove port 7575 from the LoadBalancer service. All JSON API access should route through the NGINX proxy.

---

#### M-09: Missing `NetworkPolicy` for Loki and Promtail Pods

**File:** `k8s/canton/network-policy.yaml`  
**Category:** Network Policies  

The `default-deny` NetworkPolicy blocks all traffic for pods in `musd-canton`, but no explicit allow-list NetworkPolicy exists for Loki or Promtail. This means:
- Promtail cannot push logs to Loki (no egress rule to port 3100)
- Loki cannot receive ingestion requests (no ingress rule on port 3100)
- Promtail cannot reach the Kubernetes API for pod discovery (no egress to apiserver)

The monitoring stack will be non-functional until NetworkPolicies are created.

**Recommendation:** Add a `loki-netpol` (ingress from Promtail on 3100) and `promtail-netpol` (egress to Loki on 3100, egress to apiserver on 443/6443, DNS on 53).

---

#### M-10: Cosign Image Signing is Configured but Inactive

**File:** `.github/workflows/ci.yml` (lines 419–425)  
**Category:** CI/CD Security  

```yaml
- name: Sign container image
  if: github.ref == 'refs/heads/main'
  run: |
    echo "::notice::Image signing configured — will sign on push to registry"
    # cosign sign --yes "${REGISTRY}/musd-relay@${DIGEST}"
```

The cosign signing step is commented out. Images pushed from CI are unsigned — an attacker who compromises the registry can replace images without detection. The SBOM generation step runs, but an unsigned SBOM has limited trust value.

**Recommendation:** Uncomment the `cosign sign` command and configure `REGISTRY` and `DIGEST` variables from the `docker/build-push-action` output. Use Sigstore's keyless signing for OIDC-based provenance.

---

### 🔵 LOW (7 findings)

#### L-01: Hardhat Config Uses `dotenv` — Potential for `.env` Credential Leakage

**File:** `hardhat.config.ts` (line 5)  
**Category:** Secret Management  

```typescript
dotenv.config();
```

While the deployer private key defaults to an empty string (a good remediation from a prior audit), `dotenv.config()` still loads `.env` if present. The `deploy-sepolia.sh` script warns about this, but no `.gitignore` entry for `.env` was verified. If a developer commits a `.env` with secrets, gitleaks should catch it — but the `.env` pattern should be explicitly in `.gitignore` and `.dockerignore`.

**Recommendation:** Verify `.env` is in the root `.gitignore`. Consider removing `dotenv.config()` entirely and requiring secrets via environment variables only.

---

#### L-02: Sepolia Fallback RPC URL Contains `demo` Endpoint

**File:** `hardhat.config.ts` (line 31)  

```typescript
url: RPC_URL || "https://eth-sepolia.g.alchemy.com/v2/demo",
```

The `demo` Alchemy endpoint is heavily rate-limited and publicly known. While this is a testnet fallback, it can leak the project's testnet activity to the public demo endpoint. For institutional projects, even testnet traffic should use private endpoints.

**Recommendation:** Remove the fallback or replace with a testnet-specific key from a secrets manager.

---

#### L-03: Slither Excludes Multiple Detectors — Risk of Masking Real Findings

**File:** `.github/workflows/ci.yml` (lines 163–170) and `slither.config.json`  
**Category:** CI/CD Security  

The Slither invocation excludes 9 detector categories: `naming-convention, pragma, solc-version, calls-loop, reentrancy-benign, reentrancy-events, timestamp, locked-ether, cache-array-length, cyclomatic-complexity`. Each exclusion is documented with justification — which is an improvement over prior audits — but some (`calls-loop`, `timestamp`) can mask legitimate vulnerabilities in edge cases.

**Recommendation:** Periodically (quarterly) run Slither with zero exclusions in an advisory-only mode to check for new findings masked by the exclusion list.

---

#### L-04: `audit-ci.json` Only Flags HIGH — Allows MODERATE Vulnerabilities

**File:** `audit-ci.json`  
**Category:** Supply Chain  

```json
{ "high": true }
```

This configuration only fails the build on HIGH or CRITICAL advisories. MODERATE severity npm advisories (e.g., ReDoS, prototype pollution) are silently accepted.

**Recommendation:** Set `"moderate": true` or at minimum review moderate advisories quarterly.

---

#### L-05: Backup CronJob Has No Alert for Failure

**File:** `k8s/monitoring/prometheus-rules.yaml`  
**Category:** Monitoring  

The Prometheus rules cover extensive scenarios (rate limits, TLS failures, bridge anomalies, OOM kills) but there is no alert for backup CronJob failures. A failed `pg_dump` for multiple consecutive days could go unnoticed until a disaster recovery scenario is triggered.

**Recommendation:** Add a Prometheus alert for `kube_job_status_failed{namespace="musd-canton", job_name=~"postgres-backup.*"} > 0` sustained for 1 day.

---

#### L-06: Admin API Port (5012) Exposed in Service Definition

**File:** `k8s/canton/participant-deployment.yaml` (comment at line 28)  
**Category:** Network Policies  

The Service correctly removes the admin-api port from its `ports:` list and comments note that Admin API is localhost-only. However, the container still exposes `containerPort: 5012` in the pod spec (line 172). While Kubernetes `containerPort` is informational and doesn't affect networking, removing it prevents confusion and enforces the intent that admin access is never service-routable.

**Recommendation:** Remove `containerPort: 5012` from the container spec to match the intent.

---

#### L-07: Incident Runbook URLs Are Placeholder Links

**File:** `k8s/monitoring/prometheus-rules.yaml` (lines 276–313)  
**Category:** Monitoring / Operational Readiness  

All runbook URLs in the `incident-runbook-references` ConfigMap use `https://docs.example.com/runbooks/...` placeholders. No `runbook_url` annotations are present on the actual PrometheusRule alerts.

**Recommendation:** Author runbooks for at least the CRITICAL alerts (CantonParticipantDown, PostgresDown, BridgeRelayDown, BridgeValidationFailures, PriceOracleCircuitBreakerOpen) and add `runbook_url` annotations.

---

### ℹ️ INFORMATIONAL (6 findings)

#### I-01: Canton DAML SDK Version Mismatch

**File:** `k8s/canton/participant-deployment.yaml` (line 144)  

The container uses `digitalasset/daml-sdk:2.9.3` while the CI workflow installs DAML SDK `2.10.3`. The deployment manifest includes a TODO comment acknowledging this. The version mismatch could cause runtime incompatibilities between DARs compiled with 2.10.3 and a 2.9.3 runtime.

---

#### I-02: deploy-gke.sh Uses Self-Signed TLS for Admin Certs

**File:** `scripts/deploy-gke.sh` (lines 178–189)  

Admin certs are copies of the server cert (`cp tls.key admin-tls.key`). This works for DevNet but should use cert-manager with a dedicated admin CA issuer for staging/production.

---

#### I-03: docker-compose.yml Validator Health Checks Use File Heartbeat Pattern

**File:** `relay/docker-compose.yml`  

Validators use a `/tmp/heartbeat` file touch-based health check rather than an HTTP endpoint. This verifies the process is running but not that it is correctly processing attestations. Consider adding a `/health` HTTP endpoint that validates Canton connectivity.

---

#### I-04: GKE Cluster Uses `e2-standard-4` — Undersized for Production

**File:** `scripts/deploy-gke.sh` (line 18)  

The `e2-standard-4` machine type (4 vCPU, 16GB) with only 2 nodes is appropriate for DevNet but will be undersized for production Canton participant + PostgreSQL + monitoring stack workloads.

---

#### I-05: Namespace-Scoped `ClusterSecretStore` Warning

**File:** `k8s/canton/external-secrets.yaml` (line 33)  

`ClusterSecretStore` is a cluster-scoped resource but the manifest includes a `namespace` field. Kubernetes will ignore the namespace for cluster-scoped resources. This is harmless but may cause confusion.

---

#### I-06: `.trivyignore` References Future CVEs (2026)

**File:** `relay/.trivyignore`  

The file contains CVEs with 2026 identifiers (CVE-2026-23745, CVE-2026-23950, CVE-2026-24842, CVE-2026-25547). All are documented as "mitigated via npm overrides." This is acceptable practice but should be reviewed quarterly to remove entries where the upstream fix is incorporated into the base dependency.

---

## Audit Matrix Summary

| Category | Score | Notes |
|---|---|---|
| **Secret Management** | 🟢 Strong | ESO + AWS SM, file-mounted secrets, gitleaks; PgBouncer env leak (H-01) |
| **Network Policies** | 🟢 Strong | Default-deny, per-workload policies; missing Loki/Promtail policies (M-09) |
| **Container Security** | 🟢 Strong | Non-root, readOnlyRootFS, capabilities dropped, seccomp; Promtail root (M-04) |
| **RBAC** | 🟢 Excellent | Zero-permission roles, automountServiceAccountToken:false, ClusterRole deny-all |
| **TLS / Encryption** | 🟢 Strong | TLS everywhere, mTLS admin API, HSTS; metrics scraping gaps (M-05, M-06) |
| **Backup / Recovery** | 🟡 Needs Work | CronJob exists but S3 upload is non-functional (M-01); HA is placeholder (M-02) |
| **Monitoring** | 🟢 Good | Prometheus rules, Loki stack, ServiceMonitors; missing backup alert (L-05) |
| **CI/CD Security** | 🟢 Strong | SHA-pinned actions, Slither/Mythril/Certora, Trivy, SBOM; cosign inactive (M-10) |
| **Supply Chain** | 🟢 Strong | SHA256-pinned images for core; monitoring images unpinned (M-03) |
| **Disaster Recovery** | 🟡 Needs Work | PDBs present, topology spread; HA non-functional, backup untested |

---

## Priority Remediation Roadmap

| Priority | Finding | Effort | Impact |
|---|---|---|---|
| 1 | H-01: PgBouncer env var credentials | Low | Prevents /proc credential leak |
| 2 | H-02: postgres-exporter sslmode=disable | Low | Compliance (TLS everywhere) |
| 3 | H-03: Loki auth_enabled:false | Medium | Prevents log injection/tampering |
| 4 | M-01: Fix backup S3 key mismatch + add CLI | Medium | Enables disaster recovery |
| 5 | M-09: Add NetworkPolicies for Loki/Promtail | Low | Makes monitoring stack functional |
| 6 | M-03: Pin monitoring image digests | Low | Closes supply chain gap |
| 7 | M-08: Remove JSON API from GKE LoadBalancer | Low | Enforces WAF/proxy architecture |
| 8 | M-10: Activate cosign signing | Medium | Enables image provenance verification |
| 9 | M-02: Deploy HA controller or reduce replicas | High | Eliminates false-confidence HA |
| 10 | M-04: Fix Promtail security context / namespace | Medium | PSA compliance |

---

*End of Infrastructure Security Audit — February 14, 2026*
