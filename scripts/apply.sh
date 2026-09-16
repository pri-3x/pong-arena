#!/usr/bin/env bash
# Apply the manifests, and roll the Deployments if their configuration changed.
#
# Kubernetes does NOT restart Pods when a ConfigMap or Secret changes, because
# environment variables are injected once at container start. The standard
# answer is to stamp a checksum of the config onto the Pod template: when the
# config changes the checksum changes, the Pod template changes, and the
# Deployment performs a normal rolling update. Helm does this for you with
# `checksum/config` annotations (Phase 19); this is the same idea by hand.
set -euo pipefail
cd "$(dirname "$0")/.."

# Apply EVERY manifest in k8s/, rather than a hardcoded list.
#
# This used to name each file explicitly, and silently stopped applying the
# Ingress and the HPA when those were added in Phases 10 and 13 - the cluster
# only had them because they had been applied by hand. A fresh install got an
# unreachable app with no autoscaling.
#
# The ConfigMap goes first so anything referencing it resolves.
kubectl apply -f k8s/00-config.yaml
for f in k8s/*.yaml; do
  case "$(basename "$f")" in
    00-config.yaml|secret.example.yaml) continue ;;
  esac
  kubectl apply -f "$f"
done

CONFIG_SUM=$(kubectl get configmap pong-config -o jsonpath='{.data}' | shasum -a 256 | cut -c1-16)
SECRET_SUM=$(kubectl get secret pong-secrets -o jsonpath='{.data}' | shasum -a 256 | cut -c1-16)

kubectl patch deployment game-server -p \
  "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"pong.dev/config-checksum\":\"$CONFIG_SUM\",\"pong.dev/secret-checksum\":\"$SECRET_SUM\"}}}}}"

kubectl rollout status deployment/game-server --timeout=180s
