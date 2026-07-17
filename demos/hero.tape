# Hero demo: boot, todo overlay, background subagent, /rewind picker.
# Record with: vhs demos/hero.tape (from the monorepo root; needs a fixture
# repo at /tmp/pi-demo, see scripts/record-demos.sh)

Output demos/hero.gif
Set FontSize 13
Set Width 1400
Set Height 750
Set TypingSpeed 35ms
Set Theme "Catppuccin Mocha"

Type "cd /tmp/pi-demo && pi"
Enter
Sleep 10s

Type "Use the todo tool to add three todos for building a snake game, then use the start action on the first one. Do nothing else."
Enter
Sleep 45s

Type "/rewind"
Enter
Sleep 4s
Escape
Sleep 2s

Type "/plan"
Enter
Sleep 3s
Type "/plan"
Enter
Sleep 3s
