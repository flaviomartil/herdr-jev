import { createInterface } from "node:readline";
import { triageTaskWithJev } from "../triage/client.js";
import { resolveStageSpec } from "../pipelines/matrix.js";
import { resolveDelegatedClient } from "../delegation/cross-harness.js";

import { runAgentCaptured, launchStageInHerdr } from "../herdr/launcher.js";
import { createHerdrClient } from "../herdr/client.js";
import type { ClientKind, RoleKind } from "../types/index.js";

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
];

async function handleToolCall(name: string, args: any): Promise<string> {
  if (name === "herdr_triage") {
    const decision = await triageTaskWithJev(args.task || "");
    return JSON.stringify(decision, null, 2);
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
            serverInfo: { name: "herdr-jev-mcp", version: "1.0.0" },
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
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }
  });
}
