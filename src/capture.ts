import CDP from "chrome-remote-interface";
import { EventEmitter } from "node:events";
import type { Protocol } from "devtools-protocol";

type Headers = Record<string, string>;
type Target = Protocol.Target.TargetInfo;
type Body = {
  data?: string;
  encoding?: "base64";
  truncated?: boolean;
  unavailable?: string;
};
export type CaptureOptions = {
  hosts: string[];
  extensions: string[];
  targetIds: string[];
  pauseWorkers: boolean;
  sensitive: boolean;
  limit: number;
  bodyLimit: number;
};
export type Entry = {
  id: string;
  sessionId: string;
  requestId: string;
  target: { id: string; type: string; url: string };
  url: string;
  method: string;
  resourceType?: string;
  startedAt?: string;
  requestHeaders: Headers;
  responseHeaders?: Headers;
  wireHeaders?: boolean;
  requestBody?: Body;
  responseBody?: Body;
  status?: number;
  mimeType?: string;
  redirected?: boolean;
  complete?: boolean;
  error?: string;
  bytes?: number;
  sensitive: boolean;
  protocol?: string;
  fromServiceWorker?: boolean;
  frames?: { direction: string; opcode: number; bytes: number; body?: Body }[];
  droppedFrames?: number;
};
type Group = {
  entries: (Entry | undefined)[];
  requestExtras: (Headers | undefined)[];
  responseExtras: ({ headers: Headers; status: number } | undefined)[];
};

export class Capture extends EventEmitter {
  readonly entries = new Map<string, Entry>();
  readonly targets = new Map<string, { info: Target; sessionId: string }>();
  readonly errors: string[] = [];
  private groups = new Map<string, Group>();
  private sessions = new Map<string, Target>();
  private attaching = new Set<string>();
  private sequence = 0;
  private evicted = 0;
  private pending = new Set<Promise<void>>();
  private bytes = new Map<string, number>();
  private totalBytes = 0;
  private closed = false;

  constructor(
    readonly client: CDP.Client,
    readonly options: CaptureOptions,
  ) {
    super();
  }

  matches(url: string): boolean {
    try {
      const parsed = new URL(url);
      return (
        ["http:", "https:", "ws:", "wss:"].includes(parsed.protocol) &&
        this.options.hosts.some(
          (host) =>
            parsed.hostname === host || parsed.hostname.endsWith(`.${host}`),
        )
      );
    } catch {
      return false;
    }
  }

  private selected(info: Target): boolean {
    return (
      (!this.options.targetIds.length ||
        this.options.targetIds.includes(info.targetId)) &&
      [
        "page",
        "iframe",
        "worker",
        "service_worker",
        "shared_worker",
        "background_page",
      ].includes(info.type) &&
      (this.matches(info.url) ||
        this.options.extensions.some((id) =>
          info.url.startsWith(`chrome-extension://${id}/`),
        ))
    );
  }

  private url(value: string): string {
    if (this.options.sensitive) return value;
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()])
      url.searchParams.set(key, "[redacted]");
    return url.href;
  }

  private headers(value: Headers): Headers {
    if (this.options.sensitive) return { ...value };
    return Object.fromEntries(
      Object.entries(value).filter(([key]) =>
        /^(content-type|content-length|cache-control|accept|accept-encoding)$/i.test(
          key,
        ),
      ),
    );
  }

  private body(data: string, base64 = false): Body {
    const bytes = Buffer.from(data, base64 ? "base64" : "utf8");
    return {
      data: bytes.subarray(0, this.options.bodyLimit).toString("base64"),
      encoding: "base64",
      truncated: bytes.length > this.options.bodyLimit,
    };
  }

  private note(error: unknown): void {
    this.errors.push(error instanceof Error ? error.message : String(error));
    if (this.errors.length > 20) this.errors.shift();
  }

  private update(entry: Entry): void {
    if (!this.entries.has(entry.id)) return;
    const size = Buffer.byteLength(JSON.stringify(entry));
    this.totalBytes += size - (this.bytes.get(entry.id) || 0);
    this.bytes.set(entry.id, size);
    while (
      this.entries.size > this.options.limit ||
      this.totalBytes > 64 * 1024 * 1024
    ) {
      const oldest = this.entries.values().next().value!;
      this.entries.delete(oldest.id);
      this.evicted++;
      this.totalBytes -= this.bytes.get(oldest.id) || 0;
      this.bytes.delete(oldest.id);
      const key = `${oldest.sessionId}:${oldest.requestId}`;
      const group = this.groups.get(key);
      if (group) {
        const index = group.entries.indexOf(oldest);
        group.entries[index] = undefined;
        group.requestExtras[index] = undefined;
        group.responseExtras[index] = undefined;
        if (group.entries.every((item) => !item)) this.groups.delete(key);
      }
    }
    this.emit("request", {
      id: entry.id,
      method: entry.method,
      url: entry.url,
      status: entry.status,
      complete: entry.complete,
      target: entry.target,
    });
  }

  private correlate(group: Group): void {
    group.entries.forEach((entry, index) => {
      if (!entry) return;
      if (group.requestExtras[index]) {
        entry.requestHeaders = group.requestExtras[index];
        entry.wireHeaders = true;
      }
      if (group.responseExtras[index]) {
        entry.responseHeaders = group.responseExtras[index].headers;
        entry.status = group.responseExtras[index].status;
      }
      this.update(entry);
    });
  }

  async start(): Promise<void> {
    this.client.on("event", (message) => {
      const task = this.event(
        message.method,
        message.params,
        message.sessionId,
      ).catch((error) => this.note(error));
      this.pending.add(task);
      void task.finally(() => this.pending.delete(task));
    });
    if (this.options.pauseWorkers)
      await this.client.Target.setAutoAttach({
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: "service_worker" }, { exclude: true }],
      });
    await this.client.Target.setDiscoverTargets({ discover: true });
    const { targetInfos } = await this.client.Target.getTargets();
    await Promise.all(targetInfos.map((info) => this.attach(info)));
    await Promise.all(this.pending);
  }

  private async attach(info: Target): Promise<void> {
    if (this.options.pauseWorkers && info.type === "service_worker") return;
    const existing = this.targets.get(info.targetId);
    if (!this.selected(info)) {
      if (existing) {
        this.targets.delete(info.targetId);
        this.sessions.delete(existing.sessionId);
        await this.client.Target.detachFromTarget({
          sessionId: existing.sessionId,
        });
      }
      return;
    }
    if (existing) {
      existing.info = info;
      this.sessions.set(existing.sessionId, info);
      return;
    }
    if (this.closed || this.attaching.has(info.targetId)) return;
    this.attaching.add(info.targetId);
    let sessionId: string | undefined;
    try {
      ({ sessionId } = await this.client.Target.attachToTarget({
        targetId: info.targetId,
        flatten: true,
      }));
      if (this.closed) {
        await this.client.Target.detachFromTarget({ sessionId });
        return;
      }
      await this.observe(info, sessionId);
    } catch (error) {
      if (sessionId) {
        this.sessions.delete(sessionId);
        await this.client.Target.detachFromTarget({ sessionId }).catch(
          () => {},
        );
      }
      this.note(error);
    } finally {
      this.attaching.delete(info.targetId);
    }
  }

  private async observe(info: Target, sessionId: string): Promise<void> {
    this.sessions.set(sessionId, info);
    await this.client.send(
      "Network.enable",
      {
        maxTotalBufferSize: this.options.bodyLimit * 4,
        maxResourceBufferSize: this.options.bodyLimit,
        maxPostDataSize: this.options.bodyLimit,
      },
      sessionId,
    );
    this.targets.set(info.targetId, { info, sessionId });
  }

  async listTargets() {
    const { targetInfos } = await this.client.Target.getTargets();
    return targetInfos
      .filter((info) => this.selected(info))
      .map((info) => ({
        id: info.targetId,
        type: info.type,
        url: this.url(info.url),
        attached: this.targets.has(info.targetId),
      }));
  }

  async media(targetId: string, duration: number) {
    const target = this.targets.get(targetId);
    if (!target || !["page", "iframe"].includes(target.info.type))
      throw new Error("Choose an attached page or iframe target");
    const expression =
      "Array.from(document.querySelectorAll('video'), (v, index) => ({index, time: v.currentTime, paused: v.paused, ended: v.ended, width: v.videoWidth, height: v.videoHeight, readyState: v.readyState, frames: v.getVideoPlaybackQuality().totalVideoFrames, droppedFrames: v.getVideoPlaybackQuality().droppedVideoFrames, mediaKeysAttached: Boolean(v.mediaKeys), error: v.error ? {code: v.error.code, message: v.error.message} : null}))";
    const sample = async () => {
      const result = (await this.client.send(
        "Runtime.evaluate",
        { expression, returnByValue: true },
        target.sessionId,
      )) as Protocol.Runtime.EvaluateResponse;
      if (result.exceptionDetails)
        throw new Error("Video state evaluation failed");
      return result.result.value;
    };
    const before = await sample();
    await new Promise((resolve) => setTimeout(resolve, duration));
    return { targetId, durationMs: duration, before, after: await sample() };
  }

  private async event(
    method: string,
    params: unknown,
    sessionId?: string,
  ): Promise<void> {
    if (this.closed) return;
    if (method === "Target.attachedToTarget" && this.options.pauseWorkers) {
      const {
        targetInfo,
        sessionId: attached,
        waitingForDebugger,
      } = params as Protocol.Target.AttachedToTargetEvent;
      try {
        if (this.selected(targetInfo)) await this.observe(targetInfo, attached);
      } finally {
        if (waitingForDebugger)
          await this.client.send(
            "Runtime.runIfWaitingForDebugger",
            undefined,
            attached,
          );
        if (!this.selected(targetInfo))
          await this.client.Target.detachFromTarget({ sessionId: attached });
      }
      return;
    }
    if (
      method === "Target.targetCreated" ||
      method === "Target.targetInfoChanged"
    ) {
      await this.attach(
        (params as Protocol.Target.TargetCreatedEvent).targetInfo,
      );
      return;
    }
    if (method === "Target.detachedFromTarget") {
      const { sessionId: detached } =
        params as Protocol.Target.DetachedFromTargetEvent;
      const info = this.sessions.get(detached);
      if (info) this.targets.delete(info.targetId);
      this.sessions.delete(detached);
      return;
    }
    const info = sessionId && this.sessions.get(sessionId);
    if (!info || !sessionId || !method.startsWith("Network.")) return;
    const requestId = (params as { requestId?: string }).requestId;
    if (!requestId) return;
    const key = `${sessionId}:${requestId}`;
    const group = this.groups.get(key) || {
      entries: [],
      requestExtras: [],
      responseExtras: [],
    };
    const entry = group.entries.at(-1);
    if (
      method === "Network.requestWillBeSent" ||
      method === "Network.webSocketCreated"
    ) {
      const event = params as Protocol.Network.RequestWillBeSentEvent;
      const socket = method === "Network.webSocketCreated";
      const url = socket
        ? (params as Protocol.Network.WebSocketCreatedEvent).url
        : event.request.url;
      if (!this.matches(url)) return;
      if (entry && event.redirectResponse) {
        entry.redirected = true;
        entry.complete = true;
        entry.status = event.redirectResponse.status;
        this.update(entry);
      }
      const next: Entry = {
        id: String(++this.sequence),
        sessionId,
        requestId,
        target: { id: info.targetId, type: info.type, url: this.url(info.url) },
        url: this.url(url),
        method: socket ? "WEBSOCKET" : event.request.method,
        requestHeaders: socket ? {} : this.headers(event.request.headers),
        sensitive: this.options.sensitive,
        ...(socket
          ? { frames: [], droppedFrames: 0 }
          : {
              resourceType: event.type,
              startedAt: new Date(event.wallTime * 1000).toISOString(),
              redirected: !!event.redirectResponse,
            }),
      };
      if (!socket && event.request.hasPostData && this.options.sensitive) {
        next.requestBody =
          event.request.postData === undefined ||
          /multipart\/form-data/i.test(
            Object.entries(event.request.headers).find(
              ([key]) => key.toLowerCase() === "content-type",
            )?.[1] || "",
          )
            ? {
                unavailable:
                  "Chrome omitted the body or it contains multipart data",
              }
            : this.body(event.request.postData);
      }
      group.entries.push(next);
      this.groups.set(key, group);
      this.entries.set(next.id, next);
      this.correlate(group);
      return;
    }
    if (
      method === "Network.requestWillBeSentExtraInfo" ||
      method === "Network.responseReceivedExtraInfo"
    ) {
      // Do not retain headers before a permitted request URL is known.
      if (!entry) return;
      if (method === "Network.requestWillBeSentExtraInfo")
        group.requestExtras.push(
          this.headers(
            (params as Protocol.Network.RequestWillBeSentExtraInfoEvent)
              .headers,
          ),
        );
      else {
        const event = params as Protocol.Network.ResponseReceivedExtraInfoEvent;
        group.responseExtras.push({
          headers: this.headers(event.headers),
          status: event.statusCode,
        });
      }
      this.correlate(group);
      return;
    }
    if (!entry) return;
    if (method === "Network.responseReceived") {
      const { response } = params as Protocol.Network.ResponseReceivedEvent;
      Object.assign(entry, {
        status: response.status,
        responseHeaders: this.headers(response.headers),
        mimeType: response.mimeType,
        protocol: response.protocol,
        fromServiceWorker: response.fromServiceWorker,
      });
      this.correlate(group);
      return;
    } else if (method === "Network.loadingFinished") {
      const event = params as Protocol.Network.LoadingFinishedEvent;
      entry.bytes = event.encodedDataLength;
      if (this.options.sensitive) {
        if (event.encodedDataLength > this.options.bodyLimit)
          entry.responseBody = { unavailable: "Body exceeds capture limit" };
        else {
          try {
            const response = (await this.client.send(
              "Network.getResponseBody",
              { requestId },
              sessionId,
            )) as Protocol.Network.GetResponseBodyResponse;
            entry.responseBody = this.body(
              response.body,
              response.base64Encoded,
            );
          } catch {
            entry.responseBody = {
              unavailable: "Chrome did not retain the response body",
            };
          }
        }
      }
      entry.complete = true;
    } else if (method === "Network.loadingFailed") {
      entry.error = (params as Protocol.Network.LoadingFailedEvent).errorText;
      entry.complete = true;
    } else if (method === "Network.webSocketWillSendHandshakeRequest") {
      const { request, wallTime } =
        params as Protocol.Network.WebSocketWillSendHandshakeRequestEvent;
      entry.requestHeaders = this.headers(request.headers);
      entry.startedAt = new Date(wallTime * 1000).toISOString();
    } else if (method === "Network.webSocketHandshakeResponseReceived") {
      const { response } =
        params as Protocol.Network.WebSocketHandshakeResponseReceivedEvent;
      entry.responseHeaders = this.headers(response.headers);
      entry.status = response.status;
    } else if (
      method === "Network.webSocketFrameSent" ||
      method === "Network.webSocketFrameReceived"
    ) {
      const { response } = params as Protocol.Network.WebSocketFrameSentEvent;
      const base64 = response.opcode !== 1;
      entry.frames!.push({
        direction: method.endsWith("Sent") ? "sent" : "received",
        opcode: response.opcode,
        bytes: Buffer.byteLength(
          response.payloadData,
          base64 ? "base64" : "utf8",
        ),
        ...(this.options.sensitive
          ? { body: this.body(response.payloadData, base64) }
          : {}),
      });
      if (entry.frames!.length > 100) {
        entry.frames!.shift();
        entry.droppedFrames!++;
      }
    } else if (method === "Network.webSocketClosed") entry.complete = true;
    else return;
    this.update(entry);
  }

  status() {
    return {
      sensitive: this.options.sensitive,
      hosts: this.options.hosts,
      extensions: this.options.extensions,
      targets: [...this.targets.values()].map(({ info }) => ({
        id: info.targetId,
        type: info.type,
        url: this.url(info.url),
      })),
      requests: this.entries.size,
      lastRequestId: String(this.sequence),
      evictedRequests: this.evicted,
      pauseWorkers: this.options.pauseWorkers,
      targetIds: this.options.targetIds,
      retainedBytes: this.totalBytes,
      errors: this.errors,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.client.close();
  }
}
