#!/usr/bin/env bash
#
# OPTIONAL add-on: autoscale on active games instead of only CPU.
#
# Kept out of bootstrap.sh on purpose - it needs Helm, and the default path
# should stay installable with nothing but docker and kubectl.
#
#   ./scripts/enable-custom-metrics.sh            install
#   ./scripts/enable-custom-metrics.sh --remove   revert to the CPU-only HPA
set -uo pipefail
cd "$(dirname "$0")/.."

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; RED=$'\033[31m'; OFF=$'\033[0m'
step() { echo; echo "${BOLD}==> $1${OFF}"; }
ok()   { echo "  ${GREEN}ok${OFF}  $1"; }
warn() { echo "  ${RED}!!${OFF}  $1"; }
die()  { warn "$1"; exit 1; }

command -v helm >/dev/null 2>&1 || die "helm is required: https://helm.sh/docs/intro/install/"

if [ "${1:-}" = "--remove" ]; then
  step "Removing custom metrics"
  helm uninstall prometheus-adapter -n monitoring >/dev/null 2>&1 && ok "adapter uninstalled"
  kubectl apply -f k8s/07-hpa.yaml >/dev/null && ok "restored the CPU-only HPA"
  exit 0
fi

kubectl get deploy prometheus -n monitoring >/dev/null 2>&1 \
  || die "Prometheus is not installed. Run ./scripts/bootstrap.sh first."

step "Installing prometheus-adapter"
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1
helm repo update >/dev/null 2>&1
helm upgrade --install prometheus-adapter prometheus-community/prometheus-adapter \
  -n monitoring \
  -f k8s/custom-metrics/adapter-values.yaml \
  --wait --timeout 5m >/dev/null 2>&1 || die "helm install failed"
ok "prometheus-adapter deployed"

step "Waiting for the custom metrics API to register"
# The adapter registers an APIService; until that is Available, an HPA asking
# for a custom metric gets "no metrics returned" rather than an error.
for i in $(seq 1 40); do
  AVAIL=$(kubectl get apiservice v1beta1.custom.metrics.k8s.io \
    -o jsonpath='{.status.conditions[?(@.type=="Available")].status}' 2>/dev/null)
  [ "$AVAIL" = "True" ] && break
  sleep 5
done
[ "${AVAIL:-}" = "True" ] || die "custom.metrics.k8s.io did not become available"
ok "custom.metrics.k8s.io is Available"

step "Checking the metric is actually being served"
for i in $(seq 1 24); do
  RAW=$(kubectl get --raw \
    "/apis/custom.metrics.k8s.io/v1beta1/namespaces/default/pods/*/pong_active_games" 2>/dev/null)
  echo "$RAW" | grep -q '"items"' && [ "$(echo "$RAW" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["items"]))' 2>/dev/null)" -gt 0 ] && break
  sleep 5
done
COUNT=$(echo "${RAW:-}" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("items",[])))' 2>/dev/null || echo 0)
[ "${COUNT:-0}" -gt 0 ] || die "the API is up but returned no pong_active_games series yet - check Prometheus targets"
ok "pong_active_games served for $COUNT pod(s)"

step "Switching the HPA to CPU + active games"
kubectl apply -f k8s/custom-metrics/hpa.yaml >/dev/null && ok "HPA updated"
sleep 20
kubectl get hpa game-server

cat <<EOF

${BOLD}Custom-metric autoscaling is on.${OFF}

  The HPA now scales on whichever is higher: CPU utilisation, or the average
  number of active matches per pod (target 3).

  kubectl get hpa game-server -w
  kubectl describe hpa game-server
  kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1/namespaces/default/pods/*/pong_active_games" | python3 -m json.tool

  ${DIM}Revert with: ./scripts/enable-custom-metrics.sh --remove${OFF}
EOF
