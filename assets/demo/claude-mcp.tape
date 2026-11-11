# keyshroud's MCP server as Claude's only tools: Claude Code with its built-in
# tools turned off gets the server from the same entry Claude Desktop uses,
# runs the smoke test with secrets_run and sees the key only as its name.
# One take at normal speed. agent-shell.sh mcp sets up the rest off screen, as
# for claude.tape but without the plugin.
#
# Record from the repository root, as claude.tape:
#   DEMO_API_KEY_HELPER=/path/to/print-anthropic-key vhs assets/demo/claude-mcp.tape
# and encode site/demo-mcp.mp4, .webm and .webp with claude.tape's commands.

Output "/tmp/keyshroud-demo-mcp.mp4"

Require claude
Require node
Require curl

Set Shell "bash"
Set FontSize 15
Set Width 820
Set Height 900
Set Padding 24
Set TypingSpeed 32ms
Set Framerate 24
Set PlaybackSpeed 1.0
Set WaitPattern /\$\s*$/
Set WaitTimeout 90s
Set Theme { "name": "keyshroud", "black": "#14161b", "red": "#f47067", "green": "#3fb950", "yellow": "#f0b429", "blue": "#6cb6ff", "magenta": "#8b7ffa", "cyan": "#56d4dd", "white": "#e6e8ee", "brightBlack": "#8a90a0", "brightRed": "#ff938a", "brightGreen": "#6bc46d", "brightYellow": "#f8d36b", "brightBlue": "#96d0ff", "brightMagenta": "#b4abff", "brightCyan": "#7ee6ec", "brightWhite": "#ffffff", "background": "#14161b", "foreground": "#e6e8ee", "selection": "#2c313c", "cursor": "#8b7ffa" }

Hide
Type "exec assets/demo/agent-shell.sh mcp" Enter
Wait
# No Anthropic key in the shell Claude Code starts from, or the take stops here.
Type `[ "$(env | grep -c sk-ant)" = 0 ] && [ "$(env | grep -c '^ANTHROPIC_')" = 0 ] || exit 1; clear` Enter
Sleep 1s
Show

Type "cat mcp.json" Sleep 500ms Enter
Wait
Sleep 2s

Type `claude --model haiku --tools "" --mcp-config mcp.json` Sleep 500ms Enter
Wait+Screen /ask on/
Sleep 1.5s

Type "Check that my Acme API key still works: run scripts/smoke.sh, just the script, no extra commands" Sleep 500ms Enter
Wait+Screen@120s /done \d{1,2}:\d\d/
Sleep 2s

# Claude Code folds MCP calls into one line: ctrl+o shows each call and its result.
Ctrl+O
Wait+Screen /detailed transcript/
Sleep 4s
