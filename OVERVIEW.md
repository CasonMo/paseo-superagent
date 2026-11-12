# Superagent

Superagent turns Paseo into a resident super agent for a team. It watches configured message sources, decides whether an event needs action, turns actionable events into tickets, dispatches execution agents when authorized, and returns approvals and results to the chat.

## How it works

- Message sources are user-provided scripts that emit NDJSON. Each line contains a stable event id, content, and metadata. `meta.conversationKey` groups events into a conversation.
- A built-in Paseo source listens to agent turns, failures, cancellations, and permission requests. A script source can listen to an external system such as Autowonder.
- A shared judge agent evaluates each event against the current ticket. It can request a human decision, ignore the event, or dispatch an execution agent when the user has given an instruction.
- Tickets carry a `T-` number, a state, the source event, a plan, an execution agent, a result, and a PR URL when available.
- A ticket can reuse its original source agent or executor. Autowonder tickets use a coordinator that reads workitem comments through MCP, identifies the reporting digital worker, and resumes the flow with a structured comment.

## Setup

1. Configure a provider and model for the main agent, the shared judge, and execution agents in the plugin settings.
2. Optionally configure a WeCom AI bot with Bot ID and Secret. The plugin uses an outbound WebSocket, so no public callback endpoint is required.
3. Add message sources by asking Superagent to create one. Source scripts are tested and approved before they are enabled.
4. Set a repository path and base branch if sources use background worktree executors.

## Capabilities

- A split workspace: the left pane is a read-only message feed with AI replies, and the right pane is the main Superagent chat. Messages can be quoted from the left into the right composer.
- Ticket states for waiting, dispatched, completed, failed, and ignored events, with filters and direct links to the associated execution agent.
- Human-in-the-loop policy: the default mode only notifies when the judge decides that a human must act. A user reply authorizes the next dispatch; new questions and instructions are handled by an execution agent.
- A shared judge agent, so the plugin does not create one judge per conversation. The prompt requires the judge to evaluate only the current ticket.
- Paseo source continuity: when a ticket comes from a Paseo agent, execution returns to that agent. Other sources can use a background worktree executor.
- Autowonder coordination: compact workitem history, status templates, dynamic identification of the digital worker who reported an exception, `targetAgentIds` comments, and legal status transitions up to the configured target.
- Execution results return to the main Superagent chat. Internal delivery rows are hidden from the interface.
- English and Simplified Chinese listing metadata; the plugin interface follows the user's language.

## Data and permissions

The plugin stores message sources, events, tickets, conversations, execution effects, and settings in SQLite on the Paseo daemon host. The default location is under `~/.paseo/superagent`. WeCom credentials are stored in plugin settings, not in the source tree.

Message source scripts run as the daemon user. Treat source scripts as trusted code. Paseo agents created by the plugin use the permissions configured by Paseo and their provider. Execution agents can be given the Paseo `full-access` mode and preapproved Paseo MCP tools so they can operate without repeated permission prompts; source agents keep their existing permissions.

The plugin sends prompts and tool results to the configured agent providers. The WeCom channel sends the configured bot only the messages needed for notifications and replies. Autowonder integration communicates with the MCP endpoint configured on the host.

## Limitations

- Source scheduling is one-shot polling. It does not provide a resident watch process or cron expressions.
- Source scripts are not sandboxed.
- A shared judge is serialized. A slow event can delay other events.
- The current Autowonder target and workspace defaults are intended for the configured deployment; review them before using another workspace.
- Automatic merge, release, and production writes are not performed. Execution is limited to the approved plan and the configured autonomy policy.
- The plugin is a prototype. Review the source, permissions, and execution policy before using it against production systems.
