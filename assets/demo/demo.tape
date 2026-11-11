# keyshroud on a new machine: store a token, use it masked, catch a leak.
# Record from the repository root: vhs assets/demo/demo.tape
# The token is fake and the vault key goes to a fake keychain (see shell.sh).

Output assets/demo.gif
Output site/demo.mp4
Output site/demo.webm

Require node
Require vhs

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
Type "exec assets/demo/shell.sh" Enter
Wait
Type `printf 'POST /deploy HTTP/1.1\nAuthorization: Bearer ghp_DEMOdemo0123456789demo0123456789demo\n' > debug.log; clear` Enter
Sleep 1s
Show

Type "keyshroud status" Sleep 500ms Enter
Wait
Sleep 1.5s

Type `keyshroud add --env GH_TOKEN --item "GitHub token"` Sleep 500ms Enter
Wait /GH_TOKEN:\s*$/
Sleep 500ms
Type@12ms "ghp_DEMOdemo0123456789demo0123456789demo"
Sleep 400ms Enter
Wait
Sleep 3s

Type `keyshroud run --mask -- sh -c 'echo "deploying with $GH_TOKEN"'` Sleep 500ms Enter
Wait
Sleep 2s

Type "keyshroud run --mask -- cat debug.log" Sleep 500ms Enter
Wait
Sleep 2s

Type "keyshroud scan ." Sleep 500ms Enter
Wait
Sleep 2s

Type "cat ~/.config/keyshroud/env.json" Sleep 500ms Enter
Wait
Sleep 4s
