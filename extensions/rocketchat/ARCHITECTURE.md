# OpenClaw × Rocket.Chat — PhantomX Integration Architecture

> **Repository:** `Win1817/openclaw-phantomx`  
> **Base:** OpenClaw (openclaw/openclaw) — TypeScript, plugin-SDK model  
> **Author:** Senior Distributed Systems Architect  
> **Date:** April 2026

---

## 1. Executive Summary

This document describes the production-grade integration between **OpenClaw** (a polyglot AI-agent gateway platform) and **Rocket.Chat** (self-hosted team collaboration). The integration is implemented as a first-class OpenClaw channel plugin (`@openclaw/rocketchat`) that mirrors the architecture of the existing Mattermost plugin — the closest reference implementation — while adding event-bus decoupling, security hardening, and Kubernetes-native scaling.

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Rocket.Chat Server                           │
│  ┌────────────┐  ┌──────────────┐  ┌──────────────────────────┐   │
│  │  DDP / WS  │  │  REST API    │  │  Outgoing Webhooks       │   │
│  │ (real-time)│  │ (v1)         │  │  (slash commands)        │   │
│  └─────┬──────┘  └──────┬───────┘  └────────────┬─────────────┘   │
└────────┼────────────────┼───────────────────────┼─────────────────┘
         │ WSS             │ HTTPS                 │ HTTPS POST
         ▼                 ▼                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  OpenClaw Gateway (K8s Deployment)                   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │               rocketchat channel plugin                      │   │
│  │                                                             │   │
│  │  DDPClient ──► monitor.ts ──► Security Gate ──► Reply Pipe │   │
│  │     │              │               │                  │     │   │
│  │  connect()    inbound msg      prompt inject       agent    │   │
│  │  subscribe()  routing          room allowlist     session   │   │
│  │  reconnect    chatmode gate    sender check       deliver   │   │
│  │                                                      │     │   │
│  │  send.ts ◄─────────────────────────────────────────-┘     │   │
│  │  (chunked, threaded, REST POST to /api/v1/chat.sendMessage) │   │
│  └──────────────────────────────┬──────────────────────────────┘   │
│                                 │                                   │
│  ┌──────────────────────────────▼──────────────────────────────┐   │
│  │                Event Bus Layer (infra/event-bus/)            │   │
│  │                                                             │   │
│  │   tryPublishInbound() ──► Redis XADD / NATS publish        │   │
│  │   subscribe()          ◄── XREADGROUP / JetStream pull      │   │
│  │   DLQ routing          ──► *.dlq stream on max retries      │   │
│  └──────────────────────────────┬──────────────────────────────┘   │
│                                 │                                   │
│  ┌──────────────────────────────▼──────────────────────────────┐   │
│  │                    Agent Execution Layer                     │   │
│  │                                                             │   │
│  │   ACP Manager ──► Agent Process ──► Tool Pipeline          │   │
│  │                       │                  │                  │   │
│  │                   LLM API call       bash / file / web     │   │
│  │                   (Anthropic/OAI)    (sandboxed)           │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
         │                 │
         ▼                 ▼
┌────────────────┐  ┌──────────────────────────┐
│  Redis Streams │  │  NATS JetStream          │
│  (event bus)   │  │  (alternative transport) │
│  AOF persist   │  │  leafnode edge support   │
└────────────────┘  └──────────────────────────┘
```

---

## 3. Plugin File Structure

```
extensions/rocketchat/
├── index.ts                         # Plugin entry point (defineChannelPluginEntry)
├── setup-entry.ts                   # CLI setup wizard entry
├── package.json                     # NPM manifest + openclaw.plugin.json inline
├── openclaw.plugin.json             # Plugin registry manifest
└── src/
    ├── channel.ts                   # ChannelPlugin export — wires all adapters
    ├── types.ts                     # Domain types (config, modes, policies)
    ├── config-schema.ts             # Zod schema + UI hints
    ├── normalize.ts                 # Target normalisation, ID detection
    ├── session-route.ts             # Outbound session key routing
    ├── approval-auth.ts             # Pairing approval adapter
    ├── setup-core.ts                # CLI setup adapter
    ├── runtime.ts                   # Plugin runtime singleton store
    ├── runtime-api.ts               # Plugin-SDK barrel re-export
    ├── secret-input.ts              # SecretInput resolution (env/file/plain)
    ├── rocketchat/
    │   ├── ddp-client.ts            # DDP/WebSocket real-time client
    │   ├── client.ts                # REST API client (send, rooms, users)
    │   ├── accounts.ts              # Multi-account resolution
    │   ├── monitor.ts               # Real-time inbound event monitor
    │   ├── send.ts                  # Outbound delivery (chunked, threaded)
    │   ├── security.ts              # Prompt-injection guard, room ACL
    │   ├── probe.ts                 # Health check (/api/v1/me)
    │   └── slash-commands.ts        # Slash command HTTP handler
    └── infra/
        └── event-bus/
            ├── types.ts             # IEventBus interface + event envelopes
            ├── memory.ts            # In-memory transport (dev/testing)
            ├── redis.ts             # Redis Streams transport (production)
            └── index.ts             # Factory + publish helpers

k8s/
├── kustomization.yaml               # Single-command apply entrypoint
├── rocketchat/
│   ├── namespace.yaml               # Namespace + ServiceAccount + RBAC
│   ├── configmap.yaml               # Non-sensitive gateway config
│   ├── secrets.yaml                 # Secret templates (do not commit real values)
│   ├── deployment.yaml              # Gateway Deployment (2–10 replicas)
│   ├── service.yaml                 # ClusterIP + headless services
│   ├── ingress.yaml                 # nginx Ingress with TLS + rate limiting
│   ├── hpa.yaml                     # HPA (CPU + memory + queue depth) + PDB
│   └── network-policy.yaml          # Zero-trust NetworkPolicies
├── infra/
│   ├── redis.yaml                   # Redis StatefulSet + exporter sidecar
│   └── nats.yaml                    # NATS JetStream StatefulSet + exporter
└── monitoring/
    └── service-monitor.yaml         # ServiceMonitor + PrometheusRule alerts
```

---

## 4. Message Flow (Inbound)

```
User sends message in Rocket.Chat
        │
        ▼
DDPClient.onMessage(RocketChatMessage, roomId)
        │
        ├── isBotMessage?  → skip (own messages)
        ├── isSystemMsg?   → skip (joins/leaves)
        │
        ▼
runInboundSecurityGate()
        ├── checkRoomAccess()          → allowedRoomIds / blockedRoomIds
        ├── checkMessageLength()       → maxInboundMessageLength (8 000 chars)
        ├── sanitiseInboundMessage()   → strip null bytes, RTL override, ZWS
        └── checkPromptInjection()     → 14 regex patterns (OWASP LLM Top-10)
                │
                ├── FAIL → logInboundDrop(), return
                │
                ▼
shouldRespondToMessage()  (chatmode gate)
        ├── "oncall"    → must be @mentioned (DM always passes)
        ├── "onmessage" → always respond
        └── "onchar"    → must start with trigger prefix (>, !)
                │
                ├── NO → return (silent drop)
                │
                ▼
checkSenderAllowed()  (allowFrom list for DMs)
                │
                ▼
sendRocketChatTyping()  (best-effort, async)
                │
                ▼
tryPublishInbound()  →  Redis XADD / memory emit
                │
                ▼
replyPipeline.handle()  →  ACP session  →  Agent  →  LLM
                │
                ▼
deliver()  →  sendMessageRocketChat()  →  REST POST /api/v1/chat.sendMessage
```

---

## 5. Message Flow (Outbound / Slash Commands)

```
User types /claw skill <name> in Rocket.Chat
        │
        ▼ (Rocket.Chat Outgoing Webhook POST)
POST /rocketchat/slash/default
        │
        ▼
registerRocketChatSlashCommandRoute()
        ├── Validate token
        ├── Immediate 200 "⚙️ Processing…"
        │
        ▼  (async)
handleSlashCommand()
        ├── /claw skill <name>   → trigger named skill via replyPipeline
        ├── /claw agent <id> [msg] → target specific agent
        └── /claw help          → send help text
                │
                ▼
sendMessageRocketChat(roomId, responseText)
        └── RocketChatClient.sendMessage() → POST /api/v1/chat.sendMessage
```

---

## 6. Event Bus Architecture

```
                    Inbound Path
                    ─────────────
monitor.ts ──XADD──► Redis Stream "openclaw.rocketchat.inbound"
                              │
              XREADGROUP (consumer group "gateway-1")
                              │
                    Message Handler
                    ├── ack()  → XACK → message consumed
                    └── nack() → retry with exponential backoff
                                 → DLQ after maxRetries (default: 3)

                    Outbound Path
                    ─────────────
Agent reply ──────► "openclaw.rocketchat.outbound"
                              │
              XREADGROUP
                              │
                    sendMessageRocketChat()
                    └── ack() on success / nack() on transient error

                    Agent Exec Path (decoupled execution)
                    ─────────────────────────────────────
monitor.ts ──XADD──► "openclaw.agent.exec"
                              │
              XREADGROUP (separate consumer — can run in different pod)
                              │
                    ACP session.handle()
                              │
                    publish to outbound stream
```

**Transport selection:**

| Scenario | Transport | Reason |
|----------|-----------|--------|
| Local dev / single instance | `memory` | Zero deps, zero config |
| Production single AZ | `redis` | Persistence, consumer groups, replay |
| Production multi-AZ / cloud-native | `nats` | Sub-ms latency, fan-out, federation |
| Edge / UAV / IoT | `nats` + leafnode | Disconnected operation, sync on reconnect |

---

## 7. Security Hardening

### 7.1 Prompt Injection Guard (`security.ts`)

14 regex patterns cover OWASP LLM Top-10 #01:
- Role-override: "ignore previous instructions", "act as", "pretend to be"
- Exfiltration: "repeat your system prompt", "print your prompt"
- Jailbreak framing: DAN mode, developer mode, confidential mode
- Code execution: bash/python/ruby code blocks, `exec()`, `eval()`, `subprocess`
- Unicode trickery: null bytes, right-to-left override (U+202E), zero-width chars

### 7.2 Room-Level ACL

Per-account `allowedRoomIds` / `blockedRoomIds` lists. Checked before any processing.

### 7.3 Sender Allowlist

`allowFrom` supports: `*` (open), `user:<id>`, `@username`, bare username.  
DM policy: `pairing` (default) | `allowlist` | `open` | `disabled`.

### 7.4 Kubernetes Network Policy

Zero-trust defaults:
- Default-deny all ingress + egress in `openclaw` namespace
- Gateway → Redis: port 6379 only, from gateway pod label selector
- Gateway → external: port 443 only, RFC1918 blocked
- Redis ← gateway only (no direct external access)
- Metrics: Prometheus namespace only

### 7.5 Pod Security

- `runAsNonRoot: true`, `runAsUser: 1000`
- `readOnlyRootFilesystem: true` (writable emptyDirs for /tmp, /run)
- `allowPrivilegeEscalation: false`
- `capabilities: drop: [ALL]`
- `seccompProfile: RuntimeDefault`
- `automountServiceAccountToken: false`

### 7.6 Secret Management

Secrets injected as env vars from K8s Secrets — never baked into images or ConfigMaps. Production recommendation: External Secrets Operator + HashiCorp Vault or AWS Secrets Manager.

---

## 8. Multi-Agent Orchestration

### Agent-to-Channel Mapping

Each room gets a **scoped session key**:
```
rocketchat:<accountId>:<roomId>:<threadId>
```
This isolates conversation memory per room and per thread.

### Multi-Agent Routing

```yaml
# Example config: route #devops room to devops agent, #sre to sre agent
channels:
  rocketchat:
    accounts:
      devops-bot:
        serverUrl: https://chat.example.com
        authToken: { env: RC_DEVOPS_TOKEN }
        userId: { env: RC_DEVOPS_USER_ID }
        botUsername: devops-bot
        allowedRoomIds: ["ROOM_ID_devops", "ROOM_ID_infra"]
        chatmode: oncall
      sre-bot:
        serverUrl: https://chat.example.com
        authToken: { env: RC_SRE_TOKEN }
        userId: { env: RC_SRE_USER_ID }
        botUsername: sre-bot
        allowedRoomIds: ["ROOM_ID_sre", "ROOM_ID_oncall"]
        chatmode: oncall
```

Each named account runs its own DDP monitor and agent session pool, isolated by `accountId`.

---

## 9. Kubernetes Deployment

### Quick Start

```bash
# 1. Fill in secrets (never commit real values)
cp k8s/rocketchat/secrets.yaml k8s/rocketchat/secrets.local.yaml
# Edit secrets.local.yaml with base64-encoded values

# 2. Apply infra first
kubectl apply -f k8s/rocketchat/namespace.yaml
kubectl apply -f k8s/infra/redis.yaml
kubectl apply -f k8s/infra/nats.yaml

# 3. Apply credentials
kubectl apply -f k8s/rocketchat/secrets.local.yaml

# 4. Apply full stack
kubectl apply -k k8s/

# 5. Watch rollout
kubectl rollout status deployment/openclaw-gateway -n openclaw

# 6. Check logs
kubectl logs -n openclaw -l app.kubernetes.io/name=openclaw-gateway --tail=100 -f
```

### Scaling

```bash
# Manual scale
kubectl scale deployment openclaw-gateway -n openclaw --replicas=5

# Check HPA status
kubectl get hpa openclaw-gateway -n openclaw

# Force restart after config change
kubectl rollout restart deployment/openclaw-gateway -n openclaw
```

### Observability Stack

```bash
# Install kube-prometheus-stack (includes Grafana + Alertmanager)
helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  -n monitoring --create-namespace

# Apply ServiceMonitor and PrometheusRule
kubectl apply -f k8s/monitoring/service-monitor.yaml

# Access Grafana
kubectl port-forward svc/kube-prometheus-stack-grafana -n monitoring 3000:80
```

---

## 10. Rocket.Chat Configuration

### 1. Create Bot User

Admin → Users → Add User:
- Username: `openclaw-bot`
- Roles: `bot`, `livechat-agent` (if using livechat)
- Generate Personal Access Token → use as `authToken`
- Copy `_id` from user record → use as `userId`

### 2. Configure Outgoing Webhook (Slash Commands)

Admin → Integrations → Outgoing Webhook:
- Event Trigger: `Message Sent`
- Channel: `#general` (or specific channels)
- Trigger Words: `/claw`
- URLs: `https://openclaw.example.com/rocketchat/slash/default`
- Token: set `ROCKETCHAT_SLASH_TOKEN_DEFAULT` env var in gateway

### 3. OpenClaw Config

```yaml
channels:
  rocketchat:
    serverUrl: https://chat.example.com
    authToken: { env: ROCKETCHAT_AUTH_TOKEN }
    userId: { env: ROCKETCHAT_USER_ID }
    botUsername: openclaw-bot
    chatmode: oncall
    requireMention: true
    dmPolicy: pairing
    replyTo: first
    promptInjectionGuard: true
    eventBusUrl: redis://redis-master.openclaw.svc.cluster.local:6379
    eventStreamPrefix: openclaw.rocketchat
    commands:
      native: true
      callbackPath: /rocketchat/slash/default
```

---

## 11. Edge / UAV / IoT Extension

NATS JetStream supports **leafnode** connections — lightweight edge nodes that replicate a subset of subjects from the cluster, tolerate disconnection, and sync when reconnected.

```
Cloud Cluster (NATS JetStream)
        │
        │  leafnode TLS
        ▼
Edge Node / UAV Ground Station (NATS leafnode)
        │
        │  local publish
        ▼
IoT Sensor / UAV telemetry agent
```

Configure in `nats.conf`:
```
leafnodes {
  remotes = [{
    url: "tls://nats.openclaw.example.com:7422"
    credentials: "/etc/nats/openclaw-edge.creds"
  }]
}
```

Agents on edge devices publish to `openclaw.agent.exec` locally; the leafnode replicates to the cloud cluster; cloud gateway picks up the job, executes with full LLM access, publishes result to `openclaw.rocketchat.outbound`; edge node relays the delivery back.

---

## 12. Trade-offs and Risks

| Area | Decision | Trade-off |
|------|----------|-----------|
| DDP vs polling | DDP WebSocket (real-time) | More complex reconnect logic; better latency |
| Redis vs NATS | Redis default, NATS optional | Redis simpler ops; NATS faster + edge-ready |
| Memory bus for dev | Zero deps, instant setup | No persistence, no cross-process |
| Prompt injection regex | Fast, deterministic | May miss novel patterns; complement with LLM-based guard |
| `allowedRoomIds` ACL | Explicit allowlist | Requires manual room ID maintenance |
| `readOnlyRootFilesystem` | Strong isolation | Requires emptyDir mounts for Node.js temp files |
| HPA custom metrics | Queue-depth scaling | Requires prometheus-adapter setup |
| Single Redis replica | Simple deployment | SPOF; use HA Helm chart for production |
