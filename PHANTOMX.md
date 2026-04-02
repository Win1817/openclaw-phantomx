# openclaw-phantomx

**OpenClaw** with a production-grade **Rocket.Chat** channel integration — event-driven, security-hardened, and Kubernetes-native.

> Base: [openclaw/openclaw](https://github.com/openclaw/openclaw)  
> Added: `@openclaw/rocketchat` channel plugin + K8s manifests

---

## What's new in this fork

### `extensions/rocketchat/` — Channel Plugin

A full first-class OpenClaw channel plugin for Rocket.Chat, implementing the same `ChannelPlugin<T>` contract as the existing Mattermost, Slack, and Discord integrations.

| File | Purpose |
|------|---------|
| `src/rocketchat/ddp-client.ts` | DDP/WebSocket real-time client with auto-reconnect |
| `src/rocketchat/client.ts` | REST API client (send, rooms, users, reactions) |
| `src/rocketchat/monitor.ts` | Real-time inbound event monitor + chatmode gating |
| `src/rocketchat/send.ts` | Outbound delivery (chunked, threaded, typed) |
| `src/rocketchat/security.ts` | Prompt-injection guard, room ACL, sender allowlist |
| `src/rocketchat/accounts.ts` | Multi-account resolution |
| `src/rocketchat/probe.ts` | Connectivity health check |
| `src/rocketchat/slash-commands.ts` | `/claw skill`, `/claw agent`, `/claw help` |
| `src/infra/event-bus/` | Pluggable event bus: memory / Redis Streams / NATS |
| `src/channel.ts` | Root `ChannelPlugin` — wires all 12 adapters |
| `ARCHITECTURE.md` | Full architecture doc with flow diagrams |

### `k8s/` — Kubernetes Manifests

| File | Purpose |
|------|---------|
| `rocketchat/namespace.yaml` | Namespace + ServiceAccount + RBAC |
| `rocketchat/configmap.yaml` | Non-sensitive gateway config |
| `rocketchat/secrets.yaml` | Secret templates |
| `rocketchat/deployment.yaml` | Gateway Deployment (zero-downtime rolling updates) |
| `rocketchat/service.yaml` | ClusterIP + headless services |
| `rocketchat/ingress.yaml` | nginx Ingress with TLS + rate limiting |
| `rocketchat/hpa.yaml` | HPA (CPU + memory + queue depth) + PodDisruptionBudget |
| `rocketchat/network-policy.yaml` | Zero-trust NetworkPolicies |
| `infra/redis.yaml` | Redis StatefulSet + exporter sidecar |
| `infra/nats.yaml` | NATS JetStream StatefulSet + exporter |
| `monitoring/service-monitor.yaml` | ServiceMonitor + PrometheusRule alerts |
| `kustomization.yaml` | `kubectl apply -k k8s/` entrypoint |

---

## Quick start

```bash
# Install plugin
openclaw install @openclaw/rocketchat

# Configure
openclaw channel setup rocketchat \
  --http-url https://chat.example.com \
  --token <personal-access-token> \
  --user-id <bot-user-id>

# Start
openclaw
```

### Kubernetes

```bash
kubectl apply -k k8s/
kubectl rollout status deployment/openclaw-gateway -n openclaw
```

---

## Architecture

See [`extensions/rocketchat/ARCHITECTURE.md`](extensions/rocketchat/ARCHITECTURE.md) for:
- Full message flow diagrams (inbound + outbound + slash commands)
- Event bus architecture (Redis Streams vs NATS JetStream)
- Security hardening details (prompt injection, room ACL, network policy)
- Multi-agent orchestration pattern
- Edge / UAV / IoT extension via NATS leafnode
- K8s scaling, observability, and trade-off analysis

---

## Security

- **Prompt injection guard**: 14 regex patterns (OWASP LLM Top-10 #01)
- **Room allowlist/blocklist**: per-account `allowedRoomIds` / `blockedRoomIds`
- **Sender allowlist**: DM `allowFrom` with pairing / allowlist / open policy
- **Message length cap**: configurable max (default 8 000 chars)
- **Zero-trust K8s**: default-deny NetworkPolicies, non-root pods, read-only FS
- **Secret hygiene**: all credentials from K8s Secrets via env vars only

---

## Event Bus

```
monitor.ts → Redis XADD → "openclaw.rocketchat.inbound"
                 └── XREADGROUP → agent execution → XACK
                 └── retry × 3  → DLQ stream on failure

          → NATS publish (alternative, faster, edge-capable)
```

Switch transport via env:
```bash
ROCKETCHAT_EVENT_BUS_TRANSPORT=redis   # default
ROCKETCHAT_EVENT_BUS_TRANSPORT=nats    # NATS JetStream
ROCKETCHAT_EVENT_BUS_TRANSPORT=memory  # dev/testing
```

---

## License

OpenClaw is AGPL-3.0. This fork's additions follow the same license.
