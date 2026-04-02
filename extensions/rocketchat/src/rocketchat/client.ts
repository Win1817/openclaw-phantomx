/**
 * rocketchat/client.ts
 *
 * REST API client for Rocket.Chat.
 * Covers: authentication, message send/update/delete,
 * room lookup, user info, slash-command registration.
 *
 * All methods throw on non-2xx responses.
 */

export type RocketChatClientOptions = {
  baseUrl: string;
  authToken: string;
  userId: string;
  /** Timeout in ms for each request (default 15 000) */
  timeoutMs?: number;
};

export type RCSendMessagePayload = {
  roomId: string;
  text: string;
  alias?: string;
  emoji?: string;
  avatar?: string;
  attachments?: RCAttachment[];
  tmid?: string; // reply in thread
};

export type RCAttachment = {
  color?: string;
  text?: string;
  title?: string;
  title_link?: string;
  image_url?: string;
  audio_url?: string;
  video_url?: string;
  fields?: Array<{ title: string; value: string; short?: boolean }>;
  collapsed?: boolean;
};

export type RCSendResult = {
  _id: string;
  rid: string;
  ts: string;
  msg: string;
};

export type RCRoomInfo = {
  _id: string;
  name?: string;
  fname?: string;
  t: "c" | "d" | "p" | "l";
  usernames?: string[];
  usersCount?: number;
  lastMessage?: unknown;
  description?: string;
  topic?: string;
};

export type RCUserInfo = {
  _id: string;
  username: string;
  name?: string;
  emails?: Array<{ address: string; verified: boolean }>;
  roles?: string[];
  active?: boolean;
  status?: string;
  customFields?: Record<string, string>;
};

export type RCLoginResult = {
  userId: string;
  authToken: string;
  me: RCUserInfo;
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class RocketChatClient {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(opts: RocketChatClientOptions) {
    this.base = opts.baseUrl.replace(/\/$/, "") + "/api/v1";
    this.headers = {
      "Content-Type": "application/json",
      "X-Auth-Token": opts.authToken,
      "X-User-Id": opts.userId,
    };
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  // ---------- Auth --------------------------------------------------------

  static async login(baseUrl: string, username: string, password: string): Promise<RCLoginResult> {
    const url = `${baseUrl.replace(/\/$/, "")}/api/v1/login`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const json = await res.json() as { status: string; data?: RCLoginResult };
    if (!res.ok || json.status !== "success" || !json.data) {
      throw new Error(`Rocket.Chat login failed: ${JSON.stringify(json)}`);
    }
    return json.data;
  }

  // ---------- Messages ----------------------------------------------------

  async sendMessage(payload: RCSendMessagePayload): Promise<RCSendResult> {
    const json = await this._post<{ success: boolean; message: RCSendResult }>("/chat.sendMessage", {
      message: payload,
    });
    if (!json.success) throw new Error("sendMessage: success=false");
    return json.message;
  }

  async updateMessage(msgId: string, roomId: string, text: string): Promise<RCSendResult> {
    const json = await this._post<{ success: boolean; message: RCSendResult }>("/chat.update", {
      roomId,
      msgId,
      text,
    });
    if (!json.success) throw new Error("updateMessage: success=false");
    return json.message;
  }

  async deleteMessage(msgId: string, roomId: string): Promise<void> {
    await this._post<{ success: boolean }>("/chat.delete", { roomId, msgId });
  }

  async setReaction(emoji: string, msgId: string): Promise<void> {
    await this._post<{ success: boolean }>("/chat.react", { emoji, messageId: msgId });
  }

  // ---------- Rooms -------------------------------------------------------

  async getRoomInfo(roomId: string): Promise<RCRoomInfo> {
    const json = await this._get<{ success: boolean; room: RCRoomInfo }>("/rooms.info", { roomId });
    if (!json.success) throw new Error("getRoomInfo: success=false");
    return json.room;
  }

  async getRoomByName(roomName: string): Promise<RCRoomInfo> {
    const json = await this._get<{ success: boolean; room: RCRoomInfo }>("/rooms.info", { roomName });
    if (!json.success) throw new Error("getRoomByName: success=false");
    return json.room;
  }

  async listSubscribedRooms(userId?: string): Promise<RCRoomInfo[]> {
    const json = await this._get<{ success: boolean; update: RCRoomInfo[] }>("/subscriptions.get");
    if (!json.success) throw new Error("listSubscribedRooms: success=false");
    return json.update;
  }

  // ---------- Users -------------------------------------------------------

  async getUserInfo(userId: string): Promise<RCUserInfo> {
    const json = await this._get<{ success: boolean; user: RCUserInfo }>("/users.info", { userId });
    if (!json.success) throw new Error("getUserInfo: success=false");
    return json.user;
  }

  async getUserByUsername(username: string): Promise<RCUserInfo> {
    const json = await this._get<{ success: boolean; user: RCUserInfo }>("/users.info", { username });
    if (!json.success) throw new Error("getUserByUsername: success=false");
    return json.user;
  }

  async getMe(): Promise<RCUserInfo> {
    const json = await this._get<{ success: boolean } & RCUserInfo>("/me");
    if (!json.success) throw new Error("getMe: success=false");
    return json;
  }

  // ---------- HTTP helpers ------------------------------------------------

  private async _get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(this.base + path);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: this.headers,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`GET ${path} → ${res.status}: ${body}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async _post<T>(path: string, body: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}${path}`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`POST ${path} → ${res.status}: ${text}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
