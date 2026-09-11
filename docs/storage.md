# Persistent storage

## The three objects

```
StorageClass          "how to make storage"      (standard, rancher.io/local-path)
      |  dynamically provisions
      v
PersistentVolume      "a piece of actual storage" (created automatically)
      ^  bound to
      |
PersistentVolumeClaim "I need 2Gi, read-write"    (what you write)
      ^  mounted by
      |
     Pod
```

You write the **claim**. The StorageClass creates the **volume**. You almost
never write a PersistentVolume by hand on a cluster with dynamic provisioning.

## WaitForFirstConsumer

This cluster's StorageClass uses `volumeBindingMode: WaitForFirstConsumer`, so a
new PVC sits in `Pending` until a Pod actually needs it:

```
$ kubectl describe pvc demo-claim
  Normal  WaitForFirstConsumer  waiting for first consumer to be created before binding
```

That is not a failure. It exists so the volume is created on the *same node* the
Pod gets scheduled to - binding early could strand a Pod that cannot reach its
own disk.

## reclaimPolicy

`standard` uses `reclaimPolicy: Delete`. **Deleting the PVC destroys the data.**

```
kubectl delete pvc demo-claim
kubectl get pv   ->   No resources found
```

For anything you care about, use a StorageClass with `reclaimPolicy: Retain`, so
deleting the claim leaves the volume behind for a human to inspect and release.

## StatefulSet vs Deployment

| | Deployment | StatefulSet |
|---|---|---|
| Pod names | `postgres-546fff955f-dmvcb` (random) | `postgres-0` (ordinal) |
| Identity across restarts | none | stable |
| Storage | shared or none | one PVC per replica, follows the Pod |
| Startup/shutdown | all at once | ordered: 0, 1, 2 … and reverse |
| DNS | one Service IP | `postgres-0.postgres.default.svc.cluster.local` |
| Use for | stateless replicas | databases, queues, anything where replicas differ |

The distinction is **are the replicas interchangeable?** Two game-server Pods
are. Two database Pods are not - one is primary, one is a replica, and they have
different data.

### The headless Service

`clusterIP: None` means no virtual IP and no load balancing. Instead each Pod
gets its own DNS record. Load balancing across database replicas is the last
thing you want - a write must go to a specific Pod.

The plain name `postgres` still resolves to the Pod addresses, so the
application's `POSTGRES_HOST=postgres` did not have to change.

### volumeClaimTemplates

```yaml
volumeClaimTemplates:
  - metadata: { name: data }
    spec:
      accessModes: ["ReadWriteOnce"]
      resources: { requests: { storage: 2Gi } }
```

Each replica gets its own claim, named `<template>-<statefulset>-<ordinal>`:
`data-postgres-0`. It follows that Pod forever.

**These PVCs are NOT deleted when the StatefulSet is deleted.** Verified:

```
kubectl delete statefulset postgres
  pods:  (none)
  PVC:   data-postgres-0  Bound  2Gi     <- still there
kubectl apply -f k8s/05-postgres.yaml
  users: ada, grace                      <- reattached, data intact
```

Kubernetes assumes your data is worth more than your tidiness. Cleaning up
orphaned PVCs is a manual step, on purpose.

## What "persistent" means here, honestly

This cluster provisions with `rancher.io/local-path`, which is a directory on
the node:

```
hostPath:      /var/local-path-provisioner/pvc-bb673dcc…_default_data-postgres-0
nodeAffinity:  desktop-control-plane
```

So the data survives the **Pod**. It would not survive the **node**. The volume
is also pinned to that one node by nodeAffinity, so the Pod can never be
rescheduled elsewhere.

On a real cluster the provisioner would be EBS, Persistent Disk, or a SAN, and
the volume would detach and reattach to another node.

## Why Redis is still a Deployment with emptyDir

Deliberate, not an oversight. Everything in Redis here is **recreatable**: the
matchmaking queue, presence records with a 10 s TTL, and pub/sub messages that
are fire-and-forget by design. If Redis restarts, queued players requeue.

Making Redis a StatefulSet would teach the wrong instinct - that persistence is
about importance rather than about whether the data can be rebuilt.

## Should you run PostgreSQL in Kubernetes?

For learning: yes, and that is what this is.

For production: **usually not, by default.** A managed database (RDS, Cloud SQL)
gives you backups, point-in-time recovery, failover, patching and monitoring that
you would otherwise have to build and then be on call for. A StatefulSet gives
you a Pod with a disk; it does not give you any of that.

If you do run it in-cluster, use an operator - CloudNativePG, Zalando
postgres-operator, Crunchy - which handle replication, failover and backups.
A bare StatefulSet like this one has:

- no backups
- no replication, so no failover
- no point-in-time recovery
- a single Pod, so any restart is downtime

That is fine for a learning cluster and is not production-ready.
