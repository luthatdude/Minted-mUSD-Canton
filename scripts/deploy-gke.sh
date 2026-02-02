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
    
    # Generate random password
    PG_PASSWORD=$(openssl rand -base64 32 | tr -d '=+/' | head -c 24)
    
    # Deploy PostgreSQL
    helm upgrade --install postgres bitnami/postgresql \
        --namespace musd-canton \
        --set auth.postgresPassword="$PG_PASSWORD" \
        --set auth.database=canton \
        --set primary.persistence.size=50Gi \
        --set primary.resources.requests.memory=1Gi \
        --set primary.resources.requests.cpu=500m \
        --wait
    
    echo "   ✅ PostgreSQL deployed"
    echo "   Password saved to: /tmp/canton-pg-password.txt"
    echo "$PG_PASSWORD" > /tmp/canton-pg-password.txt
}

# =============================================================================
# Step 4: Create Secrets
# =============================================================================
create_secrets() {
    echo ""
    echo "🔐 Step 4: Creating Kubernetes Secrets..."
    
    PG_PASSWORD=$(cat /tmp/canton-pg-password.txt)
    
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
    
    mkdir -p /tmp/canton-tls
    cd /tmp/canton-tls
    
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
    
    # Create secret
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
    echo "   ✅ TLS certificates generated and stored"
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
    
    cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Service
metadata:
  name: canton-participant-lb
  namespace: musd-canton
  annotations:
    cloud.google.com/load-balancer-type: "External"
spec:
  type: LoadBalancer
  loadBalancerIP: $STATIC_IP
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
    echo "   grpcurl -plaintext $STATIC_IP:5011 list"
    echo ""
}

# Run if not sourced
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
