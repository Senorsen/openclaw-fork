import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "openclaw/plugin-sdk/channel-policy";
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingSpawnPolicy,
} from "openclaw/plugin-sdk/conversation-runtime";
import { formatErrorMessage, formatUncaughtError } from "openclaw/plugin-sdk/error-runtime";
import {
  isNativeCommandsExplicitlyDisabled,
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "openclaw/plugin-sdk/native-command-config-runtime";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { DEFAULT_GROUP_HISTORY_LIMIT, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { danger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { createNonExitingRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getOrCreateAccountThrottler } from "./account-throttler.js";
import { resolveTelegramAccount, type ResolvedTelegramAccount } from "./accounts.js";
import { normalizeTelegramApiRoot } from "./api-root.js";
import type { TelegramBotDeps } from "./bot-deps.js";
import { registerTelegramHandlers } from "./bot-handlers.runtime.js";
import { createTelegramMessageProcessor } from "./bot-message.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";
import { createTelegramUpdateTracker } from "./bot-update-tracker.js";
import type { TelegramUpdateKeyContext } from "./bot-updates.js";
import { resolveDefaultAgentId } from "./bot.agent.runtime.js";
import { apiThrottler, Bot, sequentialize, type ApiClientOptions } from "./bot.runtime.js";
import type { TelegramBotOptions } from "./bot.types.js";
import { buildTelegramGroupPeerId, resolveTelegramStreamMode } from "./bot/helpers.js";
import {
  asTelegramClientFetch,
  createTelegramClientFetch,
  resolveTelegramClientTimeoutMinimumSeconds,
  resolveTelegramClientTimeoutSeconds,
  resolveTelegramOutboundClientTimeoutFloorSeconds,
} from "./client-fetch.js";
import { resolveTelegramApiBase, resolveTelegramTransport } from "./fetch.js";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { stringifyTelegramRawUpdateForLog } from "./raw-update-log.js";
import {
  buildSteerPreviewBody,
  buildSteerStopHint,
  formatReceivedAtWithWeekday,
  resolveTelegramReceiveTimezone,
} from "./received-time.js";
import { createTelegramSendChatActionHandler } from "./sendchataction-401-backoff.js";
import {
  queueAgentHarnessMessage,
  resolveActiveEmbeddedRunSessionId,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  isBtwRequestText,
} from "openclaw/plugin-sdk/command-primitives-runtime";
import {
  resolveTelegramConversationRoute,
  resolveTelegramConversationBaseSessionKey,
} from "./conversation-route.js";
import { getTelegramSequentialKey, isTelegramControlLaneText } from "./sequential-key.js";
import { createTelegramThreadBindingManager } from "./thread-bindings.js";

export type { TelegramBotOptions } from "./bot.types.js";

export { getTelegramSequentialKey };

export function resolveTelegramScopedGroupConfig(
  telegramCfg: ResolvedTelegramAccount["config"],
  chatId: string | number,
  messageThreadId?: number,
) {
  const groups = telegramCfg.groups;
  const direct = telegramCfg.direct;
  const chatIdStr = String(chatId);
  const isDm = !chatIdStr.startsWith("-");

  if (isDm) {
    const groupConfig = direct?.[chatIdStr] ?? direct?.["*"];
    const topicConfig =
      groupConfig && messageThreadId != null
        ? groupConfig.topics?.[String(messageThreadId)]
        : undefined;
    return { groupConfig, topicConfig };
  }

  const groupConfig = groups?.[chatIdStr] ?? groups?.["*"];
  const topicConfig =
    groupConfig && messageThreadId != null
      ? groupConfig.topics?.[String(messageThreadId)]
      : undefined;
  return { groupConfig, topicConfig };
}

type TelegramBotRuntime = {
  Bot: typeof Bot;
  sequentialize: typeof sequentialize;
  apiThrottler: typeof apiThrottler;
};
type TelegramBotInstance = InstanceType<TelegramBotRuntime["Bot"]>;

const DEFAULT_TELEGRAM_BOT_RUNTIME: TelegramBotRuntime = {
  Bot,
  sequentialize,
  apiThrottler,
};
const TELEGRAM_TYPING_COALESCE_MS = 4_000;

let telegramBotRuntimeForTest: TelegramBotRuntime | undefined;

/** Max time to spend downloading a steer-preview media file before falling back. */
const STEER_PREVIEW_DOWNLOAD_TIMEOUT_MS = 5_000;
/** Cap steer-preview downloads so a huge file never stalls the injection path. */
const STEER_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Best-effort download of the steer message's media file to the shared inbound
 * media directory (same store the canonical pipeline uses), returning the local
 * absolute path. Bounded by a hard timeout and size cap; any failure resolves to
 * `undefined` so the steer injection degrades to a type-only marker.
 */
async function downloadSteerPreviewMedia(params: {
  fileId: string;
  telegramFileName?: string;
  mimeType?: string;
  token: string;
  apiRoot?: string;
  transport: ReturnType<typeof resolveTelegramTransport>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getFile: (fileId: string) => Promise<any>;
}): Promise<string | undefined> {
  const withTimeout = async <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("steer preview media download timed out")),
            STEER_PREVIEW_DOWNLOAD_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

  try {
    return await withTimeout(
      (async () => {
        const file = await params.getFile(params.fileId);
        const filePath: string | undefined = file?.file_path;
        if (!filePath) {
          return undefined;
        }
        const apiBase = resolveTelegramApiBase(params.apiRoot);
        const url = `${apiBase}/file/bot${params.token}/${filePath}`;
        const res = await params.transport.sourceFetch(url);
        if (!res.ok || !res.body) {
          return undefined;
        }
        const arrayBuffer = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (buffer.byteLength > STEER_PREVIEW_MAX_BYTES) {
          return undefined;
        }
        const saved = await saveMediaBuffer(
          buffer,
          params.mimeType,
          "inbound",
          STEER_PREVIEW_MAX_BYTES,
          params.telegramFileName,
          filePath,
        );
        return saved.path;
      })(),
    );
  } catch {
    return undefined;
  }
}


export function setTelegramBotRuntimeForTest(runtime?: TelegramBotRuntime): void {
  telegramBotRuntimeForTest = runtime;
}

export function createTelegramBotCore(
  opts: TelegramBotOptions & { telegramDeps: TelegramBotDeps },
): TelegramBotInstance {
  const botRuntime = telegramBotRuntimeForTest ?? DEFAULT_TELEGRAM_BOT_RUNTIME;
  const runtime: RuntimeEnv = opts.runtime ?? createNonExitingRuntime();
  const telegramDeps = opts.telegramDeps;
  const cfg = opts.config ?? telegramDeps.getRuntimeConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const threadBindingPolicy = resolveThreadBindingSpawnPolicy({
    cfg,
    channel: "telegram",
    accountId: account.accountId,
    kind: "subagent",
  });
  const threadBindingManager = threadBindingPolicy.enabled
    ? createTelegramThreadBindingManager({
        cfg,
        accountId: account.accountId,
        idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
          cfg,
          channel: "telegram",
          accountId: account.accountId,
        }),
        maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
          cfg,
          channel: "telegram",
          accountId: account.accountId,
        }),
      })
    : null;
  const telegramCfg = account.config;

  const telegramTransport =
    opts.telegramTransport ??
    resolveTelegramTransport(opts.proxyFetch, {
      network: telegramCfg.network,
    });
  const finalFetch = createTelegramClientFetch({
    fetchImpl: asTelegramClientFetch(telegramTransport.fetch),
    timeoutSeconds: telegramCfg?.timeoutSeconds,
    shutdownSignal: opts.fetchAbortSignal,
    transport: telegramTransport,
  });

  const timeoutSeconds = resolveTelegramClientTimeoutSeconds({
    value: telegramCfg?.timeoutSeconds,
    minimum: resolveTelegramClientTimeoutMinimumSeconds([
      opts.minimumClientTimeoutSeconds,
      resolveTelegramOutboundClientTimeoutFloorSeconds(telegramCfg?.timeoutSeconds),
    ]),
  });
  const apiRoot = normalizeOptionalString(telegramCfg.apiRoot);
  const normalizedApiRoot = apiRoot ? normalizeTelegramApiRoot(apiRoot) : undefined;
  const client: ApiClientOptions | undefined =
    finalFetch || timeoutSeconds || normalizedApiRoot
      ? {
          ...(finalFetch ? { fetch: asTelegramClientFetch(finalFetch) } : {}),
          ...(timeoutSeconds ? { timeoutSeconds } : {}),
          ...(normalizedApiRoot ? { apiRoot: normalizedApiRoot } : {}),
        }
      : undefined;

  const botConfig =
    client || opts.botInfo
      ? { ...(client ? { client } : {}), ...(opts.botInfo ? { botInfo: opts.botInfo } : {}) }
      : undefined;
  const bot = new botRuntime.Bot(opts.token, botConfig);
  bot.api.config.use(getOrCreateAccountThrottler(opts.token, botRuntime.apiThrottler));
  // Catch all errors from bot middleware to prevent unhandled rejections
  bot.catch((err) => {
    runtime.error?.(danger(`telegram bot error: ${formatUncaughtError(err)}`));
  });

  const initialUpdateId =
    typeof opts.updateOffset?.lastUpdateId === "number" ? opts.updateOffset.lastUpdateId : null;
  const logSkippedUpdate = (key: string) => {
    if (shouldLogVerbose()) {
      logVerbose(`telegram dedupe: skipped ${key}`);
    }
  };
  const updateTracker = createTelegramUpdateTracker({
    initialUpdateId,
    persistenceFloorUpdateId:
      typeof opts.updateOffset?.persistenceFloorUpdateId === "number"
        ? opts.updateOffset.persistenceFloorUpdateId
        : initialUpdateId,
    ackPolicy: "after_agent_dispatch",
    ...(typeof opts.updateOffset?.onUpdateId === "function"
      ? { onAcceptedUpdateId: opts.updateOffset.onUpdateId }
      : {}),
    onPersistError: (err) => {
      runtime.error?.(`telegram: failed to persist update watermark: ${formatErrorMessage(err)}`);
    },
    onSkip: logSkippedUpdate,
  });
  const shouldSkipUpdate = (ctx: TelegramUpdateKeyContext) =>
    updateTracker.shouldSkipHandlerDispatch(ctx);

  bot.use(async (ctx, next) => {
    const begin = updateTracker.beginUpdate(ctx);
    if (!begin.accepted) {
      return;
    }
    let completed = false;
    try {
      await next();
      completed = true;
    } finally {
      updateTracker.finishUpdate(begin.update, { completed });
    }
  });

  // --- Steer stop-gate: when a run is active, inject a fixed STOP hint (no user
  //     content) then let the real message flow through sequentialize + the
  //     follow-up queue in receive order (batched). Never inline-steers raw text. ---
  const steerBypassLogger = createSubsystemLogger("gateway/channels/telegram/steer-bypass");
  bot.use(async (ctx, next) => {
    const msg = ctx.message ?? ctx.channelPost;
    if (!msg) {
      return next();
    }
    const rawText = msg.text ?? msg.caption;
    const isMediaOnly = !rawText?.trim();
    const botUsername = ctx.me?.username;
    // Skip control lane messages (/stop, /status, etc.) — they have their own lane
    if (rawText && isTelegramControlLaneText({ rawText, botUsername })) {
      return next();
    }
    // Skip /btw messages — they have their own lane
    if (rawText && isBtwRequestText(rawText, botUsername ? { botUsername } : undefined)) {
      return next();
    }
    const chatId = msg.chat?.id;
    const senderId = msg.from?.id;
    if (chatId == null) {
      return next();
    }
    const isGroup = msg.chat?.type === "group" || msg.chat?.type === "supergroup";
    try {
      const routeResult = resolveTelegramConversationRoute({
        cfg,
        accountId: account.accountId,
        chatId,
        isGroup,
        senderId: senderId ?? null,
      });
      const baseSessionKey = resolveTelegramConversationBaseSessionKey({
        cfg,
        route: routeResult.route,
        chatId,
        isGroup,
        senderId: senderId ?? null,
      });
      const sessionId = resolveActiveEmbeddedRunSessionId(baseSessionKey);
      if (!sessionId) {
        return next();
      }
      // Unified behavior (custom): regardless of message type (text, voice,
      // photo, document, ...), inject a fixed STOP hint into the active run and
      // then let the real message flow through the normal pipeline so it lands in
      // the follow-up queue in receive order. We intentionally never steer the
      // user's raw text inline anymore — that caused reordering. The stop hint
      // carries the true receive time (not the processing time) plus the Chinese
      // weekday, and never includes the user's actual message content.
      const receiveTz = resolveTelegramReceiveTimezone(cfg.agents?.defaults?.userTimezone);
      const receivedAtMs =
        typeof msg.date === "number" && msg.date > 0 ? msg.date * 1000 : Date.now();
      const receivedAtText = formatReceivedAtWithWeekday(receivedAtMs, receiveTz);
      const mediaKind: "audio" | "image" | "video" | "file" | "media" | undefined = isMediaOnly
        ? msg.voice || msg.audio
          ? "audio"
          : msg.photo
            ? "image"
            : msg.video
              ? "video"
              : msg.document
                ? "file"
                : "media"
        : undefined;
      // For media-only steer messages, best-effort download the file to the
      // shared inbound media store so the agent can transcribe/view it right
      // away. Bounded by a hard timeout; any failure degrades to a type marker.
      let steerMediaPath: string | undefined;
      if (isMediaOnly && mediaKind && mediaKind !== "media") {
        const photo = msg.photo && msg.photo.length ? msg.photo[msg.photo.length - 1] : undefined;
        const mediaSource =
          msg.voice ??
          msg.audio ??
          photo ??
          msg.video ??
          msg.document ??
          undefined;
        const fileId: string | undefined = mediaSource?.file_id;
        if (fileId) {
          const telegramFileName =
            (msg.audio?.file_name as string | undefined) ??
            (msg.document?.file_name as string | undefined) ??
            (msg.video?.file_name as string | undefined) ??
            undefined;
          const mimeType =
            (msg.voice?.mime_type as string | undefined) ??
            (msg.audio?.mime_type as string | undefined) ??
            (msg.video?.mime_type as string | undefined) ??
            (msg.document?.mime_type as string | undefined) ??
            (mediaKind === "image" ? "image/jpeg" : undefined);
          steerMediaPath = await downloadSteerPreviewMedia({
            fileId,
            telegramFileName,
            mimeType,
            token: opts.token,
            apiRoot: normalizedApiRoot,
            transport: telegramTransport,
            getFile: (id) => ctx.api.getFile(id),
          });
        }
      }
      const senderName =
        [msg.from?.first_name, msg.from?.last_name]
          .filter((part): part is string => Boolean(part && part.trim()))
          .join(" ")
          .trim() ||
        msg.from?.username ||
        "用户";
      const previewBody = buildSteerPreviewBody({
        text: rawText,
        mediaKind,
        filePath: steerMediaPath,
      });
      queueAgentHarnessMessage(
        sessionId,
        buildSteerStopHint({
          senderName,
          senderId: msg.from?.id,
          messageId: msg.message_id,
          receivedAtText,
          previewBody,
        }),
      );
      steerBypassLogger.debug(
        `steer bypass: injected stop hint into active session ${sessionId} ` +
          `(chat=${chatId}, media=${isMediaOnly}, receivedAt=${receivedAtText})`,
      );
      // Let the real message go through the normal pipeline (sequentialize +
      // follow-up queue). Multiple messages arriving during the busy turn batch
      // together in the queue instead of being steered one-by-one.
      return next();
    } catch (err) {
      steerBypassLogger.debug(
        `steer bypass: failed for chat=${chatId}: ${String(err)}`,
      );
    }
    return next();
  });

  bot.use(botRuntime.sequentialize(getTelegramSequentialKey));

  const rawUpdateLogger = createSubsystemLogger("gateway/channels/telegram/raw-update");
  const MAX_RAW_UPDATE_CHARS = 8000;

  bot.use(async (ctx, next) => {
    if (shouldLogVerbose()) {
      try {
        const raw = stringifyTelegramRawUpdateForLog(ctx.update);
        const preview =
          raw.length > MAX_RAW_UPDATE_CHARS ? `${raw.slice(0, MAX_RAW_UPDATE_CHARS)}...` : raw;
        rawUpdateLogger.debug(`telegram update: ${preview}`);
      } catch (err) {
        rawUpdateLogger.debug(`telegram update log failed: ${String(err)}`);
      }
    }
    await next();
  });

  const historyLimit = Math.max(
    0,
    telegramCfg.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const groupHistories = new Map<string, HistoryEntry[]>();
  const textLimit = resolveTextChunkLimit(cfg, "telegram", account.accountId);
  const dmPolicy = telegramCfg.dmPolicy ?? "pairing";
  const allowFrom = opts.allowFrom ?? telegramCfg.allowFrom;
  const groupAllowFrom =
    opts.groupAllowFrom ?? telegramCfg.groupAllowFrom ?? telegramCfg.allowFrom ?? allowFrom;
  const replyToMode = opts.replyToMode ?? telegramCfg.replyToMode ?? "off";
  const nativeEnabled = resolveNativeCommandsEnabled({
    providerId: "telegram",
    providerSetting: telegramCfg.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const nativeSkillsEnabled = resolveNativeSkillsEnabled({
    providerId: "telegram",
    providerSetting: telegramCfg.commands?.nativeSkills,
    globalSetting: cfg.commands?.nativeSkills,
  });
  const nativeDisabledExplicit = isNativeCommandsExplicitlyDisabled({
    providerSetting: telegramCfg.commands?.native,
    globalSetting: cfg.commands?.native,
  });
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
  const mediaMaxBytes = (opts.mediaMaxMb ?? telegramCfg.mediaMaxMb ?? 100) * 1024 * 1024;
  const logger = getChildLogger({ module: "telegram-auto-reply" });
  const streamMode = resolveTelegramStreamMode(telegramCfg);
  const resolveGroupPolicy = (chatId: string | number) =>
    resolveChannelGroupPolicy({
      cfg,
      channel: "telegram",
      accountId: account.accountId,
      groupId: String(chatId),
    });
  const resolveGroupActivation = (params: {
    chatId: string | number;
    agentId?: string;
    messageThreadId?: number;
    sessionKey?: string;
  }) => {
    const agentId = params.agentId ?? resolveDefaultAgentId(cfg);
    const sessionKey =
      params.sessionKey ??
      `agent:${agentId}:telegram:group:${buildTelegramGroupPeerId(params.chatId, params.messageThreadId)}`;
    const storePath = telegramDeps.resolveStorePath(cfg.session?.store, { agentId });
    try {
      const loadSessionStore = telegramDeps.loadSessionStore;
      if (!loadSessionStore) {
        return undefined;
      }
      const store = loadSessionStore(storePath);
      const entry = store[sessionKey];
      if (entry?.groupActivation === "always") {
        return false;
      }
      if (entry?.groupActivation === "mention") {
        return true;
      }
    } catch (err) {
      logVerbose(`Failed to load session for activation check: ${String(err)}`);
    }
    return undefined;
  };
  const resolveGroupRequireMention = (chatId: string | number) =>
    resolveChannelGroupRequireMention({
      cfg,
      channel: "telegram",
      accountId: account.accountId,
      groupId: String(chatId),
      requireMentionOverride: opts.requireMention,
      overrideOrder: "after-config",
    });
  const loadFreshTelegramAccountConfig = () => {
    try {
      return resolveTelegramAccount({
        cfg: telegramDeps.getRuntimeConfig(),
        accountId: account.accountId,
      }).config;
    } catch (error) {
      logVerbose(
        `telegram: failed to load fresh config for account ${account.accountId}; using startup snapshot: ${String(error)}`,
      );
      return telegramCfg;
    }
  };
  const resolveTelegramGroupConfig = (chatId: string | number, messageThreadId?: number) => {
    const freshTelegramCfg = loadFreshTelegramAccountConfig();
    return resolveTelegramScopedGroupConfig(freshTelegramCfg, chatId, messageThreadId);
  };

  // Global sendChatAction handler with 401 backoff / circuit breaker (issue #27092).
  // Created BEFORE the message processor so it can be injected into every message context.
  // Shared across all message contexts for this account so that consecutive 401s
  // from ANY chat are tracked together — prevents infinite retry storms.
  const sendChatActionHandler = createTelegramSendChatActionHandler({
    sendChatActionFn: (chatId, action, threadParams) =>
      bot.api.sendChatAction(chatId, action, threadParams),
    logger: (message) => logVerbose(`telegram: ${message}`),
    minIntervalMs: TELEGRAM_TYPING_COALESCE_MS,
  });

  const processMessage = createTelegramMessageProcessor({
    bot,
    cfg,
    account,
    telegramCfg,
    historyLimit,
    groupHistories,
    dmPolicy,
    allowFrom,
    groupAllowFrom,
    ackReactionScope,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveTelegramGroupConfig,
    loadFreshConfig: () => telegramDeps.getRuntimeConfig(),
    sendChatActionHandler,
    runtime,
    replyToMode,
    streamMode,
    textLimit,
    opts,
    telegramDeps,
  });

  registerTelegramNativeCommands({
    bot,
    cfg,
    runtime,
    accountId: account.accountId,
    telegramCfg,
    allowFrom,
    groupAllowFrom,
    replyToMode,
    textLimit,
    useAccessGroups,
    nativeEnabled,
    nativeSkillsEnabled,
    nativeDisabledExplicit,
    resolveGroupPolicy,
    resolveTelegramGroupConfig,
    shouldSkipUpdate,
    opts,
    telegramDeps,
  });

  registerTelegramHandlers({
    cfg,
    accountId: account.accountId,
    bot,
    opts,
    telegramTransport,
    runtime,
    mediaMaxBytes,
    telegramCfg,
    allowFrom,
    groupAllowFrom,
    resolveGroupPolicy,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveTelegramGroupConfig,
    shouldSkipUpdate,
    processMessage,
    logger,
    telegramDeps,
  });

  const originalStop = bot.stop.bind(bot);
  bot.stop = ((...args: Parameters<typeof originalStop>) => {
    threadBindingManager?.stop();
    return originalStop(...args);
  }) as typeof bot.stop;

  return bot;
}
