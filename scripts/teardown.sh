#!/usr/bin/env bash
# Remove Pong Arena from the cluster. Cluster-wide add-ons (ingress-nginx,
# metrics-server) are left alone because other projects may be using them.
set -uo pipefail
cd "$(dirname "$0")/.."

echo "Removing Pong Arena..."
kubectl delete -f k8s/monitoring/ingress.yaml    --ignore-not-found >/dev/null 2>&1
kubectl delete -f k8s/monitoring/grafana.yaml    --ignore-not-found >/dev/null 2>&1
kubectl delete -f k8s/monitoring/prometheus.yaml --ignore-not-found >/dev/null 2>&1
kubectl delete namespace monitoring --ignore-not-found >/dev/null 2>&1
for f in k8s/*.yaml; do
  [ "$(basename "$f")" = "secret.example.yaml" ] && continue
  kubectl delete -f "$f" --ignore-not-found >/dev/null 2>&1
done
kubectl delete secret pong-secrets --ignore-not-found >/dev/null 2>&1

echo
echo "Done. The database volume was deliberately NOT deleted:"
kubectl get pvc 2>/dev/null | grep -E 'NAME|postgres' || echo "  (none found)"
echo
echo "To delete the data too:   kubectl delete pvc data-postgres-0"
echo "Add-ons left installed:   ingress-nginx, metrics-server"
