/**
 * rocketchat/ddp-client.ts
 *
 * Rocket.Chat DDP (Distributed Data Protocol) WebSocket client.
 * DDP is the Meteor-based real-time protocol powering Rocket.Chat's
 * live event stream. This module handles:
 *   - WebSocket lifecycle (connect / reconnect / heartbeat)
 *   - DDP handshake and method calls
 *   - Subscription management for room messages
 *   - Typed event emission for inbound messages
 */

import WebSocket from "ws";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DDPMessage = {
  msg: string;
  id?: string;
  collection?: string;
  fields?: {
    eventName?: string;
    args?: unknown[];
  };
  result?: unknown;
  error?: { error: string | number; reason?: string; message?: string };
};

export type RocketChatMessage = {
  _id: string;
  rid: string; // room id
  msg: string;
  ts: { $date: number };
  u: { _id: string; username: string; name?: string };
  mentions?: Array<{ _id: string; username: string; name?: string; type?: string }>;
  attachments?: RocketChatAttachment[];
  tmid?: string; // thread message id
  tcount?: number;
  tlm?: { $date: number };
  t?: string; // message type (e.g. "rm" = removed, "uj" = user joined)
  editedBy?: { _id: string; username: string };
  editedAt?: { $date: number };
  pinned?: boolean;
  starred?: Array<{ _id: string }>;
  drid?: string; // direct reply id
};

export type RocketChatAttachment = {
  type?: string;
  title?: string;
  text?: string;
  image_url?: string;
  audio_url?: string;
  video_url?: string;
  title_link?: string;
  collapsed?: boolean;
  fields?: Array<{ title: string; value: string; short?: boolean }>;
};

export type RocketChatRoom = {
  _id: string;
  name?: string;
  fname?: string;
  t: "c" | "d" | "p" | "l"; // channel, direct, private, livechat
  u?: { _id: string; username: string };
  usernames?: string[];
};

export type DDPClientOptions = {
  url: string;
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
  pingIntervalMs?: number;
  onMessage?: (msg: RocketChatMessage, room: string) => void | Promise<void>;
  onError?: (err: unknown) => void;
  onReconnect?: () => void;
};

// ---------------------------------------------------------------------------
// DDPClient
// ---------------------------------------------------------------------------

export class DDPClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private connected = false;
  private pendingCalls = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private subscriptions = new Map<string, string>(); // subId → roomId
  private callCounter = 0;
  private subCounter = 0;
  private reconnectAttempts = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(private readonly opts: DDPClientOptions) {
    super();
  }

  // ---------- Lifecycle --------------------------------------------------

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.destroyed) return reject(new Error("DDPClient: already destroyed"));

      this.ws = new WebSocket(this.opts.url);

      this.ws.once("open", () => {
        this.ws!.send(JSON.stringify({
          msg: "connect",
          version: "1",
          support: ["1"],
        }));
      });

      this.ws.on("message", (raw) => {
        let payload: DDPMessage;
        try {
          payload = JSON.parse(raw.toString());
        } catch {
          return;
        }
        this._handleDDPMessage(payload, resolve, reject);
      });

      this.ws.once("error", (err) => {
        this.opts.onError?.(err);
        if (!this.connected) reject(err);
      });

      this.ws.once("close", (code, reason) => {
        this.connected = false;
        this._stopPing();
        if (!this.destroyed) this._scheduleReconnect();
      });
    });
  }

  destroy(): void {
    this.destroyed = true;
    this._stopPing();
    this.ws?.terminate();
    this.ws = null;
    this.pendingCalls.clear();
    this.subscriptions.clear();
  }

  // ---------- DDP Protocol -----------------------------------------------

  private _handleDDPMessage(
    msg: DDPMessage,
    connectResolve?: (v: void) => void,
    connectReject?: (e: unknown) => void,
  ): void {
    switch (msg.msg) {
      case "connected":
        this.connected = true;
        this.reconnectAttempts = 0;
        this._startPing();
        connectResolve?.();
        this.emit("connected");
        break;

      case "ping":
        this.ws?.send(JSON.stringify({ msg: "pong" }));
        break;

      case "result": {
        const cb = this.pendingCalls.get(msg.id ?? "");
        if (cb) {
          this.pendingCalls.delete(msg.id!);
          if (msg.error) {
            cb.reject(new Error(String(msg.error.reason ?? msg.error.message ?? msg.error.error)));
          } else {
            cb.resolve(msg.result);
          }
        }
        break;
      }

      case "changed": {
        if (msg.collection === "stream-room-messages" && msg.fields) {
          const args = msg.fields.args;
          if (Array.isArray(args) && args.length > 0) {
            const rcMsg = args[0] as RocketChatMessage;
            const roomId = msg.fields.eventName as string;
            this.opts.onMessage?.(rcMsg, roomId);
            this.emit("message", rcMsg, roomId);
          }
        }
        break;
      }

      case "ready":
        this.emit("ready", msg);
        break;

      case "nosub": {
        const subId = msg.id;
        if (subId) {
          this.subscriptions.delete(subId);
          this.emit("nosub", subId, msg.error);
        }
        break;
      }
    }
  }

  // ---------- Public API --------------------------------------------------

  async call<T = unknown>(method: string, ...params: unknown[]): Promise<T> {
    if (!this.connected || !this.ws) throw new Error("DDPClient: not connected");
    const id = String(++this.callCounter);
    return new Promise<T>((resolve, reject) => {
      this.pendingCalls.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.ws!.send(JSON.stringify({ msg: "method", method, params, id }));
    });
  }

  subscribe(roomId: string): string {
    if (!this.connected || !this.ws) throw new Error("DDPClient: not connected");
    const id = `sub-${++this.subCounter}`;
    this.subscriptions.set(id, roomId);
    this.ws.send(JSON.stringify({
      msg: "sub",
      id,
      name: "stream-room-messages",
      params: [roomId, { useCollection: false, args: [{ visitorToken: false }] }],
    }));
    return id;
  }

  unsubscribe(subId: string): void {
    if (this.ws && this.connected) {
      this.ws.send(JSON.stringify({ msg: "unsub", id: subId }));
    }
    this.subscriptions.delete(subId);
  }

  getSubscribedRooms(): string[] {
    return [...this.subscriptions.values()];
  }

  // ---------- Internals ---------------------------------------------------

  private _startPing(): void {
    const interval = this.opts.pingIntervalMs ?? 30_000;
    this.pingTimer = setInterval(() => {
      if (this.connected && this.ws) {
        this.ws.send(JSON.stringify({ msg: "ping" }));
      }
    }, interval);
  }

  private _stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private _scheduleReconnect(): void {
    const max = this.opts.maxReconnectAttempts ?? 10;
    if (this.reconnectAttempts >= max) {
      this.emit("max_reconnect_exceeded");
      return;
    }
    const delay = Math.min(
      (this.opts.reconnectDelayMs ?? 2_000) * Math.pow(1.5, this.reconnectAttempts),
      60_000,
    );
    this.reconnectAttempts++;
    setTimeout(() => {
      if (!this.destroyed) {
        this.connect()
          .then(() => {
            this.opts.onReconnect?.();
            this.emit("reconnected");
          })
          .catch((err) => this.opts.onError?.(err));
      }
    }, delay);
  }
}
