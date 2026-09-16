#!/usr/bin/env bash
# Remove Pong Arena from the cluster.
#
#   ./scripts/teardown.sh            keep the database volume AND its credentials
#   ./scripts/teardown.sh --purge    delete the data and the secret too
#
# Cluster-wide add-ons (ingress-nginx, metrics-server) are always left alone,
# because other projects on this cluster may be using them.
set -uo pipefail
cd "$(dirname "$0")/.."

PURGE=false
[ "${1:-}" = "--purge" ] && PURGE=true

echo "Removing Pong Arena..."
kubectl delete -f k8s/monitoring/ingress.yaml    --ignore-not-found >/dev/null 2>&1
kubectl delete -f k8s/monitoring/grafana.yaml    --ignore-not-found >/dev/null 2>&1
kubectl delete -f k8s/monitoring/prometheus.yaml --ignore-not-found >/dev/null 2>&1
kubectl delete namespace monitoring --ignore-not-found >/dev/null 2>&1
for f in k8s/*.yaml; do
  [ "$(basename "$f")" = "secret.example.yaml" ] && continue
  kubectl delete -f "$f" --ignore-not-found >/dev/null 2>&1
done

if $PURGE; then
  kubectl delete secret pong-secrets --ignore-not-found >/dev/null 2>&1
  kubectl delete pvc data-postgres-0 --ignore-not-found >/dev/null 2>&1
  echo
  echo "Done. The database volume and the secret were both deleted."
else
  # The Secret is KEPT deliberately, because the PVC is kept.
  #
  # PostgreSQL only reads POSTGRES_PASSWORD when it initialises an EMPTY data
  # directory. If the volume survives but the secret does not, the next
  # bootstrap generates a new password, PostgreSQL keeps the old one, and the
  # game server crash-loops on "password authentication failed" forever.
  #
  # Keeping them together means the pair stays consistent: keep both, or
  # --purge both.
  echo
  echo "Done. Kept so the next bootstrap still works:"
  kubectl get pvc data-postgres-0 --no-headers 2>/dev/null | awk '{print "  pvc     "$1"  "$2"  "$4}'
  kubectl get secret pong-secrets  --no-headers 2>/dev/null | awk '{print "  secret  "$1}'
  echo
  echo "To remove those too:   ./scripts/teardown.sh --purge"
fi
echo "Add-ons left installed:  ingress-nginx, metrics-server"
