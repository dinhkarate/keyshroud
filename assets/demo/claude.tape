# Claude Code with the keyshroud plugin: asked to check an API key, Claude runs
# the smoke test through keyshroud and sees the key only as its name. Then the
# API's log shows the key arrived, and Claude Code's saved transcript has no copy.
# One take at normal speed. agent-shell.sh sets up the rest off screen: the
# plugin from this checkout, three fake secrets and a local mock of the API.
#
# Record from the repository root. Claude Code signs in through an apiKeyHelper
# command, so no Anthropic key is ever in the recorded shell:
#   DEMO_API_KEY_HELPER=/path/to/print-anthropic-key vhs assets/demo/claude.tape
# Then encode the site's files from the raw take:
#   ffmpeg -i /tmp/keyshroud-demo-claude.mp4 -an -c:v libx264 -profile:v high -level:v 4.0 -preset veryslow -tune animation -crf 26 -pix_fmt yuv420p -movflags +faststart site/demo-claude.mp4
#   ffmpeg -i /tmp/keyshroud-demo-claude.mp4 -an -c:v libsvtav1 -preset 4 -crf 50 -svtav1-params keyint=10s:scm=1 -pix_fmt yuv420p site/demo-claude.webm
#   ffmpeg -sseof -1 -i /tmp/keyshroud-demo-claude.mp4 -frames:v 1 /tmp/poster.png && cwebp -q 80 -m 6 -sharp_yuv /tmp/poster.png -o site/demo-claude.webp

Output "/tmp/keyshroud-demo-claude.mp4"

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
Type "exec assets/demo/agent-shell.sh" Enter
Wait
# No Anthropic key in the shell Claude Code starts from, or the take stops here.
Type `[ "$(env | grep -c sk-ant)" = 0 ] && [ "$(env | grep -c '^ANTHROPIC_')" = 0 ] || exit 1; clear` Enter
Sleep 1s
Show

Type "claude --model haiku" Sleep 500ms Enter
Wait+Screen /ask on/
Sleep 1.5s

Type "Check that my Acme API key still works: run scripts/smoke.sh" Sleep 500ms Enter
Wait+Screen@120s /done \d{1,2}:\d\d/
Sleep 4s

# Exit with ctrl+c twice: typing /exit opens the command menu, which scrolls the session off screen.
Ctrl+C
Wait+Screen /again to exit/
Ctrl+C
Wait
Sleep 1s

Type "tail -n 1 ~/acme-api.log" Sleep 500ms Enter
Wait
Sleep 2s

Type "cat ~/.claude/projects/*/*.jsonl | grep -c acme_DEMO" Sleep 500ms Enter
Wait
Sleep 5s
