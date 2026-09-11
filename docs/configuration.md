# Configuration and secrets

## The split

| | ConfigMap `pong-config` | Secret `pong-secrets` |
|---|---|---|
| Holds | NODE_ENV, LOG_LEVEL, PORT, REDIS_HOST/PORT, POSTGRES_HOST/PORT/USER/DB, POSTGRES_POOL_MAX, JWT_TTL | POSTGRES_PASSWORD, JWT_SECRET |
| In git | yes (`k8s/00-config.yaml`) | no - keys only, in `k8s/secret.example.yaml` |
| Created by | `kubectl apply` | `scripts/create-secrets.sh` |

The test for "does this belong in a ConfigMap?" is not "is it a string?" but
**"would I mind this appearing in a screenshot?"**

## Creating and rotating secrets

```bash
./scripts/create-secrets.sh              # generates fresh random values
./scripts/apply.sh                       # applies manifests and rolls if config changed
```

Values are generated with `openssl rand -hex` and never written to disk.

To rotate only the signing key, keeping the database password:

```bash
POSTGRES_PASSWORD=$(kubectl get secret pong-secrets -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d) \
  ./scripts/create-secrets.sh
./scripts/apply.sh
```

**Rotating `JWT_SECRET` signs every user out.** Verified: the same token returned
200 before rotation and 401 after; signing in again returned 200.

**Rotating `POSTGRES_PASSWORD` does not change an existing database's password.**
PostgreSQL only reads that variable when it initialises an empty data directory.
On a real database you would `ALTER USER pong WITH PASSWORD ...` and then update
the Secret.

## What a Kubernetes Secret actually protects you from

Not much, by default. A Secret is **base64-encoded, not encrypted**:

```
$ kubectl get secret pong-secrets -o jsonpath='{.data.JWT_SECRET}' | base64 -d
af8a5bcc6a0895a1c35b4145…            <- the real signing key
```

What a Secret genuinely gives you:

- It is a separate object, so it can be **excluded from git** while the rest of
  the manifests are committed.
- It is covered by **RBAC** separately from ConfigMaps, so you can grant read
  access to config without granting access to credentials.
- Values are not printed in `kubectl describe pod`, and the kubelet keeps them
  in tmpfs rather than on disk when mounted as files.

What it does **not** give you:

- Encryption at rest. In etcd, Secrets are stored base64-encoded unless the
  cluster is configured with an `EncryptionConfiguration`.
- Protection from anyone who can read Secrets in the namespace, exec into a Pod,
  or read the Pod spec.

For anything real, the Secret object is a *delivery mechanism*, not storage. The
value should come from outside the cluster:

- **External Secrets Operator** - syncs from AWS Secrets Manager, Vault, GCP
  Secret Manager into a Kubernetes Secret.
- **Sealed Secrets** - encrypt a Secret with a cluster public key so the
  *encrypted* form is safe to commit.
- **SOPS** with age/KMS - encrypt values in the YAML itself.
- Cloud IAM (IRSA, Workload Identity) - avoid long-lived credentials entirely.

## Secrets already committed to git

The Phase 6 manifests contained `pong_dev_password` and
`dev-only-insecure-secret-change-me` in plain text. Those values are in commit
`b16fdd7` **permanently** - removing them from the current files does not remove
them from history.

Deleting them from HEAD is not a fix. The fix is **rotation**, which is what
`scripts/create-secrets.sh` did: the committed values are now dead and grant
access to nothing. Rewriting history (`git filter-repo`) would also be possible
here because the repository has not been shared, but rotation is the habit that
generalises - once a secret has been pushed anywhere, assume it is public.

## Why changing a ConfigMap does not restart Pods

Environment variables are injected **once, at container start**. Changing the
ConfigMap afterwards has no effect on running Pods:

```
ConfigMap now says: debug
LOG_LEVEL in the pod: info          <- 8 seconds later, same Pod, no restart
```

Two ways to deal with this:

1. `kubectl rollout restart deployment/game-server` - manual.
2. Stamp a **checksum of the config onto the Pod template**. When the config
   changes the checksum changes, the template changes, and the Deployment does a
   normal rolling update. `scripts/apply.sh` does this:

```
LOG_LEVEL info -> debug   checksum 08ce36c540812483 -> 6cde5f8bad87b433   pods replaced
no change                 checksum unchanged                              pods untouched
```

Helm automates exactly this with `checksum/config` annotations (Phase 19).

(A ConfigMap mounted as a **volume** does update in place, after a sync delay of
up to a minute. Environment variables never do.)

## Gotcha: apply overwrites patch

`kubectl patch configmap` followed by `scripts/apply.sh` silently loses the
patch, because apply re-applies the file. The YAML file is the source of truth -
the same lesson as `kubectl set image` versus `kubectl apply` in Phase 3. Edit
the file.
