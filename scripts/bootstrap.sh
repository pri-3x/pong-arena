#!/usr/bin/env bash
#
# One command to go from a fresh clone to a running cluster.
#
# Safe to re-run: every step converges rather than failing if it already exists.
set -uo pipefail
cd "$(dirname "$0")/.."

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; RED=$'\033[31m'; OFF=$'\033[0m'
step() { echo; echo "${BOLD}==> $1${OFF}"; }
ok()   { echo "  ${GREEN}ok${OFF}  $1"; }
warn() { echo "  ${RED}!!${OFF}  $1"; }
die()  { warn "$1"; exit 1; }

INGRESS_VERSION=controller-v1.11.3
METRICS_VERSION=v0.7.2

# ---------------------------------------------------------------- prereqs
step "Checking prerequisites"
for c in docker kubectl; do
  command -v "$c" >/dev/null 2>&1 || die "$c is not installed"
  ok "$c $(command -v $c >/dev/null && echo found)"
done
docker info >/dev/null 2>&1 || die "the Docker daemon is not running"
ok "docker daemon running"
kubectl cluster-info >/dev/null 2>&1 || die "no reachable Kubernetes cluster (enable Kubernetes in Docker Desktop)"
ok "cluster reachable: $(kubectl config current-context)"

# ---------------------------------------------------------------- images
# The tags come from the manifests, so this can never drift out of sync with
# what the Deployments actually reference.
step "Building images"
GS_TAG=$(grep -h 'image: pong-game-server:' k8s/01-deployment.yaml | head -1 | sed 's/.*://' | tr -d ' ')
WEB_TAG=$(grep -h 'image: pong-web:' k8s/03-web.yaml | head -1 | sed 's/.*://' | tr -d ' ')
echo "  ${DIM}game-server -> pong-game-server:${GS_TAG}${OFF}"
docker build -q -t "pong-game-server:${GS_TAG}" services/game-server >/dev/null || die "game-server image build failed"
ok "pong-game-server:${GS_TAG}"
echo "  ${DIM}web -> pong-web:${WEB_TAG}${OFF}"
docker build -q -t "pong-web:${WEB_TAG}" services/web >/dev/null || die "web image build failed"
ok "pong-web:${WEB_TAG}"

# ---------------------------------------------------------------- cluster addons
step "Installing cluster add-ons"
if kubectl get ingressclass nginx >/dev/null 2>&1; then
  ok "ingress-nginx already installed"
else
  echo "  ${DIM}installing ingress-nginx...${OFF}"
  kubectl apply -f "https://raw.githubusercontent.com/kubernetes/ingress-nginx/${INGRESS_VERSION}/deploy/static/provider/cloud/deploy.yaml" >/dev/null 2>&1
  kubectl wait --namespace ingress-nginx --for=condition=ready pod \
    --selector=app.kubernetes.io/component=controller --timeout=300s >/dev/null 2>&1 \
    && ok "ingress-nginx ready" || warn "ingress-nginx did not become ready in time"
fi

if kubectl get deployment metrics-server -n kube-system >/dev/null 2>&1; then
  ok "metrics-server already installed"
else
  echo "  ${DIM}installing metrics-server (required by the HPA)...${OFF}"
  kubectl apply -f "https://github.com/kubernetes-sigs/metrics-server/releases/download/${METRICS_VERSION}/components.yaml" >/dev/null 2>&1
  # Docker Desktop's kubelet serves a self-signed certificate.
  kubectl patch deployment metrics-server -n kube-system --type=json \
    -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' >/dev/null 2>&1
  kubectl rollout status deployment/metrics-server -n kube-system --timeout=180s >/dev/null 2>&1 \
    && ok "metrics-server ready" || warn "metrics-server did not become ready in time"
fi

# ---------------------------------------------------------------- secrets
step "Creating secrets"
if kubectl get secret pong-secrets >/dev/null 2>&1; then
  ok "pong-secrets already exists (delete it to rotate, or run scripts/create-secrets.sh)"
else
  ./scripts/create-secrets.sh >/dev/null && ok "pong-secrets generated"
fi

# ---------------------------------------------------------------- app
step "Deploying Pong Arena"
./scripts/apply.sh >/dev/null 2>&1
kubectl rollout status statefulset/postgres --timeout=300s >/dev/null 2>&1 && ok "postgres"
kubectl rollout status deployment/redis       --timeout=180s >/dev/null 2>&1 && ok "redis"
kubectl rollout status deployment/game-server --timeout=300s >/dev/null 2>&1 && ok "game-server"
kubectl rollout status deployment/web         --timeout=180s >/dev/null 2>&1 && ok "web"

# ---------------------------------------------------------------- monitoring
step "Deploying monitoring"
kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl apply -f k8s/monitoring/prometheus.yaml >/dev/null
kubectl create configmap grafana-dashboards -n monitoring \
  --from-file=pong-arena.json=k8s/monitoring/dashboards/pong-arena.json \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl apply -f k8s/monitoring/grafana.yaml >/dev/null
kubectl apply -f k8s/monitoring/ingress.yaml >/dev/null
kubectl rollout status deployment/prometheus -n monitoring --timeout=180s >/dev/null 2>&1 && ok "prometheus"
kubectl rollout status deployment/grafana    -n monitoring --timeout=180s >/dev/null 2>&1 && ok "grafana"

# ---------------------------------------------------------------- verify
step "Verifying"
READY=""
for i in $(seq 1 30); do
  READY=$(curl -s --max-time 4 http://localhost/ready 2>/dev/null)
  echo "$READY" | grep -q '"ok":true' && break
  sleep 3
done
if echo "$READY" | grep -q '"ok":true'; then
  ok "/ready -> $READY"
else
  warn "the app did not come up: ${READY:-no response}"
  warn "try: kubectl get pods && kubectl logs deploy/game-server"
  exit 1
fi

cat <<EOF

${BOLD}Pong Arena is running.${OFF}

  Play        ${BOLD}http://localhost${OFF}     (open TWO tabs and create an account in each)
  Dashboard   ${BOLD}http://localhost/grafana${OFF}

  kubectl get pods
  ./scripts/chaos.sh          run the failure tests
  ./scripts/teardown.sh       remove everything

  Start reading at docs/learning-log.md - it follows the build phase by phase.
EOF
