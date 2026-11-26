// A fake Claude Code that dies before it ever reads a prompt, so the engine
// writes to a stdin that is already gone.
process.exit(1)
