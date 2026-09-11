#!/usr/bin/env bash
# Failure testing. Each scenario states what SHOULD happen, then breaks
# something and reports what DID happen.
set -uo pipefail
BASE=${BASE:-http://localhost}
ok()   { echo "  PASS  $1"; }
bad()  { echo "  FAIL  $1"; FAILURES=$((FAILURES+1)); }
FAILURES=0

hdr() { echo; echo "=== $1 ==="; }

# ---------------------------------------------------------------- 1
hdr "1. Delete a game-server Pod -> the ReplicaSet recreates it"
BEFORE=$(kubectl get pods -l app=game-server --no-headers | grep -c Running)
VICTIM=$(kubectl get pods -l app=game-server -o jsonpath='{.items[0].metadata.name}')
kubectl delete pod "$VICTIM" --wait=false >/dev/null
sleep 12
AFTER=$(kubectl get pods -l app=game-server --no-headers | grep -c Running)
[ "$AFTER" -ge "$BEFORE" ] && ok "replica count recovered ($BEFORE -> $AFTER)" || bad "replicas $BEFORE -> $AFTER"
kubectl get pods -l app=game-server --no-headers | grep -q "$VICTIM" && bad "old pod still present" || ok "the deleted pod is gone and was replaced"

# ---------------------------------------------------------------- 2
hdr "2. Kill a Pod under load -> traffic continues through the others"
VICTIM=$(kubectl get pods -l app=game-server -o jsonpath='{.items[0].metadata.name}')
( for i in $(seq 1 60); do
    curl -s -o /dev/null -w "%{http_code}\n" --max-time 4 "$BASE/leaderboard"
    sleep 0.25
  done ) > /tmp/chaos-traffic.txt 2>&1 &
TRAFFIC=$!
sleep 3
kubectl delete pod "$VICTIM" --wait=false >/dev/null
wait $TRAFFIC
TOTAL=$(wc -l < /tmp/chaos-traffic.txt | tr -d ' ')
OK200=$(grep -c '^200$' /tmp/chaos-traffic.txt || true)
echo "  requests: $TOTAL, 200s: $OK200"
[ "$OK200" -eq "$TOTAL" ] && ok "zero failed requests while a pod was killed" || bad "$((TOTAL-OK200)) requests failed"

# ---------------------------------------------------------------- 3
hdr "3. Make PostgreSQL unreachable -> readiness fails, liveness does NOT"
kubectl scale statefulset postgres --replicas=0 >/dev/null
sleep 25
READY=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$BASE/ready")
HEALTH=$(kubectl exec deploy/game-server -- node -e "fetch('http://localhost:3000/health').then(r=>process.stdout.write(String(r.status)))" 2>/dev/null)
RESTARTS=$(kubectl get pods -l app=game-server --no-headers | awk '{s+=$4} END {print s+0}')
echo "  /ready -> $READY   /health (in-pod) -> $HEALTH   total restarts: $RESTARTS"
[ "$READY" = "503" ] || [ "$READY" = "000" ] && ok "readiness reports the dependency failure" || bad "/ready returned $READY"
[ "$HEALTH" = "200" ] && ok "liveness stays green, so pods are NOT restart-looped" || bad "/health returned $HEALTH"
kubectl scale statefulset postgres --replicas=1 >/dev/null
kubectl rollout status statefulset/postgres --timeout=180s >/dev/null 2>&1
sleep 15
R2=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "$BASE/ready")
[ "$R2" = "200" ] && ok "recovered automatically once the database returned" || bad "/ready still $R2 after recovery"

# ---------------------------------------------------------------- 4
hdr "4. Restart Redis -> matchmaking state is lost but the service recovers"
kubectl exec deploy/redis -- redis-cli DBSIZE 2>/dev/null | sed 's/^/  keys before: /'
kubectl delete pod -l app=redis --wait=true >/dev/null 2>&1
kubectl rollout status deployment/redis --timeout=120s >/dev/null
sleep 12
kubectl exec deploy/redis -- redis-cli DBSIZE 2>/dev/null | sed 's/^/  keys after:  /'
sleep 8
CL=$(curl -s --max-time 8 "$BASE/cluster" | python3 -c "import sys,json;d=json.load(sys.stdin);print(len(d['pods']))" 2>/dev/null || echo 0)
[ "$CL" -gt 0 ] && ok "presence records rebuilt themselves ($CL pods reporting)" || bad "presence did not recover"
LB=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "$BASE/leaderboard")
[ "$LB" = "200" ] && ok "match history is unaffected (it lives in PostgreSQL)" || bad "/leaderboard returned $LB"

echo
echo "=================================================="
[ "$FAILURES" -eq 0 ] && echo "ALL CHAOS SCENARIOS PASSED" || echo "$FAILURES CHECK(S) FAILED"
exit $FAILURES
