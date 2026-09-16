# Autoscaling on application metrics

**Why:** CPU is a proxy. It correlates with load here because the 60 Hz
simulation loop is CPU-bound - but a Pod holding 200 *idle* WebSocket
connections uses almost no CPU while being close to its real capacity. "How
many matches am I simulating" is the honest signal, and it was already being
exported at `/metrics` since Phase 15.

This is optional, because it needs Helm. The default `bootstrap.sh` stays
installable with nothing but `docker` and `kubectl`.

```bash
./scripts/enable-custom-metrics.sh            # install
./scripts/enable-custom-metrics.sh --remove   # back to the CPU-only HPA
```

## How the pieces fit

```
game-server /metrics          pong_active_games{namespace,kubernetes_pod}
        │  scraped
        ▼
   Prometheus
        │  queried
        ▼
prometheus-adapter            implements custom.metrics.k8s.io
        │  served as a Kubernetes API
        ▼
   HorizontalPodAutoscaler    asks for "pong_active_games" like it asks for CPU
```

The key idea: the **HPA never learns that Prometheus exists.** The adapter
registers an APIService, so a custom metric is requested through the ordinary
Kubernetes API:

```bash
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1/namespaces/default/pods/*/pong_active_games"
```

```
game-server-64c86654df-h7hjz   pong_active_games = 0
game-server-64c86654df-n9wfc   pong_active_games = 0
```

## The adapter configuration, line by line

```yaml
seriesQuery: '{__name__=~"pong_active_games|...",namespace!="",kubernetes_pod!=""}'
```
Which Prometheus series this rule covers. The label filters matter: a series
with no namespace or pod cannot be attached to a Kubernetes object, and the
adapter silently skips it.

```yaml
resources:
  overrides:
    namespace:      { resource: namespace }
    kubernetes_pod: { resource: pod }
```
Maps Prometheus **labels** to Kubernetes **resources**. This is what lets an HPA
on a Deployment find the metrics belonging to its Pods. Our scrape config
carries the Pod name as `kubernetes_pod`.

```yaml
metricsQuery: 'sum(<<.Series>>{<<.LabelMatchers>>}) by (<<.GroupBy>>)'
```
`sum()`, **not** `avg()`. This returns the value *per Pod*; the HPA's
`AverageValue` target then averages across Pods itself. Averaging here as well
would average twice and quietly halve the signal.

## Both metrics, highest wins

```yaml
metrics:
  - type: Resource        # cpu, 60% of request
  - type: Pods            # pong_active_games, AverageValue 3
```

An HPA computes a desired replica count for **every** metric and takes the
**highest**. So CPU still protects against a workload that is expensive but not
match-shaped, while active games drive normal scaling.

```
NAME          TARGETS             MINPODS   MAXPODS   REPLICAS
game-server   cpu: 14%/60%, 0/3   1         8         2
```

## Measured: scaling with CPU deliberately out of reach

To prove the *custom* metric does the work, the CPU target was temporarily
raised to 300% so it could never trigger a scale-up. Only active games could.

```
  time      cpu       games/pod    pods   cluster games
  t+24s     193%      0            1      6
  t+36s     110%      4            1      10
  t+48s     99%       11           1      13      <- 11 games on one pod
  t+60s     108%      6            2      15
  t+72s     135%      8.5          2      17
  t+96s     142%      4.75         4      21
  t+120s    107%      3.5          7      20      <- converged on target 3
  t+144s    86%       2.14         7      0
  t+168s    28%       0            7      0       <- held, scale-down is slow
```

CPU never exceeded its 300% target, so its recommendation stayed at **1 pod**
throughout. The scale from **1 → 2 → 4 → 7 pods was driven entirely by active
games**, and games-per-pod converged from 11 toward the target of 3.

Note the units: the HPA reports quantities in milli-units, so `8500m` is 8.5
games per Pod and `2142m` is 2.142.

The tail is also correct behaviour: at t+144s the load had stopped and games hit
zero, but the Pods were held. Scale-down uses a 300 s stabilisation window and
one Pod per minute, because removing a Pod drops the WebSocket connections it
holds. Wasting capacity is cheaper than disconnecting players.

## What this does not solve

- **Scale-to-zero.** `minReplicas` is still 1. A plain HPA has nothing to
  receive the connection that would trigger a scale-up; KEDA's activator does.
- **Draining.** Scaling down still drops in-flight matches. The surviving player
  is told (`server_lost`), but the match is lost.
- **Adapter as a dependency.** Autoscaling now depends on Prometheus being
  healthy. If the adapter stops serving, the HPA falls back to CPU alone - which
  is a good reason to keep the CPU metric in the list rather than replacing it.
