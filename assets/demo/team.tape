# The team's secret manager, a project's scope and a backup: a secret is read
# from a real HashiCorp Vault dev server on localhost (see tour-shell.sh), used
# masked, the project is narrowed to its own names, and the local vault is
# copied into one file. The token and passphrase typed here are made up.
# Record from the repository root: vhs assets/demo/team.tape

Output site/demo-team.mp4
Output site/demo-team.webm

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
Type "exec assets/demo/tour-shell.sh team" Enter
Wait
Type "clear" Enter
Sleep 1s
Show

Type "keyshroud source add vault --addr http://127.0.0.1:18210 --token" Sleep 500ms Enter
Wait /token:\s*$/
Sleep 500ms
Type@12ms "demo-root-token"
Sleep 400ms Enter
Wait
Sleep 2s

Type `keyshroud wire --env DB_PASSWORD --item 'vault://secret/myapp/db#password'` Sleep 500ms Enter
Wait
Sleep 1500ms

Type `keyshroud run --mask -- sh -c 'echo "migrating with $DB_PASSWORD"'` Sleep 500ms Enter
Wait
Sleep 3s

Type "clear" Enter
Type "keyshroud scope --only 'DB_*,ACME_*'" Sleep 500ms Enter
Wait
Sleep 2500ms

Type "keyshroud run --only GH_TOKEN -- gh auth status" Sleep 500ms Enter
Wait
Sleep 3s

Type "keyshroud backup" Sleep 500ms Enter
Wait /backup:\s*$/
Sleep 400ms
Type@12ms "correct horse battery staple"
Sleep 300ms Enter
Wait /it:\s*$/
Sleep 300ms
Type@12ms "correct horse battery staple"
Sleep 300ms Enter
Wait
Sleep 5s
