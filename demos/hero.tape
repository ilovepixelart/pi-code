# Hero demo, cut as a highlights reel: every command is typed visibly, each
# feature state holds for a few seconds, and Hide/Show cuts only boot time
# and the model's working stretch. Record with scripts/record-demos.sh.
#
# vhs caveats learned the hard way: Wait+Screen matches only the oldest
# screenful of scrollback, so waits work at boot and never after the
# transcript scrolls; everything later is paced with sleeps that outlast
# the hidden work.

Output demos/hero.gif
Set FontSize 13
Set Width 1400
Set Height 750
Set TypingSpeed 40ms
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
Set BorderRadius 8

Type "cd /tmp/pi-demo && pi"
Sleep 0.6s
Enter

# Beat 1: the repo ships .claude config plus an MCP server; approval gates it.
Hide
Wait+Screen@60s /Trust this project\?/
Show
Sleep 4.5s

# Beat 2: approved; extensions load, memory and MCP notices land.
Hide
Enter
Sleep 2.5s
Show
Sleep 4.5s

# Beat 3: the project's MCP server is connected.
Type "/mcp"
Sleep 0.8s
Enter
Sleep 3.5s

# Beat 4: an agent turn plans with the todo tool. The turn is shown starting,
# then the hidden stretch is the model working through its tool calls.
Type@20ms "Use the todo tool: add three todos for building a snake game (set up the canvas, write the game loop, add arrow-key controls), then set the first one in progress. Do not write code yet."
Sleep 1.2s
Enter
Sleep 3s
Hide
Sleep 60s
Show
Sleep 6s

# Beat 5: every prompt got a checkpoint; /rewind restores code and chat.
Type "/rewind"
Sleep 0.8s
Enter
Sleep 4.5s
Hide
Escape
Sleep 1s
Show

# Beat 6: plan mode restricts tools, enforced per call, and toggles back.
Type "/plan"
Sleep 0.8s
Enter
Sleep 4s
Type "/plan"
Sleep 0.8s
Enter
Sleep 3s
