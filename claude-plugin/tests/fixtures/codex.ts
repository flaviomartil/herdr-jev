export const READ: readonly string[] = [
  "{\"type\":\"thread.started\",\"thread_id\":\"01a118dc-ab47-7000-aaf3-6b7134d87795\"}",
  "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"error\",\"message\":\"loading hooks from both /home/user/.codex/hooks.json and /home/user/.codex/config.toml; prefer a single representation for this layer\"}}",
  "{\"type\":\"turn.started\"}",
  "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_1\",\"type\":\"agent_message\",\"text\":\"I’ll read `note.txt`.\\n\"}}",
  "{\"type\":\"item.started\",\"item\":{\"id\":\"item_2\",\"type\":\"command_execution\",\"command\":\"/usr/bin/zsh -lc 'cat note.txt'\",\"aggregated_output\":\"\",\"exit_code\":null,\"status\":\"in_progress\"}}",
  "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_2\",\"type\":\"command_execution\",\"command\":\"/usr/bin/zsh -lc 'cat note.txt'\",\"aggregated_output\":\"hello fixture\\n\",\"exit_code\":0,\"status\":\"completed\"}}",
  "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_3\",\"type\":\"agent_message\",\"text\":\"hello fixture\"}}",
  "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":42287,\"cached_input_tokens\":18304,\"cache_write_input_tokens\":0,\"output_tokens\":49,\"reasoning_output_tokens\":0}}"
]

export const EDIT: readonly string[] = [
  "{\"type\":\"thread.started\",\"thread_id\":\"01a118dd-652a-7780-8e55-1beb581eae54\"}",
  "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"error\",\"message\":\"loading hooks from both /home/user/.codex/hooks.json and /home/user/.codex/config.toml; prefer a single representation for this layer\"}}",
  "{\"type\":\"turn.started\"}",
  "{\"type\":\"item.started\",\"item\":{\"id\":\"item_1\",\"type\":\"command_execution\",\"command\":\"/usr/bin/zsh -lc \\\"sed -n '1,240p' /home/user/.agents/AGENTS.md && pwd && rg --files -g 'AGENTS.md' -g '\\\"'!node_modules'\\\"' . .. 2>/dev/null | head -40\\\"\",\"aggregated_output\":\"\",\"exit_code\":null,\"status\":\"in_progress\"}}",
  "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_1\",\"type\":\"command_execution\",\"command\":\"/usr/bin/zsh -lc \\\"sed -n '1,240p' /home/user/.agents/AGENTS.md && pwd && rg --files -g 'AGENTS.md' -g '\\\"'!node_modules'\\\"' . .. 2>/dev/null | head -40\\\"\",\"aggregated_output\":\"# Governança global de skills\\n\\nEsta regra vale para Codex, Claude e Kimi.\\n\\n1. Usar `~/.agents/skills/<nome>` como fonte ...\",\"exit_code\":0,\"status\":\"completed\"}}",
  "{\"type\":\"item.started\",\"item\":{\"id\":\"item_2\",\"type\":\"file_change\",\"changes\":[{\"path\":\"/work/demo/cx2/hello.txt\",\"kind\":\"add\"}],\"status\":\"in_progress\"}}",
  "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_2\",\"type\":\"file_change\",\"changes\":[{\"path\":\"/work/demo/cx2/hello.txt\",\"kind\":\"add\"}],\"status\":\"completed\"}}",
  "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_3\",\"type\":\"agent_message\",\"text\":\"Deu certo: `hello.txt` criado com `hi`.\"}}",
  "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":62945,\"cached_input_tokens\":40448,\"cache_write_input_tokens\":0,\"output_tokens\":333,\"reasoning_output_tokens\":110}}"
]

export const FAILED: readonly string[] = [
  "{\"type\":\"thread.started\",\"thread_id\":\"01a118dd-d83e-7793-94c8-5863703892c6\"}",
  "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"error\",\"message\":\"loading hooks from both /home/user/.codex/hooks.json and /home/user/.codex/config.toml; prefer a single representation for this layer\"}}",
  "{\"type\":\"item.completed\",\"item\":{\"id\":\"item_1\",\"type\":\"error\",\"message\":\"Model metadata for `not-a-real-model-xyz` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.\"}}",
  "{\"type\":\"turn.started\"}",
  "{\"type\":\"error\",\"message\":\"{\\\"detail\\\":\\\"The 'not-a-real-model-xyz' model is not supported when using Codex with a ChatGPT account.\\\"}\"}",
  "{\"type\":\"turn.failed\",\"error\":{\"message\":\"{\\\"detail\\\":\\\"The 'not-a-real-model-xyz' model is not supported when using Codex with a ChatGPT account.\\\"}\"}}"
]
