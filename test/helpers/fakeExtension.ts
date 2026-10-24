/**
 * A stand-in for the extension's BridgeService: it speaks only the wire
 * protocol, and checks every server answer with the shared validators, the
 * way the real extension has to.
 */
import {
  BRIDGE_PATHS,
  bridgePath,
  bridgeError,
  OP_NAMES,
  PROTOCOL,
  PROTOCOL_HEADER,
  validateEnvelope,
  type ErrorCode,
  type OpCapability,
  type OpName,
  type PolicyReport,
  type PollResponse,
  type ValidatedBridgeTask,
} from '@voyager-crew/bridge-protocol';

import { sha256Hex } from '../../src/util/hash';
import { rawRequest, type RawResponse } from './http';

export const EXT_ORIGIN = `chrome-extension://${'abcdefghijklmnop'.repeat(2)}`;

export class OpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string = code,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

export type OpHandler = (
  params: unknown,
  task: ValidatedBridgeTask,
  tools: { progress(event: Record<string, unknown>): Promise<void>; aborted(): boolean },
) => unknown;

/** Valid results for a text-only ask (each passes `validateOpResult`). */
export const ASK_HANDLERS: Partial<Record<OpName, OpHandler>> = {
  'conversation.open': () => ({
    tabId: 7,
    url: 'https://chatgpt.com/',
    docNonce: 'nonce-1',
    ready: {
      url: 'https://chatgpt.com/',
      conversationId: null,
      loggedIn: true,
      mode: 'chat',
      evidence: {},
    },
  }),
  'composer.send': () => ({
    conversationId: 'c-1',
    url: 'https://chatgpt.com/c/c-1',
    userTurnKey: 't-1',
  }),
  'turns.waitReply': async (_params, _task, tools) => {
    await tools.progress({ phase: 'thinking', textLength: 0, elapsedMs: 5 });
    return { assistantTurnKey: 't-2', status: 'complete', elapsedMs: 10, evidence: {} };
  },
  'turns.read': () => ({
    markdown: 'OK',
    turnKey: 't-2',
    textSha256: sha256Hex('OK'),
    files: [],
  }),
  'conversation.close': () => ({ closed: true }),
  // The page already shows GPT-6 Pro, so nothing changes and nothing is restored.
  'model.select': (params) => {
    const selection = { modelId: 'gpt-6', modelLabel: 'GPT-6', effortIndex: 4, effortMax: 4 };
    const capture = (params as { capturePrevious?: boolean }).capturePrevious === true;
    return {
      changed: false,
      ...(capture ? { previous: selection } : {}),
      observed: selection,
      evidence: {},
    };
  },
};

interface Running {
  readonly task: ValidatedBridgeTask;
  aborted: boolean;
}

export class FakeExtension {
  token: string | undefined;
  origin = EXT_ORIGIN;
  ops: OpCapability[] = OP_NAMES.map((name) => ({ name, v: 1 }));
  policy: PolicyReport = { revision: 1, state: 'allowed' };
  /** The ChatGPT plan each poll reports; left out of the poll while undefined. */
  account: unknown = undefined;
  /** Tasks it runs at once, as each poll reports; left out (one) while undefined. */
  maxTasks: number | undefined = undefined;
  readonly tasks: ValidatedBridgeTask[] = [];
  /** Each task's start and end, in order, as the handlers ran them. */
  readonly timeline: { readonly at: 'start' | 'end'; readonly task: ValidatedBridgeTask }[] = [];
  readonly aborts: { taskId: string; reason: string }[] = [];
  /** Server answers that failed the protocol validators; must stay empty. */
  readonly protocolErrors: string[] = [];
  unpaired = false;
  private readonly running = new Map<string, Running>();
  private stopped = true;
  private loopDone: Promise<void> = Promise.resolve();
  private controller = new AbortController();
  private readonly seen = new Set<string>();

  constructor(
    readonly port: number,
    public handlers: Partial<Record<OpName, OpHandler>> = ASK_HANDLERS,
  ) {}

  request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<RawResponse> {
    return rawRequest({
      port: this.port,
      method,
      path,
      body,
      signal: this.controller.signal,
      headers: {
        origin: this.origin,
        [PROTOCOL_HEADER]: String(PROTOCOL.max),
        ...(this.token === undefined ? {} : { authorization: `Bearer ${this.token}` }),
      },
    });
  }

  async hello(): Promise<RawResponse> {
    const response = await this.request('POST', BRIDGE_PATHS.hello, {
      client: 'extension',
      version: '2.1.0',
      protocol: PROTOCOL,
    });
    this.check(response, 'helloResponse');
    return response;
  }

  async pair(code: string): Promise<RawResponse> {
    const response = await this.request('POST', BRIDGE_PATHS.pair, {
      code: code.replace('-', ''),
      browser: 'chrome',
      extensionVersion: '2.1.0',
    });
    const body = this.check(response, 'pairResponse');
    if (body?.ok) this.token = body.data.token;
    return response;
  }

  /** One poll; `inflight` defaults to the tasks the fake is running. */
  async poll(
    inflight = [...this.running.keys()].map((taskId) => ({ taskId, state: 'running' as const })),
  ): Promise<{ status: number; message?: PollResponse }> {
    const response = await this.request('POST', BRIDGE_PATHS.extPoll, {
      capabilities: { ops: this.ops },
      inflight,
      policy: this.policy,
      ...(this.account === undefined ? {} : { account: this.account }),
      ...(this.maxTasks === undefined ? {} : { maxTasks: this.maxTasks }),
    });
    if (response.status === 204) return { status: 204 };
    const body = this.check(response, 'pollResponse');
    return body?.ok ? { status: response.status, message: body.data } : { status: response.status };
  }

  ack(taskId: string): Promise<RawResponse> {
    return this.request('POST', bridgePath.taskAck(taskId));
  }

  result(taskId: string, envelope: unknown): Promise<RawResponse> {
    return this.request('POST', bridgePath.taskResult(taskId), envelope);
  }

  /** Poll in a loop and run tasks with `handlers`, like BridgeService would. */
  start(): void {
    if (this.controller.signal.aborted) this.controller = new AbortController();
    this.stopped = false;
    this.loopDone = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.controller.abort();
    await this.loopDone.catch(() => undefined);
    // Manual polls after a stop use a fresh signal.
    this.controller = new AbortController();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      let polled: { status: number; message?: PollResponse };
      try {
        polled = await this.poll();
      } catch {
        if (this.stopped) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
        continue;
      }
      const message = polled.message;
      if (message === undefined) continue;
      if (message.kind === 'unpaired') {
        this.unpaired = true;
        return;
      }
      if (message.kind === 'abort') {
        this.aborts.push({ taskId: message.taskId, reason: message.reason });
        const running = this.running.get(message.taskId);
        if (running !== undefined) {
          running.aborted = true;
          this.running.delete(message.taskId);
        }
        continue;
      }
      const { task } = message;
      if (this.seen.has(task.taskId)) continue;
      this.seen.add(task.taskId);
      this.tasks.push(task);
      await this.ack(task.taskId);
      const running: Running = { task, aborted: false };
      this.running.set(task.taskId, running);
      void this.execute(running);
    }
  }

  private async execute(running: Running): Promise<void> {
    const { task } = running;
    const handler = this.handlers[task.op];
    let seq = 0;
    let envelope: unknown;
    this.timeline.push({ at: 'start', task });
    try {
      if (handler === undefined) throw new OpError('unsupported-op');
      const data = await handler(task.params, task, {
        progress: async (event) => {
          seq += 1;
          await this.request('POST', bridgePath.taskProgress(task.taskId), { seq, event });
        },
        aborted: () => running.aborted,
      });
      envelope = { ok: true, data };
    } catch (error) {
      const code = error instanceof OpError ? error.code : 'bad-request';
      const details = error instanceof OpError ? error.details : undefined;
      envelope = { ok: false, error: bridgeError(code, String(error), details) };
    }
    this.timeline.push({ at: 'end', task });
    // An aborted task produces nothing more, like terminate('cancelled').
    if (running.aborted || this.stopped) return;
    // Listed until its result has landed, as the extension's outbox keeps it.
    await this.result(task.taskId, envelope).catch(() => undefined);
    if (this.running.get(task.taskId) === running) this.running.delete(task.taskId);
  }

  private check<K extends 'helloResponse' | 'pairResponse' | 'pollResponse'>(
    response: RawResponse,
    kind: K,
  ) {
    if (response.status >= 400) return undefined;
    const checked = validateEnvelope(response.json, kind);
    if (!checked.ok) {
      this.protocolErrors.push(`${kind}: ${JSON.stringify(checked.issues)}`);
      return undefined;
    }
    return checked.value;
  }
}

/** Pair `fake` through the CLI endpoint, as `voyager pair` would. */
export async function pairFake(
  fake: FakeExtension,
  cli: (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<RawResponse>,
): Promise<void> {
  const issued = await cli('POST', BRIDGE_PATHS.pairingCodes);
  const { code } = (issued.json as { data: { code: string } }).data;
  const paired = await fake.pair(code);
  if (paired.status !== 200) throw new Error(`pairing failed: ${JSON.stringify(paired.json)}`);
}
