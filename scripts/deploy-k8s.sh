#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════
# Minted mUSD Canton — Kubernetes Deploy Script
# Applies all manifests to the musd-canton namespace in
# dependency order with pre-flight checks and rollout verification.
#
# Usage:
#   ./scripts/deploy-k8s.sh                          # Full deploy (legacy)
#   ./scripts/deploy-k8s.sh --dry-run                # Validate only
#   ./scripts/deploy-k8s.sh --component relay        # Deploy relay only
#   ./scripts/deploy-k8s.sh --skip-secrets           # Skip secret creation prompts
#   ./scripts/deploy-k8s.sh --overlay dev            # Deploy using Kustomize dev overlay
#   ./scripts/deploy-k8s.sh --overlay staging        # Deploy using Kustomize staging overlay
#   ./scripts/deploy-k8s.sh --overlay prod           # Deploy using Kustomize prod overlay
#
# Prerequisites:
#   - kubectl configured with cluster access
#   - Namespace musd-canton exists (or this script creates it)
#   - Secrets created (see k8s/canton/secrets.yaml or external-secrets.yaml)
#   - kustomize CLI (for --overlay mode): https://kubectl.docs.kubernetes.io/installation/kustomize/
# ══════════════════════════════════════════════════════════════

set -euo pipefail

# ── Color output ───────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── Script directory ───────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
K8S_DIR="$REPO_ROOT/k8s"

# ── Parse arguments ───────────────────────────────────────────
DRY_RUN=""
COMPONENT=""
SKIP_SECRETS=false
NAMESPACE="musd-canton"
OVERLAY=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)
      DRY_RUN="--dry-run=client"
      echo -e "${YELLOW}⚠️  DRY RUN MODE — no changes will be applied${NC}"
      shift
      ;;
    --component)
      COMPONENT="$2"
      shift 2
      ;;
    --skip-secrets)
      SKIP_SECRETS=true
      shift
      ;;
    --namespace)
      NAMESPACE="$2"
      shift 2
      ;;
    --overlay)
      OVERLAY="$2"
      if [[ ! "$OVERLAY" =~ ^(dev|staging|prod)$ ]]; then
        echo -e "${RED}Invalid overlay: $OVERLAY (must be dev, staging, or prod)${NC}"
        exit 1
      fi
      shift 2
      ;;
    -h|--help)
      head -20 "$0" | tail -14
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown argument: $1${NC}"
      exit 1
      ;;
  esac
done

# ── Helper functions ──────────────────────────────────────────
step() {
  echo ""
  echo -e "${CYAN}━━━ $1 ━━━${NC}"
}

ok() {
  echo -e "  ${GREEN}✅ $1${NC}"
}

warn() {
  echo -e "  ${YELLOW}⚠️  $1${NC}"
}

fail() {
  echo -e "  ${RED}❌ $1${NC}"
  exit 1
}

apply() {
  local file="$1"
  local label="${2:-$(basename "$file")}"
  if [ ! -f "$file" ]; then
    warn "File not found: $file — skipping"
    return
  fi
  echo -e "  Applying ${CYAN}${label}${NC}..."
  kubectl apply -f "$file" $DRY_RUN
  ok "$label"
}

wait_rollout() {
  local kind="$1" name="$2" timeout="${3:-120s}"
  if [ -n "$DRY_RUN" ]; then return; fi
  echo -e "  Waiting for ${CYAN}${kind}/${name}${NC} rollout (timeout ${timeout})..."
  if kubectl rollout status "$kind/$name" -n "$NAMESPACE" --timeout="$timeout" 2>/dev/null; then
    ok "$kind/$name is ready"
  else
    warn "$kind/$name rollout not complete within $timeout — continuing"
  fi
}

# ── Pre-flight checks ─────────────────────────────────────────
step "Pre-flight checks"

# 1. kubectl available
if ! command -v kubectl &>/dev/null; then
  fail "kubectl not found — install from https://kubernetes.io/docs/tasks/tools/"
fi
ok "kubectl found: $(kubectl version --client --short 2>/dev/null || kubectl version --client -o yaml | grep gitVersion | head -1)"

# 2. Cluster reachable
if ! kubectl cluster-info &>/dev/null; then
  fail "Cannot reach Kubernetes cluster — check your kubeconfig"
fi
CLUSTER=$(kubectl config current-context)
ok "Connected to cluster: $CLUSTER"

# 3. Placeholder digest check (CRIT-03)
PLACEHOLDER_HITS=$(grep -rn \
  -e 'sha256:0000000000000000000000000000000000000000000000000000000000000000' \
  -e 'MUST_REPLACE' \
  -e 'sha256:placeholder' \
  "$K8S_DIR" --include='*.yaml' 2>/dev/null || true)
if [ -n "$PLACEHOLDER_HITS" ]; then
  warn "Placeholder image digests found — replace before production deployment:"
  echo "$PLACEHOLDER_HITS" | head -10
  echo ""
  read -p "Continue anyway? (y/N): " -r
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    fail "Deploy aborted — fix placeholder digests first"
  fi
fi

# 4. Placeholder bucket check (F-02)
BUCKET_HITS=$(grep -rn 'REPLACE_WITH_ACTUAL' "$K8S_DIR" --include='*.yaml' 2>/dev/null || true)
if [ -n "$BUCKET_HITS" ]; then
  warn "Placeholder values found (backup buckets, etc.):"
  echo "$BUCKET_HITS" | head -5
fi

echo ""
echo -e "${CYAN}Deploying to namespace: ${NAMESPACE}${NC}"
echo -e "${CYAN}Cluster context:        ${CLUSTER}${NC}"
if [ -n "$OVERLAY" ]; then
  echo -e "${CYAN}Kustomize overlay:      ${OVERLAY}${NC}"
fi
if [ -n "$DRY_RUN" ]; then
  echo -e "${YELLOW}Mode: DRY RUN${NC}"
fi
echo ""
if [ -z "$DRY_RUN" ]; then
  read -p "Proceed with deployment? (y/N): " -r
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# ══════════════════════════════════════════════════════════════
# KUSTOMIZE OVERLAY DEPLOY (if --overlay specified)
# Builds the full environment-specific manifest and applies it.
# This replaces the phase-by-phase deploy below.
# ══════════════════════════════════════════════════════════════
if [ -n "$OVERLAY" ]; then
  OVERLAY_DIR="$K8S_DIR/overlays/$OVERLAY"

  if [ ! -f "$OVERLAY_DIR/kustomization.yaml" ]; then
    fail "Overlay not found: $OVERLAY_DIR/kustomization.yaml"
  fi

  # Verify kustomize is available
  if command -v kustomize &>/dev/null; then
    KUSTOMIZE_CMD="kustomize build"
  elif kubectl kustomize --help &>/dev/null 2>&1; then
    KUSTOMIZE_CMD="kubectl kustomize"
  else
    fail "Neither kustomize CLI nor kubectl kustomize found. Install: https://kubectl.docs.kubernetes.io/installation/kustomize/"
  fi

  step "Building Kustomize overlay: $OVERLAY"
  echo -e "  ${CYAN}$KUSTOMIZE_CMD $OVERLAY_DIR${NC}"

  # Validate the overlay builds cleanly
  if ! $KUSTOMIZE_CMD "$OVERLAY_DIR" > /dev/null 2>&1; then
    fail "Kustomize build failed for overlay $OVERLAY — fix errors first"
  fi
  ok "Kustomize build validated"

  # ── PROD SAFETY: Block deploy if REPLACE_WITH placeholders remain ──
  if [ "$OVERLAY" = "prod" ]; then
    RENDERED=$($KUSTOMIZE_CMD "$OVERLAY_DIR")
    PLACEHOLDER_FOUND=$(echo "$RENDERED" | grep -c 'REPLACE_WITH' || true)
    if [ "$PLACEHOLDER_FOUND" -gt 0 ]; then
      echo "$RENDERED" | grep --color=always 'REPLACE_WITH' | head -10
      echo ""
      fail "Production overlay still contains $PLACEHOLDER_FOUND REPLACE_WITH placeholder(s). Update k8s/overlays/prod/kustomization.yaml with real mainnet values before deploying."
    fi
    ok "No REPLACE_WITH placeholders in rendered production manifests"
  fi

  # Apply (or dry-run)
  step "Applying $OVERLAY overlay"
  $KUSTOMIZE_CMD "$OVERLAY_DIR" | kubectl apply $DRY_RUN -f -
  ok "All resources applied via Kustomize ($OVERLAY)"

  # Determine namespace from overlay
  case "$OVERLAY" in
    dev)     NAMESPACE="musd-canton-dev" ;;
    staging) NAMESPACE="musd-canton-staging" ;;
    prod)    NAMESPACE="musd-canton" ;;
  esac

  if [ -z "$DRY_RUN" ]; then
    step "Waiting for rollouts ($OVERLAY)"
    wait_rollout "statefulset" "postgres" "180s" 2>/dev/null || true
    wait_rollout "deployment" "canton-participant" "180s" 2>/dev/null || true
    wait_rollout "deployment" "nginx-proxy" "120s" 2>/dev/null || true
    wait_rollout "deployment" "bridge-relay" "120s" 2>/dev/null || true
    wait_rollout "deployment" "liquidation-bot" "120s" 2>/dev/null || true

    step "Post-deploy verification ($OVERLAY)"
    echo "  Pods in $NAMESPACE:"
    kubectl get pods -n "$NAMESPACE" -o wide --no-headers 2>/dev/null | while read -r line; do
      POD_STATUS=$(echo "$line" | awk '{print $3}')
      if [ "$POD_STATUS" = "Running" ] || [ "$POD_STATUS" = "Completed" ]; then
        echo -e "    ${GREEN}●${NC} $line"
      else
        echo -e "    ${RED}●${NC} $line"
      fi
    done

    echo ""
    echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  ✅ Kustomize deployment complete ($OVERLAY)!${NC}"
    echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
  else
    echo ""
    echo -e "${GREEN}✅ Kustomize dry run complete ($OVERLAY) — all manifests validated${NC}"
  fi

  exit 0
fi

# ══════════════════════════════════════════════════════════════
# PHASE 1: Namespace & RBAC
# ══════════════════════════════════════════════════════════════
if [ -z "$COMPONENT" ] || [ "$COMPONENT" = "base" ]; then
  step "Phase 1: Namespace & RBAC"
  apply "$K8S_DIR/base/namespace.yaml" "namespace"
  apply "$K8S_DIR/canton/serviceaccount.yaml" "service accounts"
fi

# ══════════════════════════════════════════════════════════════
# PHASE 2: Secrets & ConfigMaps
# ══════════════════════════════════════════════════════════════
if [ -z "$COMPONENT" ] || [ "$COMPONENT" = "secrets" ]; then
  step "Phase 2: Secrets & ConfigMaps"

  if [ "$SKIP_SECRETS" = false ] && [ -z "$DRY_RUN" ]; then
    # Check if required secrets already exist
    if kubectl get secret postgres-credentials -n "$NAMESPACE" &>/dev/null; then
      ok "postgres-credentials secret exists"
    else
      warn "postgres-credentials secret missing — create with:"
      echo "    kubectl create secret generic postgres-credentials \\"
      echo "      --namespace=$NAMESPACE \\"
      echo "      --from-literal=username=canton_user \\"
      echo "      --from-literal=password=\$(openssl rand -base64 32)"
      echo ""
    fi

    if kubectl get secret bridge-relay-secrets -n "$NAMESPACE" &>/dev/null; then
      ok "bridge-relay-secrets secret exists"
    else
      warn "bridge-relay-secrets secret missing — create with kubectl"
    fi
  fi

  # Apply secret templates (empty — won't overwrite existing)
  apply "$K8S_DIR/canton/secrets.yaml" "secret templates"
  apply "$K8S_DIR/canton/participant-config.yaml" "participant config"
  apply "$K8S_DIR/canton/nginx-configmap.yaml" "nginx configmap"

  # External Secrets (if ESO is installed)
  if kubectl api-resources | grep -q externalsecrets 2>/dev/null; then
    apply "$K8S_DIR/canton/external-secrets.yaml" "external secrets"
    ok "External Secrets Operator detected — ESO resources applied"
  else
    warn "External Secrets Operator not installed — using manual secrets"
  fi
fi

# ══════════════════════════════════════════════════════════════
# PHASE 3: Database (PostgreSQL)
# ══════════════════════════════════════════════════════════════
if [ -z "$COMPONENT" ] || [ "$COMPONENT" = "postgres" ]; then
  step "Phase 3: PostgreSQL StatefulSet"
  apply "$K8S_DIR/base/postgres-statefulset.yaml" "postgres statefulset"
  wait_rollout "statefulset" "postgres" "180s"
fi

# ══════════════════════════════════════════════════════════════
# PHASE 4: Canton Participant
# ══════════════════════════════════════════════════════════════
if [ -z "$COMPONENT" ] || [ "$COMPONENT" = "participant" ]; then
  step "Phase 4: Canton Participant"
  apply "$K8S_DIR/canton/participant-deployment.yaml" "canton participant"
  wait_rollout "deployment" "canton-participant" "180s"
fi

# ══════════════════════════════════════════════════════════════
# PHASE 5: NGINX Proxy
# ══════════════════════════════════════════════════════════════
if [ -z "$COMPONENT" ] || [ "$COMPONENT" = "nginx" ]; then
  step "Phase 5: NGINX Proxy"
  apply "$K8S_DIR/canton/nginx-deployment.yaml" "nginx proxy"
  wait_rollout "deployment" "nginx-proxy" "120s"
fi

# ══════════════════════════════════════════════════════════════
# PHASE 6: Bridge Relay
# ══════════════════════════════════════════════════════════════
if [ -z "$COMPONENT" ] || [ "$COMPONENT" = "relay" ]; then
  step "Phase 6: Bridge Relay"
  apply "$K8S_DIR/canton/relay-deployment.yaml" "bridge relay"
  wait_rollout "deployment" "bridge-relay" "120s"
fi

# ══════════════════════════════════════════════════════════════
# PHASE 7: Liquidation Bot
# ══════════════════════════════════════════════════════════════
if [ -z "$COMPONENT" ] || [ "$COMPONENT" = "bot" ]; then
  step "Phase 7: Liquidation Bot"
  apply "$K8S_DIR/canton/bot-deployment.yaml" "liquidation bot"
  wait_rollout "deployment" "liquidation-bot" "120s"
fi

# ══════════════════════════════════════════════════════════════
# PHASE 8: Network Policies & PDBs
# ══════════════════════════════════════════════════════════════
if [ -z "$COMPONENT" ] || [ "$COMPONENT" = "network" ]; then
  step "Phase 8: Network Policies & Pod Disruption Budgets"
  apply "$K8S_DIR/canton/network-policy.yaml" "network policies"
  apply "$K8S_DIR/canton/pod-disruption-budget.yaml" "pod disruption budgets"
fi

# ══════════════════════════════════════════════════════════════
# PHASE 9: Monitoring
# ══════════════════════════════════════════════════════════════
if [ -z "$COMPONENT" ] || [ "$COMPONENT" = "monitoring" ]; then
  step "Phase 9: Monitoring & Alerting"

  # Prometheus rules & ServiceMonitors (require prometheus-operator CRDs)
  if kubectl api-resources | grep -q prometheusrules 2>/dev/null; then
    apply "$K8S_DIR/monitoring/prometheus-rules.yaml" "prometheus alert rules"
    apply "$K8S_DIR/monitoring/service-monitors.yaml" "service monitors"
    ok "Prometheus Operator detected — monitoring resources applied"
  else
    warn "Prometheus Operator CRDs not found — skipping PrometheusRules/ServiceMonitors"
    warn "Install: helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack"
  fi

  apply "$K8S_DIR/monitoring/canton-health-cronjob.yaml" "canton health check cronjob"

  # Grafana dashboards (auto-provisioned via sidecar label)
  apply "$K8S_DIR/monitoring/grafana-dashboards.yaml" "grafana dashboard configmaps"

  # Loki logging stack
  apply "$K8S_DIR/monitoring/loki-stack.yaml" "loki logging stack"
fi

# ══════════════════════════════════════════════════════════════
# PHASE 10: Backup CronJobs
# ══════════════════════════════════════════════════════════════
if [ -z "$COMPONENT" ] || [ "$COMPONENT" = "backups" ]; then
  step "Phase 10: Backup CronJobs"
  apply "$K8S_DIR/canton/postgres-backup-cronjob.yaml" "postgres backup cronjob"
fi

# ══════════════════════════════════════════════════════════════
# POST-DEPLOY VERIFICATION
# ══════════════════════════════════════════════════════════════
if [ -z "$DRY_RUN" ] && [ -z "$COMPONENT" ]; then
  step "Post-deploy verification"

  echo "  Pods in $NAMESPACE:"
  kubectl get pods -n "$NAMESPACE" -o wide --no-headers 2>/dev/null | while read -r line; do
    POD_STATUS=$(echo "$line" | awk '{print $3}')
    POD_NAME=$(echo "$line" | awk '{print $1}')
    if [ "$POD_STATUS" = "Running" ] || [ "$POD_STATUS" = "Completed" ]; then
      echo -e "    ${GREEN}●${NC} $line"
    else
      echo -e "    ${RED}●${NC} $line"
    fi
  done

  echo ""
  echo "  Services:"
  kubectl get svc -n "$NAMESPACE" --no-headers 2>/dev/null | while read -r line; do
    echo "    $line"
  done

  echo ""
  echo "  CronJobs:"
  kubectl get cronjobs -n "$NAMESPACE" --no-headers 2>/dev/null | while read -r line; do
    echo "    $line"
  done

  echo ""
  echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  ✅ Deployment complete!${NC}"
  echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
  echo ""
  echo "  Next steps:"
  echo "    1. Upload DAR:    kubectl exec -it -n $NAMESPACE deploy/canton-participant -- ..."
  echo "       Or run:        ./scripts/canton-init.sh"
  echo "    2. Verify relay:  kubectl logs -n $NAMESPACE deploy/bridge-relay -f"
  echo "    3. Check health:  kubectl create job --from=cronjob/canton-health-check manual-check -n $NAMESPACE"
  echo "    4. Port forward:  kubectl port-forward -n $NAMESPACE svc/canton-participant 7575:7575"
  echo ""
fi

if [ -n "$DRY_RUN" ]; then
  echo ""
  echo -e "${GREEN}✅ Dry run complete — all manifests validated successfully${NC}"
fi
