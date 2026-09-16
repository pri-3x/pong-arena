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
HAVE_SECRET=false; kubectl get secret pong-secrets >/dev/null 2>&1 && HAVE_SECRET=true
HAVE_PVC=false;    kubectl get pvc data-postgres-0  >/dev/null 2>&1 && HAVE_PVC=true

if $HAVE_SECRET; then
  ok "pong-secrets already exists (run scripts/create-secrets.sh to rotate)"
elif $HAVE_PVC; then
  # PostgreSQL only reads POSTGRES_PASSWORD when it initialises an EMPTY data
  # directory. An existing volume keeps its old password, so generating a new
  # secret here would leave the game server crash-looping on auth failure.
  warn "found an existing database volume (data-postgres-0) but no pong-secrets."
  warn "PostgreSQL will keep the password baked into that volume, so a freshly"
  warn "generated secret would not match and the game server would crash-loop."
  echo
  echo "  Either keep the data and set the secret to the password it already has:"
  echo "    POSTGRES_PASSWORD=<the old password> ./scripts/create-secrets.sh"
  echo
  echo "  Or start clean (this DELETES the database):"
  echo "    kubectl delete pvc data-postgres-0 && ./scripts/bootstrap.sh"
  exit 1
else
  ./scripts/create-secrets.sh >/dev/null && ok "pong-secrets generated"
fi

# ---------------------------------------------------------------- app
step "Deploying Pong Arena"
./scripts/apply.sh >/dev/null 2>&1 || true

# Report each rollout honestly rather than silently swallowing a failure and
# leaving the script to hang on the next one.
roll() {
  local kind=$1 name=$2 secs=$3
  if kubectl rollout status "$kind/$name" --timeout="${secs}s" >/dev/null 2>&1; then
    ok "$name"
  else
    warn "$name did not become ready"
    kubectl get pods -l app="$name" --no-headers 2>/dev/null | sed "s/^/       /"
    kubectl logs "$kind/$name" --tail=5 2>/dev/null | sed "s/^/       /"
    return 1
  fi
}
roll statefulset postgres    300
roll deployment  redis       180
roll deployment  web         180
roll deployment  game-server 300 || die "the game server could not start - see the logs above"

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
