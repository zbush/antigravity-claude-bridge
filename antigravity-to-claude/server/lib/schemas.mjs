const LAUNCH_MODES = ["run", "resume", "fork", "review"];
const READ_TOOLS = ["Read", "Glob", "Grep"];
const EDIT_TOOLS = ["Edit", "Write"];
const ORDINARY_PERMISSION_MODES = ["plan", "acceptEdits", "dontAsk"];

const PERMISSION_MODE_SCHEMA = {
  type: "string",
  enum: ORDINARY_PERMISSION_MODES,
  description:
    "Permission mode for headless Claude Code. Defaults to 'acceptEdits' when Edit/Write are granted, else 'plan'. 'dontAsk' denies anything not pre-approved. Permission bypass is never available.",
};

const ORDINARY_TOOLS_SCHEMA = {
  type: "array",
  items: { enum: [...READ_TOOLS, ...EDIT_TOOLS] },
  description:
    "Optional subset of the host ceiling of built-in tools (Read, Glob, Grep; plus Edit, Write when the host sets AGENT_BRIDGE_ALLOW_EDITS=true). Shell and other tools are never available. Use [] for no tools.",
};

const ADD_DIRS_SCHEMA = {
  type: "array",
  items: { type: "string" },
  description: "Optional extra absolute directories, each inside the host's AGENT_BRIDGE_WORKSPACE_ROOTS.",
};

const DISALLOWED_TOOLS_SCHEMA = {
  type: "array",
  items: { type: "string" },
  description: "Optional tool rules to deny in addition to the ceiling.",
};

const SESSION_ID_SCHEMA = {
  type: "string",
  description: "Session UUID returned by an earlier bridge run in the same cwd (this server process).",
};

const CWD_SCHEMA = {
  type: "string",
  description: "Absolute working directory inside the host's AGENT_BRIDGE_WORKSPACE_ROOTS.",
};

const EFFORT_SCHEMA = {
  type: "string",
  enum: ["low", "medium", "high", "xhigh", "max"],
  description: "Optional reasoning effort level for the Claude Code session.",
};

const BRIDGE_CONTEXT_SCHEMA = {
  type: "string",
  description:
    "Optional in-band '[bridge: ...]' header from an upstream delegated prompt, used to enforce depth, hierarchy, and cycle limits.",
};

const TOOLS = [
  {
    name: "claude_run",
    description:
      "Run a restricted local Claude Code agent synchronously on a task (built-in tools limited to the host ceiling: Read, Glob, Grep, plus Edit/Write only when the host enables edits; no shell) and return its final response, session_id (for resuming/forking), file changes, permission denials, cost, and token usage.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Complete task instructions for the Claude Code agent.",
        },
        cwd: CWD_SCHEMA,
        permission_mode: PERMISSION_MODE_SCHEMA,
        model: {
          type: "string",
          description:
            "Optional model override (e.g. 'sonnet', 'opus', 'haiku', or full model name; defaults to user's Claude Code config).",
        },
        effort: EFFORT_SCHEMA,
        add_dirs: ADD_DIRS_SCHEMA,
        allowed_tools: ORDINARY_TOOLS_SCHEMA,
        disallowed_tools: DISALLOWED_TOOLS_SCHEMA,
        append_system_prompt: {
          type: "string",
          description: "Optional extra instructions appended to Claude Code's system prompt.",
        },
        max_budget_usd: {
          type: "number",
          description: "Optional maximum dollar budget for this run.",
        },
        ephemeral: {
          type: "boolean",
          description: "Run without persisting session files to disk (--no-session-persistence).",
        },
        bridge_context: BRIDGE_CONTEXT_SCHEMA,
        timeout_seconds: {
          type: "number",
          description: "Timeout in seconds (default 600, max 1800).",
        },
      },
      required: ["prompt", "cwd"],
    },
  },
  {
    name: "claude_resume",
    description:
      "Continue a finished Claude Code session that this bridge process started in the same cwd, under the same restricted tool ceiling as claude_run.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: SESSION_ID_SCHEMA,
        prompt: {
          type: "string",
          description: "Follow-up prompt for the resumed Claude Code session.",
        },
        cwd: CWD_SCHEMA,
        permission_mode: PERMISSION_MODE_SCHEMA,
        model: { type: "string", description: "Optional model override." },
        effort: EFFORT_SCHEMA,
        add_dirs: ADD_DIRS_SCHEMA,
        allowed_tools: ORDINARY_TOOLS_SCHEMA,
        disallowed_tools: DISALLOWED_TOOLS_SCHEMA,
        append_system_prompt: { type: "string" },
        max_budget_usd: { type: "number" },
        ephemeral: { type: "boolean" },
        bridge_context: BRIDGE_CONTEXT_SCHEMA,
        timeout_seconds: {
          type: "number",
          description: "Timeout in seconds (default 600, max 1800).",
        },
      },
      required: ["session_id", "prompt", "cwd"],
    },
  },
  {
    name: "claude_fork",
    description:
      "Fork a Claude Code session that this bridge process started in the same cwd into a new thread (--fork-session), under the same restricted tool ceiling as claude_run.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: SESSION_ID_SCHEMA,
        prompt: {
          type: "string",
          description: "Instructions for the forked branch.",
        },
        cwd: CWD_SCHEMA,
        permission_mode: PERMISSION_MODE_SCHEMA,
        model: { type: "string", description: "Optional model override." },
        effort: EFFORT_SCHEMA,
        add_dirs: ADD_DIRS_SCHEMA,
        allowed_tools: ORDINARY_TOOLS_SCHEMA,
        disallowed_tools: DISALLOWED_TOOLS_SCHEMA,
        append_system_prompt: { type: "string" },
        max_budget_usd: { type: "number" },
        ephemeral: { type: "boolean" },
        bridge_context: BRIDGE_CONTEXT_SCHEMA,
        timeout_seconds: {
          type: "number",
          description: "Timeout in seconds (default 600, max 1800).",
        },
      },
      required: ["session_id", "prompt", "cwd"],
    },
  },
  {
    name: "claude_review",
    description:
      "Run a restricted read-only Claude Code review of uncommitted changes, a base branch, a commit, or a supplied diff.",
    inputSchema: {
      type: "object",
      properties: {
        review_diff: { type: "string", description: "Prepared diff. When supplied, the bridge skips Git in cwd." },
        append_system_prompt: { type: "string" },
        allowed_tools: { type: "array", items: { enum: ["Read", "Glob", "Grep"] }, description: "Use [] for a diff-only review." },
        disallowed_tools: { type: "array", items: { type: "string" } },
        ephemeral: { type: "boolean" },
        cwd: {
          type: "string",
          description: "Absolute working directory inside the host's AGENT_BRIDGE_WORKSPACE_ROOTS. A supplied review_diff does not require a Git repository.",
        },
        uncommitted: {
          type: "boolean",
          description:
            "Review staged, unstaged, and untracked changes (default if no target is given).",
        },
        base: {
          type: "string",
          description: "Review changes against this base branch (e.g. 'main').",
        },
        commit: {
          type: "string",
          description: "Review changes introduced by a specific commit SHA.",
        },
        title: {
          type: "string",
          description: "Optional title for the review summary.",
        },
        prompt: {
          type: "string",
          description: "Optional custom review focus or checklist.",
        },
        model: { type: "string", description: "Optional model override." },
        effort: EFFORT_SCHEMA,
        max_budget_usd: { type: "number" },
        bridge_context: BRIDGE_CONTEXT_SCHEMA,
        timeout_seconds: {
          type: "number",
          description: "Timeout in seconds (default 600, max 1800).",
        },
      },
      required: ["cwd"],
    },
  },
  {
    name: "claude_spawn",
    description:
      "Start a local Claude Code agent asynchronously in the background and immediately return a job_id. Use this to orchestrate multiple local Claude Code agents in parallel, then poll with claude_job_status.",
    inputSchema: {
      type: "object",
      properties: {
        review_diff: { type: "string", description: "Prepared diff when mode is review." },
        mode: {
          type: "string",
          enum: ["run", "resume", "fork", "review"],
          description: "Execution mode. Default: 'run'.",
        },
        prompt: {
          type: "string",
          description: "Task instructions (required for run, resume, fork; optional for review).",
        },
        cwd: CWD_SCHEMA,
        session_id: SESSION_ID_SCHEMA,
        permission_mode: PERMISSION_MODE_SCHEMA,
        model: { type: "string", description: "Optional model override." },
        effort: EFFORT_SCHEMA,
        add_dirs: ADD_DIRS_SCHEMA,
        allowed_tools: {
          type: "array",
          items: { enum: [...READ_TOOLS, ...EDIT_TOOLS] },
          description: "Subset of the host tool ceiling (review mode: Read, Glob, Grep only).",
        },
        disallowed_tools: DISALLOWED_TOOLS_SCHEMA,
        append_system_prompt: { type: "string" },
        max_budget_usd: { type: "number" },
        uncommitted: { type: "boolean" },
        base: { type: "string" },
        commit: { type: "string" },
        title: { type: "string" },
        ephemeral: { type: "boolean" },
        bridge_context: BRIDGE_CONTEXT_SCHEMA,
        timeout_seconds: { type: "number" },
      },
      required: ["cwd"],
    },
  },
  {
    name: "claude_job_status",
    description:
      "Inspect the status and output of a background Claude Code job started by claude_spawn, or list all tracked jobs when job_id is omitted.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "Specific job_id to inspect. Omit to list all tracked jobs.",
        },
      },
    },
  },
  {
    name: "claude_job_cancel",
    description: "Cancel a currently running background Claude Code job by job_id.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "Job ID returned by claude_spawn.",
        },
      },
      required: ["job_id"],
    },
  },
  {
    name: "claude_status",
    description:
      "Check the local Claude Code installation, authentication status (`claude auth status`), and active AGENT_BRIDGE_* policy.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

export { TOOLS, READ_TOOLS, EDIT_TOOLS, ORDINARY_PERMISSION_MODES, LAUNCH_MODES, EFFORT_SCHEMA };
