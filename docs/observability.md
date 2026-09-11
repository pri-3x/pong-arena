# Observability

**Grafana:** http://localhost/grafana (anonymous viewer; admin/admin to edit)
**Dashboard:** Pong Arena - 14 panels, provisioned from
`k8s/monitoring/dashboards/pong-arena.json`

Prometheus is deliberately **not** exposed through the Ingress - it has no
authentication whatsoever.

## How Prometheus finds things

Prometheus **pulls**. The application never pushes anywhere, which is why a
crashed Pod simply stops appearing rather than corrupting a stream.

Targets are discovered by asking the Kubernetes API what exists, then filtered
to Pods carrying an opt-in annotation:

```yaml
annotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "3000"
  prometheus.io/path: "/metrics"
```

That is why the scrape config needs RBAC to list pods, services and nodes -
including `nodes/proxy`, without which the cAdvisor scrape returns
**403 Forbidden**.

## Metric types

| Type | Meaning | Ours |
|---|---|---|
| Counter | only goes up | `pong_http_requests_total`, `pong_matches_completed_total` |
| Gauge | goes up and down | `pong_active_games`, `pong_connected_players`, `pong_matchmaking_queue_length` |
| Histogram | bucketed distribution | `pong_http_request_duration_seconds`, `pong_match_duration_seconds` |

Counters are never averaged in the application. `rate(...[1m])` is computed at
query time, which keeps the app dumb and lets the dashboard pick the window.

### Cardinality

Requests are labelled with the **route pattern** (`/matches`), never the
concrete URL. Using the raw URL would create a new time series per distinct
query string - the classic way to destroy a Prometheus instance.

### Histogram buckets

```js
buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]
```

Chosen around latencies actually measured under load (median ~115ms, p95
~670ms). `histogram_quantile` interpolates *within* a bucket, so quantiles are
only as precise as the bucket they land in.

## Verified queries

Every dashboard query was checked against the Prometheus API during a live load
test:

```
sum(pong_active_games)                          16
sum(pong_connected_players)                     35
count(count by (pod) (pong_connected_players))   8
histogram_quantile(0.95, ...)                 0.25 s
sum by (reason) (pong_matches_completed_total)  win=89  opponent_left=35
CPU per pod (cadvisor)                        0.068 - 0.096 cores
```

## Dashboards as code

The dashboard is a JSON file in git, mounted as a ConfigMap and provisioned on
start. A dashboard clicked together in the UI lives only in Grafana's database
and disappears when the Pod is replaced.

### Gotcha: instant vs range queries

The first version rendered stat panels correctly and left every time series
blank. Prometheus targets in Grafana need `"range": true`; without it the query
runs as an *instant* query, the panel receives a single point, and a line chart
of one point draws nothing. Stat panels want the opposite (`"instant": true`).

### Note on screenshots

Grafana draws time series on a `<canvas>` via uPlot. Headless screenshots in
this environment capture the panel chrome and legends but not the canvas layer.
Verified the charts really are drawing by sampling canvas pixels directly
(572-759 lit samples per panel). Open the dashboard in a real browser to see it.
