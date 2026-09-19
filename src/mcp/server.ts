import { createInterface } from "node:readline";
import { triageTaskWithJev } from "../triage/client.js";
import { resolveStageSpec } from "../pipelines/matrix.js";
import { resolveDelegatedClient } from "../delegation/cross-harness.js";
import { runAgentCaptured, launchStageInHerdr } from "../herdr/launcher.js";
import { createHerdrClient } from "../herdr/client.js";
import type { ClientKind, RoleKind, TaskComplexity } from "../types/index.js";

import { evaluateQuestions, evaluateConfidenceGate, type JevQuestion } from "../triage/evaluator.js";
import { checkExecutionGuard, verifyContractAdvisory, checkSignalSufficiency } from "../orchestration/execution-guard.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

const TOOLS = [
  {
    name: "herdr_clink",
    description: "Execute a prompt in an isolated peer AI CLI (codex, claude, antigravity, kimi) and return the output directly into this conversation without polluting the context window. Ideal for quick code reviews, secondary opinions, and isolated lookups (inspired by PAL MCP but powered by Herdr-Jev).",
    inputSchema: {
      type: "object",
      properties: {
        client: {
          type: "string",
          enum: ["codex", "claude", "antigravity", "kimi"],
          description: "Target peer AI client to execute the prompt",
        },
        prompt: {
          type: "string",
          description: "The exact instructions or question for the peer CLI",
        },
      },
      required: ["client", "prompt"],
    },
  },
  {
    name: "herdr_spawn_subagent",
    description: "Spawn an autonomous subagent (researcher, implementer, reviewer, advisor) with full triage and quota protection. If running inside Herdr with split: true, opens a side-by-side pane; otherwise executes in background and returns the clean final output.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The task or prompt for the subagent",
        },
        role: {
          type: "string",
          enum: ["researcher", "implementer", "reviewer", "advisor"],
          description: "Role of the subagent (defaults to researcher)",
        },
        target: {
          type: "string",
          enum: ["codex", "claude", "antigravity", "kimi", "auto"],
          description: "Target client (default 'auto' lets Jev decide)",
        },
        split: {
          type: "boolean",
          description: "Whether to split Herdr pane (true) or execute captured inline (false, default)",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "herdr_consensus",
    description: "Run consensus across multiple AI models/CLIs simultaneously on an architectural decision or bug diagnosis, returning comparative findings.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The architectural question or code snippet to review across models",
        },
        clients: {
          type: "array",
          items: { type: "string", enum: ["claude", "codex", "antigravity", "kimi"] },
          description: "List of clients to poll for consensus (default: ['claude', 'codex'])",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "herdr_triage",
    description: "Triage a task using TypeSafe Jev System One to determine complexity, required effort, and optimal pipeline stages.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Task description to triage",
        },
      },
      required: ["task"],
    },
  },
  {
    name: "herdr_decide",
    description: "Evaluate arbitrary typed questions (noul/choice/score) against a state text via TypeSafe Jev System One, returning typed answers without open-ended text generation (inspired by Jevbridge).",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          description: "Unstructured state, document, diff, or error message to evaluate",
        },
        questions: {
          type: "object",
          description: "Map of question definitions (type: noul | choice | score)",
        },
      },
      required: ["state", "questions"],
    },
  },
  {
    name: "herdr_gate",
    description: "Confidence-gate a proposed action or tool call against destructive risk and execution safety (execute | confirm | escalate | abort) (inspired by Jevbridge).",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          description: "Current environment context or state",
        },
        proposedAction: {
          type: "string",
          description: "The action, command, or modification to evaluate",
        },
        executeThreshold: {
          type: "number",
          description: "Confidence threshold to allow automatic execution (default 0.75)",
        },
        confirmThreshold: {
          type: "number",
          description: "Threshold below which confirmation or escalation is forced (default 0.45)",
        },
      },
      required: ["state", "proposedAction"],
    },
  },
  {
    name: "herdr_execution_guard",
    description: "Checks whether the current agent is permitted to write code directly or if the Execution Guard forces delegation to an autonomous subagent for moderate/architectural tasks (inspired by jev-gate V5).",
    inputSchema: {
      type: "object",
      properties: {
        complexity: {
          type: "string",
          enum: ["trivial", "routine", "moderate", "architectural"],
          description: "Task complexity level",
        },
        agentRole: {
          type: "string",
          enum: ["coordinator", "subagent", "standalone"],
          description: "Role of the executing agent",
        },
        isCodeMutation: {
          type: "boolean",
          description: "Whether the proposed step involves creating or modifying code files",
        },
      },
      required: ["complexity", "agentRole", "isCodeMutation"],
    },
  },
  {
    name: "herdr_verify_contract",
    description: "Performs advisory contract verification applying the 'Code owns acceptance' doctrine. Deterministic tests and linters govern state, while Jev provides advisory compliance analysis.",
    inputSchema: {
      type: "object",
      properties: {
        contractSpec: {
          type: "string",
          description: "Specification or requirements checklist",
        },
        testPassed: {
          type: "boolean",
          description: "Whether automated test suite passed",
        },
        deliverableSummary: {
          type: "string",
          description: "Summary of files, features, or diffs delivered",
        },
        linterClean: {
          type: "boolean",
          description: "Whether linters and typecheck passed cleanly",
        },
      },
      required: ["contractSpec", "testPassed", "deliverableSummary"],
    },
  },
  {
    name: "herdr_fit_check",
    description: "Assesses whether a task qualifies for Jev System One evaluation according to the Law of Signal Self-Sufficiency (inspired by jev-capability-atlas).",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          description: "Context text provided to evaluate",
        },
        question: {
          type: "string",
          description: "Question or determination requested",
        },
      },
      required: ["state", "question"],
    },
  },
];

async function handleToolCall(name: string, args: any): Promise<string> {
  if (name === "herdr_triage") {
    const decision = await triageTaskWithJev(args.task || "");
    return JSON.stringify(decision, null, 2);
  }

  if (name === "herdr_decide") {
    const questions = (args.questions || {}) as Record<string, JevQuestion>;
    const res = await evaluateQuestions(args.state || "", questions);
    return JSON.stringify(res, null, 2);
  }

  if (name === "herdr_gate") {
    const res = await evaluateConfidenceGate({
      state: args.state || "",
      proposedAction: args.proposedAction || "",
      executeThreshold: args.executeThreshold,
      confirmThreshold: args.confirmThreshold,
    });
    return JSON.stringify(res, null, 2);
  }

  if (name === "herdr_execution_guard") {
    const res = checkExecutionGuard({
      complexity: (args.complexity || "routine") as TaskComplexity,
      agentRole: args.agentRole || "coordinator",
      isCodeMutation: Boolean(args.isCodeMutation),
    });
    return JSON.stringify(res, null, 2);
  }

  if (name === "herdr_verify_contract") {
    const res = verifyContractAdvisory({
      contractSpec: args.contractSpec || "",
      testPassed: Boolean(args.testPassed),
      deliverableSummary: args.deliverableSummary || "",
      linterClean: args.linterClean !== false,
    });
    return JSON.stringify(res, null, 2);
  }

  if (name === "herdr_fit_check") {
    const res = checkSignalSufficiency(args.state || "", args.question || "");
    return JSON.stringify(res, null, 2);
  }

  if (name === "herdr_clink") {
    const targetClient = (args.client || "codex") as ClientKind;
    const stage = resolveStageSpec(targetClient, "implementer", "standard");
    const res = runAgentCaptured({
      client: targetClient,
      stage,
      promptText: args.prompt || "",
    });
    if (!res.ok) {
      return `[herdr_clink error: exit code ${res.exitCode}]\n${res.error || ""}\n${res.output}`;
    }
    return res.output;
  }

  if (name === "herdr_spawn_subagent") {
    const role = (args.role || "researcher") as RoleKind;
    const explicitTarget = args.target && args.target !== "auto" ? (args.target as ClientKind) : undefined;
    const delegated = resolveDelegatedClient("claude", role, { explicitTarget });
    const targetClient = delegated.client;
    const stage = resolveStageSpec(targetClient, role, "standard");

    const isHerdr = process.env.HERDR_ENV === "1";
    if (args.split && isHerdr) {
      const herdr = createHerdrClient();
      const res = await launchStageInHerdr({
        client: targetClient,
        stage,
        handoffPrompt: args.prompt || "",
        herdr,
      });
      if (!res.ok) {
        return `[herdr_spawn_subagent split error]: ${res.error}`;
      }
      return `Subagent spawned successfully in Herdr pane ${res.paneId} (${res.agentName}) running ${targetClient}/${stage.model}`;
    }

    // Default inline / captured execution
    const res = runAgentCaptured({
      client: targetClient,
      stage,
      promptText: args.prompt || "",
    });
    if (!res.ok) {
      return `[herdr_subagent error: exit code ${res.exitCode}]\n${res.error || ""}\n${res.output}`;
    }
    return res.output;
  }

  if (name === "herdr_consensus") {
    const clients: ClientKind[] = Array.isArray(args.clients) && args.clients.length > 0 ? args.clients : ["claude", "codex"];
    const question = args.question || "";

    const promises = clients.map(async (client) => {
      const stage = resolveStageSpec(client, "reviewer", "standard");
      const res = runAgentCaptured({
        client,
        stage,
        promptText: `Consensus question: ${question}`,
      });
      return {
        client,
        model: stage.model,
        ok: res.ok,
        output: res.output,
      };
    });

    const results = await Promise.all(promises);
    let compiled = `# Herdr Consensus Across ${results.length} Models\n\n**Question**: ${question}\n\n`;
    for (const r of results) {
      compiled += `### Client: ${r.client.toUpperCase()} (${r.model})\n`;
      compiled += `${r.output}\n\n---\n`;
    }
    return compiled;
  }

  throw new Error(`Unknown tool: ${name}`);
}

export function startMcpServer() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  const send = (res: JsonRpcResponse) => {
    process.stdout.write(JSON.stringify(res) + "\n");
  };

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const req = JSON.parse(trimmed) as JsonRpcRequest;
      const id = req.id ?? null;

      if (req.method === "initialize") {
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "herdr-jev-mcp", version: "1.1.0" },
          },
        });
        return;
      }

      if (req.method === "notifications/initialized") {
        return;
      }

      if (req.method === "tools/list") {
        send({
          jsonrpc: "2.0",
          id,
          result: { tools: TOOLS },
        });
        return;
      }

      if (req.method === "tools/call") {
        const { name, arguments: args } = req.params || {};
        try {
          const textResult = await handleToolCall(name, args || {});
          send({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: textResult }],
            },
          });
        } catch (err) {
          send({
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: `Tool error: ${err instanceof Error ? err.message : String(err)}` }],
            },
          });
        }
        return;
      }

      if (req.method === "ping") {
        send({ jsonrpc: "2.0", id, result: {} });
        return;
      }

      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      });
    } catch (err) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32700, message: "Parse error" },
      });
    }
  });
}
