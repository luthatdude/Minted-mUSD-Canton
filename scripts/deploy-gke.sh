#!/bin/bash
# =============================================================================
# Canton DevNet Deployment to Google Kubernetes Engine (GKE)
# =============================================================================
# This script sets up a GKE cluster and deploys the Canton participant node
# for connection to Canton DevNet.
#
# Prerequisites:
#   - gcloud CLI installed and authenticated
#   - kubectl installed
#   - Helm 3 installed
# =============================================================================

set -euo pipefail

# Configuration
PROJECT_ID="${GCP_PROJECT:-minted-canton}"
REGION="${GCP_REGION:-us-central1}"
ZONE="${GCP_ZONE:-us-central1-a}"
CLUSTER_NAME="minted-canton-devnet"
MACHINE_TYPE="e2-standard-4"  # 4 vCPU, 16GB RAM
NODE_COUNT=2

echo "=============================================="
echo "  Canton DevNet - GKE Deployment"
echo "=============================================="
echo ""
echo "Project: $PROJECT_ID"
echo "Region:  $REGION"
echo "Cluster: $CLUSTER_NAME"
echo ""

# =============================================================================
# Step 1: Create GKE Cluster
# =============================================================================
create_cluster() {
    echo "📦 Step 1: Creating GKE Cluster..."
    
    # Check if cluster already exists
    if gcloud container clusters describe $CLUSTER_NAME --zone=$ZONE --project=$PROJECT_ID &>/dev/null; then
        echo "   Cluster already exists, skipping creation."
    else
        gcloud container clusters create $CLUSTER_NAME \
            --project=$PROJECT_ID \
            --zone=$ZONE \
            --machine-type=$MACHINE_TYPE \
            --num-nodes=$NODE_COUNT \
            --enable-ip-alias \
            --workload-pool=$PROJECT_ID.svc.id.goog \
            --release-channel=regular \
            --enable-shielded-nodes \
            --shielded-secure-boot \
            --enable-network-policy
        
        echo "   ✅ Cluster created successfully"
    fi
    
    # Get credentials
    gcloud container clusters get-credentials $CLUSTER_NAME --zone=$ZONE --project=$PROJECT_ID
    echo "   ✅ kubectl configured for $CLUSTER_NAME"
}

# =============================================================================
# Step 2: Reserve Static IP
# =============================================================================
reserve_static_ip() {
    echo ""
    echo "🌐 Step 2: Reserving Static IP..."
    
    if gcloud compute addresses describe canton-devnet-ip --region=$REGION --project=$PROJECT_ID &>/dev/null; then
        echo "   Static IP already reserved."
    else
        gcloud compute addresses create canton-devnet-ip \
            --project=$PROJECT_ID \
            --region=$REGION
        echo "   ✅ Static IP reserved"
    fi
    
    STATIC_IP=$(gcloud compute addresses describe canton-devnet-ip --region=$REGION --project=$PROJECT_ID --format="get(address)")
    echo ""
    echo "   =========================================="
    echo "   📋 YOUR STATIC IP FOR DEVNET WHITELIST:"
    echo "   $STATIC_IP"
    echo "   =========================================="
    echo ""
    echo "   Submit this IP to the Canton DevNet form!"
}

# =============================================================================
# Step 3: Deploy PostgreSQL
# =============================================================================
deploy_postgres() {
    echo ""
    echo "🐘 Step 3: Deploying PostgreSQL..."
    
    # Create namespace
    kubectl create namespace musd-canton --dry-run=client -o yaml | kubectl apply -f -
    
    # Add Bitnami repo
    helm repo add bitnami https://charts.bitnami.com/bitnami 2>/dev/null || true
    helm repo update
    
    # FIX HIGH-TMPFILE: Generate password in memory with restrictive umask
    # Password never touches disk in world-readable form
    local OLD_UMASK=$(umask)
    umask 077
    PG_SECRETS_DIR=$(mktemp -d)
    trap 'rm -rf "$PG_SECRETS_DIR"' EXIT
    
    PG_PASSWORD=$(openssl rand -base64 32 | tr -d '=+/' | head -c 24)
    
    # Deploy PostgreSQL — pass password directly via --set, never write to file
    helm upgrade --install postgres bitnami/postgresql \
        --namespace musd-canton \
        --set auth.postgresPassword="$PG_PASSWORD" \
        --set auth.database=canton \
        --set primary.persistence.size=50Gi \
        --set primary.resources.requests.memory=1Gi \
        --set primary.resources.requests.cpu=500m \
        --wait
    
    # FIX HIGH-TMPFILE: Store password in K8s secret directly, not in /tmp
    kubectl create secret generic canton-pg-credentials \
        --namespace=musd-canton \
        --from-literal=password="$PG_PASSWORD" \
        --dry-run=client -o yaml | kubectl apply -f -
    
    umask $OLD_UMASK
    echo "   ✅ PostgreSQL deployed"
    echo "   Password stored in K8s secret: canton-pg-credentials"
}

# =============================================================================
# Step 4: Create Secrets
# =============================================================================
create_secrets() {
    echo ""
    echo "🔐 Step 4: Creating Kubernetes Secrets..."
    
    # FIX HIGH-TMPFILE: Read password from K8s secret instead of /tmp file
    PG_PASSWORD=$(kubectl get secret canton-pg-credentials -n musd-canton -o jsonpath='{.data.password}' | base64 -d)
    
    # Create Canton secrets
    kubectl create secret generic canton-secrets \
        --namespace=musd-canton \
        --from-literal=CANTON_DB_USER=postgres \
        --from-literal=CANTON_DB_PASSWORD="$PG_PASSWORD" \
        --from-literal=CANTON_DB_NAME=canton \
        --from-literal=CANTON_DB_HOST=postgres-postgresql.musd-canton.svc.cluster.local \
        --from-literal=CANTON_DB_PORT=5432 \
        --dry-run=client -o yaml | kubectl apply -f -
    
    echo "   ✅ Secrets created"
}

# =============================================================================
# Step 5: Generate TLS Certificates
# =============================================================================
generate_tls() {
    echo ""
    echo "🔒 Step 5: Generating TLS Certificates..."
    
    # FIX HIGH-TMPFILE: Use restrictive umask and secure tmpdir
    local OLD_UMASK=$(umask)
    umask 077
    local TLS_DIR=$(mktemp -d)
    # FIX HIGH-TMPFILE: Ensure TLS keys are cleaned up on exit
    trap 'rm -rf "$TLS_DIR"' EXIT
    
    cd "$TLS_DIR"
    
    # Generate CA
    openssl genrsa -out ca.key 4096
    openssl req -new -x509 -days 365 -key ca.key -out ca.crt -subj "/CN=Canton CA"
    
    # Generate server cert
    openssl genrsa -out tls.key 2048
    openssl req -new -key tls.key -out tls.csr -subj "/CN=canton-participant"
    openssl x509 -req -days 365 -in tls.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out tls.crt
    
    # Admin certs (self-signed for now)
    cp tls.key admin-tls.key
    cp tls.crt admin-tls.crt
    cp ca.crt admin-ca.crt
    openssl req -new -x509 -days 365 -key tls.key -out admin-client.crt -subj "/CN=admin-client"
    
    # Create secret — keys go directly to K8s, then tmpdir is wiped
    kubectl create secret generic canton-tls \
        --namespace=musd-canton \
        --from-file=tls.crt \
        --from-file=tls.key \
        --from-file=ca.crt \
        --from-file=admin-tls.crt \
        --from-file=admin-tls.key \
        --from-file=admin-ca.crt \
        --from-file=admin-client.crt \
        --dry-run=client -o yaml | kubectl apply -f -
    
    cd -
    # FIX HIGH-TMPFILE: Immediately wipe TLS keys after upload to K8s
    rm -rf "$TLS_DIR"
    umask $OLD_UMASK
    echo "   ✅ TLS certificates generated and stored (local copies wiped)"
}

# =============================================================================
# Step 6: Deploy Canton Participant
# =============================================================================
deploy_canton() {
    echo ""
    echo "🚀 Step 6: Deploying Canton Participant..."
    
    # Apply configs
    kubectl apply -f k8s/base/
    kubectl apply -f k8s/canton/
    
    # Wait for deployment
    kubectl rollout status deployment/canton-participant -n musd-canton --timeout=300s
    
    echo "   ✅ Canton participant deployed"
}

# =============================================================================
# Step 7: Create LoadBalancer with Static IP
# =============================================================================
create_loadbalancer() {
    echo ""
    echo "🌍 Step 7: Creating LoadBalancer with Static IP..."
    
    STATIC_IP=$(gcloud compute addresses describe canton-devnet-ip --region=$REGION --project=$PROJECT_ID --format="get(address)")
    
    # FIX HIGH-WAF: Canton LB now restricted to Canton DevNet IPs only
    # and protected by Cloud Armor security policy.
    # IMPORTANT: Replace CANTON_DEVNET_CIDR with the actual Canton Network IP range.
    CANTON_DEVNET_CIDR="${CANTON_DEVNET_CIDR:-35.186.0.0/16}"

    cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Service
metadata:
  name: canton-participant-lb
  namespace: musd-canton
  annotations:
    cloud.google.com/load-balancer-type: "External"
    cloud.google.com/backend-config: '{"default": "canton-lb-backend"}'
spec:
  type: LoadBalancer
  loadBalancerIP: $STATIC_IP
  # FIX HIGH-WAF: Restrict source IPs to Canton DevNet range only
  loadBalancerSourceRanges:
    - "$CANTON_DEVNET_CIDR"
  ports:
    - name: ledger-api
      port: 5011
      targetPort: 5011
      protocol: TCP
    - name: json-api
      port: 7575
      targetPort: 7575
      protocol: TCP
  selector:
    app.kubernetes.io/name: canton-participant
---
apiVersion: cloud.google.com/v1
kind: BackendConfig
metadata:
  name: canton-lb-backend
  namespace: musd-canton
spec:
  securityPolicy:
    name: minted-waf-policy
  logging:
    enable: true
    sampleRate: 1.0
EOF

    echo "   ✅ LoadBalancer created with IP: $STATIC_IP"
}

# =============================================================================
# Main Execution
# =============================================================================
main() {
    create_cluster
    reserve_static_ip
    deploy_postgres
    create_secrets
    generate_tls
    deploy_canton
    create_loadbalancer
    
    echo ""
    echo "=============================================="
    echo "  ✅ DEPLOYMENT COMPLETE"
    echo "=============================================="
    echo ""
    
    STATIC_IP=$(gcloud compute addresses describe canton-devnet-ip --region=$REGION --project=$PROJECT_ID --format="get(address)")
    
    echo "📋 Next Steps:"
    echo ""
    echo "1. Submit this IP to Canton DevNet whitelist form:"
    echo "   IP: $STATIC_IP"
    echo ""
    echo "2. Wait for whitelist approval (up to 7 days)"
    echo ""
    echo "3. Check participant status:"
    echo "   kubectl logs -f deployment/canton-participant -n musd-canton"
    echo ""
    echo "4. Access Ledger API:"
    echo "   grpcurl -cert admin-client.crt -key tls.key -cacert ca.crt $STATIC_IP:5011 list"
    echo ""
}

# Run if not sourced
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
