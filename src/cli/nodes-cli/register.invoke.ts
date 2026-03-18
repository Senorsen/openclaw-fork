// Generic node.invoke command with shell-exec commands intentionally blocked.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { randomIdempotencyKey } from "../../gateway/call.js";
import { defaultRuntime } from "../../runtime.js";
import { getNodesTheme, runNodesCommand } from "./cli-utils.js";
import {
  callGatewayCli,
  nodesCallOpts,
  parseOptionalNodePositiveInteger,
  resolveNodeId,
} from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";

const BLOCKED_NODE_INVOKE_COMMANDS = new Set(["system.run", "system.run.prepare"]);

/** Register direct node command invocation. */
export function registerNodesInvokeCommands(nodes: Command) {
  nodesCallOpts(
    nodes
      .command("invoke")
      .description("Invoke a command on a paired node")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .requiredOption("--command <command>", "Command (e.g. canvas.eval)")
      .option("--params <json>", "JSON object string for params", "{}")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 15000)", "15000")
      .option("--idempotency-key <key>", "Idempotency key (optional)")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("invoke", async () => {
          const nodeId = await resolveNodeId(opts, normalizeOptionalString(opts.node) ?? "");
          const command = normalizeOptionalString(opts.command) ?? "";
          if (!nodeId || !command) {
            const { error } = getNodesTheme();
            defaultRuntime.error(error("--node and --command required"));
            defaultRuntime.exit(1);
            return;
          }
          if (BLOCKED_NODE_INVOKE_COMMANDS.has(normalizeLowercaseStringOrEmpty(command))) {
            throw new Error(
              `command "${command}" is reserved for shell execution; use the exec tool with host=node instead`,
            );
          }
          const params = JSON.parse(opts.params ?? "{}") as unknown;
          const timeoutMs = parseOptionalNodePositiveInteger(
            opts.invokeTimeout,
            "--invoke-timeout",
          );

          const invokeParams: Record<string, unknown> = {
            nodeId,
            command,
            params,
            idempotencyKey: opts.idempotencyKey ?? randomIdempotencyKey(),
          };
          if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) {
            invokeParams.timeoutMs = timeoutMs;
          }

          const result = await callGatewayCli("node.invoke", opts, invokeParams);
          defaultRuntime.writeJson(result);
        });
      }),
    { timeoutMs: 30_000 },
  );

  nodesCallOpts(
    nodes
      .command("run")
      .description("Run a shell command on a node (mac only)")
      .option("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--cwd <path>", "Working directory")
      .option(
        "--env <key=val>",
        "Environment override (repeatable)",
        (value: string, prev: string[] = []) => [...prev, value],
      )
      .option("--raw <command>", "Run a raw shell command string (sh -lc / cmd.exe /c)")
      .option("--agent <id>", "Agent id (default: configured default agent)")
      .option("--ask <mode>", "Exec ask mode (off|on-miss|always)")
      .option("--security <mode>", "Exec security mode (deny|allowlist|full)")
      .option("--command-timeout <ms>", "Command timeout (ms)")
      .option("--needs-screen-recording", "Require screen recording permission")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 60000)", "60000")
      .argument("[command...]", "Command and args")
      .action(async (command: string[], opts: NodesRunOpts) => {
        await runNodesCommand("run", async () => {
          const cfg = loadConfig();
          const agentId = opts.agent?.trim() || resolveDefaultAgentId(cfg);
          const execDefaults = resolveExecDefaults(cfg, agentId);
          const raw = typeof opts.raw === "string" ? opts.raw.trim() : "";
          if (raw && Array.isArray(command) && command.length > 0) {
            throw new Error("use --raw or argv, not both");
          }
          if (!raw && (!Array.isArray(command) || command.length === 0)) {
            throw new Error("command required");
          }

          const nodeQuery = String(opts.node ?? "").trim() || execDefaults?.node?.trim() || "";
          if (!nodeQuery) {
            throw new Error("node required (set --node or tools.exec.node)");
          }
          const nodeId = await resolveNodeId(opts, nodeQuery);
          const preparedContext = await prepareNodesRunContext({
            opts,
            command,
            raw,
            nodeId,
            agentId,
            execDefaults,
          });
          const approvalPlan = preparedContext.prepared.plan;
          const policy = resolveNodesRunPolicy(opts, execDefaults);
          const approvals = await resolveNodeApprovals({
            opts,
            nodeId,
            agentId,
            security: policy.security,
            ask: policy.ask,
          });
          if (approvals.hostSecurity === "deny") {
            throw new Error("exec denied: host=node security=deny");
          }
          const approvalResult = await maybeRequestNodesRunApproval({
            opts,
            nodeId,
            agentId,
            approvalPlan,
            hostSecurity: approvals.hostSecurity,
            hostAsk: approvals.hostAsk,
            askFallback: approvals.askFallback,
          });
          const invokeParams = buildSystemRunInvokeParams({
            nodeId,
            approvalPlan,
            nodeEnv: preparedContext.nodeEnv,
            timeoutMs: preparedContext.timeoutMs,
            invokeTimeout: preparedContext.invokeTimeout,
            approvedByAsk: approvalResult.approvedByAsk,
            approvalDecision: approvalResult.approvalDecision,
            approvalId: approvalResult.approvalId,
            idempotencyKey: opts.idempotencyKey,
            fallbackAgentId: agentId,
            needsScreenRecording: opts.needsScreenRecording === true,
          });

          const result = await callGatewayCli("node.invoke", opts, invokeParams);
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }

          const payload =
            typeof result === "object" && result !== null
              ? (result as { payload?: Record<string, unknown> }).payload
              : undefined;

          const stdout = typeof payload?.stdout === "string" ? payload.stdout : "";
          const stderr = typeof payload?.stderr === "string" ? payload.stderr : "";
          const exitCode = typeof payload?.exitCode === "number" ? payload.exitCode : null;
          const timedOut = payload?.timedOut === true;
          const success = payload?.success === true;

          if (stdout) {
            process.stdout.write(stdout);
          }
          if (stderr) {
            process.stderr.write(stderr);
          }
          if (timedOut) {
            const { error } = getNodesTheme();
            defaultRuntime.error(error("run timed out"));
            defaultRuntime.exit(1);
            return;
          }
          if (exitCode !== null && exitCode !== 0) {
            const hint = unauthorizedHintForMessage(`${stderr}\n${stdout}`);
            if (hint) {
              const { warn } = getNodesTheme();
              defaultRuntime.error(warn(hint));
            }
          }
          if (exitCode !== null && exitCode !== 0 && !success) {
            const { error } = getNodesTheme();
            defaultRuntime.error(error(`run exit ${exitCode}`));
            defaultRuntime.exit(1);
            return;
          }
        });
      }),
    { timeoutMs: 35_000 },
  );
}
