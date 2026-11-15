# The guard: a command that fails prints the key it sent; with the guard on, the
# shell Claude Code starts masks it as it is written. No agent in this take: the
# last command is what Claude Code's Bash tool runs once CLAUDE_CODE_SHELL names
# the launcher. tour-shell.sh sets up the rest off screen: three fake secrets, a
# local mock of the API, and a shell started through `keyshroud run`.
# Record from the repository root: vhs assets/demo/guard.tape

Output site/demo-guard.mp4
Output site/demo-guard.webm

Require node
Require vhs
Require curl

Set Shell "bash"
Set FontSize 15
Set Width 1120
Set Height 540
Set Padding 24
Set TypingSpeed 32ms
Set Framerate 24
Set PlaybackSpeed 1.0
Set WaitPattern /\$\s*$/
Set WaitTimeout 60s
Set Theme { "name": "keyshroud", "black": "#14161b", "red": "#f47067", "green": "#3fb950", "yellow": "#f0b429", "blue": "#6cb6ff", "magenta": "#8b7ffa", "cyan": "#56d4dd", "white": "#e6e8ee", "brightBlack": "#8a90a0", "brightRed": "#ff938a", "brightGreen": "#6bc46d", "brightYellow": "#f8d36b", "brightBlue": "#96d0ff", "brightMagenta": "#b4abff", "brightCyan": "#7ee6ec", "brightWhite": "#ffffff", "background": "#14161b", "foreground": "#e6e8ee", "selection": "#2c313c", "cursor": "#8b7ffa" }

Hide
Type "exec assets/demo/tour-shell.sh guard" Enter
Wait
Type "clear" Enter
Sleep 1s
Show

Type "# a deploy that fails, and prints the header it sent" Sleep 300ms Enter
Type "scripts/deploy.sh" Sleep 500ms Enter
Wait
Sleep 3s

Type "keyshroud claude-guard" Sleep 500ms Enter
Wait
Sleep 3s

Type "# what Claude Code's Bash tool runs from now on" Sleep 300ms Enter
Type `GUARD=$(ls ~/.config/keyshroud/guard/*/bash)` Sleep 400ms Enter
Wait
Type `"$GUARD" -c scripts/deploy.sh; echo "exit=$?"` Sleep 500ms Enter
Wait
Sleep 6s
