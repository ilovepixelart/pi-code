# Hero demo, a highlights reel: commands are typed visibly, each feature state
# holds a few seconds, and Hide/Show cuts only boot and the model's working
# stretch. Record with scripts/record-demos.sh.
#
# vhs Wait note: `Wait+Screen /re/` matches the boot screen and is reliable only
# before the transcript scrolls, and a bare `Wait` matches the last line, which
# is the empty input box at idle, so neither can detect a finished model turn.
# The one model turn is therefore hidden behind a generous fixed sleep that
# outlasts it; keep the storyboard otherwise deterministic (UI states only).

Output demos/hero.gif
Set FontSize 16
Set Width 1200
Set Height 720
Set TypingSpeed 40ms
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
Set BorderRadius 8

Type "cd /tmp/pi-demo && pi"
Sleep 0.6s
Enter

# Beat 1: the repo ships .claude config plus an MCP server; approval gates it,
# and the yes is shown on camera, since trust is the whole point.
Hide
Wait+Screen@60s /Trust this project\?/
Show
Sleep 3s
Enter
Sleep 8s

# Beat 2: the project's own MCP server is connected; its tools list.
Type "/mcp"
Sleep 0.8s
Enter
Sleep 4s

# Beat 3: an agent turn plans with the todo tool. The turn is shown starting,
# the hidden stretch outlasts the model working, then the finished overlay holds.
Type@20ms "Use the todo tool: add three todos for building a snake game (set up the canvas, write the game loop, add arrow-key controls), then set the first one in progress. Do not write code yet."
Sleep 1.2s
Enter
Sleep 4s
Hide
Sleep 120s
Show
Sleep 6s

# Beat 4: every prompt got a checkpoint; /rewind opens the restore picker.
Type "/rewind"
Sleep 0.8s
Enter
Sleep 4.5s
Escape
Sleep 1s

# Beat 5: plan mode restricts tools, enforced per call, and toggles back.
Type "/plan"
Sleep 0.8s
Enter
Sleep 3.5s
Type "/plan"
Sleep 0.8s
Enter
Sleep 3.5s
